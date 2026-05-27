import { runAgent } from './agent-runner.js';
import { logger } from './logger.js';
import { addStep, Priority } from './queue.js';
import { createWorkflow, getRunnableSteps } from './workflow-store.js';
import { initVectorIndex } from './vector-memory.js';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * @param {string} task
 * @param {object} opts
 * @param {string} [opts.tenantId]   - tenant identifier (default: 'default')
 * @param {number} [opts.priority]   - Priority.* constant (default NORMAL)
 * @param {number} [opts.timeoutMs]  - wall-clock timeout for the whole workflow
 * @returns {string} workflowId
 */
export async function runSystem(task, opts = {}) {
  const tenantId  = assertTenantId(opts.tenantId ?? DEFAULT_TENANT);
  const workflowId = uuidv4();
  const priority   = opts.priority ?? Priority.NORMAL;

  logger.info({ tenantId, workflowId, task, priority }, 'Start');

  // Ensure this tenant's vector index exists before first use
  await initVectorIndex(tenantId);

  // 1️⃣ Plan
  const planRaw = await runAgent('planner', task, {}, tenantId);
  const plan    = JSON.parse(planRaw);

  // 2️⃣ Persist workflow
  await createWorkflow(workflowId, plan.tasks, {
    tenantId,
    priority,
    timeoutMs: opts.timeoutMs ?? null
  });

  // 3️⃣ Get initial runnable steps
  const steps = await getRunnableSteps(workflowId, tenantId);

  // 4️⃣ Schedule — no execution here
  for (const step of steps) {
    await addStep(workflowId, step, priority, tenantId);
  }

  logger.info({ tenantId, workflowId, steps: steps.length, priority }, 'Scheduled');

  return workflowId;
}