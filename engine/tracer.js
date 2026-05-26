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
 */

import fs from 'fs';

const PATH = '.claude/context/traces.json';

function load() {
  if (!fs.existsSync(PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function save(traces) {
  fs.writeFileSync(PATH, JSON.stringify(traces, null, 2));
}

// ─── write ───────────────────────────────────────────────────────────────────

/**
 * Open a new span for a step.
 * @param {string} traceId   - workflowId
 * @param {string} spanId    - stepId
 * @param {string} stepDesc  - human-readable step description
 * @param {string} agent     - agent name executing this step
 */
export function startSpan(traceId, spanId, stepDesc, agent) {
  const traces = load();
  if (!traces[traceId]) traces[traceId] = { traceId, spans: {} };

  traces[traceId].spans[spanId] = {
    spanId,
    step: stepDesc,
    agent,
    patch: null,
    testResult: null,
    startMs: Date.now(),
    endMs: null,
    status: 'running',
  };

  save(traces);
}

/**
 * Attach the generated patch to an open span.
 * @param {string} traceId
 * @param {string} spanId
 * @param {string} patch
 */
export function attachPatch(traceId, spanId, patch) {
  const traces = load();
  const span = traces[traceId]?.spans[spanId];
  if (!span) return;
  span.patch = patch;
  save(traces);
}

/**
 * Attach the test result to an open span.
 * @param {string} traceId
 * @param {string} spanId
 * @param {{ success: boolean, output: string }} testResult
 */
export function attachTestResult(traceId, spanId, testResult) {
  const traces = load();
  const span = traces[traceId]?.spans[spanId];
  if (!span) return;
  span.testResult = testResult;
  save(traces);
}

/**
 * Close a span.
 * @param {string} traceId
 * @param {string} spanId
 * @param {'success'|'failure'} status
 */
export function endSpan(traceId, spanId, status) {
  const traces = load();
  const span = traces[traceId]?.spans[spanId];
  if (!span) return;
  span.endMs = Date.now();
  span.status = status;
  save(traces);
}

// ─── read ────────────────────────────────────────────────────────────────────

/**
 * Return the full trace for a workflow.
 * @param {string} traceId
 * @returns {{ traceId, spans: object } | null}
 */
export function getTrace(traceId) {
  const traces = load();
  return traces[traceId] ?? null;
}

/**
 * Return all traces (newest first, capped at limit).
 * @param {number} limit
 * @returns {Array}
 */
export function listTraces(limit = 100) {
  const traces = load();
  return Object.values(traces)
    .sort((a, b) => {
      const aStart = Math.min(...Object.values(a.spans).map(s => s.startMs));
      const bStart = Math.min(...Object.values(b.spans).map(s => s.startMs));
      return bStart - aStart;
    })
    .slice(0, limit);
}