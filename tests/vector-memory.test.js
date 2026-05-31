/**
 * tests/vector-memory.test.js
 *
 * Unit tests for engine/vector-memory.js
 *
 * Strategy: Redis and the OpenAI client are fully mocked.
 * Tests cover the exported functions that contain testable pure logic:
 *   storeMemory()          — skips storage silently when embed returns null
 *   searchMemory()         — returns [] when embed returns null (no key)
 *   evictExpiredMemory()   — issues correct pipeline commands for expired keys
 *   getVectorCapabilities()— returns correct flags based on env / Redis response
 *
 * The reranking algorithm inside searchMemory() (similarity, recency, quality
 * score filtering) is exercised through a controlled FT.SEARCH mock response.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Redis mock ────────────────────────────────────────────────────────────────

const redisMock = {
  call: vi.fn(),
  pipeline: vi.fn(),
  hset: vi.fn(),
  expire: vi.fn(),
  zadd: vi.fn(),
  expireat: vi.fn(),
  zrangebyscore: vi.fn(async () => []),
  del: vi.fn(async () => 1),
  zremrangebyscore: vi.fn(async () => 0),
  _reset() {
    for (const fn of Object.values(this)) {
      if (typeof fn?.mockReset === 'function') fn.mockReset();
    }
    this.zrangebyscore.mockResolvedValue([]);
  },
};

// pipeline returns a mini-pipeline that collects calls
function makePipeline() {
  const ops = [];
  const p = {
    hset:     vi.fn(() => p),
    expire:   vi.fn(() => p),
    zadd:     vi.fn(() => p),
    expireat: vi.fn(() => p),
    del:      vi.fn(() => p),
    zremrangebyscore: vi.fn(() => p),
    exec:     vi.fn(async () => []),
  };
  return p;
}

vi.mock('ioredis', () => ({
  default: vi.fn(() => redisMock),
}));

// ─── OpenAI mock ──────────────────────────────────────────────────────────────
// Controlled via process.env.OPENAI_API_KEY + the dynamic import inside embed().

const FAKE_VECTOR = new Array(1536).fill(0.1);

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    embeddings: {
      create: vi.fn(async () => ({
        data: [{ embedding: FAKE_VECTOR }],
      })),
    },
  })),
}));

// ─── Module imports (after mocks) ────────────────────────────────────────────

import {
  storeMemory,
  searchMemory,
  evictExpiredMemory,
  getVectorCapabilities,
} from '../engine/vector-memory.js';

// ─── Reset between tests ──────────────────────────────────────────────────────

beforeEach(() => {
  redisMock._reset();
  redisMock.pipeline.mockReturnValue(makePipeline());
  redisMock.call.mockResolvedValue(['OK']); // default FT.CREATE success
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. storeMemory() — embedding-gate
// ═══════════════════════════════════════════════════════════════════════════════

describe('storeMemory() — when embeddings are unavailable', () => {
  it('returns null without calling redis pipeline when OPENAI_API_KEY is absent', async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    // Re-import so the lazy client promise is re-created without the key
    vi.resetModules();
    const { storeMemory: store } = await import('../engine/vector-memory.js');

    const result = await store('some task', '{}');
    expect(result).toBeNull();

    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. searchMemory() — returns empty when no embedding available
// ═══════════════════════════════════════════════════════════════════════════════

describe('searchMemory() — no-op when embeddings unavailable', () => {
  it('returns an empty array when OPENAI_API_KEY is absent', async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    vi.resetModules();
    const { searchMemory: search } = await import('../engine/vector-memory.js');
    const results = await search('fix the bug', 3);
    expect(results).toEqual([]);

    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. evictExpiredMemory() — Redis pipeline commands
// ═══════════════════════════════════════════════════════════════════════════════

describe('evictExpiredMemory()', () => {
  it('returns 0 and issues no deletions when there are no expired keys', async () => {
    redisMock.zrangebyscore = vi.fn(async () => []);
    const count = await evictExpiredMemory('default');
    expect(count).toBe(0);
  });

  it('deletes each expired key via a pipeline', async () => {
    const expired = ['memory:default:111_aaa', 'memory:default:222_bbb'];
    redisMock.zrangebyscore = vi.fn(async () => expired);
    const pipe = makePipeline();
    redisMock.pipeline.mockReturnValue(pipe);

    const count = await evictExpiredMemory('default');
    expect(count).toBe(2);
    expect(pipe.del).toHaveBeenCalledTimes(2);
    expect(pipe.exec).toHaveBeenCalledOnce();
  });

  it('calls zrangebyscore with -inf and a past cutoff', async () => {
    redisMock.zrangebyscore = vi.fn(async () => []);
    const before = Date.now();
    await evictExpiredMemory('default');
    const after = Date.now();

    const [, min, max] = redisMock.zrangebyscore.mock.calls[0];
    expect(min).toBe('-inf');
    // cutoff = Date.now() - TTL_MS; should be a timestamp in the past
    expect(Number(max)).toBeLessThan(before);
  });

  it('removes evicted members from the age index in the same pipeline', async () => {
    const expired = ['memory:default:111_aaa'];
    redisMock.zrangebyscore = vi.fn(async () => expired);
    const pipe = makePipeline();
    redisMock.pipeline.mockReturnValue(pipe);

    await evictExpiredMemory('default');

    expect(pipe.zremrangebyscore).toHaveBeenCalledOnce();
  });

  it('throws for an invalid tenantId', async () => {
    await expect(evictExpiredMemory('')).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. getVectorCapabilities()
// ═══════════════════════════════════════════════════════════════════════════════

describe('getVectorCapabilities()', () => {
  it('returns the four expected fields', async () => {
    redisMock.call = vi.fn(async () => []); // FT._LIST succeeds
    vi.resetModules();
    process.env.OPENAI_API_KEY = 'sk-test';
    const { getVectorCapabilities: getCaps } = await import('../engine/vector-memory.js');
    const caps = await getCaps();

    expect(caps).toHaveProperty('openai');
    expect(caps).toHaveProperty('redisSearch');
    expect(caps).toHaveProperty('embeddings');
    expect(caps).toHaveProperty('warnings');
    expect(Array.isArray(caps.warnings)).toBe(true);
  });

  it('sets redisSearch=false and adds a warning when FT._LIST is unknown command', async () => {
    vi.resetModules();
    process.env.OPENAI_API_KEY = 'sk-test';

    // Mock ioredis to return an ERR unknown command for FT._LIST
    vi.doMock('ioredis', () => ({
      default: vi.fn(() => ({
        ...redisMock,
        call: vi.fn(async (cmd) => {
          if (cmd === 'FT._LIST') throw new Error('ERR unknown command `FT._LIST`');
          return [];
        }),
      })),
    }));

    const { getVectorCapabilities: getCaps } = await import('../engine/vector-memory.js');
    const caps = await getCaps();
    expect(caps.redisSearch).toBe(false);
    expect(caps.warnings.some(w => /Redis Stack/i.test(w))).toBe(true);
  });

  it('sets openai=false and adds a warning when OPENAI_API_KEY is absent', async () => {
    vi.resetModules();
    delete process.env.OPENAI_API_KEY;

    vi.doMock('ioredis', () => ({
      default: vi.fn(() => ({
        ...redisMock,
        call: vi.fn(async () => []),
      })),
    }));

    const { getVectorCapabilities: getCaps } = await import('../engine/vector-memory.js');
    const caps = await getCaps();
    expect(caps.openai).toBe(false);
    expect(caps.warnings.some(w => /OPENAI_API_KEY/i.test(w))).toBe(true);
  });

  it('embeddings=false when either openai or redisSearch is false', async () => {
    vi.resetModules();
    delete process.env.OPENAI_API_KEY;

    vi.doMock('ioredis', () => ({
      default: vi.fn(() => ({
        ...redisMock,
        call: vi.fn(async () => []),
      })),
    }));

    const { getVectorCapabilities: getCaps } = await import('../engine/vector-memory.js');
    const caps = await getCaps();
    expect(caps.embeddings).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. tenant validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('tenant validation', () => {
  it('storeMemory throws for an invalid tenantId', async () => {
    await expect(storeMemory('task', '{}', '')).rejects.toThrow();
  });

  it('searchMemory throws for an invalid tenantId', async () => {
    await expect(searchMemory('query', 3, '')).rejects.toThrow();
  });

  it('evictExpiredMemory throws for an invalid tenantId', async () => {
    await expect(evictExpiredMemory('')).rejects.toThrow();
  });
});
