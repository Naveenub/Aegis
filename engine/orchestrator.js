import { runAgent } from './agent-runner.js';
import { logger } from './logger.js';
import { addStep, Priority } from './queue.js';
import { createWorkflow, getRunnableSteps } from './workflow-store.js';
import { initVectorIndex } from './vector-memory.js';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';
import { assertWorkflowQuota, trackWorkflowStart } from './tenant-quota.js';
import { recordUsageEvent, EVENT_TYPES } from './usage-recorder.js';
import { scanRepo } from './repo-scanner.js';
import { worktreeDir } from './git.js';
// crypto.randomUUID() is built into Node 14.17+ — no external package needed.

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

// Minimum meaningful description length (chars). Catches "fix it", "done", etc.
const MIN_DESCRIPTION_LENGTH = 20;

/**
 * Strip markdown code fences the model sometimes wraps around JSON output
 * despite explicit instructions not to.
 */
function stripFences(raw) {
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

// ─── Structural graph validation ──────────────────────────────────────────────

/**
 * Detect cycles in the dependency graph using Kahn's topological sort.
 *
 * parsePlan() already rejects forward-references (a task depending on an id
 * not yet seen), so by the time this runs every dep is guaranteed to exist.
 * This pass catches the remaining case: a cycle where A→B→C→A all appear in
 * order but form a loop through indirect paths.
 *
 * Throws with the detected cycle path on failure.
 *
 * @param {object[]} tasks  - validated task objects with .id and .depends_on
 */
function assertNoCycles(tasks) {
  // Build adjacency (id → set of ids that depend ON it, i.e. out-edges)
  // and in-degree map for Kahn's algorithm.
  const inDegree = new Map();
  const children = new Map(); // id → [ids that list id as a dependency]

  for (const t of tasks) {
    if (!inDegree.has(t.id)) inDegree.set(t.id, 0);
    if (!children.has(t.id)) children.set(t.id, []);
  }

  for (const t of tasks) {
    for (const dep of t.depends_on) {
      inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1);
      children.get(dep).push(t.id);
    }
  }

  // Kahn's: start with all nodes that have no incoming edges
  const queue = [...inDegree.entries()]
    .filter(([, deg]) => deg === 0)
    .map(([id]) => id);

  let processed = 0;

  while (queue.length) {
    const node = queue.shift();
    processed++;

    for (const child of (children.get(node) ?? [])) {
      const newDeg = inDegree.get(child) - 1;
      inDegree.set(child, newDeg);
      if (newDeg === 0) queue.push(child);
    }
  }

  if (processed !== tasks.length) {
    // Nodes that were never processed are part of a cycle
    const cycleNodes = [...inDegree.entries()]
      .filter(([, deg]) => deg > 0)
      .map(([id]) => id);

    throw new Error(
      `Planner produced a circular dependency among tasks: [${cycleNodes.join(', ')}]. ` +
      'The dependency graph must be a DAG (directed acyclic graph).'
    );
  }
}

/**
 * Validate that every file listed in task.files actually exists in the repo.
 *
 * Called after the worktree is available (or falls back to process.cwd()).
 * Unknown files are stripped from the task in-place and a warning is logged
 * rather than throwing — a hallucinated file path should not abort the whole
 * workflow, but it must not silently reach agent-runner where it would cause
 * a confusing "file not found" deep in execution.
 *
 * @param {object[]} tasks      - mutable task array (files arrays edited in-place)
 * @param {string}   repoRoot   - absolute path to scan for real files
 * @param {object}   [log]      - logger instance (optional, falls back to console)
 */
async function stripHallucinatedFiles(tasks, repoRoot, log = logger) {
  // Build a Set of repo-relative paths for O(1) lookup.
  // scanRepo returns absolute paths; convert to repo-relative for matching.
  const repoFiles = new Set(
    (await scanRepo(repoRoot)).map(abs => abs.slice(repoRoot.length).replace(/^[\\/]/, ''))
  );

  for (const task of tasks) {
    if (!task.files || task.files.length === 0) continue;

    const valid   = [];
    const phantom = [];

    for (const f of task.files) {
      // Normalise separators so Windows paths match the scan output
      const normalised = f.replace(/\\/g, '/').replace(/^\.\//, '');
      if (repoFiles.has(normalised)) {
        valid.push(f);
      } else {
        phantom.push(f);
      }
    }

    if (phantom.length) {
      log.warn(
        { taskId: task.id, phantomFiles: phantom },
        'Planner referenced files that do not exist in the repo — stripped'
      );
      task.files = valid;
    }
  }
}

/**
 * Ensure every task description is substantive enough to be actionable.
 * A description like "fix it" or "done" gives agents nothing to work with.
 *
 * @param {object[]} tasks
 */
function assertDescriptionsSubstantive(tasks) {
  for (const task of tasks) {
    if (task.description.trim().length < MIN_DESCRIPTION_LENGTH) {
      throw new Error(
        `tasks id="${task.id}" description is too vague (${task.description.trim().length} chars, ` +
        `minimum ${MIN_DESCRIPTION_LENGTH}): "${task.description}". ` +
        'Descriptions must include concrete details (file names, function names, expected behaviour).'
      );
    }
  }
}

// ─── Plan parsing (schema + structural) ──────────────────────────────────────

/**
 * Parse and validate the planner's raw JSON output.
 *
 * @param {string} raw   - Raw text returned by the planner agent
 * @returns {{ tasks: object[] }}
 */
function parsePlan(raw) {
  let plan;
  try {
    plan = JSON.parse(stripFences(raw));
  } catch (err) {
    throw new Error(
      `Planner returned invalid JSON: ${err.message}\n` +
      `--- raw output (first 500 chars) ---\n${String(raw).slice(0, 500)}`
    );
  }

  return validatePlan(plan);
}

/**
 * Structural + semantic validation of a plan object — shape, per-task
 * schema, description substance, and dependency-graph cycle detection.
 *
 * Shared by parsePlan() (already-parsed planner JSON) and template
 * save/run (a plan object built directly from a request body, which never
 * passes through the planner).
 *
 * Validation layers (in order):
 *   1. Top-level shape  { tasks: [...] }
 *   2. Per-task schema  (id, agent, description, depends_on, files)
 *   3. Description substance  (not just "fix it")
 *   4. Cycle detection  (DAG check via topological sort)
 *
 * File-path validation (stripHallucinatedFiles) is a separate pass called
 * once the repoRoot is known, because neither the planner nor a template
 * run before any worktree exists.
 *
 * @param {object} plan   - { tasks: object[] }
 * @returns {{ tasks: object[] }}
 */
export function validatePlan(plan) {
  // ── 1. Top-level shape ─────────────────────────────────────────────────────
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

  // ── 2. Per-task schema ─────────────────────────────────────────────────────
  const seenIds = new Set();

  for (let i = 0; i < plan.tasks.length; i++) {
    const t   = plan.tasks[i];
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

    // depends_on — must be array; every dep must be a previously-seen id
    if (!Array.isArray(t.depends_on)) {
      throw new Error(
        `${loc} (id="${t.id}") "depends_on" must be an array (got ${JSON.stringify(t.depends_on)})`
      );
    }
    for (const dep of t.depends_on) {
      if (typeof dep !== 'string' || dep.trim() === '') {
        throw new Error(
          `${loc} (id="${t.id}") "depends_on" contains a non-string entry: ${JSON.stringify(dep)}`
        );
      }
      if (!seenIds.has(dep)) {
        throw new Error(
          `${loc} (id="${t.id}") depends_on "${dep}" which is not defined before this task. ` +
          'Tasks must be listed in dependency order.'
        );
      }
    }

    // files — optional, but must be array of strings when present
    if (t.files !== undefined) {
      if (!Array.isArray(t.files) || t.files.some((f) => typeof f !== 'string')) {
        throw new Error(`${loc} (id="${t.id}") "files" must be an array of strings`);
      }
    } else {
      // Normalise absent files to empty array for uniform downstream handling
      t.files = [];
    }
  }

  // ── 3. Description substance ───────────────────────────────────────────────
  assertDescriptionsSubstantive(plan.tasks);

  // ── 4. Cycle detection ─────────────────────────────────────────────────────
  assertNoCycles(plan.tasks);

  return plan;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

const MAX_PLAN_ATTEMPTS = 3;

/**
 * Finish orchestrating an already-validated plan: strip hallucinated file
 * paths, persist the workflow, and schedule its initial runnable steps.
 * Shared by runSystem() (planner-produced plan) and runTemplate() (a saved
 * plan re-run without the planner).
 *
 * @param {string}   workflowId
 * @param {object[]} tasks
 * @param {string}   tenantId
 * @param {number}   priority
 * @param {object}   opts
 * @param {number}   [opts.timeoutMs]
 */
async function scheduleValidatedPlan(workflowId, tasks, tenantId, priority, opts) {
  // File-path validation — strip hallucinated paths now that we can scan.
  // The tenant base worktree may not exist yet (workflow worktree is created
  // per-workflow in git.js); fall back to process.cwd() so this pass always
  // runs rather than being skipped when there's nothing to scan.
  const repoRoot = worktreeDir(tenantId) ?? process.cwd();
  await stripHallucinatedFiles(tasks, repoRoot);

  await createWorkflow(workflowId, tasks, {
    tenantId,
    priority,
    timeoutMs: opts.timeoutMs ?? null,
  });

  // Record usage for quota tracking and billing
  await trackWorkflowStart(tenantId);
  recordUsageEvent({
    tenantId, eventType: EVENT_TYPES.WORKFLOW_RUN, quantity: 1, metadata: { workflowId },
  });

  const steps = await getRunnableSteps(workflowId, tenantId);

  for (const step of steps) {
    await addStep(workflowId, step, priority, tenantId);
  }

  logger.info({ tenantId, workflowId, steps: steps.length, priority }, 'Scheduled');
}

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

  // 0️⃣ Quota check — reject before any work is done if tenant is over limit
  await assertWorkflowQuota(tenantId);

  // Ensure this tenant's vector index exists before first use
  await initVectorIndex(tenantId);

  // 1️⃣ Plan — retry up to MAX_PLAN_ATTEMPTS on parse/schema/graph failure
  let plan;
  let lastError;

  for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
    const planRaw = await runAgent('planner', task, { workflowId }, tenantId);

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

  // 2️⃣–5️⃣ Validate file paths, persist workflow, schedule initial steps
  await scheduleValidatedPlan(workflowId, plan.tasks, tenantId, priority, opts);

  return workflowId;
}

/**
 * Run a previously saved template's plan directly, skipping the planner.
 * The template's tasks are re-validated (validatePlan) since a template is
 * just persisted JSON that could have been edited or gone stale between
 * save and run.
 *
 * @param {object}   template        - { task, tasks } from template-store.getTemplate()
 * @param {object}   [opts]
 * @param {string}   [opts.tenantId]  - tenant identifier (default: 'default')
 * @param {number}   [opts.priority]  - Priority.* constant (default NORMAL)
 * @param {number}   [opts.timeoutMs] - wall-clock timeout for the whole workflow
 * @returns {string} workflowId
 */
export async function runTemplate(template, opts = {}) {
  const tenantId   = assertTenantId(opts.tenantId ?? DEFAULT_TENANT);
  const workflowId = crypto.randomUUID();
  const priority   = opts.priority ?? Priority.NORMAL;

  logger.info({ tenantId, workflowId, task: template.task, priority }, 'Start (from template)');

  await assertWorkflowQuota(tenantId);
  await initVectorIndex(tenantId);

  const plan = validatePlan({ tasks: template.tasks });

  await scheduleValidatedPlan(workflowId, plan.tasks, tenantId, priority, opts);

  return workflowId;
}
