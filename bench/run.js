#!/usr/bin/env node
/**
 * bench/run.js — run Aegis against the real-repo task suite and record outcomes.
 *
 * For each verified task:
 *   1. fetch the repo at baseSha into a clean directory (the task's `prompt` is
 *      the ONLY thing Aegis is told — never the tests, never the gold patch)
 *   2. let the engine plan → patch → test → merge onto its tenant branch
 *   3. independently validate the merged result: apply the HELD-OUT test.patch,
 *      run fail_to_pass and pass_to_pass. Aegis never sees these.
 *   4. write one JSON record per task: outcome, LLM cost, wall time, patch size
 *
 * Output: bench/results/<runId>/{results.jsonl, meta.json}. Then:
 *   node bench/report.js bench/results/<runId>
 *
 * Usage
 *   node bench/run.js [--engine aegis|oracle] [--id <taskId>]... [--docker <image>]
 *                     [--timeout-sec 1200] [--run-id <id>] [--out <dir>]
 *
 * Requirements for --engine aegis
 *   - ANTHROPIC_API_KEY, a Redis Stack reachable at REDIS_URL, Docker (sandbox)
 *   - a DEDICATED Redis: per-run cost is the delta of the engine's global cost
 *     counter, so nothing else may call the engine while the benchmark runs.
 *   - tasks run sequentially, one tenant each, so costs never overlap.
 *
 * --engine oracle applies each task's gold patch with no LLM. It validates the
 * harness (expect 100% accepted, $0) and is stamped synthetic in meta.json.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { loadTasks } from './lib/tasks.js';
import { sh, git, checkoutSha, applyPatch } from './lib/exec.js';
import { aegisEngine, oracleEngine, tenantBranch } from './lib/engines.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

/** Count lines/files changed between two refs. */
function diffStats(repoDir, base, branch) {
  const out = git(['diff', '--numstat', base, branch], repoDir);
  let files = 0; let lines = 0;
  for (const l of out.split('\n').filter(Boolean)) {
    const [a, d] = l.split('\t');
    files++;
    lines += (Number(a) || 0) + (Number(d) || 0);
  }
  return { filesChanged: files, linesChanged: lines };
}

/**
 * Run one task end to end. Exported for tests.
 *
 * @returns {Promise<object>} a record (see bench/lib/metrics.js)
 */
export async function runTask({ task, engine, workDir, tenantId, docker = null, timeoutSec = 1200, remote }) {
  const repoDir = path.join(workDir, 'repo');
  const worktreesDir = path.join(workDir, 'worktrees');
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(worktreesDir, { recursive: true });

  const record = {
    taskId: task.id, repo: task.repo, baseSha: task.baseSha, tenantId,
    baselineMinutes: task.baseline?.minutes ?? null,
  };

  try {
    checkoutSha({ repo: task.repo, sha: task.baseSha, dir: repoDir, ...(remote ? { remote } : {}) });
  } catch (err) {
    return { ...record, outcome: 'infra_error', costUsd: 0, error: `checkout failed: ${err.message}` };
  }

  const t0 = Date.now();
  let res;
  try {
    res = await engine.execute({ task, repoDir, worktreesDir, tenantId, timeoutSec });
  } catch (err) {
    res = { status: 'infra_error', costUsd: 0, tokensIn: 0, tokensOut: 0, error: String(err?.message ?? err) };
  }
  const wallSeconds = (Date.now() - t0) / 1000;

  Object.assign(record, {
    engineStatus: res.status, workflowId: res.workflowId ?? null, steps: res.steps ?? null,
    retries: res.retries ?? null, costUsd: res.costUsd ?? 0, tokensIn: res.tokensIn ?? 0,
    tokensOut: res.tokensOut ?? 0, llmCalls: res.llmCalls ?? null, wallSeconds,
    error: res.error ?? null, reason: res.reason ?? null,
  });

  if (res.status === 'infra_error') return { ...record, outcome: 'infra_error' };

  // "Merged" = the tenant branch actually moved past baseSha. We check git, not
  // the engine's own status, so a status bug cannot manufacture a merge.
  const branch = tenantBranch(tenantId);
  let merged = false;
  try {
    merged = git(['rev-parse', '--verify', '-q', branch], repoDir) !== ''
      && Number(git(['rev-list', '--count', `${task.baseSha}..${branch}`], repoDir)) > 0;
  } catch { merged = false; }
  if (!merged) return { ...record, outcome: 'not_merged' };

  Object.assign(record, diffStats(repoDir, task.baseSha, branch));

  // Held-out validation on a throwaway worktree of the merged branch.
  const valDir = path.join(workDir, 'validate');
  git(['worktree', 'add', '-q', '--detach', valDir, branch], repoDir);
  const timeout = task.timeoutSec ?? 900;
  const steps = [];
  let accepted = false;
  try {
    applyPatch(valDir, path.join(task.dir, 'test.patch'));
    const setupOk = task.setup.every((c) => sh(c, { cwd: valDir, timeoutSec: timeout, network: true, docker }).code === 0);
    if (!setupOk) {
      steps.push({ label: 'setup', ok: false });
    } else {
      const f2p = sh(task.fail_to_pass, { cwd: valDir, timeoutSec: timeout, network: false, docker });
      steps.push({ label: 'fail_to_pass', ok: f2p.code === 0, exitCode: f2p.code, tail: f2p.code === 0 ? undefined : f2p.output.slice(-1200) });
      let p2pOk = true;
      if (task.pass_to_pass) {
        const p2p = sh(task.pass_to_pass, { cwd: valDir, timeoutSec: timeout, network: false, docker });
        p2pOk = p2p.code === 0;
        steps.push({ label: 'pass_to_pass', ok: p2pOk, exitCode: p2p.code, tail: p2pOk ? undefined : p2p.output.slice(-1200) });
      }
      accepted = f2p.code === 0 && p2pOk;
    }
  } catch (err) {
    // e.g. the test patch no longer applies because Aegis rewrote the same
    // lines of a test file: that is a real failure of the patch, not infra.
    steps.push({ label: 'apply test.patch', ok: false, tail: err.message.slice(0, 600) });
  } finally {
    try { git(['worktree', 'remove', '--force', valDir], repoDir); } catch { /* best effort */ }
  }

  return { ...record, outcome: accepted ? 'accepted' : 'merged_bad', validation: steps };
}

function parseArgs(argv) {
  const a = { engine: 'aegis', ids: [], docker: null, timeoutSec: 1200, runId: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--engine') a.engine = argv[++i];
    else if (k === '--id') a.ids.push(argv[++i]);
    else if (k === '--docker') a.docker = { image: argv[++i] };
    else if (k === '--timeout-sec') a.timeoutSec = Number(argv[++i]);
    else if (k === '--run-id') a.runId = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else throw new Error(`Unknown argument: ${k}`);
  }
  if (!['aegis', 'oracle'].includes(a.engine)) throw new Error('--engine must be aegis or oracle');
  return a;
}

function aegisCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(ROOT, '..'), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

/** Run a list of tasks sequentially and write results. Exported for tests. */
export async function runBenchmark({ tasks, engine, outDir, workRoot, docker = null, timeoutSec = 1200, remoteFor, log = console.info }) {
  fs.mkdirSync(outDir, { recursive: true });
  const resultsPath = path.join(outDir, 'results.jsonl');
  fs.writeFileSync(resultsPath, '');
  const runTag = path.basename(outDir).replace(/[^a-zA-Z0-9]/g, '').slice(-12) || 'run';

  const records = [];
  for (const [i, task] of tasks.entries()) {
    log(`\n[bench] (${i + 1}/${tasks.length}) ${task.id}`);
    const rec = await runTask({
      task, engine, docker, timeoutSec,
      workDir: path.join(workRoot, task.id),
      tenantId: `b${runTag}${i}`.slice(0, 64),
      remote: remoteFor?.(task),
    });
    records.push(rec);
    fs.appendFileSync(resultsPath, JSON.stringify(rec) + '\n');
    log(`[bench]   → ${rec.outcome}  cost=$${(rec.costUsd ?? 0).toFixed(4)}  ${Math.round(rec.wallSeconds ?? 0)}s${rec.error ? `  (${rec.error.slice(0, 120)})` : ''}`);
  }

  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({
    startedAt: new Date().toISOString(),
    engine: engine.name,
    synthetic: engine.synthetic,
    aegisCommit: aegisCommit(),
    node: process.version,
    models: {
      build: process.env.AEGIS_MODEL_BUILD || process.env.AEGIS_MODEL || 'default',
      cheap: process.env.AEGIS_MODEL_CHEAP || process.env.AEGIS_MODEL || 'default',
    },
    docker: docker?.image ?? null,
    taskIds: tasks.map((t) => t.id),
  }, null, 2) + '\n');
  return records;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { tasks, skippedUnverified } = loadTasks(path.join(ROOT, 'tasks'), { ids: args.ids.length ? args.ids : undefined });
  if (skippedUnverified.length) console.warn(`[bench] skipping unverified tasks (run verify-tasks): ${skippedUnverified.join(', ')}`);
  if (!tasks.length) { console.error('[bench] no verified tasks to run'); process.exit(2); }

  if (args.engine === 'aegis' && !process.env.ANTHROPIC_API_KEY) {
    console.error('[bench] ANTHROPIC_API_KEY is not set. Use --engine oracle to self-test the harness without an LLM.');
    process.exit(2);
  }

  const runId = args.runId ?? `${args.engine}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = path.resolve(args.out ?? path.join(ROOT, 'results', runId));
  const workRoot = path.join(ROOT, '.cache', 'runs', runId);
  const engine = args.engine === 'oracle' ? oracleEngine() : aegisEngine();
  if (engine.synthetic) console.warn('[bench] SYNTHETIC run (oracle engine): validates the harness only; NOT evidence about Aegis.');

  await runBenchmark({ tasks, engine, outDir, workRoot, docker: args.docker, timeoutSec: args.timeoutSec });
  console.info(`\n[bench] wrote ${outDir}\n[bench] next: node bench/report.js ${path.relative(process.cwd(), outDir)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(2); });
}
