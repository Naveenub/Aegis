import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { runAgent } from '../engine/agent-runner.js';
import { runReviewPipeline } from '../engine/review-system.js';
import { applyPatch, parsePatch } from '../engine/code-writer.js';
import { runTests } from '../engine/test-runner.js';
import { updateJob, incrementRetries } from '../engine/job-store.js';
import { backupFile, restoreFile, cleanupBackup } from '../engine/backup.js';

const connection = new IORedis();

new Worker(
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

      const result = await runAgent(
        attempt === 1 ? step.agent : 'debugger',
        attempt === 1 ? step.description : lastError,
        {}
      );

      // ❌ handle no patch case properly
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

      // 1️⃣ backup
      backupFile(file);

      // 2️⃣ apply patch
      applyPatch({ file, content });

      // 3️⃣ run tests
      const testResult = runTests();

      if (testResult.success) {
        success = true;

        // ✅ cleanup backup after success
        cleanupBackup(file);

        updateJob(job.id, {
          status: 'completed',
          result: 'success'
        });

      } else {
        lastError = testResult.output;

        // ❌ rollback on failure
        restoreFile(file);
      }
    }

    if (!success) {
      updateJob(job.id, {
        status: 'failed',
        result: lastError
      });

      throw new Error('Step failed after retries');
    }

    return { success: true };
  },
  { connection }
);
