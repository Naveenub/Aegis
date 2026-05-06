import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { runAgent } from '../engine/agent-runner.js';
import { runReviewPipeline } from '../engine/review-system.js';
import { applyPatch } from '../engine/code-writer.js';
import { runTests } from '../engine/test-runner.js';

const connection = new IORedis();

new Worker(
  'aegis-tasks',
  async (job) => {
    const { step } = job.data;

    let attempt = 0;
    let success = false;
    let lastError = '';

    while (attempt < 3 && !success) {
      attempt++;

      const result = await runAgent(
        attempt === 1 ? step.agent : 'debugger',
        attempt === 1 ? step.description : lastError,
        {}
      );

      if (!result.includes('PATCH:')) return;

      const patch = result.split('PATCH:')[1].trim();

      const review = runReviewPipeline(patch);
      if (!review.ok) return;

      const aiReview = await runAgent('review-guard', patch, {});
      if (!aiReview.includes('APPROVED')) return;

      applyPatch(patch);

      const testResult = runTests();

      if (testResult.success) {
        success = true;
      } else {
        lastError = testResult.output;
      }
    }

    if (!success) {
      throw new Error('Step failed after retries');
    }

    return { success: true };
    else {
      throw new Error('Step failed');
    }
  },
  { connection }
);
