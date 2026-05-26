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
import { taskQueue } from '../engine/queue.js';
import IORedis from 'ioredis';

const connection = new IORedis();

// How long to wait (ms) while polling a paused workflow before giving up
const PAUSE_POLL_INTERVAL = 3000;
const PAUSE_POLL_MAX_WAIT = 10 * 60 * 1000; // 10 minutes

/**
 * Block until workflow is no longer paused, or until max wait exceeded.
 * Returns false if we should abort (cancelled or timed out during wait).
 */
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

    // ─── Timeout check at entry ───────────────────────────────────────────────
    if (await isWorkflowTimedOut(workflowId)) {
      await cancelWorkflow(workflowId, 'timeout');
      throw new Error(`Workflow ${workflowId} exceeded configured timeout`);
    }

    // ✅ mark step running
    await updateStep(workflowId, step.id, 'running');

    recordStart(job.id);
    updateJob(job.id, { status: 'running' });

    // ── open trace span (traceId = workflowId, spanId = stepId) ──────────
    startSpan(workflowId, step.id, step.description ?? step.id, 'pending');

    // ─── Resolve per-step retry policy ───────────────────────────────────────
    const policy = resolvePolicy(step);

    let attempt = 0;
    let success = false;
    let lastError = '';

    while (attempt < policy.maxAttempts && !success) {
      attempt++;

      // ─── Backoff delay before retry (no delay on first attempt) ──────────
      const delay = calcDelay(policy, attempt);
      if (delay > 0) await new Promise(r => setTimeout(r, delay));

      // ─── Control check #2: per-retry gate ──────────────────────────────────
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

      // ─── Timeout check per retry ──────────────────────────────────────────
      if (await isWorkflowTimedOut(workflowId)) {
        await cancelWorkflow(workflowId, 'timeout');
        await updateStep(workflowId, step.id, 'failed');
        throw new Error(`Workflow ${workflowId} timed out during retry ${attempt}`);
      }

      incrementRetries(job.id);
      recordRetry();

      // ─── Agent selection via escalation ladder ────────────────────────────
      const activeAgent = agentForAttempt(step, policy, attempt);

      // ── update span + step-level metric with the active agent ────────────
      recordStepStart(step.id, activeAgent);
      startSpan(workflowId, step.id, step.description ?? step.id, activeAgent);

      // 🔍 memory retrieval
      const similar = await searchMemory(
        attempt === 1 ? step.description : lastError
      );

      const memoryContext = similar
        .map(s => `Past Fix:\n${s.text}\nPatch:\n${s.patch}`)
        .join('\n\n');

      const result = await runAgent(
        activeAgent,
        attempt === 1
          ? `${step.description}\n\nRelevant fixes:\n${memoryContext}`
          : `Fix this error (attempt ${attempt}, agent: ${activeAgent}):\n${lastError}\n\nRelevant fixes:\n${memoryContext}`,
        {}
      );

      // ❌ no patch
      if (!result.includes('PATCH:')) {
        recordFailure(job.id);

        updateJob(job.id, {
          status: 'failed',
          result: 'No patch generated'
        });

        await updateStep(workflowId, step.id, 'failed');

        throw new Error('No patch generated');
      }

      const patch = result.split('PATCH:')[1].trim();

      // ── attach patch to trace span ────────────────────────────────────────
      attachPatch(workflowId, step.id, patch);

      // ✅ system review
      const review = runReviewPipeline(patch);
      if (!review.ok) {
        recordFailure(job.id);

        updateJob(job.id, {
          status: 'failed',
          result: review.message
        });

        await updateStep(workflowId, step.id, 'failed');

        throw new Error('System review failed');
      }

      // ✅ AI review
      const aiReview = await runAgent('review-guard', patch, {});
      if (!aiReview.includes('APPROVED')) {
        recordFailure(job.id);

        updateJob(job.id, {
          status: 'failed',
          result: 'AI review rejected'
        });

        await updateStep(workflowId, step.id, 'failed');

        throw new Error('AI review rejected');
      }

      const { file, content } = parsePatch(patch);

      // 🧠 idempotency key
      const opId = getOperationId(workflowId, step.id, patch);

      // 🔁 skip if already applied
      if (await isApplied(opId)) {
        updateJob(job.id, {
          status: 'completed',
          result: 'skipped (already applied)'
        });

        recordSuccess(job.id);
        await updateStep(workflowId, step.id, 'completed');

        success = true;
        break;
      }

      // 🔒 distributed lock
      const lock = await acquireLock(file);

      try {
        // 🌿 ensure workflow branch (CRITICAL)
        ensureWorkflowBranch(workflowId);

        // apply patch
        applyPatch(file, content);

        // commit change
        commitChanges(`Aegis: ${step.id}`);

        // run tests
        const testResult = runTests();

        // ── attach test result to trace span ──────────────────────────────
        attachTestResult(workflowId, step.id, { success: testResult.success, output: testResult.output });

        if (testResult.success) {
          success = true;

          await storeMemory(step.description, patch);

          // ✅ idempotency mark
          await markApplied(opId);

          updateJob(job.id, {
            status: 'completed',
            result: 'success'
          });

          recordSuccess(job.id);
          recordStepEnd(step.id, 'success');
          endSpan(workflowId, step.id, 'success');

          // ✅ mark step completed
          await updateStep(workflowId, step.id, 'completed');

          // 🚀 DAG progression — inherit workflow priority
          const nextSteps = await getRunnableSteps(workflowId);

          for (const next of nextSteps) {
            await addStep(workflowId, next, job.opts.priority ?? 5);
          }

        } else {
          lastError = testResult.output;

          // 🔁 rollback ONLY last commit (safe)
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

      updateJob(job.id, {
        status: 'failed',
        result: lastError
      });

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
  },
  { connection }
);

// ✅ queue-level failure safety — catches throws that bypass the inner handler
worker.on('failed', async (job, err) => {
  await deadLetterQueue.add('failed-step', {
    originalJobId: job.id,
    workflowId: job.data.workflowId,
    step: job.data.step,
    error: err.message,
    attemptsExhausted: job.attemptsMade,
    policy: job.data.step ? resolvePolicy(job.data.step) : null
  });
});