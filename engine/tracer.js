/**
 * tracer.js — lightweight structured trace store
 *
 * Trace model:
 *   trace (traceId = workflowId)
 *     └─ span  (spanId = stepId)
 *           step        string
 *           agent       string
 *           patch       string | null
 *           testResult  { success, output } | null
 *           startMs     number
 *           endMs       number | null
 *           status      'running' | 'success' | 'failure'
 *
 * Persisted to .claude/context/traces.json (append-friendly object map).
 *
 * FIX: The original code did an unguarded load→mutate→save.
 * Under concurrent BullMQ workers N workers could read the same stale snapshot,
 * each write their span, and all but the last writer's span would be silently
 * dropped.  Every write now holds an advisory lock via `proper-lockfile`.
 * Reads remain lock-free — an eventually-consistent trace is fine for the UI.
 */

import fs   from 'fs';
import path from 'path';
import lock from 'proper-lockfile';

const PATH      = '.claude/context/traces.json';
const LOCK_OPTS = {
  retries : { retries: 10, minTimeout: 50, maxTimeout: 200, factor: 1.5 },
  stale   : 15_000,
};

// ─── internal helpers ────────────────────────────────────────────────────────

function ensureFile() {
  if (!fs.existsSync(PATH)) {
    fs.mkdirSync(path.dirname(PATH), { recursive: true });
    fs.writeFileSync(PATH, '{}');
  }
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function save(traces) {
  fs.writeFileSync(PATH, JSON.stringify(traces, null, 2));
}

async function withLock(fn) {
  ensureFile();
  const release = await lock.lock(PATH, LOCK_OPTS);
  try {
    const traces  = load();
    const updated = fn(traces);
    save(updated);
  } finally {
    await release();
  }
}

// ─── write ───────────────────────────────────────────────────────────────────

/**
 * Open a new span for a step.
 * @param {string} traceId   - workflowId
 * @param {string} spanId    - stepId
 * @param {string} stepDesc  - human-readable step description
 * @param {string} agent     - agent name executing this step
 */
export async function startSpan(traceId, spanId, stepDesc, agent) {
  await withLock(traces => {
    if (!traces[traceId]) traces[traceId] = { traceId, spans: {} };
    traces[traceId].spans[spanId] = {
      spanId,
      step       : stepDesc,
      agent,
      patch      : null,
      testResult : null,
      startMs    : Date.now(),
      endMs      : null,
      status     : 'running',
    };
    return traces;
  });
}

/**
 * Attach the generated patch to an open span.
 * @param {string} traceId
 * @param {string} spanId
 * @param {string} patch
 */
export async function attachPatch(traceId, spanId, patch) {
  await withLock(traces => {
    const span = traces[traceId]?.spans[spanId];
    if (span) span.patch = patch;
    return traces;
  });
}

/**
 * Attach the test result to an open span.
 * @param {string} traceId
 * @param {string} spanId
 * @param {{ success: boolean, output: string }} testResult
 */
export async function attachTestResult(traceId, spanId, testResult) {
  await withLock(traces => {
    const span = traces[traceId]?.spans[spanId];
    if (span) span.testResult = testResult;
    return traces;
  });
}

/**
 * Close a span.
 * @param {string} traceId
 * @param {string} spanId
 * @param {'success'|'failure'} status
 */
export async function endSpan(traceId, spanId, status) {
  await withLock(traces => {
    const span = traces[traceId]?.spans[spanId];
    if (span) {
      span.endMs  = Date.now();
      span.status = status;
    }
    return traces;
  });
}

// ─── read (lock-free — eventual consistency is fine for the UI) ──────────────

/**
 * Return the full trace for a workflow.
 * @param {string} traceId
 * @returns {{ traceId, spans: object } | null}
 */
export function getTrace(traceId) {
  ensureFile();
  const traces = load();
  return traces[traceId] ?? null;
}

/**
 * Return all traces (newest first, capped at limit).
 * @param {number} limit
 * @returns {Array}
 */
export function listTraces(limit = 100) {
  ensureFile();
  const traces = load();
  return Object.values(traces)
    .sort((a, b) => {
      const aStart = Math.min(...Object.values(a.spans).map(s => s.startMs));
      const bStart = Math.min(...Object.values(b.spans).map(s => s.startMs));
      return bStart - aStart;
    })
    .slice(0, limit);
}