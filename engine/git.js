/**
 * engine/git.js — Git operations for per-workflow worktrees + worker factory
 *
 * Each workflow runs in an isolated git worktree so concurrent workflows never
 * touch the same working directory.  All functions that shell out to git are
 * synchronous (spawnSync) because they are called inside BullMQ job handlers
 * where async git subprocess management adds no value.
 *
 * Exports
 * ───────
 *   worktreeDir(tenantId)                         → string | null
 *   ensureWorkflowBranch(workflowId, tenantId)    → { cwd, lock }
 *   commitChanges(message, cwd)                   → void
 *   rollbackLastCommit(cwd)                       → void
 *   revertStepCommit(workflowId, stepId, cwd)     → { commitHash }
 *   finaliseWorkflow(workflowId, tenantId)        → { merged, conflicts }
 *   removeWorkflowWorktree(workflowId, tenantId)  → Promise<void>
 *   getWorker(tenantId)                           → Worker  (BullMQ worker factory)
 */

import { execFileSync, spawnSync } from 'child_process';
import fs   from 'fs';
import path from 'path';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { acquireLock, releaseLock } from './lock.js';
import { applyPatch, parsePatch } from './code-writer.js';
import { getTaskQueue, getDeadLetterQueue, addStep } from './queue.js';
import { getOperationId, isApplied, markApplied } from './idempotency.js';
import { recordStart, recordRetry, recordSuccess, recordFailure, recordStepStart, recordStepEnd } from './metrics.js';
import { startSpan, attachPatch, attachTestResult, endSpan } from './tracer.js';
import { runAgent } from './agent-runner.js';
import { runReviewPipeline } from './review-system.js';
import { runTests } from './test-runner.js';
import { storeMemory } from './vector-memory.js';
import { createJob, updateJob, incrementRetries } from './job-store.js';
import {
  updateStep,
  getRunnableSteps,
  getWorkflowStatus,
  isWorkflowTimedOut,
  cancelWorkflow,
  flagForReview,
} from './workflow-store.js';
import { resolvePolicy, calcDelay, agentForAttempt } from './retry-policy.js';
import { needsApproval, approvalModeActive } from './approval-gate.js';
import { acquireSlot, clearSlots } from './concurrency.js';
import { DEFAULT_TENANT, assertTenantId } from './tenant.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const REPO_ROOT      = path.resolve(process.env.AEGIS_REPO_ROOT ?? process.cwd());
const WORKTREES_BASE = path.resolve(process.env.AEGIS_WORKTREES ?? path.join(REPO_ROOT, '.aegis-worktrees'));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function git(args, cwd = REPO_ROOT) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${(result.stderr ?? '').trim()}`);
  }
  return (result.stdout ?? '').trim();
}

/**
 * Return the absolute path of a tenant's base worktree, or null when the
 * worktrees directory does not exist yet (first workflow run).
 */
export function worktreeDir(tenantId) {
  const dir = path.join(WORKTREES_BASE, tenantId);
  return fs.existsSync(dir) ? dir : null;
}

// ─── Per-workflow branch ──────────────────────────────────────────────────────

/**
 * Ensure the per-workflow branch + worktree exist and return the cwd together
 * with a held lock.  The lock prevents two steps of the same workflow from
 * writing concurrently.
 *
 * Branch name:   aegis/<tenantId>/<workflowId>
 * Worktree path: <WORKTREES_BASE>/<tenantId>/<workflowId>
 */
export async function ensureWorkflowBranch(workflowId, tenantId) {
  const branch   = `aegis/${tenantId}/${workflowId}`;
  const cwd      = path.join(WORKTREES_BASE, tenantId, workflowId);
  const lockName = `worktree:${workflowId}`;

  const lock = await acquireLock(lockName, tenantId);

  try {
    if (!fs.existsSync(cwd)) {
      // Create the base worktree directory for the tenant if needed
      fs.mkdirSync(path.join(WORKTREES_BASE, tenantId), { recursive: true });

      // Create an isolated worktree on a new branch tracking tenant base
      const baseBranch = `aegis-tenant/${tenantId}`;
      const baseExists = spawnSync('git', ['rev-parse', '--verify', baseBranch], {
        cwd: REPO_ROOT, encoding: 'utf-8',
      }).status === 0;

      if (baseExists) {
        git(['worktree', 'add', '-b', branch, cwd, baseBranch]);
      } else {
        // First workflow for this tenant — branch from HEAD
        git(['worktree', 'add', '-b', branch, cwd, 'HEAD']);
      }
    }
  } catch (err) {
    await releaseLock(lock);
    throw err;
  }

  return { cwd, lock };
}

// ─── Commit / rollback ────────────────────────────────────────────────────────

/**
 * Stage all changes in `cwd` and create a commit with the given message.
 * Always use the canonical format "Aegis: <stepId>".
 */
export function commitChanges(message, cwd) {
  git(['add', '-A'], cwd);
  git(['commit', '--allow-empty', '-m', message], cwd);
}

/**
 * Undo the most recent commit in the worktree (test-failure rollback path).
 * Working-tree changes are discarded; the branch tip moves back one commit.
 */
export function rollbackLastCommit(cwd) {
  git(['reset', '--hard', 'HEAD~1'], cwd);
}

// ─── Step revert ──────────────────────────────────────────────────────────────

/**
 * Find the commit created for `stepId` (message "Aegis: <stepId>") and revert
 * it via `git revert --no-edit`.  The revert itself becomes a new commit whose
 * hash is returned so the caller can record it.
 *
 * Throws when:
 *   • no commit with the expected message exists in the worktree history
 *   • `git revert` exits non-zero (e.g. merge conflict)
 *
 * @param {string} workflowId  – used only for error messages
 * @param {string} stepId      – the step whose commit should be reverted
 * @param {string} cwd         – absolute path of the workflow worktree
 * @returns {{ commitHash: string }}
 */
export function revertStepCommit(workflowId, stepId, cwd) {
  const expectedMessage = `Aegis: ${stepId}`;

  // Walk the log looking for the commit that carries this step's message.
  // --fixed-strings avoids regex interpretation of stepId characters.
  const found = git(
    ['log', '--fixed-strings', `--grep=${expectedMessage}`, '--format=%H', '-1'],
    cwd,
  );

  if (!found) {
    throw new Error(
      `No commit found for step "${stepId}" in workflow "${workflowId}". ` +
      `Expected a commit with message "${expectedMessage}".`,
    );
  }

  const targetHash = found.trim();

  // Revert the commit non-interactively; this creates a new "Revert …" commit.
  git(['revert', '--no-edit', targetHash], cwd);

  // Return the hash of the newly created revert commit (HEAD after the revert).
  const commitHash = git(['rev-parse', 'HEAD'], cwd);

  return { commitHash };
}

// ─── Finalise / cleanup ───────────────────────────────────────────────────────

/**
 * Merge the workflow branch into the tenant base branch.
 * Acquires the tenant-level lock to serialise concurrent merges.
 *
 * @returns {{ merged: boolean, conflicts: string[] }}
 */
export async function finaliseWorkflow(workflowId, tenantId) {
  const branch     = `aegis/${tenantId}/${workflowId}`;
  const baseBranch = `aegis-tenant/${tenantId}`;
  const lockName   = `tenant-merge:${tenantId}`;

  const lock = await acquireLock(lockName, tenantId);

  try {
    // Ensure the base branch exists (create it on first workflow for this tenant)
    const baseExists = spawnSync('git', ['rev-parse', '--verify', baseBranch], {
      cwd: REPO_ROOT, encoding: 'utf-8',
    }).status === 0;

    if (!baseExists) {
      git(['branch', baseBranch, 'HEAD']);
    }

    // Merge the workflow branch; --no-ff preserves history
    try {
      execFileSync('git', ['merge', '--no-ff', '-m', `Aegis merge: ${workflowId}`, branch], {
        cwd: REPO_ROOT, encoding: 'utf-8',
      });
    } catch {
      // Collect conflicting files and abort
      const conflicts = git(['diff', '--name-only', '--diff-filter=U'], REPO_ROOT)
        .split('\n').filter(Boolean);
      git(['merge', '--abort'], REPO_ROOT);
      return { merged: false, conflicts };
    }

    return { merged: true, conflicts: [] };
  } finally {
    await releaseLock(lock);
  }
}

/**
 * Remove the per-workflow worktree and delete the workflow branch.
 * Best-effort — does not throw on failure.
 */
export async function removeWorkflowWorktree(workflowId, tenantId) {
  const worktreePath = path.join(WORKTREES_BASE, tenantId, workflowId);
  const branch       = `aegis/${tenantId}/${workflowId}`;

  try {
    git(['worktree', 'remove', '--force', worktreePath]);
  } catch { /* already removed or never created */ }

  try {
    git(['branch', '-D', branch]);
  } catch { /* branch may already be deleted */ }
}

// ─── Worker factory ───────────────────────────────────────────────────────────
//
// BullMQ workers bind to a single named queue at construction time.
// Since each tenant gets its own queue ("aegis-tasks:{tenantId}"), we must
// spawn one Worker instance per tenant rather than one global worker on the
// bare "aegis-tasks" queue (which no tenant ever writes to).
//
// Workers are created lazily on first job and cached for the process lifetime.
// In a horizontally-scaled deployment every worker process subscribes to the
// same set of queues, so any process can pick up any tenant's jobs.

const connection = new IORedis();

const PAUSE_POLL_INTERVAL = 3000;
const PAUSE_POLL_MAX_WAIT = 10 * 60 * 1000;

async function waitIfPaused(workflowId) {
  let waited = 0;
  while (true) {
    const status = await getWorkflowStatus(workflowId);
    if (status !== 'paused') return status !== 'cancelled';
    if (waited >= PAUSE_POLL_MAX_WAIT) return false;
    await new Promise(r => setTimeout(r, PAUSE_POLL_INTERVAL));
    waited += PAUSE_POLL_INTERVAL;
  }
}

const _workers = new Map();

export function getWorker(tenantId) {
  assertTenantId(tenantId);
  if (_workers.has(tenantId)) return _workers.get(tenantId);

  const queueName = `aegis-tasks:${tenantId}`;

  const worker = new Worker(
    queueName,
    async (job) => {
      const { step, workflowId, tenantId: jobTenantId } = job.data;

      // tenantId in job.data is the authoritative source — it was set by
      // addStep() in queue.js and survives queue serialisation unchanged.
      const tenant = jobTenantId ?? tenantId;

      // ─── Control check #1: entry gate ──────────────────────────────────────
      const entryStatus = await getWorkflowStatus(workflowId);

      if (entryStatus === 'cancelled') {
        removeWorkflowWorktree(workflowId, tenant).catch(() => {});
        return { skipped: true, reason: 'workflow cancelled' };
      }

      if (entryStatus === 'paused') {
        const shouldContinue = await waitIfPaused(workflowId);
        if (!shouldContinue) {
          removeWorkflowWorktree(workflowId, tenant).catch(() => {});
          return { skipped: true, reason: 'workflow cancelled during pause' };
        }
      }

      if (await isWorkflowTimedOut(workflowId)) {
        await cancelWorkflow(workflowId, 'timeout');
        removeWorkflowWorktree(workflowId, tenant).catch(() => {});
        throw new Error(`Workflow ${workflowId} exceeded configured timeout`);
      }

      // ─── Concurrency gate ───────────────────────────────────────────────────
      const priority = job.opts?.priority ?? 5;
      const slot = await acquireSlot(workflowId, job.id, priority);

      try {
        await updateStep(workflowId, step.id, 'running');

        await recordStart(job.id);
        await createJob(job.id, step, tenant);
        await updateJob(job.id, { status: 'running' }, tenant);
        await startSpan(workflowId, step.id, step.description ?? step.id, 'pending');

        const policy = resolvePolicy(step);

        let attempt   = 0;
        let success   = false;
        let lastError = '';
        let lastPatch = '';

        while (attempt < policy.maxAttempts && !success) {
          attempt++;

          const delay = calcDelay(policy, attempt);
          if (delay > 0) await new Promise(r => setTimeout(r, delay));

          // ─── Control check #2: per-retry gate ────────────────────────────
          const loopStatus = await getWorkflowStatus(workflowId);

          if (loopStatus === 'cancelled') {
            await updateStep(workflowId, step.id, 'failed');
            removeWorkflowWorktree(workflowId, tenant).catch(() => {});
            return { skipped: true, reason: 'workflow cancelled mid-retry' };
          }

          if (loopStatus === 'paused') {
            const shouldContinue = await waitIfPaused(workflowId);
            if (!shouldContinue) {
              await updateStep(workflowId, step.id, 'failed');
              removeWorkflowWorktree(workflowId, tenant).catch(() => {});
              return { skipped: true, reason: 'workflow cancelled during pause' };
            }
          }

          if (await isWorkflowTimedOut(workflowId)) {
            await cancelWorkflow(workflowId, 'timeout');
            await updateStep(workflowId, step.id, 'failed');
            removeWorkflowWorktree(workflowId, tenant).catch(() => {});
            throw new Error(`Workflow ${workflowId} timed out during retry ${attempt}`);
          }

          await incrementRetries(job.id, tenant);
          await recordRetry();

          const activeAgent = agentForAttempt(step, policy, attempt);
          await recordStepStart(step.id, activeAgent);
          await startSpan(workflowId, step.id, step.description ?? step.id, activeAgent);

          const agentContext = {
            files: step.files ?? [],
            error: attempt > 1 ? lastError : undefined,
            patch: attempt > 1 ? lastPatch  : undefined,
          };

          const taskDescription =
            attempt === 1
              ? step.description
              : `Fix this error (attempt ${attempt}, agent: ${activeAgent}):\n${lastError}`;

          const result = await runAgent(
            activeAgent,
            taskDescription,
            agentContext,
            tenant
          );

          if (!result.includes('PATCH:')) {
            await recordFailure(job.id);
            await updateJob(job.id, { status: 'failed', result: 'No patch generated' }, tenant);
            await updateStep(workflowId, step.id, 'failed');
            throw new Error('No patch generated');
          }

          const patch = result.split('PATCH:')[1].trim();
          lastPatch = patch;
          await attachPatch(workflowId, step.id, patch);

          const { file, content } = parsePatch(patch);
          const opId = getOperationId(workflowId, step.id, patch);

          const fileLock = await acquireLock(file, tenant);

          let worktreeLock = null;
          let cwd = null;

          try {
            ({ cwd, lock: worktreeLock } = await ensureWorkflowBranch(workflowId, tenant));

            const review = runReviewPipeline(patch, cwd, file);
            if (!review.ok) {
              await recordFailure(job.id);
              await updateJob(job.id, { status: 'failed', result: review.message }, tenant);
              await updateStep(workflowId, step.id, 'failed');
              throw new Error('System review failed');
            }

            const aiReview = await runAgent('review-guard', patch, { patch }, tenant);
            if (!aiReview.includes('APPROVED')) {
              await recordFailure(job.id);
              await updateJob(job.id, { status: 'failed', result: 'AI review rejected' }, tenant);
              await updateStep(workflowId, step.id, 'failed');
              throw new Error('AI review rejected');
            }

            if (await isApplied(opId, tenant)) {
              await updateJob(job.id, { status: 'completed', result: 'skipped (already applied)' }, tenant);
              await recordSuccess(job.id);
              await updateStep(workflowId, step.id, 'completed');
              success = true;
              try { await worktreeLock.release(); } catch { /* best-effort */ }
              worktreeLock = null;
              await releaseLock(fileLock);
              break;
            }

            // ─── Approval gate ────────────────────────────────────────────────
            const gate = needsApproval(step);
            if (gate) {
              await flagForReview(workflowId, step.id, {
                ...gate,
                patch,
                agent      : activeAgent,
                description: step.description,
                flaggedAt  : Date.now(),
              });
              await updateStep(workflowId, step.id, 'needs-review');
              await updateJob(job.id, { status: 'needs-review', result: gate.reason }, tenant);
              try { await worktreeLock.release(); } catch { /* best-effort */ }
              worktreeLock = null;
              return { awaitingApproval: true, reason: gate.reason };
            }

            applyPatch(file, content, cwd);
            commitChanges(`Aegis: ${step.id}`, cwd);

            const testResult = runTests(cwd, [file]);
            await attachTestResult(workflowId, step.id, { success: testResult.success, output: testResult.output });

            if (testResult.success) {
              success = true;

              await storeMemory(step.description, patch, tenant);
              await markApplied(opId, tenant);

              await updateJob(job.id, { status: 'completed', result: 'success' }, tenant);
              await recordSuccess(job.id);
              await recordStepEnd(step.id, 'success');
              await endSpan(workflowId, step.id, 'success');

              await updateStep(workflowId, step.id, 'completed');

              const nextSteps = await getRunnableSteps(workflowId);
              for (const next of nextSteps) {
                await addStep(workflowId, next, job.opts?.priority ?? 5, tenant);
              }

              if (nextSteps.length === 0) {
                try { await worktreeLock.release(); } catch { /* best-effort */ }
                worktreeLock = null;

                const mergeResult = await finaliseWorkflow(workflowId, tenant);

                if (!mergeResult.merged) {
                  await flagForReview(workflowId, 'merge', {
                    reason: 'merge-conflict',
                    description: 'Workflow completed but could not be merged into the tenant base branch due to conflicts with a concurrent workflow.',
                    conflicts: mergeResult.conflicts,
                    branch: `aegis/${tenant}/${workflowId}`,
                    baseBranch: `aegis-tenant/${tenant}`,
                    flaggedAt: Date.now(),
                  });
                  await updateStep(workflowId, step.id, 'needs-review');
                  await updateJob(job.id, {
                    status: 'needs-review',
                    result: `Merge conflicts: ${mergeResult.conflicts.join(', ')}`,
                  }, tenant);
                }
              }

            } else {
              lastError = testResult.output;
              rollbackLastCommit(cwd);
            }

          } finally {
            if (worktreeLock) {
              try { await worktreeLock.release(); } catch { /* best-effort */ }
            }
            await releaseLock(fileLock);
          }
        } // end while

        if (!success) {
          await recordFailure(job.id);
          await recordStepEnd(step.id, 'failure');
          await endSpan(workflowId, step.id, 'failure');

          await updateJob(job.id, { status: 'failed', result: lastError }, tenant);
          await updateStep(workflowId, step.id, 'failed');

          const dlq = getDeadLetterQueue(tenant);
          await dlq.add('failed-step', {
            originalJobId: job.id,
            workflowId,
            step,
            error: lastError,
            attemptsExhausted: attempt,
            policy
          });

          throw new Error('Step failed after retries');
        }

        return { success: true };

      } finally {
        await slot.release();
      }
    },
    { connection }
  );

  worker.on('failed', async (job, err) => {
    const tenant = job?.data?.tenantId ?? tenantId;
    const dlq = getDeadLetterQueue(tenant);
    await dlq.add('failed-step', {
      originalJobId: job.id,
      workflowId: job.data.workflowId,
      step: job.data.step,
      error: err.message,
      attemptsExhausted: job.attemptsMade,
      policy: job.data.step ? resolvePolicy(job.data.step) : null
    });
  });

  _workers.set(tenantId, worker);
  return worker;
}
