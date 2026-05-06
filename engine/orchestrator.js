import { runAgent } from './agent-runner.js';
import { logger } from './logger.js';
import { runDAG } from './dag-executor.js';
import { taskQueue } from './queue.js';

export async function runSystem(task) {
  logger.info({ task }, 'Start');

  // 1. Plan
  const planRaw = await runAgent('planner', task, {});
  const plan = JSON.parse(planRaw);

  // 2. Schedule tasks (NO execution here)
  await runDAG(plan.tasks, async (step) => {
  const job = await taskQueue.add('step', { step });
  return job; // IMPORTANT
});
