#!/usr/bin/env node
/**
 * scripts/migrate-token-split.js
 *
 * One-time migration for the tokens -> tokens_in/tokens_out meter split.
 * Dry-run by default; pass --apply to write.
 *
 *   1. usage_events: unreported legacy 'tokens' rows -> 'tokens_out'
 *      (worst-case rate; the in/out split of old rows is unknown).
 *   2. Stripe: on every subscription with metadata.tenantId, replace the item
 *      priced on the legacy `aegis_tokens` meter with the tenant tier's
 *      STRIPE_PRICE_{TIER}_TOKENS_IN / _TOKENS_OUT items.
 *
 * Run AFTER scripts/stripe-setup.js and AFTER the new env vars are set.
 *   STRIPE_SECRET_KEY=sk_... DATABASE_URL=... node scripts/migrate-token-split.js [--apply]
 */
import dotenv from 'dotenv';
import pg from 'pg';
import Stripe from 'stripe';
import { getTier } from '../engine/tenant-registry.js';

dotenv.config();
const apply = process.argv.includes('--apply');
const LEGACY_METER_EVENT = process.env.STRIPE_METER_EVENT_TOKENS || 'aegis_tokens';
console.log(`[migrate] ${apply ? 'APPLY' : 'DRY-RUN'}`);

// ── 1. usage_events ──────────────────────────────────────────────────────────
if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const where = `event_type='tokens' AND reported_at IS NULL`;
  try {
    const { rows } = await pool.query(`SELECT COUNT(*) AS n, COALESCE(SUM(quantity),0) AS q FROM usage_events WHERE ${where}`);
    console.log(`[migrate] unreported legacy token rows: ${rows[0].n} (${rows[0].q} tokens)`);
    if (apply && Number(rows[0].n) > 0) {
      const r = await pool.query(`UPDATE usage_events SET event_type='tokens_out' WHERE ${where}`);
      console.log(`[migrate] reclassified ${r.rowCount} rows -> tokens_out`);
    }
  } catch (err) {
    if (err.code === '42P01') console.log('[migrate] usage_events does not exist yet — nothing to move');
    else throw err;
  } finally {
    await pool.end();
  }
} else {
  console.warn('[migrate] DATABASE_URL not set — skipping usage_events step');
}

// ── 2. Stripe subscription items ─────────────────────────────────────────────
if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('[migrate] STRIPE_SECRET_KEY not set — skipping Stripe step');
  process.exit(0);
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const meterCache = new Map();
async function meterEventName(meterId) {
  if (!meterCache.has(meterId)) meterCache.set(meterId, (await stripe.billing.meters.retrieve(meterId)).event_name);
  return meterCache.get(meterId);
}
const price = (tier, suffix) => {
  const v = process.env[`STRIPE_PRICE_${tier.toUpperCase()}_${suffix}`];
  if (!v) throw new Error(`Missing STRIPE_PRICE_${tier.toUpperCase()}_${suffix}`);
  return v;
};

let changed = 0, skipped = 0;
for await (const sub of stripe.subscriptions.list({ status: 'all', limit: 100, expand: ['data.items.data.price'] })) {
  const tenantId = sub.metadata?.tenantId;
  if (!tenantId || ['canceled', 'incomplete_expired'].includes(sub.status)) continue;

  let legacy = null, hasNew = false;
  for (const item of sub.items.data) {
    const meterId = item.price?.recurring?.meter;
    if (!meterId) continue;
    const name = await meterEventName(meterId);
    if (name === LEGACY_METER_EVENT) legacy = item;
    if (name.endsWith('_tokens_in') || name.endsWith('_tokens_out')) hasNew = true;
  }
  if (!legacy) { skipped++; continue; }
  if (hasNew) { console.log(`[migrate] ${tenantId}: legacy + new items both present, removing legacy only`); }

  const tier = await getTier(tenantId);
  const items = [{ id: legacy.id, deleted: true, clear_usage: false }];
  if (!hasNew) items.push({ price: price(tier, 'TOKENS_IN') }, { price: price(tier, 'TOKENS_OUT') });
  console.log(`[migrate] ${tenantId} (${sub.id}, tier=${tier}): swap ${legacy.id} -> tokens_in/tokens_out`);
  if (apply) await stripe.subscriptions.update(sub.id, { items, proration_behavior: 'none' });
  changed++;
}
console.log(`[migrate] subscriptions ${apply ? 'updated' : 'to update'}=${changed} untouched=${skipped}`);
