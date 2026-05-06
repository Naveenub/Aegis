import { acquireLock, releaseLock } from '../engine/lock.js';
import { applyPatch, parsePatch } from '../engine/code-writer.js';
import { deadLetterQueue } from '../engine/queue.js';
import { ensureWorkflowBranch, commitChanges, rollbackLastCommit } from '../engine/git.js';
import { getOperationId, isApplied, markApplied } from '../engine/idempotency.js';
import { recordStart, recordRetry, recordSuccess, recordFailure } from '../engine/metrics.js';
import { runAgent } from '../engine/agent-runner.js';
import { runReviewPipeline } from '../engine/review-system.js';
import { runTests } from '../engine/test-runner.js';
import { storeMemory, searchMemory } from '../engine/vector-memory.js';
import { updateJob, incrementRetries } from '../engine/job-store.js';
import { updateStep, getRunnableSteps } from '../engine/workflow-store.js';
import { taskQueue } from '../engine/queue.js';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis();

const worker = new Worker(
  'aegis-tasks',
  async (job) => {
    const { step, workflowId } = job.data;

    // ✅ mark step running (await REQUIRED)
    await updateStep(workflowId, step.id, 'running');

    recordStart(job.id);
    updateJob(job.id, { status: 'running' });

    let attempt = 0;
    let success = false;
    let lastError = '';

    while (attempt < 3 && !success) {
      attempt++;

      incrementRetries(job.id);
      recordRetry();

      // 🔍 memory retrieval
      const similar = await searchMemory(
        attempt === 1 ? step.description : lastError
      );

      const memoryContext = similar
        .map(s => `Past Fix:\n${s.text}\nPatch:\n${s.patch}`)
        .join('\n\n');

      const result = await runAgent(
        attempt === 1 ? step.agent : 'debugger',
        attempt === 1
          ? `${step.description}\n\nRelevant fixes:\n${memoryContext}`
          : `${lastError}\n\nRelevant fixes:\n${memoryContext}`,
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

          // ✅ mark step completed
          await updateStep(workflowId, step.id, 'completed');

          // 🚀 DAG progression
          const nextSteps = await getRunnableSteps(workflowId);

          for (const next of nextSteps) {
            await taskQueue.add('step', {
              workflowId,
              step: next
            });
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

      updateJob(job.id, {
        status: 'failed',
        result: lastError
      });

      await updateStep(workflowId, step.id, 'failed');

      await deadLetterQueue.add('failed-step', {
        originalJobId: job.id,
        step,
        error: lastError
      });

      throw new Error('Step failed after retries');
    }

    return { success: true };
  },
  { connection }
);

// ✅ queue-level failure safety
worker.on('failed', async (job, err) => {
  await deadLetterQueue.add('failed-step', {
    originalJobId: job.id,
    step: job.data.step,
    error: err.message
  });
});
