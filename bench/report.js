#!/usr/bin/env node
/**
 * bench/report.js — turn a results directory into report.md + summary.json.
 *
 *   node bench/report.js <resultsDir> [--hourly-usd 120]
 *
 * Optional <resultsDir>/annotations.json supplies human time, keyed by taskId:
 *   { "click-sentinel-copy-pickle-3805": { "reviewMinutes": 9, "fixupMinutes": 0,
 *                                          "baselineMinutes": 45, "baselineSource": "timed by maintainer X" } }
 * baselineMinutes here overrides the task manifest. Without both a baseline and
 * a review time for a task, time saved is NOT computed for it (see metrics.js).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { summarize, summarizeByRepo } from './lib/metrics.js';

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const usd = (x, d = 2) => (x === null || x === undefined ? 'n/a' : `$${x.toFixed(d)}`);
const num = (x, d = 0) => (x === null || x === undefined ? 'n/a' : x.toFixed(d));
const rate = (w) => (w.n === 0 ? 'n/a' : `${w.k}/${w.n} = ${pct(w.rate)} (95% CI ${pct(w.lo)}–${pct(w.hi)})`);

export function loadResults(dir) {
  const records = fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf-8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8'));
  let annotations = {};
  const ap = path.join(dir, 'annotations.json');
  if (fs.existsSync(ap)) annotations = JSON.parse(fs.readFileSync(ap, 'utf-8'));
  const merged = records.map((r) => ({ ...r, ...pickAnnotation(annotations[r.taskId]) }));
  return { records: merged, meta };
}

function pickAnnotation(a) {
  if (!a) return {};
  const o = {};
  for (const k of ['reviewMinutes', 'fixupMinutes', 'baselineMinutes']) if (typeof a[k] === 'number') o[k] = a[k];
  return o;
}

export function renderReport({ records, meta }, { hourlyUsd } = {}) {
  const s = summarize(records, { hourlyUsd });
  const byRepo = summarizeByRepo(records, { hourlyUsd });
  const L = [];

  L.push('# Aegis benchmark report', '');
  if (meta.synthetic) {
    L.push('> **SYNTHETIC RUN — NOT EVIDENCE.** The `oracle` engine applies each task\'s known-good patch with no LLM. It only proves the harness works. Do not quote these numbers.', '');
  }
  L.push(`- Engine: \`${meta.engine}\`  ·  Aegis commit: \`${meta.aegisCommit?.slice(0, 10) ?? 'unknown'}\`  ·  Started: ${meta.startedAt}`);
  L.push(`- Models: build=\`${meta.models.build}\`, cheap=\`${meta.models.cheap}\``);
  L.push(`- Tasks attempted: **${s.attempted}** across ${Object.keys(byRepo).length} repos` +
    (s.excludedInfraErrors ? `  ·  **${s.excludedInfraErrors} excluded as infrastructure errors** (API/harness outage, not a quality signal)` : ''), '');

  L.push('## Headline', '');
  L.push('| Metric | Result |', '|---|---|');
  L.push(`| **Verified merge rate** (merged *and* held-out tests pass) | ${rate(s.verifiedMergeRate)} |`);
  L.push(`| Merge rate (Aegis reported done and branch merged) | ${rate(s.mergeRate)} |`);
  L.push(`| **Cost per merged PR** (all spend, failures included) | ${usd(s.cost.perMergedPrUsd)} |`);
  L.push(`| Median cost of a merged PR | ${usd(s.cost.perMergedPrMedianUsd)} |`);
  L.push(`| Total LLM spend | ${usd(s.cost.totalUsd)} |`);
  L.push(`| Median wall-clock, merged PRs | ${s.latency.medianWallSecondsAccepted === null ? 'n/a' : `${num(s.latency.medianWallSecondsAccepted / 60, 1)} min`} |`);
  L.push(`| Median patch size, merged PRs | ${num(s.patch.medianFilesChangedAccepted, 0)} files / ${num(s.patch.medianLinesChangedAccepted, 0)} lines |`);
  L.push('');

  L.push('## Time saved', '');
  const t = s.timeSaved;
  if (t.n === 0) {
    L.push(`**Not measured.** No task has both an unassisted-human baseline and a recorded review time (coverage 0 of ${t.of}). Add \`annotations.json\` — see bench/README.md. This report does not estimate it.`);
  } else {
    L.push(`Measured on **${t.n} of ${t.of}** tasks (${pct(t.coverage)} coverage); not extrapolated to the rest.`, '');
    L.push(`- Net human time saved: **${num(t.totalMinutes, 0)} min** total, ${num(t.meanMinutesPerTask, 1)} min/task (failed attempts count as lost review time)`);
    if (t.netValueUsd !== undefined) {
      L.push(`- At an **assumed** loaded rate of ${usd(t.assumptions.hourlyUsd, 0)}/h: value ${usd(t.valueUsd)} − LLM cost ${usd(t.llmCostUsd)} = **net ${usd(t.netValueUsd)}**`);
    }
  }
  L.push('');

  L.push('## Per repo', '', '| Repo | Attempted | Verified merge rate | Cost / merged PR |', '|---|---|---|---|');
  for (const [repo, r] of Object.entries(byRepo)) {
    L.push(`| ${repo} | ${r.attempted} | ${rate(r.verifiedMergeRate)} | ${usd(r.cost.perMergedPrUsd)} |`);
  }
  L.push('');

  L.push('## Per task', '', '| Task | Outcome | Cost | Wall | Steps | Files/lines |', '|---|---|---|---|---|---|');
  for (const r of records) {
    L.push(`| ${r.taskId} | ${r.outcome} | ${usd(r.costUsd, 3)} | ${num((r.wallSeconds ?? 0) / 60, 1)} min | ${r.steps ?? 'n/a'} | ${r.filesChanged ?? '–'}/${r.linesChanged ?? '–'} |`);
  }
  L.push('');

  L.push('## How to read this', '',
    `- ${s.attempted} tasks is a small sample: read the confidence interval, not the point estimate.`,
    '- Correctness is judged by tests Aegis never saw (held out from the prompt and the repo). Passing them is necessary, not sufficient, for a maintainer to merge.',
    '- Tasks come from public repos; a model may have seen the original fix. Tasks were chosen from 2026 merges to limit this, but it cannot be ruled out.',
    '- Cost is complete spend including retries and failed attempts, from the engine\'s own metering.',
    '- Methodology and limits: bench/README.md.', '');

  return { markdown: L.join('\n'), summary: { overall: s, byRepo, meta } };
}

function main() {
  const argv = process.argv.slice(2);
  const dir = argv.find((a) => !a.startsWith('--'));
  const hi = argv.indexOf('--hourly-usd');
  const hourlyUsd = hi >= 0 ? Number(argv[hi + 1]) : undefined;
  if (!dir) { console.error('usage: node bench/report.js <resultsDir> [--hourly-usd N]'); process.exit(2); }
  const data = loadResults(path.resolve(dir));
  const { markdown, summary } = renderReport(data, { hourlyUsd });
  fs.writeFileSync(path.join(dir, 'report.md'), markdown);
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.info(markdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
