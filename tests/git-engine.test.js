/**
 * tests/git-engine.test.js
 *
 * Unit tests for engine/git.js — the real git operations layer.
 *
 * Covers:
 *   worktreeDir()              — returns null when directory absent, path when present
 *   ensureWorkflowBranch()     — creates worktree dir + branch, returns { cwd, lock }
 *                                skips creation when worktree already exists
 *                                releases lock and re-throws on git failure
 *   commitChanges()            — calls git add -A then git commit
 *   rollbackLastCommit()       — calls git reset --hard HEAD~1
 *   finaliseWorkflow()         — creates base branch when absent, merges, returns { merged, conflicts, resolvedVia? }
 *                                returns { merged: false, conflicts } on merge failure
 *                                returns resolvedVia="direct"|"rebase" on success
 *   removeWorkflowWorktree()   — calls worktree remove + branch -D (best-effort, no throw)
 *   getWorker()                — rejects invalid tenantId, caches workers per tenant
 *
 * Strategy: spawnSync / execFileSync / fs are mocked so no real git binary or
 * filesystem is exercised.  acquireLock / releaseLock are mocked to return a
 * controllable lock stub.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock external I/O ────────────────────────────────────────────────────────

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

vi.mock('dotenv', () => ({ default: { config: vi.fn() }, config: vi.fn() }));

// ─── Mock child_process ───────────────────────────────────────────────────────

const spawnSyncMock    = vi.fn();
const execFileSyncMock = vi.fn();

vi.mock('child_process', () => ({
  spawnSync:    (...args) => spawnSyncMock(...args),
  execFileSync: (...args) => execFileSyncMock(...args),
}));

// ─── Mock fs ──────────────────────────────────────────────────────────────────
// existsSyncMock and mkdirSyncMock must be created via vi.hoisted() so they are
// available when the vi.mock('fs', ...) factory is evaluated at hoist time.
// An async factory also risks not being ready before git.js first imports 'fs',
// so the factory is kept synchronous — importOriginal is not needed because we
// provide every method the SUT uses explicitly.

const { existsSyncMock, mkdirSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  mkdirSyncMock:  vi.fn(),
}));

vi.mock('fs', () => {
  const mod = {
    existsSync:    (...args) => existsSyncMock(...args),
    mkdirSync:     (...args) => mkdirSyncMock(...args),
    writeFileSync: vi.fn(),
    readFileSync:  vi.fn(() => '# persona'),
  };
  return { ...mod, default: mod };
});

// ─── Mock engine dependencies ─────────────────────────────────────────────────

const mockLock = { release: vi.fn(async () => {}) };
const acquireLockMock = vi.fn(async () => mockLock);
const releaseLockMock = vi.fn(async () => {});

vi.mock('../engine/lock.js', () => ({
  acquireLock:  (...args) => acquireLockMock(...args),
  releaseLock:  (...args) => releaseLockMock(...args),
}));

vi.mock('../engine/queue.js', () => ({
  getTaskQueue:       vi.fn(() => ({ add: vi.fn() })),
  getDeadLetterQueue: vi.fn(() => ({ add: vi.fn() })),
  addStep:            vi.fn(),
  createTaskWorker:   vi.fn(() => ({ on: vi.fn() })),
}));

vi.mock('../engine/idempotency.js', () => ({
  getOperationId: vi.fn(() => 'op-1'),
  isApplied:      vi.fn(async () => false),
  markApplied:    vi.fn(),
}));

vi.mock('../engine/metrics.js', () => ({
  recordStart:   vi.fn(), recordRetry: vi.fn(), recordSuccess: vi.fn(),
  recordFailure: vi.fn(), recordStepStart: vi.fn(), recordStepEnd: vi.fn(),
}));

vi.mock('../engine/tracer.js', () => ({
  startSpan: vi.fn(), attachPatch: vi.fn(),
  attachTestResult: vi.fn(), endSpan: vi.fn(),
}));

vi.mock('../engine/agent-runner.js',  () => ({ runAgent: vi.fn(async () => 'PATCH: {}') }));
vi.mock('../engine/review-system.js', () => ({ runReviewPipeline: vi.fn(() => ({ ok: true, message: 'APPROVED' })) }));
vi.mock('../engine/test-runner.js',   () => ({ runTests: vi.fn(() => ({ success: true, output: '' })) }));
vi.mock('../engine/vector-memory.js', () => ({ storeMemory: vi.fn(), searchMemory: vi.fn(async () => []) }));
vi.mock('../engine/job-store.js',     () => ({ createJob: vi.fn(), updateJob: vi.fn(), incrementRetries: vi.fn() }));
vi.mock('../engine/workflow-store.js', () => ({
  updateStep:           vi.fn(), getRunnableSteps: vi.fn(async () => []),
  getWorkflowStatus:    vi.fn(async () => 'running'),
  isWorkflowTimedOut:   vi.fn(async () => false),
  cancelWorkflow:       vi.fn(), flagForReview: vi.fn(),
}));
vi.mock('../engine/concurrency.js',   () => ({ acquireSlot: vi.fn(async () => ({ release: vi.fn() })), clearSlots: vi.fn() }));
vi.mock('../engine/approval-gate.js', () => ({ needsApproval: vi.fn(() => null), approvalModeActive: false }));
vi.mock('../engine/retry-policy.js',  () => ({
  resolvePolicy:   vi.fn(() => ({ maxAttempts: 3 })),
  calcDelay:       vi.fn(() => 0),
  agentForAttempt: vi.fn(() => 'feature-builder'),
}));

// ─── Import after all mocks ───────────────────────────────────────────────────

import {
  worktreeDir,
  ensureWorkflowBranch,
  commitChanges,
  rollbackLastCommit,
  revertStepCommit,
  finaliseWorkflow,
  removeWorkflowWorktree,
  getWorker,
} from '../engine/git.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Simulate a successful git spawn (status 0, optional stdout). */
function gitOk(stdout = '') {
  return { status: 0, stdout, stderr: '' };
}

/** Simulate a failed git spawn (status 1). */
function gitFail(stderr = 'fatal: not a git repository') {
  return { status: 1, stdout: '', stderr };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLock.release.mockResolvedValue(undefined);
  acquireLockMock.mockResolvedValue(mockLock);
  // Default: all git calls succeed
  spawnSyncMock.mockReturnValue(gitOk());
  execFileSyncMock.mockReturnValue('');
  // Default: worktree directory does not exist → create path is exercised
  existsSyncMock.mockReturnValue(false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. worktreeDir()
// ═══════════════════════════════════════════════════════════════════════════════

describe('worktreeDir()', () => {
  it('returns null when the tenant worktrees directory does not exist', () => {
    existsSyncMock.mockReturnValue(false);
    expect(worktreeDir('tenant-abc')).toBeNull();
  });

  it('returns the expected path string when the directory exists', () => {
    existsSyncMock.mockReturnValue(true);
    const result = worktreeDir('tenant-abc');
    expect(typeof result).toBe('string');
    expect(result).toContain('tenant-abc');
  });

  it('includes the tenant id in the returned path', () => {
    existsSyncMock.mockReturnValue(true);
    const result = worktreeDir('my-tenant');
    expect(result).toContain('my-tenant');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. ensureWorkflowBranch()
// ═══════════════════════════════════════════════════════════════════════════════

describe('ensureWorkflowBranch()', () => {
  it('acquires a lock and returns { cwd, lock }', async () => {
    const result = await ensureWorkflowBranch('wf-001', 'tenant-abc');
    expect(acquireLockMock).toHaveBeenCalledWith('worktree:wf-001', 'tenant-abc');
    expect(result).toHaveProperty('cwd');
    expect(result).toHaveProperty('lock');
  });

  it('cwd contains both the tenantId and workflowId', async () => {
    const { cwd } = await ensureWorkflowBranch('wf-002', 'tenant-xyz');
    expect(cwd).toContain('tenant-xyz');
    expect(cwd).toContain('wf-002');
  });

  it('calls mkdirSync + git worktree add when the worktree does not exist', async () => {
    existsSyncMock.mockReturnValue(false);
    // base branch exists check (first spawnSync), then worktree add (second spawnSync)
    spawnSyncMock
      .mockReturnValueOnce(gitOk())  // rev-parse --verify base branch → exists
      .mockReturnValue(gitOk());     // worktree add + any further git calls

    await ensureWorkflowBranch('wf-new', 'tenant-t');
    expect(mkdirSyncMock).toHaveBeenCalled();
    // At least one call must be 'worktree'
    const worktreeCall = spawnSyncMock.mock.calls.find(
      ([bin, args]) => bin === 'git' && args.includes('worktree')
    );
    expect(worktreeCall).toBeDefined();
  });

  it('branches from HEAD when the tenant base branch does not yet exist', async () => {
    existsSyncMock.mockReturnValue(false);
    // rev-parse fails → base branch absent → should branch from HEAD
    spawnSyncMock
      .mockReturnValueOnce(gitFail('fatal: not found')) // base branch absent
      .mockReturnValue(gitOk());

    await ensureWorkflowBranch('wf-first', 'brand-new-tenant');

    const worktreeAddCall = spawnSyncMock.mock.calls.find(
      ([bin, args]) => bin === 'git' && args[0] === 'worktree' && args[1] === 'add'
    );
    expect(worktreeAddCall).toBeDefined();
    // Should use 'HEAD' as start point, not the non-existent base branch
    expect(worktreeAddCall[1]).toContain('HEAD');
  });

  it('skips mkdirSync and git worktree add when worktree already exists', async () => {
    existsSyncMock.mockReturnValue(true); // dir already there
    await ensureWorkflowBranch('wf-existing', 'tenant-abc');
    expect(mkdirSyncMock).not.toHaveBeenCalled();
    // No worktree add should be issued
    const worktreeAddCall = spawnSyncMock.mock.calls.find(
      ([bin, args]) => bin === 'git' && args[0] === 'worktree' && args[1] === 'add'
    );
    expect(worktreeAddCall).toBeUndefined();
  });

  it('releases lock and rethrows when git worktree add fails', async () => {
    existsSyncMock.mockReturnValue(false);
    spawnSyncMock
      .mockReturnValueOnce(gitOk())         // base branch check passes
      .mockReturnValue(gitFail('fatal'));    // worktree add fails

    await expect(ensureWorkflowBranch('wf-bad', 'tenant-err')).rejects.toThrow();
    expect(releaseLockMock).toHaveBeenCalledWith(mockLock);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. commitChanges()
// ═══════════════════════════════════════════════════════════════════════════════

describe('commitChanges()', () => {
  it('calls git add -A then git commit with the given message', () => {
    const cwd = '/tmp/wt/tenant/wf-001';
    commitChanges('Aegis: step-1', cwd);

    const addCall = spawnSyncMock.mock.calls.find(
      ([bin, args]) => bin === 'git' && args.includes('-A')
    );
    const commitCall = spawnSyncMock.mock.calls.find(
      ([bin, args]) => bin === 'git' && args[0] === 'commit'
    );

    expect(addCall).toBeDefined();
    expect(commitCall).toBeDefined();
    expect(commitCall[1]).toContain('Aegis: step-1');
  });

  it('passes the cwd option to spawnSync for both git calls', () => {
    const cwd = '/tmp/wt/tenant/wf-002';
    commitChanges('msg', cwd);

    for (const [bin, , opts] of spawnSyncMock.mock.calls) {
      if (bin === 'git') expect(opts.cwd).toBe(cwd);
    }
  });

  it('throws when git commit returns a non-zero exit code', () => {
    spawnSyncMock
      .mockReturnValueOnce(gitOk())    // add -A succeeds
      .mockReturnValue(gitFail('nothing to commit'));

    expect(() => commitChanges('msg', '/tmp/wt')).toThrow(/commit failed/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. rollbackLastCommit()
// ═══════════════════════════════════════════════════════════════════════════════

describe('rollbackLastCommit()', () => {
  it('calls git reset --hard HEAD~1 in the given cwd', () => {
    const cwd = '/tmp/wt/tenant/wf-rollback';
    rollbackLastCommit(cwd);

    const resetCall = spawnSyncMock.mock.calls.find(
      ([bin, args]) => bin === 'git' && args[0] === 'reset' && args.includes('HEAD~1')
    );
    expect(resetCall).toBeDefined();
    expect(resetCall[2].cwd).toBe(cwd);
  });

  it('throws when git reset returns a non-zero exit code', () => {
    spawnSyncMock.mockReturnValue(gitFail('fatal: bad revision'));
    expect(() => rollbackLastCommit('/tmp/wt')).toThrow(/reset.*failed/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. revertStepCommit()
// ═══════════════════════════════════════════════════════════════════════════════

describe('revertStepCommit()', () => {
  const cwd = '/tmp/wt/tenant/wf-revert';

  it('finds the step commit and calls git revert --no-edit with its hash', () => {
    // git log --grep returns the target hash; git revert succeeds; git rev-parse returns new HEAD
    spawnSyncMock
      .mockReturnValueOnce(gitOk('abc1234'))  // git log --grep
      .mockReturnValueOnce(gitOk())           // git revert --no-edit abc1234
      .mockReturnValueOnce(gitOk('def5678')); // git rev-parse HEAD

    revertStepCommit('wf-revert', 'step-1', cwd);

    const revertCall = spawnSyncMock.mock.calls.find(
      ([bin, args]) => bin === 'git' && args[0] === 'revert'
    );
    expect(revertCall).toBeDefined();
    expect(revertCall[1]).toContain('--no-edit');
    expect(revertCall[1]).toContain('abc1234');
  });

  it('returns { commitHash } set to the new HEAD after the revert commit', () => {
    spawnSyncMock
      .mockReturnValueOnce(gitOk('abc1234'))  // git log --grep
      .mockReturnValueOnce(gitOk())           // git revert
      .mockReturnValueOnce(gitOk('def5678')); // git rev-parse HEAD

    const result = revertStepCommit('wf-revert', 'step-1', cwd);
    expect(result).toEqual({ commitHash: 'def5678' });
  });

  it('searches using the canonical "Aegis: <stepId>" commit message format', () => {
    spawnSyncMock
      .mockReturnValueOnce(gitOk('abc1234'))
      .mockReturnValueOnce(gitOk())
      .mockReturnValueOnce(gitOk('def5678'));

    revertStepCommit('wf-revert', 'my-step-id', cwd);

    const logCall = spawnSyncMock.mock.calls.find(
      ([bin, args]) => bin === 'git' && args[0] === 'log'
    );
    expect(logCall).toBeDefined();
    const grepArg = logCall[1].find(a => a.startsWith('--grep='));
    expect(grepArg).toBe('--grep=Aegis: my-step-id');
  });

  it('throws when no commit exists for the given stepId', () => {
    // git log returns empty stdout → no commit found
    spawnSyncMock.mockReturnValueOnce(gitOk(''));

    expect(() => revertStepCommit('wf-revert', 'missing-step', cwd))
      .toThrow(/no commit found/i);
  });

  it('throws when git revert fails (e.g. merge conflict)', () => {
    spawnSyncMock
      .mockReturnValueOnce(gitOk('abc1234'))       // git log finds the commit
      .mockReturnValueOnce(gitFail('CONFLICT'));    // git revert fails

    expect(() => revertStepCommit('wf-revert', 'step-conflict', cwd))
      .toThrow(/revert failed/i);
  });

  it('passes the correct cwd to all git sub-commands', () => {
    spawnSyncMock
      .mockReturnValueOnce(gitOk('abc1234'))
      .mockReturnValueOnce(gitOk())
      .mockReturnValueOnce(gitOk('def5678'));

    revertStepCommit('wf-revert', 'step-1', cwd);

    for (const [bin, , opts] of spawnSyncMock.mock.calls) {
      if (bin === 'git') expect(opts.cwd).toBe(cwd);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. finaliseWorkflow()
// ═══════════════════════════════════════════════════════════════════════════════

describe('finaliseWorkflow()', () => {
  it('returns { merged: true, conflicts: [] } on a clean merge', async () => {
    // rev-parse for base branch (exists), then execFileSync merge succeeds
    spawnSyncMock.mockReturnValue(gitOk());
    execFileSyncMock.mockReturnValue('');

    const result = await finaliseWorkflow('wf-ok', 'tenant-ok');
    expect(result.merged).toBe(true);
    expect(result.conflicts).toHaveLength(0);
    expect(result.resolvedVia).toBe('direct');
  });

  it('creates the base branch when it does not exist yet', async () => {
    // First spawnSync is rev-parse → base branch absent
    spawnSyncMock
      .mockReturnValueOnce(gitFail('fatal: not found')) // rev-parse fails
      .mockReturnValue(gitOk());                         // branch create + any diff

    execFileSyncMock.mockReturnValue('');

    await finaliseWorkflow('wf-first', 'brand-new');

    const branchCreateCall = spawnSyncMock.mock.calls.find(
      ([bin, args]) => bin === 'git' && args[0] === 'branch'
    );
    expect(branchCreateCall).toBeDefined();
  });

  it('returns { merged: false, conflicts } when merge fails', async () => {
    // Use the 'flag' strategy so the function returns {merged:false} immediately
    // after the first merge fails, without entering the rebase path.  Without
    // this the default 'rebase' strategy triggers additional spawnSync /
    // execFileSync calls whose mock return values interact with this test's setup
    // and can cause the rebase to appear successful, flipping merged to true.
    process.env.AEGIS_MERGE_STRATEGY = 'flag';
    try {
      spawnSyncMock.mockReturnValue(gitOk()); // rev-parse ok
      execFileSyncMock.mockImplementationOnce(() => {
        throw new Error('CONFLICT');
      });
      // git diff --name-only → conflicting files
      spawnSyncMock.mockReturnValue(gitOk('engine/foo.js\nengine/bar.js'));
      // git merge --abort
      spawnSyncMock.mockReturnValue(gitOk());

      const result = await finaliseWorkflow('wf-conflict', 'tenant-c');
      expect(result.merged).toBe(false);
      expect(Array.isArray(result.conflicts)).toBe(true);
    } finally {
      delete process.env.AEGIS_MERGE_STRATEGY;
    }
  });

  it('acquires and releases the tenant-level merge lock', async () => {
    spawnSyncMock.mockReturnValue(gitOk());
    execFileSyncMock.mockReturnValue('');

    await finaliseWorkflow('wf-lock', 'tenant-l');
    expect(acquireLockMock).toHaveBeenCalledWith('tenant-merge:tenant-l', 'tenant-l');
    // lock is released via releaseLock() in the finally block
    expect(releaseLockMock).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. removeWorkflowWorktree()
// ═══════════════════════════════════════════════════════════════════════════════

describe('removeWorkflowWorktree()', () => {
  it('calls git worktree remove and git branch -D for the workflow', async () => {
    await removeWorkflowWorktree('wf-done', 'tenant-abc');

    const removeCall = spawnSyncMock.mock.calls.find(
      ([bin, args]) => bin === 'git' && args[0] === 'worktree' && args[1] === 'remove'
    );
    const deleteBranchCall = spawnSyncMock.mock.calls.find(
      ([bin, args]) => bin === 'git' && args[0] === 'branch' && args.includes('-D')
    );

    expect(removeCall).toBeDefined();
    expect(deleteBranchCall).toBeDefined();
  });

  it('does not throw when git worktree remove fails (already removed)', async () => {
    spawnSyncMock.mockReturnValue(gitFail('fatal: worktree not found'));
    await expect(removeWorkflowWorktree('wf-gone', 'tenant-abc')).resolves.not.toThrow();
  });

  it('does not throw when git branch -D fails (branch already deleted)', async () => {
    spawnSyncMock
      .mockReturnValueOnce(gitFail('fatal: no worktree'))
      .mockReturnValue(gitFail('error: branch not found'));
    await expect(removeWorkflowWorktree('wf-clean', 'tenant-abc')).resolves.not.toThrow();
  });

  it('uses the correct branch name pattern aegis/<tenantId>/<workflowId>', async () => {
    spawnSyncMock.mockReturnValue(gitOk());
    await removeWorkflowWorktree('wf-123', 'my-tenant');

    const deleteBranchCall = spawnSyncMock.mock.calls.find(
      ([bin, args]) => bin === 'git' && args[0] === 'branch' && args.includes('-D')
    );
    const branchArg = deleteBranchCall[1].find(a => a.startsWith('aegis/'));
    expect(branchArg).toBe('aegis/my-tenant/wf-123');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. getWorker() — tenant validation and caching (unchanged behaviour)
// ═══════════════════════════════════════════════════════════════════════════════

describe('getWorker()', () => {
  it('throws for an empty tenantId', () => {
    expect(() => getWorker('')).toThrow();
  });

  it('throws for a tenantId containing path-injection characters', () => {
    expect(() => getWorker('../evil')).toThrow();
  });

  it('returns a worker object with an .on method for a valid tenantId', () => {
    const worker = getWorker('tenant-valid');
    expect(worker).toBeDefined();
    expect(typeof worker.on).toBe('function');
  });

  it('returns the same cached worker on repeated calls for the same tenantId', () => {
    const w1 = getWorker('tenant-cache-test');
    const w2 = getWorker('tenant-cache-test');
    expect(w1).toBe(w2);
  });

  it('returns different workers for different tenantIds', () => {
    const w1 = getWorker('tenant-A1');
    const w2 = getWorker('tenant-B2');
    expect(w1).not.toBe(w2);
  });
});
