#!/usr/bin/env node
/**
 * scripts/onboard-design-partner.js
 *
 * Registers a tenant and issues an API key — the same two steps as
 * POST /tenants + POST /tenants/:id/keys (server.js), called directly so
 * you don't need a running server or an admin key to onboard someone.
 *
 * No Stripe involved. Bill the partner manually via a Stripe Payment Link;
 * engine/billing/* stays dormant until you wire up self-serve signup.
 *
 * Usage:
 *   node scripts/onboard-design-partner.js <tenantId> [label] [tier]
 *
 *   tenantId  required — e.g. "acme"
 *   label     optional — human-readable name, defaults to tenantId
 *   tier      optional — starter|pro|enterprise, defaults to starter
 *
 * Example:
 *   node scripts/onboard-design-partner.js acme "Acme Design Partner"
 */
import dotenv from 'dotenv';
import { registerTenant, setTier } from '../engine/tenant-registry.js';
import { setQuota } from '../engine/tenant-quota.js';
import { createKey } from '../engine/key-store.js';
import { getTierConfig, TIERS, DEFAULT_TIER } from '../engine/billing/tiers.js';

dotenv.config();

const [tenantId, label, tier = DEFAULT_TIER] = process.argv.slice(2);

if (!tenantId) {
  console.error('[onboard-design-partner] Usage: node scripts/onboard-design-partner.js <tenantId> [label] [tier]');
  process.exit(2);
}
if (!TIERS[tier]) {
  console.error(`[onboard-design-partner] Unknown tier "${tier}". Valid: ${Object.keys(TIERS).join(', ')}.`);
  process.exit(2);
}

const tenant = await registerTenant(tenantId, { label });
await setTier(tenantId, tier);
await setQuota(tenantId, getTierConfig(tier).quota);
const { rawKey } = await createKey(tenantId, { label: label || 'design-partner' });

console.log(`[onboard-design-partner] tenant=${tenantId} tier=${tier} created=${tenant.created}`);
console.log(`[onboard-design-partner] API key (shown once): ${rawKey}`);
process.exit(0);
