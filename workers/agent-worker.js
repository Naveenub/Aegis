import { acquireLock, releaseLock } from '../engine/lock.js';
import { applyPatch, parsePatch } from '../engine/code-writer.js';
import { backupFile, restoreFile, cleanupBackup } from '../engine/backup.js';
import { deadLetterQueue } from '../engine/queue.js';
import { runAgent } from '../engine/agent-runner.js';
import { runReviewPipeline } from '../engine/review-system.js';
import { runTests } from '../engine/test-runner.js';
import { storeMemory, searchMemory } from '../engine/vector-memory.js';
import { updateJob, incrementRetries } from '../engine/job-store.js';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis();

// ⚠️ FIX: assign worker to variable
const worker = new Worker(
  'aegis-tasks',
  async (job) => {
    const { step } = job.data;

    // ✅ mark job as running
    updateJob(job.id, { status: 'running' });

    let attempt = 0;
    let success = false;
    let lastError = '';

    while (attempt < 3 && !success) {
      attempt++;
      incrementRetries(job.id);

      // 🔍 retrieve similar past fixes
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
        updateJob(job.id, {
          status: 'failed',
          result: review.message
        });
        throw new Error('System review failed');
      }

      // ✅ AI review
      const aiReview = await runAgent('review-guard', patch, {});
      if (!aiReview.includes('APPROVED')) {
        updateJob(job.id, {
          status: 'failed',
          result: 'AI review rejected'
        });
        throw new Error('AI review rejected');
      }

      // ✅ parse patch
      const { file, content } = parsePatch(patch);

      // 🔒 acquire lock (CRITICAL)
      const lock = acquireLock(file);

      try {
        // 1️⃣ backup
        backupFile(file);

        // 2️⃣ apply patch
        applyPatch({ file, content });

        // 3️⃣ run tests
        const testResult = runTests();

        if (testResult.success) {
          success = true;
          await storeMemory(step.description, patch);

          // ✅ cleanup backup
          cleanupBackup(file);

          updateJob(job.id, {
            status: 'completed',
            result: 'success'
          });

        } else {
          lastError = testResult.output;

          // ❌ rollback
          restoreFile(file);
        }

      } finally {
        // 🔓 always release lock
        releaseLock(lock);
      }
    }

    if (!success) {
      updateJob(job.id, {
        status: 'failed',
        result: lastError
      });

      // 🚨 send to DLQ
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

// ✅ queue-level failure handling
worker.on('failed', async (job, err) => {
  await deadLetterQueue.add('failed-step', {
    originalJobId: job.id,
    step: job.data.step,
    error: err.message
  });
});
