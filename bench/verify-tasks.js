#!/usr/bin/env node
/**
 * bench/verify-tasks.js — prove each task is a well-formed benchmark problem
 * WITHOUT calling any LLM.
 *
 * For every task it checks, on a fresh checkout of baseSha:
 *   1. with the held-out tests applied and no fix:  fail_to_pass FAILS
 *   2. (if set) pass_to_pass PASSES                  — the suite is green at base
 *   3. with the gold patch also applied:             fail_to_pass PASSES
 *   4. (if set) pass_to_pass still PASSES            — the fix doesn't regress
 *
 * Only then is `verified.json` written. The runner ignores unverified tasks, so
 * a task whose "tests" pass without any fix (or never pass at all) cannot
 * inflate or deflate the merge rate.
 *
 * Usage
 *   node bench/verify-tasks.js [--id <taskId>]... [--docker <image>] [--keep]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadTasks, taskFingerprint } from './lib/tasks.js';
import { sh, checkoutSha, applyPatch } from './lib/exec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const TASKS = path.join(ROOT, 'tasks');
const CACHE = path.join(ROOT, '.cache', 'verify');

function parseArgs(argv) {
  const a = { ids: [], docker: null, keep: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--id') a.ids.push(argv[++i]);
    else if (argv[i] === '--docker') a.docker = { image: argv[++i] };
    else if (argv[i] === '--keep') a.keep = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return a;
}

/**
 * Verify one task. Exported for tests.
 * @returns {{ ok: boolean, steps: object[], reason?: string }}
 */
export function verifyTask(task, { docker = null, workRoot = CACHE, keep = false } = {}) {
  const dir = path.join(workRoot, task.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const steps = [];
  const timeoutSec = task.timeoutSec ?? 900;
  const run = (label, cmd, network, expect) => {
    const t0 = Date.now();
    const r = sh(cmd, { cwd: dir, timeoutSec, network, docker });
    const pass = r.code === 0;
    const okStep = expect === 'pass' ? pass : !pass && !r.timedOut;
    steps.push({ label, expect, exitCode: r.code, timedOut: r.timedOut, ok: okStep, seconds: Math.round((Date.now() - t0) / 1000) });
    if (!okStep) steps.at(-1).tail = r.output.slice(-1500);
    return okStep;
  };
  const setup = () => task.setup.every((c, i) => run(`setup[${i}]`, c, true, 'pass'));

  try {
    checkoutSha({ repo: task.repo, sha: task.baseSha, dir });
    if (!setup()) return { ok: false, steps, reason: 'setup failed at base' };

    applyPatch(dir, path.join(task.dir, 'test.patch'));
    if (!run('fail_to_pass @ base+tests (must FAIL)', task.fail_to_pass, false, 'fail')) {
      return { ok: false, steps, reason: 'fail_to_pass did not fail without the fix (test does not exercise the bug)' };
    }
    if (task.pass_to_pass && !run('pass_to_pass @ base+tests (must PASS)', task.pass_to_pass, false, 'pass')) {
      return { ok: false, steps, reason: 'pass_to_pass is not green at base' };
    }

    applyPatch(dir, path.join(task.dir, 'gold.patch'));
    if (!setup()) return { ok: false, steps, reason: 'setup failed after gold patch' };
    if (!run('fail_to_pass @ gold (must PASS)', task.fail_to_pass, false, 'pass')) {
      return { ok: false, steps, reason: 'fail_to_pass does not pass with the gold patch' };
    }
    if (task.pass_to_pass && !run('pass_to_pass @ gold (must PASS)', task.pass_to_pass, false, 'pass')) {
      return { ok: false, steps, reason: 'gold patch regresses pass_to_pass' };
    }
    return { ok: true, steps };
  } catch (err) {
    return { ok: false, steps, reason: err.message };
  } finally {
    if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { tasks } = loadTasks(TASKS, { requireVerified: false, ids: args.ids.length ? args.ids : undefined });
  if (!tasks.length) {
    console.error('[verify] no tasks found in bench/tasks/');
    process.exit(2);
  }

  let failed = 0;
  for (const task of tasks) {
    console.info(`\n[verify] ${task.id}  (${task.repo}@${task.baseSha.slice(0, 8)})`);
    const res = verifyTask(task, { docker: args.docker, keep: args.keep });
    for (const s of res.steps) {
      console.info(`  ${s.ok ? '✓' : '✗'} ${s.label}  exit=${s.exitCode}${s.timedOut ? ' TIMEOUT' : ''}  ${s.seconds}s`);
    }
    const out = path.join(task.dir, 'verified.json');
    if (res.ok) {
      fs.writeFileSync(out, JSON.stringify({
        ok: true,
        fingerprint: taskFingerprint(task.dir),
        verifiedAt: new Date().toISOString(),
        node: process.version,
        docker: args.docker?.image ?? null,
        steps: res.steps.map(({ tail: _t, ...s }) => s),
      }, null, 2) + '\n');
      console.info('  → verified');
    } else {
      failed++;
      fs.rmSync(out, { force: true });
      console.error(`  → NOT verified: ${res.reason}`);
      const last = res.steps.at(-1);
      if (last?.tail) console.error(last.tail.split('\n').map((l) => `      ${l}`).join('\n'));
    }
  }
  console.info(`\n[verify] ${tasks.length - failed}/${tasks.length} tasks verified`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
