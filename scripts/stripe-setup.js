#!/usr/bin/env node
/**
 * scripts/stripe-setup.js
 *
 * One-time Stripe provisioning: 4 Billing Meters, 3 base prices, and 12
 * per-tier metered prices (graduated — the tier's included allowance from
 * engine/billing/tiers.js is the free band, overage above it is charged).
 * Prints the env lines for .env / k8s secrets.
 *
 * You supply the money (nothing is defaulted):
 *   BASE_USD_STARTER, BASE_USD_PRO, BASE_USD_ENTERPRISE   monthly base, USD
 *   OVERAGE_USD_WORKFLOW_RUN, OVERAGE_USD_AGENT_STEP,
 *   OVERAGE_USD_TOKENS, OVERAGE_USD_SANDBOX_MINUTES       USD per single unit
 *     (tokens are per token, e.g. 0.000005 = $5 per 1M)
 *
 *   STRIPE_SECRET_KEY=sk_... BASE_USD_STARTER=... node scripts/stripe-setup.js [--dry-run]
 *
 * Not idempotent: run once per Stripe account/mode. Use a test-mode key first.
 */
import dotenv from 'dotenv';
import Stripe from 'stripe';
import { TIERS } from '../engine/billing/tiers.js';
import { EVENT_TYPES } from '../engine/usage-recorder.js';
import { meterEventName } from '../engine/billing/stripe-reporter.js';

dotenv.config();
const dryRun = process.argv.includes('--dry-run');

function need(name) {
  const v = process.env[name];
  if (v === undefined || v === '' || Number.isNaN(Number(v)) || Number(v) < 0) {
    console.error(`[stripe-setup] ${name} is required (non-negative number, USD).`);
    process.exit(2);
  }
  return Number(v);
}

const base = {};
for (const tier of Object.keys(TIERS)) base[tier] = need(`BASE_USD_${tier.toUpperCase()}`);
const overage = {};
for (const ev of Object.values(EVENT_TYPES)) overage[ev] = need(`OVERAGE_USD_${ev.toUpperCase()}`);

if (!dryRun && !process.env.STRIPE_SECRET_KEY) {
  console.error('[stripe-setup] STRIPE_SECRET_KEY is required.');
  process.exit(2);
}
const stripe = dryRun ? null : new Stripe(process.env.STRIPE_SECRET_KEY);
const cents = (usd) => String(+(usd * 100).toFixed(10)); // unit_amount_decimal, in cents

async function call(label, params, fn) {
  if (dryRun) {
    console.log(`# ${label}\n${JSON.stringify(params)}`);
    return { id: `dry_${label.replace(/\W+/g, '_')}` };
  }
  return fn(params);
}

const env = [];

const meters = {};
for (const ev of Object.values(EVENT_TYPES)) {
  const m = await call(`meter ${ev}`, {
    display_name: `AEGIS ${ev}`,
    event_name: meterEventName(ev),
    default_aggregation: { formula: 'sum' },
    customer_mapping: { event_payload_key: 'stripe_customer_id', type: 'by_id' },
    value_settings: { event_payload_key: 'value' },
  }, (p) => stripe.billing.meters.create(p));
  meters[ev] = m.id;
}

for (const [tier, cfg] of Object.entries(TIERS)) {
  const T = tier.toUpperCase();
  const bp = await call(`base ${tier}`, {
    currency: 'usd',
    unit_amount_decimal: cents(base[tier]),
    recurring: { interval: 'month' },
    product_data: { name: `AEGIS ${cfg.label}` },
  }, (p) => stripe.prices.create(p));
  env.push(`STRIPE_PRICE_${T}=${bp.id}`);

  for (const ev of Object.values(EVENT_TYPES)) {
    const included = cfg.allowance[ev]; // null = unlimited
    const tiers = included === null
      ? [{ up_to: 'inf', unit_amount_decimal: '0' }]
      : [
          { up_to: included, unit_amount_decimal: '0' },
          { up_to: 'inf', unit_amount_decimal: cents(overage[ev]) },
        ];
    const mp = await call(`metered ${tier} ${ev}`, {
      currency: 'usd',
      billing_scheme: 'tiered',
      tiers_mode: 'graduated',
      tiers,
      recurring: { interval: 'month', usage_type: 'metered', meter: meters[ev] },
      product_data: { name: `AEGIS ${cfg.label} — ${ev} overage` },
    }, (p) => stripe.prices.create(p));
    env.push(`STRIPE_PRICE_${T}_${ev.toUpperCase()}=${mp.id}`);
  }
}

console.log('\n# ── add to .env / k8s secret ──');
console.log(env.join('\n'));
