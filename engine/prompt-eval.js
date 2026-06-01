/**
 * engine/prompt-eval.js — Agent Prompt Evaluation Harness
 *
 * Problem it solves
 * ─────────────────
 * Agent personas in .claude/agents/*.md are loaded verbatim and sent to the
 * Claude API with no systematic testing. A bad edit to a persona can silently
 * degrade output quality — wrong format, missing PATCH block, invalid JSON,
 * vague reasoning — with no feedback until a real workflow fails in production.
 *
 * This module provides:
 *   1. A suite of per-agent test cases (golden inputs + expected output shape).
 *   2. An `evalAgent(agent, cases, opts)` function that runs each case through
 *      runAgent() and scores the response against structural + quality rubrics.
 *   3. An `evalAll(opts)` function that runs every agent in the roster.
 *   4. A `recordEvalResult(result)` function that writes scored outcomes to
 *      .claude/context/eval-history.jsonl so the meta-reviewer can read trends.
 *
 * Usage (one-off, from CLI or CI)
 * ────────────────────────────────
 *   import { evalAll } from './engine/prompt-eval.js';
 *   const report = await evalAll();
 *   console.log(report.summary);
 *
 * Usage (in CI, non-zero exit on regression)
 * ───────────────────────────────────────────
 *   node -e "
 *     import('./engine/prompt-eval.js')
 *       .then(m => m.evalAll())
 *       .then(r => { if (!r.passed) process.exit(1); });
 *   "
 *
 * dryRun option
 * ─────────────
 *   { dryRun: true } skips writing to Redis eval history but still calls the
 *   real agent via runAgent(). This is safe for local smoke-runs where Redis
 *   is unavailable. It does NOT substitute stub responses — use the unit-test
 *   suite (tests/prompt-eval.test.js) with a mocked agent-runner for that.
 *
 * Scoring rubrics (per agent type)
 * ─────────────────────────────────
 *   PATCH agents  (debugger, feature-builder, refactorer, security-editor)
 *     - Contains a PATCH block                   +2
 *     - PATCH block is valid JSON                +2
 *     - JSON has `file` (string) field           +1
 *     - JSON has `content` (string) field        +1
 *     - Reasoning section present (Explanation/Design/Changes/Vulnerabilities) +1
 *     - Reasoning is ≥ 3 sentences               +1
 *     MAX score: 8
 *
 *   planner
 *     - Response is valid JSON                   +2
 *     - Has `tasks` array                        +2
 *     - Every task has id, agent, description, depends_on +2
 *     - All agents are from the valid roster     +1
 *     - At least one task                        +1
 *     MAX score: 8
 *
 *   review-guard
 *     - Response is exactly "APPROVED" or starts with "REJECTED\nReason:" +4
 *     - No extra text before/after               +2
 *     - Reason has ≥ 1 bullet line (if REJECTED) +2
 *     MAX score: 8
 *
 *   test-writer
 *     - Contains `import` statements             +1
 *     - Contains `describe` block                +1
 *     - Contains `it(` or `test(` calls          +2
 *     - Contains at least one `expect(`          +2
 *     - No real network calls (no `fetch(`, `axios`, real HTTP) +2
 *     MAX score: 8
 *
 *   meta-reviewer
 *     - Contains `## Summary` section            +2
 *     - Contains `## Findings` table             +2
 *     - Contains `## Top 3 improvements`         +2
 *     - At least one finding row                 +2
 *     MAX score: 8
 *
 * A score < PASS_THRESHOLD (6/8) counts as a failure for that case.
 * An agent passes its eval suite if ≥ AGENT_PASS_RATE (0.8) of cases pass.
 */

import IORedis from 'ioredis';
import { runAgent } from './agent-runner.js';
import { logger } from './logger.js';

const redis = new IORedis(process.env.REDIS_URL || undefined);

// ─── Configuration ────────────────────────────────────────────────────────────

export const PASS_THRESHOLD  = 6;   // minimum score out of 8 per case
export const MAX_SCORE       = 8;
export const AGENT_PASS_RATE = 0.8; // fraction of cases an agent must pass

// Redis key for the eval history list (one JSON entry per element, newest last)
const EVAL_HISTORY_KEY = 'aegis:eval-history';

const VALID_AGENTS = new Set([
  'feature-builder',
  'debugger',
  'refactorer',
  'test-writer',
  'security-editor',
  'review-guard',
  'meta-reviewer',
]);

// ─── Golden test cases ────────────────────────────────────────────────────────

/**
 * Minimal, self-contained test inputs per agent.
 * Each case has:
 *   id          — unique label for reporting
 *   task        — the task string passed to runAgent()
 *   context     — optional context object (files, error, patch)
 *   expectNull  — true if PATCH: null is a valid response (no-op scenario)
 */
export const AGENT_CASES = {
  debugger: [
    {
      id: 'simple-throw',
      task: `Fix the failing test:

FAIL engine/job-store.test.js
  ● getJob › returns null for unknown id
    TypeError: Cannot read properties of undefined (reading 'id')
      at getJob (engine/job-store.js:14:20)

Relevant source (engine/job-store.js):
\`\`\`js
export function getJob(id) {
  const jobs = loadJobs();
  return jobs.find(j => j.id === id).id;
}
\`\`\``,
      context: {},
    },
    {
      id: 'async-rejection',
      task: `Fix the unhandled promise rejection:

UnhandledPromiseRejection: ENOENT: no such file or directory, open 'config.json'
  at readConfig (engine/config.js:8)

Relevant source (engine/config.js):
\`\`\`js
export async function readConfig() {
  const raw = await fs.promises.readFile('config.json', 'utf-8');
  return JSON.parse(raw);
}
\`\`\``,
      context: {},
    },
  ],

  'feature-builder': [
    {
      id: 'add-health-endpoint',
      task: `Add a GET /health endpoint to server.js that returns
{ status: 'ok', uptime: process.uptime() } with HTTP 200.
The endpoint must not require authentication.`,
      context: { files: ['server.js'] },
    },
    {
      id: 'add-pagination',
      task: `Add cursor-based pagination to the listJobs() function in
engine/job-store.js. Accept { cursor, limit = 20 } and return
{ items, nextCursor }. Existing callers pass no arguments and must
continue to work (return all items when no cursor/limit given).`,
      context: { files: ['engine/job-store.js'] },
    },
  ],

  refactorer: [
    {
      id: 'extract-helpers',
      task: `Refactor the following function to reduce nesting and extract helpers.
Do not change its external behaviour.

\`\`\`js
export async function processJob(job) {
  if (job) {
    if (job.status === 'pending') {
      try {
        const result = await runStep(job.step);
        if (result) {
          if (result.ok) {
            job.status = 'done';
            await saveJob(job);
            return { success: true };
          } else {
            job.status = 'failed';
            await saveJob(job);
            return { success: false, reason: result.error };
          }
        }
      } catch(e) {
        job.status = 'error';
        await saveJob(job);
        throw e;
      }
    }
  }
}
\`\`\``,
      context: {},
    },
    {
      id: 'no-change-needed',
      task: `Review this function and refactor if needed:

\`\`\`js
export function add(a, b) { return a + b; }
\`\`\``,
      context:    {},
      expectNull: true,
    },
  ],

  'test-writer': [
    {
      id: 'write-tests-for-utility',
      task: `Write Jest/Vitest tests for this utility module:

\`\`\`js
// engine/math-utils.js
export function clamp(value, min, max) {
  if (min > max) throw new RangeError('min must be <= max');
  return Math.min(Math.max(value, min), max);
}

export async function fetchAndDouble(url) {
  const res = await fetch(url);
  const { value } = await res.json();
  return value * 2;
}
\`\`\`

Save to tests/math-utils.test.js`,
      context: {},
    },
  ],

  'security-editor': [
    {
      id: 'path-traversal',
      task: `Audit and fix security issues in this route handler:

\`\`\`js
app.get('/file', (req, res) => {
  const filePath = req.query.path;
  const content = fs.readFileSync(filePath, 'utf-8');
  res.send(content);
});
\`\`\``,
      context: {},
    },
    {
      id: 'no-issues',
      task: `Audit this function for security issues:

\`\`\`js
export function add(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('numbers required');
  return x + y;
}
\`\`\``,
      context:    {},
      expectNull: true,
    },
  ],

  'review-guard': [
    {
      id: 'approve-clean-patch',
      task: `Review this patch:

PATCH:
{
  "file": "engine/utils.js",
  "content": "export function noop() {}"
}

Task: Add a noop utility function.`,
      context: {},
    },
    {
      id: 'reject-eval-usage',
      task: `Review this patch:

PATCH:
{
  "file": "engine/executor.js",
  "content": "export function run(code) { return eval(code); }"
}

Task: Add a code execution helper.`,
      context: {},
    },
  ],

  'meta-reviewer': [
    {
      id: 'basic-retrospective',
      task: `Analyse this workflow execution:

Workflow: wf-001
Duration: 45s
Steps:
  A (feature-builder) → APPROVED after 1 attempt (12s)
  B (test-writer)     → APPROVED after 2 attempts (18s, retry due to missing describe block)
  C (review-guard)    → APPROVED after 1 attempt (15s)

Agent outputs:
  B attempt 1: output had no describe() wrapper — parse failed
  B attempt 2: correct format

Produce a structured improvement report.`,
      context: {},
    },
  ],
};

// ─── Scorers ──────────────────────────────────────────────────────────────────

/**
 * Extract the PATCH block JSON string from a raw agent response.
 * Returns null if no PATCH block is found or if value is literally "null".
 */
function extractPatch(raw) {
  const match = raw.match(/PATCH:\s*(\{[\s\S]*\}|null)/);
  if (!match) return null;
  const value = match[1].trim();
  return value === 'null' ? 'NULL' : value;
}

function scorePatchAgent(raw, agent, expectNull) {
  let score = 0;
  const notes = [];

  const patchValue = extractPatch(raw);

  if (patchValue === null) {
    notes.push('FAIL: no PATCH block found');
    return { score, notes };
  }
  score += 2;
  notes.push('PASS: PATCH block present');

  if (patchValue === 'NULL') {
    if (expectNull) {
      score += 6; // full remaining credit — null is the correct answer
      notes.push('PASS: PATCH: null is correct for no-op scenario');
    } else {
      notes.push('WARN: PATCH: null but this case expected a real patch');
    }
    return { score, notes };
  }

  // Valid JSON
  let parsed;
  try {
    parsed = JSON.parse(patchValue);
    score += 2;
    notes.push('PASS: PATCH JSON is valid');
  } catch (e) {
    notes.push(`FAIL: PATCH JSON parse error — ${e.message}`);
    return { score, notes };
  }

  // `file` field
  if (typeof parsed.file === 'string' && parsed.file.length > 0) {
    score += 1;
    notes.push('PASS: `file` field present');
  } else {
    notes.push('FAIL: `file` field missing or not a string');
  }

  // `content` field
  if (typeof parsed.content === 'string' && parsed.content.length > 0) {
    score += 1;
    notes.push('PASS: `content` field present');
  } else {
    notes.push('FAIL: `content` field missing or not a string');
  }

  // Reasoning section
  const reasoningKeywords = {
    debugger:         'Explanation:',
    'feature-builder':'Design:',
    refactorer:       'Changes:',
    'security-editor':'Vulnerabilities:',
  };
  const keyword = reasoningKeywords[agent] ?? 'Explanation:';
  const reasoningIdx = raw.indexOf(keyword);
  if (reasoningIdx !== -1) {
    score += 1;
    notes.push(`PASS: reasoning section (${keyword}) present`);

    // Count sentences in the reasoning block (up to PATCH:)
    const patchIdx = raw.indexOf('PATCH:');
    const reasoningBlock = raw.slice(reasoningIdx, patchIdx !== -1 ? patchIdx : undefined);
    const sentences = reasoningBlock.split(/[.!?]+\s/).filter(s => s.trim().length > 10);
    if (sentences.length >= 3) {
      score += 1;
      notes.push(`PASS: reasoning has ${sentences.length} sentences (≥ 3)`);
    } else {
      notes.push(`FAIL: reasoning only has ${sentences.length} sentence(s) — need ≥ 3`);
    }
  } else {
    notes.push(`FAIL: reasoning section (${keyword}) missing`);
  }

  return { score, notes };
}

function scorePlanner(raw) {
  let score = 0;
  const notes = [];

  // Strip fences
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
    score += 2;
    notes.push('PASS: response is valid JSON');
  } catch (e) {
    notes.push(`FAIL: JSON parse error — ${e.message}`);
    return { score, notes };
  }

  if (Array.isArray(parsed?.tasks)) {
    score += 2;
    notes.push('PASS: `tasks` array present');
  } else {
    notes.push('FAIL: `tasks` array missing');
    return { score, notes };
  }

  if (parsed.tasks.length > 0) {
    score += 1;
    notes.push(`PASS: ${parsed.tasks.length} task(s) present`);
  } else {
    notes.push('FAIL: tasks array is empty');
    return { score, notes };
  }

  const requiredFields = ['id', 'agent', 'description', 'depends_on'];
  const allHaveRequiredFields = parsed.tasks.every(t =>
    requiredFields.every(f => t[f] !== undefined)
  );
  if (allHaveRequiredFields) {
    score += 2;
    notes.push('PASS: all tasks have required fields');
  } else {
    notes.push('FAIL: some tasks missing required fields (id/agent/description/depends_on)');
  }

  const allValidAgents = parsed.tasks.every(t => VALID_AGENTS.has(t.agent));
  if (allValidAgents) {
    score += 1;
    notes.push('PASS: all agents are from the valid roster');
  } else {
    const bad = parsed.tasks.filter(t => !VALID_AGENTS.has(t.agent)).map(t => t.agent);
    notes.push(`FAIL: unknown agents: ${bad.join(', ')}`);
  }

  return { score, notes };
}

function scoreReviewGuard(raw) {
  let score = 0;
  const notes = [];

  const trimmed = raw.trim();

  const isApproved = trimmed === 'APPROVED';
  const isRejected = trimmed.startsWith('REJECTED\nReason:') || trimmed.startsWith('REJECTED\r\nReason:');

  if (isApproved || isRejected) {
    score += 4;
    notes.push(`PASS: verdict is ${isApproved ? 'APPROVED' : 'REJECTED'}`);
  } else {
    notes.push('FAIL: response is neither "APPROVED" nor "REJECTED\\nReason: ..."');
    return { score, notes };
  }

  // No extra text before the verdict
  const firstLine = trimmed.split('\n')[0];
  if (firstLine === 'APPROVED' || firstLine === 'REJECTED') {
    score += 2;
    notes.push('PASS: no extra text before verdict');
  } else {
    notes.push('FAIL: extra text appears before the verdict line');
  }

  if (isRejected) {
    // Expect at least one bullet line after "Reason:"
    const afterReason = trimmed.split(/Reason:/)[1] ?? '';
    const bulletLines = afterReason.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('*') || l.trim().match(/^\d+\./));
    if (bulletLines.length >= 1) {
      score += 2;
      notes.push(`PASS: REJECTED has ${bulletLines.length} reason bullet(s)`);
    } else {
      notes.push('FAIL: REJECTED has no reason bullets');
    }
  } else {
    // APPROVED needs no bullets
    score += 2;
    notes.push('PASS: APPROVED needs no reason bullets');
  }

  return { score, notes };
}

function scoreTestWriter(raw) {
  let score = 0;
  const notes = [];

  if (/\bimport\b/.test(raw)) {
    score += 1;
    notes.push('PASS: contains import statement');
  } else {
    notes.push('FAIL: no import statement found');
  }

  if (/\bdescribe\s*\(/.test(raw)) {
    score += 1;
    notes.push('PASS: contains describe() block');
  } else {
    notes.push('FAIL: no describe() block found');
  }

  if (/\b(it|test)\s*\(/.test(raw)) {
    score += 2;
    notes.push('PASS: contains it() or test() calls');
  } else {
    notes.push('FAIL: no it() or test() calls found');
  }

  if (/\bexpect\s*\(/.test(raw)) {
    score += 2;
    notes.push('PASS: contains expect() assertions');
  } else {
    notes.push('FAIL: no expect() assertions found');
  }

  // No real network calls
  const realNetworkPattern = /\b(new XMLHttpRequest|fetch\s*\(\s*['"`]https?:\/\/|axios\.get\s*\(\s*['"`]https?:\/\/)/;
  if (!realNetworkPattern.test(raw)) {
    score += 2;
    notes.push('PASS: no real network calls detected');
  } else {
    notes.push('FAIL: possible real network call detected (not mocked)');
  }

  return { score, notes };
}

function scoreMetaReviewer(raw) {
  let score = 0;
  const notes = [];

  if (/##\s+Summary/i.test(raw)) {
    score += 2;
    notes.push('PASS: ## Summary section present');
  } else {
    notes.push('FAIL: ## Summary section missing');
  }

  if (/##\s+Findings/i.test(raw)) {
    score += 2;
    notes.push('PASS: ## Findings section present');
  } else {
    notes.push('FAIL: ## Findings section missing');
  }

  if (/##\s+Top\s+3\s+improvements?/i.test(raw)) {
    score += 2;
    notes.push('PASS: ## Top 3 improvements section present');
  } else {
    notes.push('FAIL: ## Top 3 improvements section missing');
  }

  // At least one finding table row (contains pipe-delimited row with a number)
  if (/\|\s*\d+\s*\|/.test(raw)) {
    score += 2;
    notes.push('PASS: at least one finding row in table');
  } else {
    notes.push('FAIL: no finding rows found in table');
  }

  return { score, notes };
}

/**
 * Score a raw agent response for a given agent type.
 *
 * @param {string}  agent      - agent name
 * @param {string}  raw        - raw response text from runAgent()
 * @param {boolean} expectNull - true when PATCH: null is a valid response
 * @returns {{ score: number, notes: string[] }}
 */
export function scoreResponse(agent, raw, expectNull = false) {
  const PATCH_AGENTS = new Set(['debugger', 'feature-builder', 'refactorer', 'security-editor']);

  if (PATCH_AGENTS.has(agent))  return scorePatchAgent(raw, agent, expectNull);
  if (agent === 'planner')      return scorePlanner(raw);
  if (agent === 'review-guard') return scoreReviewGuard(raw);
  if (agent === 'test-writer')  return scoreTestWriter(raw);
  if (agent === 'meta-reviewer')return scoreMetaReviewer(raw);

  return { score: 0, notes: [`Unknown agent type: ${agent}`] };
}

// ─── Eval runner ──────────────────────────────────────────────────────────────

/**
 * Run the eval suite for a single agent.
 *
 * @param {string}    agent    - agent name
 * @param {object[]}  cases    - array of test case objects
 * @param {object}    [opts]
 * @param {boolean}   [opts.dryRun=false]   - when true, skips writing to Redis
 *                                            eval history but still calls the
 *                                            real agent via runAgent(). Safe for
 *                                            local smoke-runs without Redis.
 * @param {string}    [opts.tenantId]        - passed through to runAgent()
 * @returns {Promise<object>} eval result for this agent
 */
export async function evalAgent(agent, cases, opts = {}) {
  const { dryRun = false, tenantId = 'default' } = opts;
  const results = [];

  for (const tc of cases) {
    let raw;
    let apiError = null;

    try {
      raw = await runAgent(agent, tc.task, tc.context ?? {}, tenantId);
    } catch (err) {
      apiError = err.message;
      raw = '';
    }

    const { score, notes } = scoreResponse(agent, raw, tc.expectNull ?? false);
    const passed = score >= PASS_THRESHOLD;

    results.push({
      caseId:   tc.id,
      passed,
      score,
      maxScore: MAX_SCORE,
      notes,
      apiError:  apiError ?? null,
      rawLength: raw.length,
    });
  }

  const passCount  = results.filter(r => r.passed).length;
  const agentPassed = passCount / results.length >= AGENT_PASS_RATE;

  const evalResult = {
    agent,
    passed:    agentPassed,
    passCount,
    totalCases: results.length,
    cases:     results,
  };

  if (!dryRun) {
    await recordEvalResult(evalResult);
  }

  return evalResult;
}

/**
 * Run evals for every agent in the roster.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]
 * @param {string}  [opts.tenantId]
 * @returns {Promise<{ passed: boolean, summary: string, agents: object[] }>}
 */
export async function evalAll(opts = {}) {
  const agentResults = [];

  for (const [agent, cases] of Object.entries(AGENT_CASES)) {
    logger.info({ agent }, '[prompt-eval] evaluating agent');
    const result = await evalAgent(agent, cases, opts);
    agentResults.push(result);
  }

  const allPassed = agentResults.every(r => r.passed);

  const summary = [
    `Prompt eval — ${new Date().toISOString()}`,
    allPassed ? 'RESULT: PASS' : 'RESULT: FAIL',
    '',
    ...agentResults.map(r =>
      `  ${r.passed ? '✓' : '✗'} ${r.agent.padEnd(18)} ${r.passCount}/${r.totalCases} cases passed`
    ),
  ].join('\n');

  return { passed: allPassed, summary, agents: agentResults };
}

// ─── History writer ───────────────────────────────────────────────────────────

/**
 * Append a scored eval result to the Redis eval history list.
 *
 * Replaces the old fs.appendFileSync approach (which was unsafe under
 * multi-process execution) with a Redis RPUSH, consistent with the fixes
 * already applied to tracer.js and job-store.js.
 *
 * The meta-reviewer reads this list to detect trends (e.g. an agent that
 * keeps failing `score < PASS_THRESHOLD` after prompt changes).
 *
 * @param {object} result - output of evalAgent() for one agent
 */
export async function recordEvalResult(result) {
  try {
    const entry = JSON.stringify({
      ts:        new Date().toISOString(),
      agent:     result.agent,
      passed:    result.passed,
      passCount: result.passCount,
      total:     result.totalCases,
      cases:     result.cases.map(c => ({
        id:     c.caseId,
        passed: c.passed,
        score:  c.score,
        notes:  c.notes,
      })),
    });

    await redis.rpush(EVAL_HISTORY_KEY, entry);
  } catch (err) {
    // Non-fatal: eval history is advisory, never abort real work
    logger.warn({ err: err.message }, '[prompt-eval] could not write eval history');
  }
}

/**
 * Read the last N eval runs from Redis history.
 *
 * @param {number} [n=20] - number of most recent records to return
 * @returns {Promise<object[]>}
 */
export async function readEvalHistory(n = 20) {
  try {
    // LRANGE with negative indices reads from the tail (most recent entries)
    const entries = await redis.lrange(EVAL_HISTORY_KEY, -n, -1);
    return entries.map(e => JSON.parse(e));
  } catch {
    return [];
  }
}

// ─── Stub responses (used when dryRun: true) ─────────────────────────────────
// These are the minimum correct outputs each agent should produce.
// They let the scoring functions be tested without real API calls.

export const STUB_RESPONSES = {
  debugger: `Explanation: The root cause is that Array.prototype.find() returns undefined
when no element matches, and the code immediately accesses .id on that result.
This causes a TypeError because undefined has no properties. The fix wraps
the return in an optional-chain so a missing job returns undefined gracefully.

PATCH:
{
  "file": "engine/job-store.js",
  "content": "export function getJob(id) {\\n  const jobs = loadJobs();\\n  return jobs.find(j => j.id === id)?.id ?? null;\\n}"
}`,

  'feature-builder': `Design: The /health endpoint is a lightweight liveness probe that returns the
process uptime so orchestrators can verify the server started correctly. It
uses no auth middleware because health checks must work before session context
is established. It is placed before any auth middleware in the middleware chain
to guarantee availability during startup. The response shape follows the
existing JSON conventions in server.js.

PATCH:
{
  "file": "server.js",
  "content": "app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));\\n"
}`,

  refactorer: `Changes:
- Extracted early-return guard for falsy job
- Replaced nested if/else with early returns to flatten nesting depth from 5 to 2
- Extracted \`markJob(job, status)\` helper to avoid repeating saveJob pattern

PATCH:
{
  "file": "engine/processor.js",
  "content": "async function markJob(job, status) { job.status = status; await saveJob(job); }\\nexport async function processJob(job) {\\n  if (!job || job.status !== 'pending') return;\\n  try {\\n    const result = await runStep(job.step);\\n    if (!result) return;\\n    await markJob(job, result.ok ? 'done' : 'failed');\\n    return { success: result.ok, reason: result.error };\\n  } catch (e) {\\n    await markJob(job, 'error');\\n    throw e;\\n  }\\n}"
}`,

  'test-writer': `import { describe, it, expect, vi } from 'vitest';
import { clamp, fetchAndDouble } from '../engine/math-utils.js';

vi.stubGlobal('fetch', vi.fn());

describe('clamp', () => {
  it('returns value when within range', () => {
    expect(clamp(5, 1, 10)).toBe(5);
  });
  it('clamps to min when value is below range', () => {
    expect(clamp(0, 1, 10)).toBe(1);
  });
  it('clamps to max when value is above range', () => {
    expect(clamp(20, 1, 10)).toBe(10);
  });
  it('throws RangeError when min > max', () => {
    expect(() => clamp(5, 10, 1)).toThrow(RangeError);
  });
});

describe('fetchAndDouble', () => {
  it('returns doubled value from fetch response', async () => {
    fetch.mockResolvedValueOnce({ json: async () => ({ value: 21 }) });
    expect(await fetchAndDouble('https://example.com')).toBe(42);
  });
});`,

  'security-editor': `Vulnerabilities:
[HIGH] Path traversal in GET /file — req.query.path is passed directly to
fs.readFileSync without any validation, allowing an attacker to read arbitrary
files on the server (e.g. /etc/passwd, .env, private keys).

PATCH:
{
  "file": "server.js",
  "content": "import path from 'path';\\nconst SAFE_ROOT = path.resolve('./public');\\napp.get('/file', (req, res) => {\\n  const requested = path.resolve(SAFE_ROOT, req.query.path ?? '');\\n  if (!requested.startsWith(SAFE_ROOT + path.sep)) return res.status(403).json({ error: 'Forbidden' });\\n  try { res.send(fs.readFileSync(requested, 'utf-8')); } catch { res.status(404).json({ error: 'Not found' }); }\\n});"
}`,

  'review-guard': `APPROVED`,

  'meta-reviewer': `## Summary
Workflow wf-001 completed successfully in 45s. The test-writer agent required
one retry due to a missing describe() wrapper, suggesting the prompt output
contract for that agent needs stricter enforcement or a format example.

## Findings
| # | Severity | Area | Finding | Recommendation |
|---|----------|------|---------|----------------|
| 1 | MEDIUM | test-writer prompt | First attempt lacked a describe() block, causing a parse failure and retry | Add a concrete output example to the test-writer prompt showing the required describe/it structure |
| 2 | LOW | parallelism | Steps A and B could run in parallel since B depends only on the inlined source, not A's output | Review planner DAG rules to allow test-writer to run concurrently with feature-builder |

## Top 3 improvements
1. Add a code example to the test-writer prompt that demonstrates the required describe/it/expect structure.
2. Adjust planner rules to parallelise independent test-writing and feature-building steps where the test file does not import the patched output.
3. Add a post-parse validation step in agent-worker.js that re-checks output format before marking a step done, to catch format regressions without requiring a full retry.`,
};
