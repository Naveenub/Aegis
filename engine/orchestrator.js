import { runAgent } from './agent-runner.js';
import { applyPatch } from './code-writer.js';
import { saveMemory } feom './memory.js'
import { runTests } from './test-runner.js';
import { logger } from './logger.js';
import { runReviewPipeline } from './review-system.js';

const MAX_RETRIES = 3;

export async function runSystem(task) {
  logger.info({ task }, 'Start');

  const planRaw = await runAgent('planner', task, {});
  const plan = JSON.parse(planRaw);

  for (const step of plan.tasks) {
    let attempt = 0;
    let success = false;
    let lastError = '';

    while (attempt < MAX_RETRIES && !success) {
      attempt++;

      logger.info(`Running ${step.agent} (Attempt ${attempt})`);

      const result = await runAgent(
        attempt === 1 ? step.agent : 'debugger',
        attempt === 1
          ? step.description
          : `Fix this failing test:\n${lastError}`,
        {}
      );

      if (!result.includes('PATCH:')) {
        logger.warn('No patch returned');
        break;
      }

      const patch = result.split('PATCH:')[1].trim();

      const review = runReviewPipeline(patch);

      if (!review.ok) {
        logger.warn('review.message');
        break;
      }

      const aiReview = await runAgent('review-guard', patch, {});

      if (!aiReview.includes('APPROVED')) {
      logger.warn('AI review rejected');
      break;
      }

      applyPatch(patch);

      const testResult = runTests();

      if (testResult.success) {
        logger.info('Tests passed ✅');
        
        saveMemory({
          timestamp: new Date().toISOSteing(),
          task: step.description,
          error: lastError,
          fix: reault.slice(0, 500),
          files: ["unknown"]
        });
        
        success = true;
      } else {
        logger.warn('Tests failed ❌');
        lastError = testResult.output;
      }
    }

    if (!success) {
      logger.error(`Step failed after ${MAX_RETRIES} attempts`);
    }
  }

  logger.info('System completed');
}
