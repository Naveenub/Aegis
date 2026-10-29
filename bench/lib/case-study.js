/**
 * bench/lib/case-study.js — render a design-partner case study from a ledger of
 * REAL pull requests. It computes; it never invents.
 *
 * Ledger entry (one per PR Aegis opened for the partner)
 *   workflowId, title, prUrl
 *   outcome   'merged'          a human merged it as-is
 *             'merged_edited'   a human merged it after editing (fixupMinutes)
 *             'closed'          a human closed it unmerged
 *             'open'            still undecided → excluded from rates, listed
 *   costUsd, wallSeconds        from `case-study export` (engine metering)
 *   reviewMinutes, fixupMinutes human time the partner actually spent
 *   baselineMinutes             what the partner says the same ticket takes
 *                               without Aegis (and `baselineMethod` in inputs)
 *
 * Inputs (partner.json)
 *   partner { name, description }  period { from, to }  baselineMethod
 *   consent { namedPublicly, approvedBy, approvedAt, quoteApproved }
 *   quote { text, attribution }    hourlyUsd (optional assumption)
 *
 * Guards: the partner is named only with namedPublicly + approvedBy +
 * approvedAt; a quote only with quoteApproved. Anything unmeasured prints
 * "not measured". Fewer than MIN_PRS decided PRs prints a small-sample warning.
 */

import { summarize } from './metrics.js';

export const MIN_PRS = 10;

const OUTCOME = { merged: 'accepted', merged_edited: 'accepted', closed: 'not_merged' };
const pct = (x) => (x === null || x === undefined ? 'not measured' : `${(x * 100).toFixed(0)}%`);
const usd = (x, d = 2) => (x === null || x === undefined ? 'not measured' : `$${x.toFixed(d)}`);

export function validateLedger(ledger) {
  const errs = [];
  if (!Array.isArray(ledger)) return ['ledger must be an array'];
  ledger.forEach((e, i) => {
    if (!e.workflowId) errs.push(`entry ${i}: workflowId missing`);
    if (!e.prUrl) errs.push(`entry ${i}: prUrl missing — every PR must be checkable`);
    if (!['merged', 'merged_edited', 'closed', 'open'].includes(e.outcome)) errs.push(`entry ${i}: bad outcome "${e.outcome}"`);
  });
  return errs;
}

export function canNamePartner(consent) {
  return consent?.namedPublicly === true && !!consent.approvedBy && !!consent.approvedAt;
}

/** @returns {{ markdown: string, summary: object, publishable: boolean, problems: string[] }} */
export function buildCaseStudy(ledger, inputs) {
  const problems = validateLedger(ledger);
  if (problems.length) throw new Error(`Invalid ledger:\n  - ${problems.join('\n  - ')}`);

  const decided = ledger.filter((e) => e.outcome !== 'open');
  const open = ledger.length - decided.length;
  const records = decided.map((e) => ({
    taskId: e.workflowId, repo: inputs.partner?.repo ?? 'partner',
    outcome: OUTCOME[e.outcome], costUsd: e.costUsd, wallSeconds: e.wallSeconds,
    reviewMinutes: e.reviewMinutes, fixupMinutes: e.fixupMinutes, baselineMinutes: e.baselineMinutes,
  }));
  const s = summarize(records, { hourlyUsd: inputs.hourlyUsd });

  const named = canNamePartner(inputs.consent);
  const name = named ? inputs.partner.name : 'a design partner (anonymised)';
  const quoteOk = inputs.consent?.quoteApproved === true && inputs.quote?.text;
  const small = decided.length < MIN_PRS;
  const publishable = named && !small && s.timeSaved.n > 0;

  const issues = [];
  if (!named) issues.push('Partner has not consented to being named (consent.namedPublicly + approvedBy + approvedAt).');
  if (small) issues.push(`Only ${decided.length} decided PRs (< ${MIN_PRS}); too small to generalise.`);
  if (s.timeSaved.n === 0) issues.push('No PR has both a baseline and recorded review time; time saved is unmeasured.');
  if (!inputs.baselineMethod) issues.push('baselineMethod is missing; a baseline without a method is not credible.');

  const L = [];
  if (!publishable) L.push(`> **DRAFT — NOT FOR PUBLICATION.** ${issues.join(' ')}`, '');
  L.push(`# Case study: ${name}`, '');
  if (inputs.partner?.description) L.push(inputs.partner.description, '');
  L.push(`**Period:** ${inputs.period?.from ?? '?'} → ${inputs.period?.to ?? '?'}  ·  **PRs opened by Aegis:** ${ledger.length} (${decided.length} decided, ${open} still open)`, '');

  L.push('## Results', '', '| Metric | Result |', '|---|---|');
  const w = s.verifiedMergeRate;
  L.push(`| PRs merged by the partner's engineers | ${w.n ? `${w.k}/${w.n} = ${pct(w.rate)} (95% CI ${pct(w.lo)}–${pct(w.hi)})` : 'not measured'} |`);
  L.push(`| Cost per merged PR (all LLM spend incl. closed PRs) | ${usd(s.cost.perMergedPrUsd)} |`);
  L.push(`| Median time from request to PR | ${s.latency.medianWallSecondsAll === null ? 'not measured' : `${(s.latency.medianWallSecondsAll / 60).toFixed(1)} min`} |`);
  const t = s.timeSaved;
  L.push(`| Net engineer time saved | ${t.n ? `${t.totalMinutes.toFixed(0)} min over ${t.n} of ${t.of} PRs (${(t.meanMinutesPerTask).toFixed(1)} min/PR; closed PRs count as lost review time)` : 'not measured'} |`);
  if (t.netValueUsd !== undefined) {
    L.push(`| Net value at assumed ${usd(t.assumptions.hourlyUsd, 0)}/h | ${usd(t.netValueUsd)} (value ${usd(t.valueUsd)} − LLM cost ${usd(t.llmCostUsd)}) |`);
  }
  L.push('');

  L.push('## Method', '',
    '- Outcome is what the partner\'s engineers did with each PR on their own repo, not a score from Aegis.',
    `- Baseline: ${inputs.baselineMethod ?? 'NOT PROVIDED'}.`,
    '- Review and fix-up minutes were recorded by the partner per PR.',
    '- Cost is LLM spend from Aegis\'s own metering, including PRs that were closed.', '');

  L.push('## PR ledger', '', '| PR | Outcome | Cost | Review min | Baseline min |', '|---|---|---|---|---|');
  for (const e of ledger) {
    L.push(`| [${e.title ?? e.workflowId}](${e.prUrl}) | ${e.outcome} | ${usd(e.costUsd, 3)} | ${e.reviewMinutes ?? '–'} | ${e.baselineMinutes ?? '–'} |`);
  }
  L.push('');

  if (quoteOk) L.push('## In their words', '', `> ${inputs.quote.text}`, '', `— ${inputs.quote.attribution ?? name}`, '');

  return { markdown: L.join('\n'), summary: s, publishable, problems: issues };
}
