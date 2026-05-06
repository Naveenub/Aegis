import { acquireLock, releaseLock } from '../engine/lock.js';
import { applyPatch, parsePatch } from '../engine/code-writer.js';
import { backupFile, restoreFile, cleanupBackup } from '../engine/backup.js';
import { deadLetterQueue } from '../engine/queue.js';
import { recordStart, recordRetry, recordSuccess, recordFailure } from '../engine/metrics.js';
import { runAgent } from '../engine/agent-runner.js';
import { runReviewPipeline } from '../engine/review-system.js';
import { runTests } from '../engine/test-runner.js';
import { storeMemory, searchMemory } from '../engine/vector-memory.js';
import { updateJob, incrementRetries } from '../engine/job-store.js';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis();

const worker = new Worker(
  'aegis-tasks',
  async (job) => {
    const { step } = job.data;

    // ✅ job start tracking
    recordStart(job.id);

    updateJob(job.id, { status: 'running' });

    let attempt = 0;
    let success = false;
    let lastError = '';

    while (attempt < 3 && !success) {
      attempt++;

      // ✅ retry tracking
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

        throw new Error('AI review rejected');
      }

      // ✅ parse patch
      const { file, content } = parsePatch(patch);

      // 🔒 ✅ FIX: distributed lock (await REQUIRED)
      const lock = await acquireLock(file);

      try {
        // backup
        backupFile(file);

        // apply
        applyPatch({ file, content });

        // test
        const testResult = runTests();

        if (testResult.success) {
          success = true;

          await storeMemory(step.description, patch);

          cleanupBackup(file);

          updateJob(job.id, {
            status: 'completed',
            result: 'success'
          });

          // ✅ success metrics
          recordSuccess(job.id);

        } else {
          lastError = testResult.output;

          // rollback
          restoreFile(file);
        }

      } finally {
        // 🔓 ✅ FIX: await release
        await releaseLock(lock);
      }
    }

    if (!success) {
      recordFailure(job.id);

      updateJob(job.id, {
        status: 'failed',
        result: lastError
      });

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
