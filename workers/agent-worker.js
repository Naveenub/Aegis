import { Worker } from 'bullmq';
import { acquireLock, releaseLock } from '../engine/lock.js';
import { applyPatch, parsePatch } from '../engine/code-writer.js';
import { getTaskQueue, getDeadLetterQueue, addStep } from '../engine/queue.js';
import { ensureWorkflowBranch, commitChanges, rollbackLastCommit } from '../engine/git.js';
import { getOperationId, isApplied, markApplied } from '../engine/idempotency.js';
import { recordStart, recordRetry, recordSuccess, recordFailure, recordStepStart, recordStepEnd } from '../engine/metrics.js';
import { startSpan, attachPatch, attachTestResult, endSpan } from '../engine/tracer.js';
import { runAgent } from '../engine/agent-runner.js';
import { runReviewPipeline } from '../engine/review-system.js';
import { runTests } from '../engine/test-runner.js';
import { storeMemory } from '../engine/vector-memory.js';
import { updateJob, incrementRetries } from '../engine/job-store.js';
import {
  updateStep,
  getRunnableSteps,
  getWorkflowStatus,
  isWorkflowTimedOut,
  cancelWorkflow
} from '../engine/workflow-store.js';
import { resolvePolicy, calcDelay, agentForAttempt } from '../engine/retry-policy.js';
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
        return { skipped: true, reason: 'workflow cancelled' };
      }

      if (entryStatus === 'paused') {
        const shouldContinue = await waitIfPaused(workflowId);
        if (!shouldContinue) return { skipped: true, reason: 'workflow cancelled during pause' };
      }

      if (await isWorkflowTimedOut(workflowId)) {
        await cancelWorkflow(workflowId, 'timeout');
        throw new Error(`Workflow ${workflowId} exceeded configured timeout`);
      }

      // ─── Concurrency gate ───────────────────────────────────────────────────
      const priority = job.opts?.priority ?? 5;
      const slot = await acquireSlot(workflowId, job.id, priority);

      try {
        // ✅ mark step running — inside slot so count is accurate
        await updateStep(workflowId, step.id, 'running');

        await recordStart(job.id);
        updateJob(job.id, { status: 'running' });
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
            return { skipped: true, reason: 'workflow cancelled mid-retry' };
          }

          if (loopStatus === 'paused') {
            const shouldContinue = await waitIfPaused(workflowId);
            if (!shouldContinue) {
              await updateStep(workflowId, step.id, 'failed');
              return { skipped: true, reason: 'workflow cancelled during pause' };
            }
          }

          if (await isWorkflowTimedOut(workflowId)) {
            await cancelWorkflow(workflowId, 'timeout');
            await updateStep(workflowId, step.id, 'failed');
            throw new Error(`Workflow ${workflowId} timed out during retry ${attempt}`);
          }

          incrementRetries(job.id);
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
            updateJob(job.id, { status: 'failed', result: 'No patch generated' });
            await updateStep(workflowId, step.id, 'failed');
            throw new Error('No patch generated');
          }

          const patch = result.split('PATCH:')[1].trim();
          lastPatch = patch;
          await attachPatch(workflowId, step.id, patch);

          const review = runReviewPipeline(patch);
          if (!review.ok) {
            await recordFailure(job.id);
            updateJob(job.id, { status: 'failed', result: review.message });
            await updateStep(workflowId, step.id, 'failed');
            throw new Error('System review failed');
          }

          const aiReview = await runAgent('review-guard', patch, { patch }, tenant);
          if (!aiReview.includes('APPROVED')) {
            await recordFailure(job.id);
            updateJob(job.id, { status: 'failed', result: 'AI review rejected' });
            await updateStep(workflowId, step.id, 'failed');
            throw new Error('AI review rejected');
          }

          const { file, content } = parsePatch(patch);
          const opId = getOperationId(workflowId, step.id, patch);

          if (await isApplied(opId, tenant)) {
            updateJob(job.id, { status: 'completed', result: 'skipped (already applied)' });
            await recordSuccess(job.id);
            await updateStep(workflowId, step.id, 'completed');
            success = true;
            break;
          }

          const lock = await acquireLock(file, tenant);

          try {
            ensureWorkflowBranch(workflowId, tenant);
            applyPatch(file, content);
            commitChanges(`Aegis: ${step.id}`);

            const testResult = runTests();
            await attachTestResult(workflowId, step.id, { success: testResult.success, output: testResult.output });

            if (testResult.success) {
              success = true;

              await storeMemory(step.description, patch, tenant);
              await markApplied(opId, tenant);

              updateJob(job.id, { status: 'completed', result: 'success' });
              await recordSuccess(job.id);
              await recordStepEnd(step.id, 'success');
              await endSpan(workflowId, step.id, 'success');

              await updateStep(workflowId, step.id, 'completed');

              // 🚀 DAG progression — next steps inherit priority and tenant
              const nextSteps = await getRunnableSteps(workflowId);
              for (const next of nextSteps) {
                await addStep(workflowId, next, job.opts?.priority ?? 5, tenant);
              }

            } else {
              lastError = testResult.output;
              const { cwd } = ensureWorkflowBranch(workflowId, tenant);
              rollbackLastCommit(cwd);
            }

          } finally {
            await releaseLock(lock);
          }
        } // end while

        if (!success) {
          await recordFailure(job.id);
          await recordStepEnd(step.id, 'failure');
          await endSpan(workflowId, step.id, 'failure');

          updateJob(job.id, { status: 'failed', result: lastError });
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
// Start a worker for every tenant listed in AEGIS_TENANTS (comma-separated).
// Defaults to the single "default" tenant for single-tenant deployments.
// Example: AEGIS_TENANTS=acme,org_xyz,staging
//
// Workers for new tenants can also be started at runtime by calling
// getWorker(tenantId) directly — e.g. from a tenant-registration webhook.

const TENANTS = (process.env.AEGIS_TENANTS ?? DEFAULT_TENANT)
  .split(',')
  .map(t => t.trim())
  .filter(Boolean);

for (const tenant of TENANTS) {
  getWorker(tenant);
  console.log(`[agent-worker] Listening on aegis-tasks:${tenant}`);
}

export { getWorker };
