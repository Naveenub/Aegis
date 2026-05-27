import { Worker } from 'bullmq';
import { acquireLock, releaseLock } from '../engine/lock.js';
import { applyPatch, parsePatch } from '../engine/code-writer.js';
import { deadLetterQueue, addStep } from '../engine/queue.js';
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

const worker = new Worker(
  'aegis-tasks',
  async (job) => {
    const { step, workflowId } = job.data;

    // ─── Control check #1: entry gate ────────────────────────────────────────
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

    // ─── Concurrency gate ─────────────────────────────────────────────────────
    // Acquire a per-workflow semaphore slot before touching any shared resource.
    // Priority is inherited from the BullMQ job so CRITICAL workflows get more
    // concurrent slots than NORMAL/LOW ones (see engine/concurrency.js).
    const priority = job.opts?.priority ?? 5;
    const slot = await acquireSlot(workflowId, job.id, priority);

    try {
      // ✅ mark step running — inside slot so count is accurate
      await updateStep(workflowId, step.id, 'running');

      recordStart(job.id);
      updateJob(job.id, { status: 'running' });
      startSpan(workflowId, step.id, step.description ?? step.id, 'pending');

      const policy = resolvePolicy(step);

      let attempt   = 0;
      let success   = false;
      let lastError = '';
      let lastPatch = '';

      while (attempt < policy.maxAttempts && !success) {
        attempt++;

        const delay = calcDelay(policy, attempt);
        if (delay > 0) await new Promise(r => setTimeout(r, delay));

        // ─── Control check #2: per-retry gate ────────────────────────────────
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
        recordRetry();

        const activeAgent = agentForAttempt(step, policy, attempt);
        recordStepStart(step.id, activeAgent);
        startSpan(workflowId, step.id, step.description ?? step.id, activeAgent);

        // 🔍 Structured context — agent-runner handles memory lookup internally
        const agentContext = {
          files: step.files ?? [],          // file paths relevant to this step
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
          agentContext
        );

        if (!result.includes('PATCH:')) {
          recordFailure(job.id);
          updateJob(job.id, { status: 'failed', result: 'No patch generated' });
          await updateStep(workflowId, step.id, 'failed');
          throw new Error('No patch generated');
        }

        const patch = result.split('PATCH:')[1].trim();
        lastPatch = patch;
        attachPatch(workflowId, step.id, patch);

        const review = runReviewPipeline(patch);
        if (!review.ok) {
          recordFailure(job.id);
          updateJob(job.id, { status: 'failed', result: review.message });
          await updateStep(workflowId, step.id, 'failed');
          throw new Error('System review failed');
        }

        const aiReview = await runAgent('review-guard', patch, { patch });
        if (!aiReview.includes('APPROVED')) {
          recordFailure(job.id);
          updateJob(job.id, { status: 'failed', result: 'AI review rejected' });
          await updateStep(workflowId, step.id, 'failed');
          throw new Error('AI review rejected');
        }

        const { file, content } = parsePatch(patch);
        const opId = getOperationId(workflowId, step.id, patch);

        if (await isApplied(opId)) {
          updateJob(job.id, { status: 'completed', result: 'skipped (already applied)' });
          recordSuccess(job.id);
          await updateStep(workflowId, step.id, 'completed');
          success = true;
          break;
        }

        const lock = await acquireLock(file);

        try {
          ensureWorkflowBranch(workflowId);
          applyPatch(file, content);
          commitChanges(`Aegis: ${step.id}`);

          const testResult = runTests();
          attachTestResult(workflowId, step.id, { success: testResult.success, output: testResult.output });

          if (testResult.success) {
            success = true;

            await storeMemory(step.description, patch);
            await markApplied(opId);

            updateJob(job.id, { status: 'completed', result: 'success' });
            recordSuccess(job.id);
            recordStepEnd(step.id, 'success');
            endSpan(workflowId, step.id, 'success');

            await updateStep(workflowId, step.id, 'completed');

            // 🚀 DAG progression — next steps also inherit priority
            const nextSteps = await getRunnableSteps(workflowId);
            for (const next of nextSteps) {
              await addStep(workflowId, next, job.opts?.priority ?? 5);
            }

          } else {
            lastError = testResult.output;
            rollbackLastCommit();
          }

        } finally {
          await releaseLock(lock);
        }
      } // end while

      if (!success) {
        recordFailure(job.id);
        recordStepEnd(step.id, 'failure');
        endSpan(workflowId, step.id, 'failure');

        updateJob(job.id, { status: 'failed', result: lastError });
        await updateStep(workflowId, step.id, 'failed');

        await deadLetterQueue.add('failed-step', {
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
      // ─── Always release the concurrency slot ─────────────────────────────
      // This runs whether the step succeeded, failed, or threw — ensuring
      // the semaphore never leaks even on unexpected errors.
      await slot.release();
    }
  },
  { connection }
);

worker.on('failed', async (job, err) => {
  // Slot is released in the finally block above, so no slot cleanup needed here.
  // We do still need to push to DLQ for jobs that throw before entering the try.
  await deadLetterQueue.add('failed-step', {
    originalJobId: job.id,
    workflowId: job.data.workflowId,
    step: job.data.step,
    error: err.message,
    attemptsExhausted: job.attemptsMade,
    policy: job.data.step ? resolvePolicy(job.data.step) : null
  });
});