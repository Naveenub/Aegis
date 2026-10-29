/**
 * bench/lib/metrics.js — the ROI metrics, defined once.
 *
 * Every number the benchmark publishes comes from `summarize()`. The
 * definitions below are deliberately conservative; they are the contract that
 * keeps the report honest, so change them with care and update bench/README.md.
 *
 * Record shape (one per task attempt; see bench/run.js)
 * ─────────────────────────────────────────────────────
 *   taskId, repo
 *   outcome        'accepted'   merged AND held-out tests pass
 *                  'merged_bad' merged by Aegis but held-out tests fail
 *                  'not_merged' workflow failed / cancelled / timed out /
 *                               merge conflict / needs human approval
 *                  'infra_error' harness or API outage — NOT a quality signal,
 *                               excluded from every rate, but counted
 *   costUsd        all LLM spend attributed to the workflow, INCLUDING retries
 *                  and attempts that never merged
 *   tokensIn, tokensOut, wallSeconds, steps, retries, filesChanged, linesChanged
 *   reviewMinutes, fixupMinutes   human time (optional, from annotations)
 *   baselineMinutes               unassisted human time (optional, from task)
 *
 * Definitions
 * ───────────
 *   merge rate            merged / attempted           (Aegis said "done")
 *   verified merge rate   accepted / attempted         (merged AND correct)
 *                         ← the headline number. A patch that merges but breaks
 *                           the held-out tests is a liability, not a success.
 *   cost per merged PR    Σ costUsd over ALL attempted tasks / accepted
 *                         Failures are paid for by the successes. Undefined
 *                         (null) when nothing was accepted.
 *   time saved            per task with baseline AND review time recorded:
 *                           accepted:     baseline − review − fixup
 *                           otherwise:    −review   (human still does the work
 *                                         from scratch; review time was wasted)
 *                         Reported as a sum, a mean, and COVERAGE (how many of
 *                         the tasks had both inputs). Never extrapolated.
 *   net value             only when an hourly rate is supplied (an assumption
 *                         the reader can challenge): time saved × rate − LLM cost
 *                         over the same tasks.
 */

import { wilson, sum, mean, median } from './stats.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** @param {object} r */
export function timeSavedMinutes(r) {
  if (!isNum(r.baselineMinutes) || !isNum(r.reviewMinutes)) return null;
  if (r.outcome === 'accepted') {
    return r.baselineMinutes - r.reviewMinutes - (isNum(r.fixupMinutes) ? r.fixupMinutes : 0);
  }
  return -r.reviewMinutes;
}

/**
 * @param {object[]} records
 * @param {object}   [opts]
 * @param {number}   [opts.hourlyUsd]  loaded engineering cost per hour (assumption)
 */
export function summarize(records, { hourlyUsd } = {}) {
  const valid = records.filter((r) => r.outcome !== 'infra_error');
  const infra = records.length - valid.length;
  const n = valid.length;

  const accepted = valid.filter((r) => r.outcome === 'accepted');
  const merged = valid.filter((r) => r.outcome === 'accepted' || r.outcome === 'merged_bad');

  const totalCost = sum(valid.map((r) => (isNum(r.costUsd) ? r.costUsd : 0)));

  // Time saved over tasks where both human inputs were recorded.
  const timed = valid
    .map((r) => ({ r, saved: timeSavedMinutes(r) }))
    .filter((x) => x.saved !== null);
  const savedMinutes = sum(timed.map((x) => x.saved));
  const timedCost = sum(timed.map((x) => (isNum(x.r.costUsd) ? x.r.costUsd : 0)));

  const timeSaved = {
    n: timed.length,
    of: n,
    coverage: n ? timed.length / n : null,
    totalMinutes: timed.length ? savedMinutes : null,
    meanMinutesPerTask: timed.length ? savedMinutes / timed.length : null,
  };
  if (isNum(hourlyUsd) && timed.length) {
    const valueUsd = (savedMinutes / 60) * hourlyUsd;
    timeSaved.assumptions = { hourlyUsd };
    timeSaved.valueUsd = valueUsd;
    timeSaved.llmCostUsd = timedCost;
    timeSaved.netValueUsd = valueUsd - timedCost;
  }

  const outcomes = {};
  for (const r of records) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;

  return {
    attempted: n,
    excludedInfraErrors: infra,
    outcomes,
    mergeRate: wilson(merged.length, n),
    verifiedMergeRate: wilson(accepted.length, n),
    cost: {
      totalUsd: totalCost,
      perAttemptMeanUsd: mean(valid.map((r) => r.costUsd).filter(isNum)),
      perMergedPrUsd: accepted.length ? totalCost / accepted.length : null,
      perMergedPrMedianUsd: median(accepted.map((r) => r.costUsd).filter(isNum)),
    },
    latency: {
      medianWallSecondsAccepted: median(accepted.map((r) => r.wallSeconds).filter(isNum)),
      medianWallSecondsAll: median(valid.map((r) => r.wallSeconds).filter(isNum)),
    },
    patch: {
      medianFilesChangedAccepted: median(accepted.map((r) => r.filesChanged).filter(isNum)),
      medianLinesChangedAccepted: median(accepted.map((r) => r.linesChanged).filter(isNum)),
    },
    timeSaved,
  };
}

/** Group records by repo and summarize each. */
export function summarizeByRepo(records, opts) {
  const groups = new Map();
  for (const r of records) {
    if (!groups.has(r.repo)) groups.set(r.repo, []);
    groups.get(r.repo).push(r);
  }
  return Object.fromEntries([...groups].map(([repo, rs]) => [repo, summarize(rs, opts)]));
}
