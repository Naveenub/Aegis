/**
 * tests/git-engine.test.js
 *
 * Unit tests for the Git engine layer — engine/code-writer.js
 * (validateTargetPath, parsePatch, applyPatch) and the agent-worker
 * getWorker() factory guard.
 *
 * Covers:
 *   validateTargetPath()  — inside-root paths, traversal attempts, blocked names
 *   parsePatch()          — valid JSON, invalid JSON, null patch
 *   applyPatch()          — writes file inside root, blocks traversal, blocks
 *                           oversized content, blocks blocked filenames
 *   getWorker()           — rejects invalid tenantId, returns cached worker
 *
 * No real filesystem writes — fs.writeFileSync and fs.mkdirSync are mocked.
 * No Redis / BullMQ connections — ioredis and bullmq are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// ─── Mock BullMQ ──────────────────────────────────────────────────────────────

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
  })),
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn(),
  })),
}));

// ─── Mock ioredis ─────────────────────────────────────────────────────────────

vi.mock('ioredis', () => ({
  default: vi.fn(() => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    hget: vi.fn(async () => null),
    hset: vi.fn(async () => 1),
    pipeline: vi.fn(() => ({ exec: vi.fn(async () => []) })),
    zadd: vi.fn(async () => 1),
    zrangebyscore: vi.fn(async () => []),
    del: vi.fn(async () => 1),
    zremrangebyscore: vi.fn(async () => 0),
  })),
}));

// ─── Mock all engine dependencies of agent-worker ────────────────────────────

vi.mock('../engine/lock.js',          () => ({ acquireLock: vi.fn(async () => ({})), releaseLock: vi.fn(async () => {}) }));
vi.mock('../engine/queue.js',         () => ({ getTaskQueue: vi.fn(() => ({ add: vi.fn() })), getDeadLetterQueue: vi.fn(() => ({ add: vi.fn() })), addStep: vi.fn() }));
vi.mock('../engine/idempotency.js',   () => ({ getOperationId: vi.fn(() => 'op-1'), isApplied: vi.fn(async () => false), markApplied: vi.fn() }));
vi.mock('../engine/metrics.js',       () => ({ recordStart: vi.fn(), recordRetry: vi.fn(), recordSuccess: vi.fn(), recordFailure: vi.fn(), recordStepStart: vi.fn(), recordStepEnd: vi.fn() }));
vi.mock('../engine/tracer.js',        () => ({ startSpan: vi.fn(), attachPatch: vi.fn(), attachTestResult: vi.fn(), endSpan: vi.fn() }));
vi.mock('../engine/agent-runner.js',  () => ({ runAgent: vi.fn(async () => 'PATCH: {"file":"a.js","content":"x"}') }));
vi.mock('../engine/review-system.js', () => ({ runReviewPipeline: vi.fn(() => ({ ok: true, message: 'APPROVED' })) }));
vi.mock('../engine/test-runner.js',   () => ({ runTests: vi.fn(() => ({ success: true, output: '' })) }));
vi.mock('../engine/vector-memory.js', () => ({ storeMemory: vi.fn(), searchMemory: vi.fn(async () => []) }));
vi.mock('../engine/job-store.js',     () => ({ createJob: vi.fn(), updateJob: vi.fn(), incrementRetries: vi.fn() }));
vi.mock('../engine/workflow-store.js',() => ({ updateStep: vi.fn(), getRunnableSteps: vi.fn(async () => []), getWorkflowStatus: vi.fn(async () => 'running'), isWorkflowTimedOut: vi.fn(async () => false), cancelWorkflow: vi.fn(), flagForReview: vi.fn() }));
vi.mock('../engine/concurrency.js',   () => ({ acquireSlot: vi.fn(async () => ({ release: vi.fn() })), clearSlots: vi.fn() }));
vi.mock('../engine/approval-gate.js', () => ({ needsApproval: vi.fn(() => null), approvalModeActive: false }));

// ─── Mock fs to avoid real disk writes ───────────────────────────────────────

const writtenFiles = new Map();

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeFileSync: vi.fn((filePath, content) => {
      writtenFiles.set(filePath, content);
    }),
    mkdirSync:   vi.fn(),
    readFileSync: vi.fn((filePath) => '# persona'),
    existsSync:   vi.fn(() => true),
  };
});

vi.mock('dotenv', () => ({ default: { config: vi.fn() }, config: vi.fn() }));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { validateTargetPath, parsePatch, applyPatch } from '../engine/code-writer.js';
import { getWorker } from '../engine/git.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

beforeEach(() => {
  writtenFiles.clear();
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. validateTargetPath()
// ═══════════════════════════════════════════════════════════════════════════════

describe('validateTargetPath()', () => {
  it('returns null for a valid path inside root', () => {
    const resolved = path.join(PROJECT_ROOT, 'src', 'foo.js');
    expect(validateTargetPath(resolved, PROJECT_ROOT)).toBeNull();
  });

  it('returns an error string for a path outside root (traversal)', () => {
    const traversal = path.resolve(PROJECT_ROOT, '../../etc/passwd');
    const err = validateTargetPath(traversal, PROJECT_ROOT);
    expect(typeof err).toBe('string');
    expect(err).toMatch(/traversal/i);
  });

  it('returns an error string for a path to root itself (not inside)', () => {
    const err = validateTargetPath(PROJECT_ROOT, PROJECT_ROOT);
    expect(typeof err).toBe('string');
  });

  it('blocks .env filename', () => {
    const blocked = path.join(PROJECT_ROOT, 'src', '.env');
    const err = validateTargetPath(blocked, PROJECT_ROOT);
    expect(typeof err).toBe('string');
    expect(err).toMatch(/\.env/);
  });

  it('blocks files with "secrets" in the name', () => {
    const blocked = path.join(PROJECT_ROOT, 'config', 'secrets.json');
    const err = validateTargetPath(blocked, PROJECT_ROOT);
    expect(typeof err).toBe('string');
    expect(err).toMatch(/secrets/i);
  });

  it('accepts a deep nested valid path', () => {
    const deep = path.join(PROJECT_ROOT, 'engine', 'sub', 'deep', 'file.js');
    expect(validateTargetPath(deep, PROJECT_ROOT)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. parsePatch()
// ═══════════════════════════════════════════════════════════════════════════════

describe('parsePatch()', () => {
  it('parses a valid JSON patch string', () => {
    const raw = JSON.stringify({ file: 'src/x.js', content: 'hello' });
    const parsed = parsePatch(raw);
    expect(parsed.file).toBe('src/x.js');
    expect(parsed.content).toBe('hello');
  });

  it('throws on invalid JSON', () => {
    expect(() => parsePatch('not-json')).toThrow();
  });

  it('parses null patch (patch: null) without throwing', () => {
    const parsed = parsePatch('null');
    expect(parsed).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. applyPatch()
// ═══════════════════════════════════════════════════════════════════════════════

describe('applyPatch()', () => {
  const { writeFileSync } = await import('fs');

  it('calls writeFileSync for a valid in-root file', async () => {
    const { writeFileSync } = await import('fs');
    applyPatch('src/ok.js', 'content', PROJECT_ROOT);
    expect(writeFileSync).toHaveBeenCalledOnce();
  });

  it('does not write when the path escapes the root (traversal)', async () => {
    const { writeFileSync } = await import('fs');
    applyPatch('../../etc/passwd', 'evil', PROJECT_ROOT);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('does not write when content exceeds 50 000 characters', async () => {
    const { writeFileSync } = await import('fs');
    applyPatch('src/big.js', 'x'.repeat(50_001), PROJECT_ROOT);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('does not write to a blocked filename (.env)', async () => {
    const { writeFileSync } = await import('fs');
    applyPatch('.env', 'SECRET=1', PROJECT_ROOT);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('writes to the resolved path inside the given cwd, not PROJECT_ROOT', async () => {
    const { writeFileSync } = await import('fs');
    const worktree = path.join(PROJECT_ROOT, 'worktrees', 'wf-abc');
    applyPatch('src/feature.js', '// code', worktree);
    const [calledPath] = writeFileSync.mock.calls[0];
    expect(calledPath).toContain('wf-abc');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. getWorker() — tenant validation and caching
// ═══════════════════════════════════════════════════════════════════════════════

describe('getWorker()', () => {
  it('throws for an empty tenantId', () => {
    expect(() => getWorker('')).toThrow();
  });

  it('returns a worker object for a valid tenantId', () => {
    const worker = getWorker('tenant-abc');
    expect(worker).toBeDefined();
    expect(typeof worker.on).toBe('function');
  });

  it('returns the same cached worker on a second call for the same tenant', () => {
    const w1 = getWorker('tenant-cache');
    const w2 = getWorker('tenant-cache');
    expect(w1).toBe(w2);
  });

  it('returns different workers for different tenants', () => {
    const w1 = getWorker('tenant-X');
    const w2 = getWorker('tenant-Y');
    expect(w1).not.toBe(w2);
  });
});
