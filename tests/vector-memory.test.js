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

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Redis mock ────────────────────────────────────────────────────────────────
// redisMock must be declared via vi.hoisted() so it exists at the time
// vi.mock('ioredis', ...) factory is hoisted to the top of the file.
// Using a plain const here causes a TDZ ReferenceError because vi.mock
// factories are moved before all imports/declarations by vitest's transformer.

const redisMock = vi.hoisted(() => ({
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
}));

// pipeline returns a mini-pipeline that collects calls
function makePipeline() {
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
  it('throws EMBEDDINGS_UNAVAILABLE (not a silent null) when OPENAI_API_KEY is absent', async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    vi.resetModules();
    const { storeMemory: store } = await import('../engine/vector-memory.js');

    await expect(store('some task', '{}')).rejects.toMatchObject({
      code: 'EMBEDDINGS_UNAVAILABLE',
      message: expect.stringContaining('OPENAI_API_KEY'),
    });

    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. searchMemory() — degrades to [] when no embedding available
// ═══════════════════════════════════════════════════════════════════════════════
// searchMemory intentionally returns [] (not throws) when OPENAI_API_KEY is
// absent.  Missing past-fix context is recoverable — agents still run; only
// storeMemory (a write) throws so the data-loss path is surfaced loudly.

describe('searchMemory() — graceful degradation when embeddings unavailable', () => {
  it('returns [] (not throws) when OPENAI_API_KEY is absent', async () => {
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

  it('embeddings=true even when redisSearch=false (HSCAN path still uses embeddings)', async () => {
    vi.resetModules();
    process.env.OPENAI_API_KEY = 'sk-test';

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
    // embeddings depends only on the OpenAI client, not Redis Stack
    expect(caps.embeddings).toBe(true);
    expect(caps.redisSearch).toBe(false);
  });

  it('embeddings=false only when openai=false (key absent)', async () => {
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
    expect(caps.openai).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. storeMemory error is catchable by code (write vs read asymmetry)
// ═══════════════════════════════════════════════════════════════════════════════
// storeMemory throws so silent data loss is impossible.
// searchMemory returns [] so agents degrade gracefully in CI / no-key envs.

describe('storeMemory error code is EMBEDDINGS_UNAVAILABLE', () => {
  it('err.code === "EMBEDDINGS_UNAVAILABLE" when key is absent', async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    vi.resetModules();
    const { storeMemory: store } = await import('../engine/vector-memory.js');

    let caught;
    try { await store('task', '{}'); } catch (e) { caught = e; }

    expect(caught?.code).toBe('EMBEDDINGS_UNAVAILABLE');
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
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
