/**
 * engine/billing/pricing-model.js
 *
 * Pure pricing math (no I/O) behind scripts/measure-cost.js and
 * scripts/propose-pricing.js. It turns MEASURED cost per workflow plus unit
 * costs and a target gross margin into the numbers stripe-setup.js needs, and
 * checks every tier in tiers.js against them.
 *
 * Nothing here defaults a price. The margin is a required input, and a
 * measurement with too few workflows is refused rather than extrapolated.
 *
 * Cost model. LLM cost is carried entirely by the two token meters, so
 * workflow_run and agent_step overage only has to cover platform overhead
 * (queue, Redis, compute), which you supply; at 0 their overage is 0.
 *
 *   unit cost            tokens_in / tokens_out  provider list price per token
 *                        sandbox_minutes         your infra cost per minute
 *                        workflow_run/agent_step overhead you supply (default 0)
 *   overage price        unit cost / (1 - margin), rounded UP to 4 significant figures
 *   base price floor     (cost of using the whole allowance) / (1 - margin), rounded up to whole USD
 *   unlimited tier       allowance is null; the floor is built from spend.capUsd,
 *                        the hard ceiling on platform LLM cost, and is a floor to quote from
 */

import { EVENT_TYPES } from '../usage-recorder.js';

const EV = EVENT_TYPES;
export const MIN_SAMPLES = 30;

// ─── Stats ────────────────────────────────────────────────────────────────────

/** Nearest-rank percentile of an ascending-sorted array. */
export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function stats(values) {
  const v = [...values].sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / (v.length || 1);
  return { mean, p50: percentile(v, 50), p90: percentile(v, 90), p99: percentile(v, 99), max: v[v.length - 1] ?? 0 };
}

// ─── Unit costs ───────────────────────────────────────────────────────────────

/**
 * Per-unit cost in USD. Token prices default to the provider list price the
 * rest of the engine already uses (metrics.js); the sandbox cost is infra only
 * you know, so it is required.
 */
export function unitCostsFromEnv(env = process.env) {
  const num = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || raw === '') {
      if (fallback === undefined) throw new Error(`${name} is required (USD).`);
      return fallback;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number.`);
    return n;
  };
  return {
    [EV.TOKENS_IN]:        num('AEGIS_COST_INPUT_PER_MTOK', 3) / 1e6,
    [EV.TOKENS_OUT]:       num('AEGIS_COST_OUTPUT_PER_MTOK', 15) / 1e6,
    [EV.SANDBOX_MINUTES]:  num('AEGIS_COST_SANDBOX_PER_MIN'),
    [EV.WORKFLOW_RUN]:     num('AEGIS_COST_PER_RUN_USD', 0),
    [EV.AGENT_STEP]:       num('AEGIS_COST_PER_STEP_USD', 0),
  };
}

// ─── Measurement ──────────────────────────────────────────────────────────────

/**
 * @param {Array<{ workflowId: string, tokensIn: number, tokensOut: number, steps: number }>} workflows
 *   one row per workflow that STARTED in the window
 * @param {{ tokens_in: number, tokens_out: number }} unit  USD per token
 * @param {{ sandboxMinutes?: number, runs?: number }} [sandbox] window totals; sandbox events carry no workflowId
 */
export function summarizeWorkflows(workflows, unit, sandbox = {}) {
  // A workflow with no recorded tokens never reached a platform-key LLM call
  // (BYOK, or failed before one). Counting it as $0 would drag the average
  // down, so it is excluded and counted separately.
  const measured = workflows.filter((w) => w.tokensIn > 0 || w.tokensOut > 0);
  const cost = measured.map((w) => w.tokensIn * unit[EV.TOKENS_IN] + w.tokensOut * unit[EV.TOKENS_OUT]);
  return {
    n: measured.length,
    withoutTokens: workflows.length - measured.length,
    costUsd:   stats(cost),
    tokensIn:  stats(measured.map((w) => w.tokensIn)),
    tokensOut: stats(measured.map((w) => w.tokensOut)),
    steps:     stats(measured.map((w) => w.steps)),
    sandboxMinutesPerWorkflow: sandbox.runs > 0 ? (sandbox.sandboxMinutes ?? 0) / sandbox.runs : null,
  };
}

// ─── Pricing ──────────────────────────────────────────────────────────────────

/** Round UP to `digits` significant figures so rounding never costs margin. */
export function ceilSig(x, digits = 4) {
  if (x === 0) return 0;
  const mag = Math.floor(Math.log10(Math.abs(x)));
  const f = 10 ** (digits - 1 - mag);
  return Math.ceil(x * f - 1e-9) / f;
}

const EVENTS = Object.values(EV);

/** USD cost of consuming a tier's whole allowance, or null if it has an unlimited one. */
export function allowanceCostUsd(tier, unit) {
  let total = 0;
  for (const ev of EVENTS) {
    const q = tier.allowance[ev];
    if (q === null) return null;
    total += q * unit[ev];
  }
  return total;
}

/**
 * @param {object} p
 * @param {Record<string, object>} p.tiers     tiers.js TIERS
 * @param {object} p.measured                  summarizeWorkflows() output
 * @param {Record<string, number>} p.unit      unitCostsFromEnv()
 * @param {number} p.margin                    target gross margin, 0 ≤ m ≤ 0.9
 * @param {number} [p.minSamples]
 * @returns {{ env: Record<string,string>, tiers: object, warnings: string[] }}
 */
export function proposePricing({ tiers, measured, unit, margin, minSamples = MIN_SAMPLES }) {
  if (!Number.isFinite(margin) || margin < 0 || margin > 0.9) {
    throw new Error('Target gross margin must be between 0 and 0.9 (e.g. 0.6 for 60%).');
  }
  if (!measured || measured.n < minSamples) {
    throw new Error(
      `Only ${measured?.n ?? 0} measured workflows; need at least ${minSamples} before cost per workflow means anything. ` +
      'Run more real workflows (or widen --days) and measure again.'
    );
  }

  const keep = 1 - margin;
  const warnings = [];
  const env = {};
  const out = {};

  // Overage per single unit — one price shared by every paid tier.
  const overage = {};
  for (const ev of EVENTS) overage[ev] = ceilSig(unit[ev] / keep);
  for (const ev of EVENTS) env[`OVERAGE_USD_${ev.toUpperCase()}`] = String(overage[ev]);
  for (const ev of [EV.WORKFLOW_RUN, EV.AGENT_STEP]) {
    if (unit[ev] === 0) {
      warnings.push(`${ev} overage is $0: no platform overhead cost was given (AEGIS_COST_PER_${ev === EV.WORKFLOW_RUN ? 'RUN' : 'STEP'}_USD). LLM cost is billed through the token meters.`);
    }
  }

  for (const [name, tier] of Object.entries(tiers)) {
    const row = {};
    const full = allowanceCostUsd(tier, unit);
    const capUsd = tier.spend.capUsd;
    const runs = tier.allowance[EV.WORKFLOW_RUN];

    row.allowanceCostUsd = full;
    row.spendCapUsd = capUsd;

    // Base price floor.
    if (tier.paid) {
      const basis = full ?? capUsd; // unlimited: the cap is the ceiling on LLM cost
      row.baseFloorUsd = Math.ceil(basis / keep - 1e-9);
      env[`BASE_USD_${name.toUpperCase()}`] = String(row.baseFloorUsd);
      if (full === null) row.note = 'unlimited allowance: floor is built from spend.capUsd — quote individually';
    }

    // What the measurement says about this tier's own numbers.
    if (runs != null) {
      row.expectedLlmCostAtP50 = runs * measured.costUsd.p50;
      row.expectedLlmCostAtP90 = runs * measured.costUsd.p90;
      const byIn  = measured.tokensIn.mean  > 0 ? tier.allowance[EV.TOKENS_IN]  / measured.tokensIn.mean  : Infinity;
      const byOut = measured.tokensOut.mean > 0 ? tier.allowance[EV.TOKENS_OUT] / measured.tokensOut.mean : Infinity;
      row.workflowsTheTokenAllowanceCovers = Math.floor(Math.min(byIn, byOut));
      if (row.workflowsTheTokenAllowanceCovers < runs) {
        warnings.push(
          `${name}: the token allowance covers ~${row.workflowsTheTokenAllowanceCovers} average workflows but the plan advertises ${runs} runs. ` +
          'Tenants will hit token overage well before the run allowance — raise the token allowance or lower the runs.'
        );
      }
    }

    if (full !== null && capUsd < full) {
      warnings.push(
        `${name}: spend.capUsd ($${capUsd}) is below the cost of the whole allowance ($${full.toFixed(2)}). ` +
        'The hard cap stops platform-key calls before the allowance is used, so its token overage can never bill.'
      );
    }
    if (!tier.paid) {
      // Free tier: your worst case per tenant per month.
      const worst = Math.min(capUsd, full ?? capUsd);
      row.worstCaseCostPerTenantUsd = worst;
      if (row.expectedLlmCostAtP90 > capUsd) {
        warnings.push(
          `${name}: ${runs} runs at the measured p90 cost ($${measured.costUsd.p90.toFixed(4)}) would be $${row.expectedLlmCostAtP90.toFixed(2)}, ` +
          `over the $${capUsd} cap — a busy free tenant hits the cap before the run limit.`
        );
      }
    }
    out[name] = row;
  }

  return { env, tiers: out, warnings };
}
