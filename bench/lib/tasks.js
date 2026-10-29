/**
 * bench/lib/tasks.js — task manifest schema, loader and validator.
 *
 * A task is a real, already-merged change from a public repo, turned into an
 * SWE-bench-style problem:
 *
 *   bench/tasks/<id>/task.json   manifest (below)
 *   bench/tasks/<id>/test.patch  the PR's TEST changes only — held out; applied
 *                                after Aegis finishes, never shown to the agent
 *   bench/tasks/<id>/gold.patch  the PR's NON-test changes — used only by
 *                                `verify-tasks` and the oracle self-test
 *   bench/tasks/<id>/verified.json  written by verify-tasks; a task is only
 *                                counted once this exists and matches task.json
 *
 * task.json
 * ─────────
 *   id            string   [a-z0-9-], equals the directory name
 *   repo          string   "owner/name" on github.com
 *   baseSha       string   40-hex commit the PR was based on
 *   language      string   javascript | typescript | python | go | java
 *   source        { type: 'pull_request', url, issueUrl?, mergedAt }
 *   prompt        string   what Aegis is told. Written from the issue/PR
 *                          description as a maintainer would file it. MUST NOT
 *                          contain the diff or name the fix.
 *   setup         string[] commands run once (network on) after checkout
 *   fail_to_pass  string   shell command; exits non-zero before the fix, 0 after
 *   pass_to_pass  string?  shell command; exits 0 before and after
 *   timeoutSec    number   per-command timeout (default 900)
 *   baseline      { minutes: number|null, source: string|null, note?: string }
 *                          unassisted human time. null = not measured; the report
 *                          then refuses to compute time saved for this task.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const LANGUAGES = new Set(['javascript', 'typescript', 'python', 'go', 'java']);

/** @returns {string[]} list of problems (empty = valid) */
export function validateTask(t, dirName) {
  const e = [];
  const str = (k) => typeof t[k] === 'string' && t[k].trim().length > 0;
  if (!str('id') || !/^[a-z0-9][a-z0-9-]*$/.test(t.id)) e.push('id must match /^[a-z0-9][a-z0-9-]*$/');
  if (dirName && t.id !== dirName) e.push(`id "${t.id}" must equal directory name "${dirName}"`);
  if (!str('repo') || !/^[\w.-]+\/[\w.-]+$/.test(t.repo)) e.push('repo must be "owner/name"');
  if (!str('baseSha') || !/^[0-9a-f]{40}$/.test(t.baseSha)) e.push('baseSha must be a 40-char hex sha');
  if (!LANGUAGES.has(t.language)) e.push(`language must be one of ${[...LANGUAGES].join(', ')}`);
  if (t.source?.type !== 'pull_request' || !/^https:\/\/github\.com\//.test(t.source?.url ?? '')) {
    e.push('source must be { type: "pull_request", url: "https://github.com/..." }');
  }
  if (!str('prompt') || t.prompt.length < 40) e.push('prompt must be a real task description (≥ 40 chars)');
  if (!Array.isArray(t.setup) || !t.setup.every((c) => typeof c === 'string')) e.push('setup must be string[]');
  if (!str('fail_to_pass')) e.push('fail_to_pass command is required');
  if (t.pass_to_pass !== undefined && typeof t.pass_to_pass !== 'string') e.push('pass_to_pass must be a string');
  if (t.baseline !== undefined) {
    const b = t.baseline;
    if (b.minutes !== null && !(typeof b.minutes === 'number' && b.minutes > 0)) e.push('baseline.minutes must be null or > 0');
    if (b.minutes !== null && !b.source) e.push('baseline.source is required when baseline.minutes is set');
  }
  return e;
}

/** sha256 over the files that define a task's validity; stored in verified.json. */
export function taskFingerprint(dir) {
  const h = crypto.createHash('sha256');
  for (const f of ['task.json', 'test.patch', 'gold.patch']) {
    h.update(f).update('\0').update(fs.readFileSync(path.join(dir, f))).update('\0');
  }
  return h.digest('hex');
}

/**
 * Load every task under `root`. Throws on an invalid manifest — a malformed
 * task silently skipped would bias the benchmark.
 *
 * @param {string}  root
 * @param {object}  [opts]
 * @param {boolean} [opts.requireVerified=true]  drop tasks lacking a matching verified.json
 * @param {string[]} [opts.ids]                  restrict to these ids
 * @returns {{ tasks: object[], skippedUnverified: string[] }}
 */
export function loadTasks(root, { requireVerified = true, ids } = {}) {
  const tasks = [];
  const skippedUnverified = [];
  if (!fs.existsSync(root)) return { tasks, skippedUnverified };

  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (ids && !ids.includes(name)) continue;

    const manifestPath = path.join(dir, 'task.json');
    if (!fs.existsSync(manifestPath)) continue;
    const t = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const problems = validateTask(t, name);
    if (problems.length) throw new Error(`Invalid task "${name}":\n  - ${problems.join('\n  - ')}`);

    for (const f of ['test.patch', 'gold.patch']) {
      if (!fs.existsSync(path.join(dir, f))) throw new Error(`Task "${name}" is missing ${f}`);
    }

    if (requireVerified) {
      const vp = path.join(dir, 'verified.json');
      let ok = false;
      try {
        const v = JSON.parse(fs.readFileSync(vp, 'utf-8'));
        ok = v.ok === true && v.fingerprint === taskFingerprint(dir);
      } catch { /* missing or unreadable = unverified */ }
      if (!ok) { skippedUnverified.push(name); continue; }
    }

    tasks.push({ ...t, dir, baseline: t.baseline ?? { minutes: null, source: null } });
  }
  return { tasks, skippedUnverified };
}
