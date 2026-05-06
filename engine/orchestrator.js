import { runAgent } from './agent-runner.js';
import { logger } from './logger.js';
import { taskQueue } from './queue.js';
import { createWorkflow, getRunnableSteps } from './workflow-store.js';
import { v4 as uuidv4 } from 'uuid';

export async function runSystem(task) {
  const workflowId = uuidv4();

  logger.info({ workflowId, task }, 'Start');

  // 1️⃣ Plan
  const planRaw = await runAgent('planner', task, {});
  const plan = JSON.parse(planRaw);

  // 2️⃣ Persist workflow (CRITICAL - must await)
  await createWorkflow(workflowId, plan.tasks);

  // 3️⃣ Get initial runnable steps (must await)
  const steps = await getRunnableSteps(workflowId);

  // 4️⃣ Schedule ONLY (no execution here)
  for (const step of steps) {
    await taskQueue.add('step', {
      workflowId,
      step
    });
  }

  logger.info({ workflowId, steps: steps.length }, 'Scheduled');

  return workflowId;
}
