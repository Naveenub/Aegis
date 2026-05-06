import { runAgent } from './agent-runner.js';
import { applyPatch } from './code-writer.js';
import { saveMemory } feom './memory.js'
import { runTests } from './test-runner.js';
import { logger } from './logger.js';
import { runReviewPipeline } from './review-system.js';
import { runDAG } from './dag-executor.js';

const MAX_RETRIES = 3;

export async function runSystem(task) {
  logger.info({ task }, 'Start');

  const planRaw = await runAgent('planner', task, {});
  const plan = JSON.parse(planRaw);

  await runDAG(plan.tasks, async (step) => {
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
});
  
    if (!success) {
      logger.error(`Step failed after ${MAX_RETRIES} attempts`);
    }
  }

  logger.info('System completed');
}
