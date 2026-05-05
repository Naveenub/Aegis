import { runAgent } from './agent-runner.js';
import { applyPatch } from './code-writer.js';
import { logger } from './logger.js';
import fs from 'fs';

export async function runSystem(task) {
  logger.info({ task }, 'Start');

  const planRaw = await runAgent('planner', task, {});
  const plan = JSON.parse(planRaw);

  for (const step of plan.tasks.sort((a,b)=>a.priority-b.priority)) {
    logger.info(`Running ${step.agent}`);

    const result = await runAgent(step.agent, step.description, {});

    logDecision(step.agent, result);

    if (result.includes('PATCH:')) {
      const patch = extractPatch(result);

      const review = await runAgent('review-guard', patch, {});

      if (!review.includes('APPROVED')) {
        logger.warn('Patch rejected');
        continue;
      }

      applyPatch(patch);
    }
  }

  logger.info('Done');
}

function extractPatch(result) {
  return result.split('PATCH:')[1].trim();
}

function logDecision(agent, result) {
  fs.appendFileSync(
    '.claude/context/decisions.log',
    `[${new Date().toISOString()}] ${agent}\n${result}\n\n`
  );
}
