import { runAgent } from './agent-runner.js';
import { logger } from './logger.js';
import { addStep, Priority } from './queue.js';
import { createWorkflow, getRunnableSteps } from './workflow-store.js';
import { initVectorIndex } from './vector-memory.js';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';
// crypto.randomUUID() is built into Node 14.17+ — no external package needed.
// This replaces the former `import { v4 as uuidv4 } from 'uuid'` which was
// absent from package.json and relied on uuid being a transitive dependency.

// ─── Planner output validation ────────────────────────────────────────────────

const VALID_AGENTS = new Set([
  'feature-builder',
  'debugger',
  'refactorer',
  'test-writer',
  'security-editor',
  'review-guard',
  // meta-reviewer is the fallback agent used by retry-policy.js on attempt 3+.
  // It must be listed here so parsePlan() accepts plans that reference it, and
  // so the error message in validation never incorrectly names it "unknown".
  'meta-reviewer',
]);

/**
 * Strip markdown code fences the model sometimes wraps around JSON output
 * despite explicit instructions not to.
 *
 * Handles:
 *   ```json\n{...}\n```
 *   ```\n{...}\n```
 *   plain {...}
 */
function stripFences(raw) {
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

/**
 * Parse and validate the planner's JSON output.
 * Throws a descriptive error rather than letting bad data silently corrupt
 * the workflow or produce an unreadable crash further downstream.
 *
 * @param {string} raw   - Raw text returned by the planner agent
 * @returns {{ tasks: object[] }}
 */
function parsePlan(raw) {
  // ── 1. Parse JSON ──────────────────────────────────────────────────────────
  let plan;
  try {
    plan = JSON.parse(stripFences(raw));
  } catch (err) {
    throw new Error(
      `Planner returned invalid JSON: ${err.message}\n` +
      `--- raw output (first 500 chars) ---\n${String(raw).slice(0, 500)}`
    );
  }

  // ── 2. Top-level shape ─────────────────────────────────────────────────────
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error(
      `Planner JSON must be an object with a "tasks" array, got: ${JSON.stringify(plan).slice(0, 200)}`
    );
  }

  if (!Array.isArray(plan.tasks)) {
    throw new Error(
      `Planner output missing "tasks" array. Keys present: ${Object.keys(plan).join(', ') || '(none)'}`
    );
  }

  if (plan.tasks.length === 0) {
    throw new Error('Planner returned an empty tasks array — nothing to execute.');
  }

  // ── 3. Per-task validation ─────────────────────────────────────────────────
  const seenIds = new Set();

  for (let i = 0; i < plan.tasks.length; i++) {
    const t = plan.tasks[i];
    const loc = `tasks[${i}]`;

    if (t === null || typeof t !== 'object') {
      throw new Error(`${loc} is not an object`);
    }

    // id
    if (typeof t.id !== 'string' || t.id.trim() === '') {
      throw new Error(`${loc}.id must be a non-empty string (got ${JSON.stringify(t.id)})`);
    }
    if (seenIds.has(t.id)) {
      throw new Error(`${loc}.id "${t.id}" is duplicated — all task ids must be unique`);
    }
    seenIds.add(t.id);

    // agent
    if (!VALID_AGENTS.has(t.agent)) {
      throw new Error(
        `${loc} (id="${t.id}") has unknown agent "${t.agent}". ` +
        `Valid agents: ${[...VALID_AGENTS].join(', ')}`
      );
    }

    // description
    if (typeof t.description !== 'string' || t.description.trim() === '') {
      throw new Error(`${loc} (id="${t.id}") must have a non-empty description string`);
    }

    // depends_on
    if (!Array.isArray(t.depends_on)) {
      throw new Error(
        `${loc} (id="${t.id}") "depends_on" must be an array (got ${JSON.stringify(t.depends_on)})`
      );
    }
    for (const dep of t.depends_on) {
      if (!seenIds.has(dep)) {
        throw new Error(
          `${loc} (id="${t.id}") depends_on "${dep}" which is not defined before this task`
        );
      }
    }

    // files (optional but must be array of strings when present)
    if (t.files !== undefined) {
      if (!Array.isArray(t.files) || t.files.some((f) => typeof f !== 'string')) {
        throw new Error(`${loc} (id="${t.id}") "files" must be an array of strings`);
      }
    }
  }

  return plan;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

const MAX_PLAN_ATTEMPTS = 3;

/**
 * @param {string} task
 * @param {object} opts
 * @param {string} [opts.tenantId]   - tenant identifier (default: 'default')
 * @param {number} [opts.priority]   - Priority.* constant (default NORMAL)
 * @param {number} [opts.timeoutMs]  - wall-clock timeout for the whole workflow
 * @returns {string} workflowId
 */
export async function runSystem(task, opts = {}) {
  const tenantId   = assertTenantId(opts.tenantId ?? DEFAULT_TENANT);
  const workflowId = crypto.randomUUID();
  const priority   = opts.priority ?? Priority.NORMAL;

  logger.info({ tenantId, workflowId, task, priority }, 'Start');

  // Ensure this tenant's vector index exists before first use
  await initVectorIndex(tenantId);

  // 1️⃣ Plan — retry up to MAX_PLAN_ATTEMPTS on parse/schema failure
  let plan;
  let lastError;

  for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
    const planRaw = await runAgent('planner', task, {}, tenantId);

    try {
      plan = parsePlan(planRaw);
      break; // success
    } catch (err) {
      lastError = err;
      logger.warn(
        { tenantId, workflowId, attempt, error: err.message },
        'Planner output failed validation — retrying'
      );
    }
  }

  if (!plan) {
    throw new Error(
      `Planner failed to produce a valid plan after ${MAX_PLAN_ATTEMPTS} attempts. ` +
      `Last error: ${lastError.message}`
    );
  }

  // 2️⃣ Persist workflow
  await createWorkflow(workflowId, plan.tasks, {
    tenantId,
    priority,
    timeoutMs: opts.timeoutMs ?? null,
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
