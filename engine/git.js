import { Worker } from 'bullmq';
import { acquireLock, releaseLock } from '../engine/lock.js';
import { applyPatch, parsePatch } from '../engine/code-writer.js';
import { getTaskQueue, getDeadLetterQueue, addStep } from '../engine/queue.js';
import {
  ensureWorkflowBranch,
  commitChanges,
  rollbackLastCommit,
  finaliseWorkflow,
  removeWorkflowWorktree,   // NEW: clean up worktree on cancellation
} from '../engine/git.js';
import { getOperationId, isApplied, markApplied } from '../engine/idempotency.js';
import { recordStart, recordRetry, recordSuccess, recordFailure, recordStepStart, recordStepEnd } from '../engine/metrics.js';
import { startSpan, attachPatch, attachTestResult, endSpan } from '../engine/tracer.js';
import { runAgent } from '../engine/agent-runner.js';
import { runReviewPipeline } from '../engine/review-system.js';
import { runTests } from '../engine/test-runner.js';
import { storeMemory } from '../engine/vector-memory.js';
import { createJob, updateJob, incrementRetries } from '../engine/job-store.js';
import {
  updateStep,
  getRunnableSteps,
  getWorkflowStatus,
  isWorkflowTimedOut,
  cancelWorkflow,
  flagForReview,
} from '../engine/workflow-store.js';
import { resolvePolicy, calcDelay, agentForAttempt } from '../engine/retry-policy.js';
import { needsApproval, approvalModeActive }         from '../engine/approval-gate.js';
import { acquireSlot, clearSlots } from '../engine/concurrency.js';
import { DEFAULT_TENANT, assertTenantId } from '../engine/tenant.js';
import IORedis from 'ioredis';

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

// ─── Per-tenant worker factory ────────────────────────────────────────────────
// BullMQ workers bind to a single named queue at construction time.
// Since each tenant gets its own queue ("aegis-tasks:{tenantId}"), we must
// spawn one Worker instance per tenant rather than one global worker on the
// bare "aegis-tasks" queue (which no tenant ever writes to).
//
// Workers are created lazily on first job and cached for the process lifetime.
// In a horizontally-scaled deployment every worker process subscribes to the
// same set of queues, so any process can pick up any tenant's jobs.

const _workers = new Map();

function getWorker(tenantId) {
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
        // Clean up the per-workflow worktree if it exists. Best-effort — the
        // workflow may not have reached the git layer yet.
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
        // ✅ mark step running — inside slot so count is accurate
        await updateStep(workflowId, step.id, 'running');

        await recordStart(job.id);
        // Create the job record first so getJob() and GET /jobs return a result
        // immediately — before any status transition fires.
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

          // 🔍 Structured context — agent-runner handles memory lookup internally
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

          // Parse the patch to extract file + content early — needed for the
          // scoped review pipeline and for acquireLock below.
          const { file, content } = parsePatch(patch);
          const opId = getOperationId(workflowId, step.id, patch);

          // acquireLock guards file-level writes across workflows that might
          // touch the same file path within the same tenant.
          // ensureWorkflowBranch creates the per-workflow worktree (once) and
          // then acquires the per-workflow lock for the apply+commit window.
          // Different workflows never contend on each other's lock.
          const fileLock = await acquireLock(file, tenant);

          // worktreeLock is released inside the finally block below.
          // Declared outside the inner try so rollback can also use cwd.
          let worktreeLock = null;
          let cwd = null;

          try {
            ({ cwd, lock: worktreeLock } = await ensureWorkflowBranch(workflowId, tenant));

            // Run the structural + lint + baseline-test review pipeline now that
            // cwd is known. Lint and the baseline test execute inside the
            // per-workflow worktree (cwd), fully isolated from other workflows.
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

            // —— Approval gate ————————————————————
            // When MODE=approval or CLAUDE_AUTONOMY=false the patch has passed
            // all automated checks but still needs a human sign-off before it
            // is written to disk. Flag the step for review and return early.
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

            // FIX: pass cwd to applyPatch so the write lands in the
            // per-workflow worktree, not PROJECT_ROOT (the default fallback).
            applyPatch(file, content, cwd);
            commitChanges(`Aegis: ${step.id}`, cwd);

            // Run tests inside the per-workflow worktree, scoped to the changed
            // file. Concurrent workflows use different cwd values and never
            // share a test run.
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

              // 🚀 DAG progression — next steps inherit priority and tenant
              const nextSteps = await getRunnableSteps(workflowId);
              for (const next of nextSteps) {
                await addStep(workflowId, next, job.opts?.priority ?? 5, tenant);
              }

              // When no more steps remain the workflow is complete —
              // merge the workflow branch into the tenant base branch.
              // finaliseWorkflow acquires the tenant lock internally, so we
              // release our per-workflow lock first to avoid ordering issues.
              if (nextSteps.length === 0) {
                try { await worktreeLock.release(); } catch { /* best-effort */ }
                worktreeLock = null;

                const mergeResult = await finaliseWorkflow(workflowId, tenant);

                if (!mergeResult.merged) {
                  // Merge conflicts detected — the workflow branch is left intact
                  // so a human can inspect or manually resolve. Flag for review.
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
        // ─── Always release the concurrency slot ──────────────────────────
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

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const TENANTS = (process.env.AEGIS_TENANTS ?? DEFAULT_TENANT)
  .split(',')
  .map(t => t.trim())
  .filter(Boolean);

for (const tenant of TENANTS) {
  getWorker(tenant);
  console.log(`[agent-worker] Listening on aegis-tasks:${tenant}`);
}

if (approvalModeActive) {
  console.log('[agent-worker] Approval gate ACTIVE — patches will be held for human review before apply');
}

export { getWorker };
