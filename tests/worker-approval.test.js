/**
 * tests/worker-approval.test.js
 *
 * Drives the real worker loop in engine/git.js (real git, real worktree, real
 * code-writer) with the model, queue, Redis and test runner mocked, to prove what
 * a human approval actually does:
 *
 *   - an approved patch is applied exactly as approved: the agent is not asked to
 *     regenerate it, review-guard is not asked again, the gate does not re-fire;
 *   - without an approval, the gate holds the patch and writes nothing, and the
 *     held record carries the tenant and kind the review routes rely on;
 *   - an approval covers ONE patch: if it fails its tests, the regenerated patch
 *     goes back through the gate.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

// ─── Real temp repo (legacy single-repo mode) ────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-worker-approval-'));
const REPO = path.join(TMP, 'repo');
const WORKTREES = path.join(TMP, 'worktrees');
const saved = {};
const ENV = {
  AEGIS_REPO_ROOT: REPO,
  AEGIS_WORKTREES: WORKTREES,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
};

beforeAll(() => {
  for (const k of [...Object.keys(ENV), 'AEGIS_REPOS_BASE']) saved[k] = process.env[k];
  Object.assign(process.env, ENV);
  delete process.env.AEGIS_REPOS_BASE;
  fs.mkdirSync(REPO, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: REPO, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(REPO, 'README.md'), 'seed\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed');
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('ioredis', () => ({
  default: vi.fn(() => ({
    on: () => {}, get: vi.fn(async () => null), set: vi.fn(async () => 'OK'),
    hget: vi.fn(async () => null), hset: vi.fn(async () => 1), del: vi.fn(async () => 1),
    zadd: vi.fn(async () => 1), zrangebyscore: vi.fn(async () => []),
    pipeline: vi.fn(() => ({ exec: vi.fn(async () => []) })),
  })),
}));
vi.mock('dotenv', () => ({ default: { config: vi.fn() }, config: vi.fn() }));

const runAgentMock       = vi.fn();
const runTestsMock       = vi.fn();
const needsApprovalMock  = vi.fn();
const consumeMock        = vi.fn();
const flagForReviewMock  = vi.fn();
const updateStepMock     = vi.fn();
const addStepMock        = vi.fn();
let   processor;

vi.mock('../engine/lock.js', () => ({
  acquireLock: vi.fn(async () => ({ release: async () => {} })),
  releaseLock: vi.fn(async () => {}),
}));
vi.mock('../engine/queue.js', () => ({
  getDeadLetterQueue: vi.fn(() => ({ add: vi.fn() })),
  addStep:            (...a) => addStepMock(...a),
  createTaskWorker:   (_tenant, fn) => { processor = fn; return { on: vi.fn() }; },
}));
vi.mock('../engine/idempotency.js', () => ({
  getOperationId: vi.fn(() => 'op-id'), isApplied: vi.fn(async () => false), markApplied: vi.fn(),
}));
vi.mock('../engine/metrics.js', () => ({
  recordStart: vi.fn(), recordRetry: vi.fn(), recordSuccess: vi.fn(), recordFailure: vi.fn(),
  recordStepStart: vi.fn(), recordStepEnd: vi.fn(),
}));
vi.mock('../engine/tracer.js', () => ({
  startSpan: vi.fn(), attachPatch: vi.fn(), attachTestResult: vi.fn(), endSpan: vi.fn(),
}));
vi.mock('../engine/agent-runner.js',  () => ({ runAgent: (...a) => runAgentMock(...a) }));
vi.mock('../engine/review-system.js', () => ({ runReviewPipeline: vi.fn(() => ({ ok: true })) }));
vi.mock('../engine/test-runner.js',   () => ({ runTests: (...a) => runTestsMock(...a) }));
vi.mock('../engine/vector-memory.js', () => ({ storeMemory: vi.fn(), searchMemory: vi.fn(async () => []) }));
vi.mock('../engine/job-store.js',     () => ({ createJob: vi.fn(), updateJob: vi.fn(), incrementRetries: vi.fn() }));
vi.mock('../engine/concurrency.js',   () => ({ acquireSlot: vi.fn(async () => ({ release: vi.fn() })), clearSlots: vi.fn() }));
vi.mock('../engine/notifier.js',      () => ({ notifyWorkflowStatus: vi.fn() }));
vi.mock('../engine/audit-log.js',     () => ({ recordAuditEvent: vi.fn(async () => ({})) }));
vi.mock('../engine/git-remote.js',    () => ({ pushAndOpenPR: vi.fn() }));
vi.mock('../engine/retry-policy.js',  () => ({
  resolvePolicy:   vi.fn(() => ({ maxAttempts: 3, backoff: 'fixed', delay: 0 })),
  calcDelay:       vi.fn(() => 0),
  agentForAttempt: vi.fn((step, _p, attempt) => (attempt > 1 ? 'debugger' : step.agent)),
}));
vi.mock('../engine/approval-gate.js', () => ({
  needsApproval:           (...a) => needsApprovalMock(...a),
  notifyApprovalRequired:  vi.fn(),
  approvalModeActive:      true,
}));
vi.mock('../engine/workflow-store.js', () => ({
  updateStep:         (...a) => updateStepMock(...a),
  getRunnableSteps:   vi.fn(async () => [{ id: 'next' }]), // keeps the run from finalising/merging
  getWorkflowStatus:  vi.fn(async () => 'running'),
  isWorkflowTimedOut: vi.fn(async () => false),
  cancelWorkflow:     vi.fn(),
  flagForReview:      (...a) => flagForReviewMock(...a),
  consumeApprovedPatch: (...a) => consumeMock(...a),
  completeWorkflow:   vi.fn(),
}));

import { getWorker } from '../engine/git.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const GATE = { reason: 'global MODE="approval"', mode: 'approval', autonomy: 'false' };
const patchFor = (file, content) => JSON.stringify({ file, content });
const STEP = { id: 'step-1', agent: 'feature-builder', description: 'add a file', depends_on: [], files: [] };

let n = 0;
async function runJob() {
  const workflowId = `wf-approval-${++n}`;
  getWorker('acme');
  const result = await processor({
    id: `job-${n}`,
    data: { step: STEP, workflowId, tenantId: 'acme' },
    opts: { priority: 5 },
    attemptsMade: 0,
  });
  return { result, workflowId, worktree: path.join(WORKTREES, 'acme', workflowId) };
}

beforeEach(() => {
  vi.clearAllMocks();
  needsApprovalMock.mockReturnValue(GATE);
  runTestsMock.mockReturnValue({ success: true, output: '' });
  consumeMock.mockResolvedValue(null);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('worker — a human-approved patch', () => {
  it('is applied exactly as approved, with no regeneration, second AI review, or second gate', async () => {
    consumeMock.mockResolvedValueOnce(patchFor('approved.txt', 'APPROVED-CONTENT\n'));

    const { result, worktree } = await runJob();

    expect(result).toEqual({ success: true });
    expect(fs.readFileSync(path.join(worktree, 'approved.txt'), 'utf8')).toBe('APPROVED-CONTENT\n');
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(needsApprovalMock).not.toHaveBeenCalled();
    expect(flagForReviewMock).not.toHaveBeenCalled();
  });
});

describe('worker — no approval on record', () => {
  it('holds the patch for review and writes nothing', async () => {
    const held = patchFor('held.txt', 'HELD-CONTENT\n');
    runAgentMock.mockImplementation(async (agent) => (agent === 'review-guard' ? 'APPROVED' : `PATCH:${held}`));

    const { result, workflowId, worktree } = await runJob();

    expect(result).toMatchObject({ awaitingApproval: true });
    expect(fs.existsSync(path.join(worktree, 'held.txt'))).toBe(false);
    expect(flagForReviewMock).toHaveBeenCalledTimes(1);
    expect(flagForReviewMock).toHaveBeenCalledWith(workflowId, 'step-1', expect.objectContaining({
      kind: 'approval', tenantId: 'acme', patch: held,
    }));
    expect(updateStepMock).toHaveBeenCalledWith(workflowId, 'step-1', 'needs-review');
  });
});

describe('worker — an approval covers one patch only', () => {
  it('sends a regenerated patch back through the gate when the approved one fails its tests', async () => {
    const approved    = patchFor('first.txt', 'FIRST\n');
    const regenerated = patchFor('second.txt', 'SECOND\n');
    consumeMock.mockResolvedValueOnce(approved);
    runTestsMock.mockReturnValueOnce({ success: false, output: 'boom' });
    runAgentMock.mockImplementation(async (agent) => (agent === 'review-guard' ? 'APPROVED' : `PATCH:${regenerated}`));

    const { result, workflowId, worktree } = await runJob();

    // The approved patch was tried first, failed, and was rolled back…
    expect(consumeMock).toHaveBeenCalledTimes(1);
    // …and the replacement was NOT applied on the strength of that approval.
    expect(result).toMatchObject({ awaitingApproval: true });
    expect(fs.existsSync(path.join(worktree, 'second.txt'))).toBe(false);
    expect(flagForReviewMock).toHaveBeenCalledWith(workflowId, 'step-1', expect.objectContaining({
      kind: 'approval', tenantId: 'acme', patch: regenerated,
    }));
  });
});
