/**
 * One-time, run BEFORE deploying spend-guard: stamps firstPaidAt on existing
 * active, Stripe-backed tenants so they are not held to the unverified cap.
 *   node scripts/backfill-first-paid.js [--dry-run]
 */
import dotenv from 'dotenv';
import { listTenants, getTenant, getStripeCustomerId, markFirstPaid, getFirstPaid } from '../engine/tenant-registry.js';

dotenv.config();
const dry = process.argv.includes('--dry-run');
let n = 0;
for (const id of await listTenants()) {
  const t = await getTenant(id);
  if (!t || (t.status && t.status !== 'active')) continue;
  if (!(await getStripeCustomerId(id)) || (await getFirstPaid(id))) continue;
  console.log(`${dry ? '[dry-run] ' : ''}firstPaidAt ← now: ${id}`);
  if (!dry) await markFirstPaid(id);
  n++;
}
console.log(`done: ${n} tenant(s)`);
process.exit(0);
