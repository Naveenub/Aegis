#!/usr/bin/env node
/**
 * cli/claude.js — Aegis CLI entry point
 *
 * Usage:  aegis "<task description>"
 *
 * After submitting the task this process polls until the workflow reaches a
 * terminal state (completed | failed | cancelled), then writes a snapshot of
 * the completed jobs to .claude/context/jobs.json so the Claude CLI agents
 * have accurate, up-to-date context on each subsequent run.
 *
 * Previously jobs.json was never written by the CLI path and remained an
 * empty array [], making the persistent context layer a no-op.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import IORedis from 'ioredis';

import { runSystem }     from '../engine/orchestrator.js';
import { getWorkflow }   from '../engine/workflow-store.js';
import { listJobs }      from '../engine/job-store.js';
import { DEFAULT_TENANT } from '../engine/tenant.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const POLL_TIMEOUT_MS    = 10 * 60_000;    // give up after 10 min (safety net)
const WORKFLOW_EVENTS_PREFIX = 'aegis:workflow:events:';
const JOBS_CONTEXT_PATH  = path.resolve(
  fileURLToPath(import.meta.url),
  '../../.claude/context/jobs.json',
);
const MAX_CONTEXT_JOBS   = 50;             // keep the file readable

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Wait for the workflow to reach a terminal state, driven by workflow-store's
 * pub/sub events instead of fixed-interval polling — status changes are
 * picked up the moment they're published, with no wasted round-trips while a
 * long-running workflow is still in progress. Falls back to POLL_TIMEOUT_MS
 * as a safety net in case an event is missed (e.g. a Redis reconnect).
 * Returns the final workflow object (or null on timeout).
 *
 * @param {string} workflowId
 * @param {string} tenantId
 * @returns {Promise<object|null>}
 */
async function waitUntilDone(workflowId, _tenantId) {
  // Race can happen before we subscribe — check current state first.
  const initial = await getWorkflow(workflowId);
  if (initial && TERMINAL_STATUSES.has(initial.status)) {
    process.stdout.write(`  status: ${initial.status}\n`);
    return initial;
  }

  const subscriber = new IORedis();
  const channel = WORKFLOW_EVENTS_PREFIX + workflowId;

  try {
    await subscriber.subscribe(channel);

    const finalStatus = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), POLL_TIMEOUT_MS);

      subscriber.on('message', (_chan, raw) => {
        let event;
        try { event = JSON.parse(raw); } catch { return; }

        if (TERMINAL_STATUSES.has(event.status)) {
          clearTimeout(timer);
          process.stdout.write(`  status: ${event.status}\n`);
          resolve(event.status);
        }
      });
    });

    if (!finalStatus) {
      process.stdout.write('\n');
      return null; // timed out
    }

    return await getWorkflow(workflowId);
  } finally {
    await subscriber.quit().catch(() => {});
  }
}

/**
 * Write the most recent jobs for this tenant into the context file so the
 * Claude CLI can reference them as structured history.
 *
 * Schema written to jobs.json:
 * [
 *   {
 *     "jobId":       "...",
 *     "stepId":      "...",
 *     "agent":       "debugger",
 *     "status":      "completed",
 *     "result":      "success",
 *     "retries":     0,
 *     "tenantId":    "default",
 *     "createdAt":   "2026-05-31T...",
 *     "updatedAt":   "2026-05-31T..."
 *   },
 *   ...
 * ]
 *
 * @param {string} tenantId
 */
async function persistJobsContext(tenantId) {
  try {
    const jobs = await listJobs(tenantId, { limit: MAX_CONTEXT_JOBS });

    // Ensure the context directory exists (first-run safety)
    fs.mkdirSync(path.dirname(JOBS_CONTEXT_PATH), { recursive: true });

    fs.writeFileSync(
      JOBS_CONTEXT_PATH,
      JSON.stringify(jobs, null, 2) + '\n',
      'utf-8',
    );

    console.info(`  context: wrote ${jobs.length} job(s) → ${JOBS_CONTEXT_PATH}`);
  } catch (err) {
    // Non-fatal: a stale context file is better than crashing the CLI
    console.warn(`  [warn] could not update jobs context: ${err.message}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const task     = process.argv.slice(2).join(' ').trim();
const tenantId = process.env.AEGIS_TENANT ?? DEFAULT_TENANT;

if (!task) {
  console.info('Usage: aegis "<task description>"');
  process.exit(1);
}

console.info(`\nAegis — submitting task (tenant: ${tenantId})`);
console.info(`  task: ${task}\n`);

let workflowId;
try {
  workflowId = await runSystem(task, { tenantId });
} catch (err) {
  console.error(`[error] Failed to start workflow: ${err.message}`);
  process.exit(1);
}

console.info(`  workflow: ${workflowId}`);
console.info('  waiting for completion...');

const finalWorkflow = await waitUntilDone(workflowId, tenantId);

if (!finalWorkflow) {
  console.warn(`\n[warn] Workflow did not complete within ${POLL_TIMEOUT_MS / 1000}s.`);
  console.warn('       Context file will reflect jobs up to this point.');
} else {
  const statusLine = finalWorkflow.status === 'completed'
    ? `✔  completed`
    : `✘  ${finalWorkflow.status}${finalWorkflow.cancelReason ? ` (${finalWorkflow.cancelReason})` : ''}`;
  console.info(`\n  ${statusLine}`);

  if (finalWorkflow.steps?.length) {
    console.info('\n  Steps:');
    for (const s of finalWorkflow.steps) {
      const icon = s.status === 'completed' ? '✔' : s.status === 'failed' ? '✘' : '·';
      console.info(`    [${icon}] ${s.id}  ${s.agent}  — ${s.description ?? ''}`);
    }
  }
}

// Always persist context, even on failure — partial results are still useful
console.info('');
await persistJobsContext(tenantId);

process.exit(finalWorkflow?.status === 'completed' ? 0 : 1);
