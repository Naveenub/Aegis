#!/usr/bin/env node
/**
 * scripts/propose-pricing.js
 *
 * Turns measured cost per workflow (scripts/measure-cost.js) into the prices
 * stripe-setup.js takes, and checks every tier in engine/billing/tiers.js
 * (including the free tier's cap and allowances) against the measurement.
 * Prints; changes nothing, calls nothing.
 *
 *   TARGET_GROSS_MARGIN=0.6 AEGIS_COST_SANDBOX_PER_MIN=0.002 \
 *     node scripts/propose-pricing.js --measured=measured-cost.json [--json]
 *
 * Required:  TARGET_GROSS_MARGIN (0–0.9)   AEGIS_COST_SANDBOX_PER_MIN (your infra cost / minute)
 * Optional:  AEGIS_COST_INPUT_PER_MTOK / AEGIS_COST_OUTPUT_PER_MTOK (default 3 / 15),
 *            AEGIS_COST_PER_RUN_USD / AEGIS_COST_PER_STEP_USD (platform overhead, default 0),
 *            MIN_SAMPLES (default 30 workflows)
 *
 * The base prices it prints are FLOORS: they keep the margin even if a tenant
 * uses the whole allowance. Charging more is a positioning decision; charging
 * less means the allowance is subsidised. Read the warnings before using them.
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
import { TIERS } from '../engine/billing/tiers.js';
import { proposePricing, unitCostsFromEnv, MIN_SAMPLES } from '../engine/billing/pricing-model.js';

dotenv.config();

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const fail = (m) => { console.error(`[propose-pricing] ${m}`); process.exit(2); };

const file = arg('measured');
if (!file) fail('--measured=<file from scripts/measure-cost.js> is required.');
if (process.env.TARGET_GROSS_MARGIN === undefined || process.env.TARGET_GROSS_MARGIN === '') {
  fail('TARGET_GROSS_MARGIN is required (e.g. 0.6 for 60%). It is not defaulted.');
}

let result, measured;
try {
  measured = JSON.parse(fs.readFileSync(file, 'utf8'));
  result = proposePricing({
    tiers: TIERS,
    measured,
    unit: unitCostsFromEnv(),
    margin: Number(process.env.TARGET_GROSS_MARGIN),
    minSamples: Number(process.env.MIN_SAMPLES ?? MIN_SAMPLES),
  });
} catch (err) {
  fail(err.message);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const usd = (n, d = 2) => (n == null ? '—' : `$${Number(n).toFixed(d)}`);
console.log(`# Measured: ${measured.n} workflows over ${measured.window?.days ?? '?'} days`);
console.log(`#   LLM cost / workflow   mean ${usd(measured.costUsd.mean, 4)}   p50 ${usd(measured.costUsd.p50, 4)}   p90 ${usd(measured.costUsd.p90, 4)}   p99 ${usd(measured.costUsd.p99, 4)}`);
console.log(`#   tokens / workflow     in ${Math.round(measured.tokensIn.mean)}   out ${Math.round(measured.tokensOut.mean)}   steps ${measured.steps.mean.toFixed(1)}`);
console.log(`#   sandbox min / workflow ${measured.sandboxMinutesPerWorkflow == null ? '—' : measured.sandboxMinutesPerWorkflow.toFixed(2)} (window total ÷ workflows)`);
console.log(`# Target gross margin ${(Number(process.env.TARGET_GROSS_MARGIN) * 100).toFixed(0)}%\n`);

for (const [name, t] of Object.entries(result.tiers)) {
  console.log(`## ${name}`);
  console.log(`   cost of using the whole allowance  ${usd(t.allowanceCostUsd)}   hard LLM cap ${usd(t.spendCapUsd)}`);
  if (t.expectedLlmCostAtP50 !== undefined) {
    console.log(`   advertised runs at measured cost   p50 ${usd(t.expectedLlmCostAtP50)}   p90 ${usd(t.expectedLlmCostAtP90)}   (token allowance covers ~${t.workflowsTheTokenAllowanceCovers} avg workflows)`);
  }
  if (t.baseFloorUsd !== undefined) console.log(`   base price floor                   ${usd(t.baseFloorUsd, 0)} / month${t.note ? `  (${t.note})` : ''}`);
  if (t.worstCaseCostPerTenantUsd !== undefined) console.log(`   your worst-case cost per tenant    ${usd(t.worstCaseCostPerTenantUsd)} / month`);
}

if (result.warnings.length) {
  console.log('\n# Warnings');
  for (const w of result.warnings) console.log(`#  - ${w}`);
}

console.log('\n# Paste into the environment for scripts/stripe-setup.js');
for (const [k, v] of Object.entries(result.env)) console.log(`${k}=${v}`);
