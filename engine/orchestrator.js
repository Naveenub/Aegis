import { runAgent } from './agent-runner.js';
import { logger } from './logger.js';
import { addStep, Priority } from './queue.js';
import { createWorkflow, getRunnableSteps } from './workflow-store.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * @param {string} task
 * @param {object} opts
 * @param {number} [opts.priority]   - Priority.* constant (default NORMAL)
 * @param {number} [opts.timeoutMs]  - wall-clock timeout for the whole workflow
 * @returns {string} workflowId
 */
export async function runSystem(task, opts = {}) {
  const workflowId = uuidv4();
  const priority = opts.priority ?? Priority.NORMAL;

  logger.info({ workflowId, task, priority }, 'Start');

  // 1️⃣ Plan
  const planRaw = await runAgent('planner', task, {});
  const plan = JSON.parse(planRaw);

  // 2️⃣ Persist workflow with control metadata
  await createWorkflow(workflowId, plan.tasks, {
    priority,
    timeoutMs: opts.timeoutMs ?? null
  });

  // 3️⃣ Get initial runnable steps
  const steps = await getRunnableSteps(workflowId);

  // 4️⃣ Schedule with priority — no execution here
  for (const step of steps) {
    await addStep(workflowId, step, priority);
  }

  logger.info({ workflowId, steps: steps.length, priority }, 'Scheduled');

  return workflowId;
}
