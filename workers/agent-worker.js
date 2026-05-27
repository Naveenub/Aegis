import { acquireLock, releaseLock } from '../engine/lock.js';
import { applyPatch, parsePatch } from '../engine/code-writer.js';
import { getDeadLetterQueue, addStep } from '../engine/queue.js';
import { ensureWorkflowBranch, commitChanges, rollbackLastCommit } from '../engine/git.js';
import { getOperationId, isApplied, markApplied } from '../engine/idempotency.js';
import { recordStart, recordRetry, recordSuccess, recordFailure, recordStepStart, recordStepEnd } from '../engine/metrics.js';
import { startSpan, attachPatch, attachTestResult, endSpan } from '../engine/tracer.js';
import { runAgent } from '../engine/agent-runner.js';
import { runReviewPipeline } from '../engine/review-system.js';
import { runTests } from '../engine/test-runner.js';
import { storeMemory, searchMemory } from '../engine/vector-memory.js';
import { updateJob, incrementRetries } from '../engine/job-store.js';
import {
  updateStep,
  getRunnableSteps,
  getWorkflowStatus,
  isWorkflowTimedOut,
  cancelWorkflow
} from '../engine/workflow-store.js';
import { resolvePolicy, calcDelay, agentForAttempt } from '../engine/retry-policy.js';
import { DEFAULT_TENANT, assertTenantId } from '../engine/tenant.js';
import IORedis from 'ioredis';
import { Worker } from 'bullmq';

const connection = new IORedis();

const PAUSE_POLL_INTERVAL = 3000;
const PAUSE_POLL_MAX_WAIT = 10 * 60 * 1000;

async function waitIfPaused(workflowId, tenantId) {
  let waited = 0;
  while (true) {
    const status = await getWorkflowStatus(workflowId, tenantId);
    if (status !== 'paused') return status !== 'cancelled';
    if (waited >= PAUSE_POLL_MAX_WAIT) return false;
    await new Promise(r => setTimeout(r, PAUSE_POLL_INTERVAL));
    waited += PAUSE_POLL_INTERVAL;
  }
}

/**
 * Build a worker for a specific tenant queue.
 * Called once per tenant that is active in this process.
 */
export function createTenantWorker(tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const queueName = `aegis-tasks:${tenantId}`;

  const worker = new Worker(
    queueName,
    async (job) => {
      // tenantId is embedded in the job payload — trust it, but validate
      const tid = assertTenantId(job.data.tenantId ?? tenantId);
      const { step, workflowId } = job.data;

      // ─── Control check #1: entry gate ──────────────────────────────────────
      const entryStatus = await getWorkflowStatus(workflowId, tid);

      if (entryStatus === 'cancelled') {
        return { skipped: true, reason: 'workflow cancelled' };
      }

      if (entryStatus === 'paused') {
        const shouldContinue = await waitIfPaused(workflowId, tid);
        if (!shouldContinue) return { skipped: true, reason: 'workflow cancelled during pause' };
      }

      if (await isWorkflowTimedOut(workflowId, tid)) {
        await cancelWorkflow(workflowId, 'timeout', tid);
        throw new Error(`Workflow ${workflowId} exceeded configured timeout`);
      }

      await updateStep(workflowId, step.id, 'running', tid);
      recordStart(job.id);
      updateJob(job.id, { status: 'running' }, tid);
      startSpan(workflowId, step.id, step.description ?? step.id, 'pending');

      const policy     = resolvePolicy(step);
      let attempt      = 0;
      let success      = false;
      let lastError    = '';

      while (attempt < policy.maxAttempts && !success) {
        attempt++;

        const delay = calcDelay(policy, attempt);
        if (delay > 0) await new Promise(r => setTimeout(r, delay));

        // ─── Control check #2: per-retry gate ────────────────────────────────
        const loopStatus = await getWorkflowStatus(workflowId, tid);

        if (loopStatus === 'cancelled') {
          await updateStep(workflowId, step.id, 'failed', tid);
          return { skipped: true, reason: 'workflow cancelled mid-retry' };
        }

        if (loopStatus === 'paused') {
          const shouldContinue = await waitIfPaused(workflowId, tid);
          if (!shouldContinue) {
            await updateStep(workflowId, step.id, 'failed', tid);
            return { skipped: true, reason: 'workflow cancelled during pause' };
          }
        }

        if (await isWorkflowTimedOut(workflowId, tid)) {
          await cancelWorkflow(workflowId, 'timeout', tid);
          await updateStep(workflowId, step.id, 'failed', tid);
          throw new Error(`Workflow ${workflowId} timed out during retry ${attempt}`);
        }

        incrementRetries(job.id, tid);
        recordRetry();

        const activeAgent = agentForAttempt(step, policy, attempt);
        recordStepStart(step.id, activeAgent);
        startSpan(workflowId, step.id, step.description ?? step.id, activeAgent);

        // 🔍 memory retrieval — tenant-scoped
        const similar = await searchMemory(
          attempt === 1 ? step.description : lastError,
          3,
          tid
        );

        const memoryContext = similar
          .map(s => `Past Fix:\n${s.text}\nPatch:\n${s.patch}`)
          .join('\n\n');

        const result = await runAgent(
          activeAgent,
          attempt === 1
            ? `${step.description}\n\nRelevant fixes:\n${memoryContext}`
            : `Fix this error (attempt ${attempt}, agent: ${activeAgent}):\n${lastError}\n\nRelevant fixes:\n${memoryContext}`,
          {},
          tid
        );

        if (!result.includes('PATCH:')) {
          recordFailure(job.id);
          updateJob(job.id, { status: 'failed', result: 'No patch generated' }, tid);
          await updateStep(workflowId, step.id, 'failed', tid);
          throw new Error('No patch generated');
        }

        const patch = result.split('PATCH:')[1].trim();
        attachPatch(workflowId, step.id, patch);

        const review = runReviewPipeline(patch);
        if (!review.ok) {
          recordFailure(job.id);
          updateJob(job.id, { status: 'failed', result: review.message }, tid);
          await updateStep(workflowId, step.id, 'failed', tid);
          throw new Error('System review failed');
        }

        const aiReview = await runAgent('review-guard', patch, {}, tid);
        if (!aiReview.includes('APPROVED')) {
          recordFailure(job.id);
          updateJob(job.id, { status: 'failed', result: 'AI review rejected' }, tid);
          await updateStep(workflowId, step.id, 'failed', tid);
          throw new Error('AI review rejected');
        }

        const { file, content } = parsePatch(patch);
        const opId = getOperationId(workflowId, step.id, patch);

        if (await isApplied(opId, tid)) {
          updateJob(job.id, { status: 'completed', result: 'skipped (already applied)' }, tid);
          recordSuccess(job.id);
          await updateStep(workflowId, step.id, 'completed', tid);
          success = true;
          break;
        }

        // 🔒 tenant-scoped distributed lock
        const lock = await acquireLock(file, tid);

        try {
          // 🌿 tenant-isolated worktree
          const { cwd } = ensureWorkflowBranch(workflowId, tid);

          applyPatch(file, content, cwd);
          commitChanges(`Aegis: ${step.id}`, cwd);

          const testResult = runTests(cwd);
          attachTestResult(workflowId, step.id, { success: testResult.success, output: testResult.output });

          if (testResult.success) {
            success = true;

            await storeMemory(step.description, patch, tid);
            await markApplied(opId, tid);

            updateJob(job.id, { status: 'completed', result: 'success' }, tid);
            recordSuccess(job.id);
            recordStepEnd(step.id, 'success');
            endSpan(workflowId, step.id, 'success');

            await updateStep(workflowId, step.id, 'completed', tid);

            const nextSteps = await getRunnableSteps(workflowId, tid);
            for (const next of nextSteps) {
              await addStep(workflowId, next, job.opts.priority ?? 5, tid);
            }

          } else {
            lastError = testResult.output;
            rollbackLastCommit(cwd);
          }

        } finally {
          await releaseLock(lock);
        }
      } // end while

      if (!success) {
        recordFailure(job.id);
        recordStepEnd(step.id, 'failure');
        endSpan(workflowId, step.id, 'failure');

        updateJob(job.id, { status: 'failed', result: lastError }, tid);
        await updateStep(workflowId, step.id, 'failed', tid);

        await getDeadLetterQueue(tid).add('failed-step', {
          originalJobId: job.id,
          workflowId,
          step,
          tenantId: tid,
          error: lastError,
          attemptsExhausted: attempt,
          policy
        });

        throw new Error('Step failed after retries');
      }

      return { success: true };
    },
    { connection }
  );

  worker.on('failed', async (job, err) => {
    const tid = job.data.tenantId ?? tenantId;
    await getDeadLetterQueue(tid).add('failed-step', {
      originalJobId: job.id,
      workflowId: job.data.workflowId,
      step: job.data.step,
      tenantId: tid,
      error: err.message,
      attemptsExhausted: job.attemptsMade,
      policy: job.data.step ? resolvePolicy(job.data.step) : null
    });
  });

  return worker;
}

// ── Default single-tenant worker (keeps existing single-tenant deploys working)
export default createTenantWorker(DEFAULT_TENANT);