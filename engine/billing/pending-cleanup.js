/**
 * engine/billing/pending-cleanup.js
 *
 * Reaps self-serve signups that never paid. A tenant is a candidate when its
 * status is 'pending' and it was created more than maxAgeHours ago (Stripe
 * expires an unpaid default_incomplete subscription after ~23h, so the
 * default 48h leaves slack for a delayed webhook).
 *
 * Per candidate, in order:
 *   1. Has a Stripe customer with a live subscription (active / trialing /
 *      past_due)? The payment webhook was missed — RECONCILE: set status
 *      active, do not delete.
 *   2. Otherwise delete the Stripe customer, revoke all API keys, remove the
 *      tenant from the registry, write an audit event.
 *   A Stripe failure skips the tenant (retried next run) — nothing local is
 *   deleted unless Stripe was handled first.
 *
 * Only 'pending' tenants are touched. 'suspended' tenants (paid at some
 * point) and tenants with no status (design partners, env-seeded) never are.
 */

import { listTenants, getTenant, getStripeCustomerId, setStatus, removeTenant } from '../tenant-registry.js';
import { listKeys, revokeKey } from '../key-store.js';
import { hasLiveSubscription, deleteCustomer } from './stripe-customer.js';
import { recordAuditEvent } from '../audit-log.js';
import { logger } from '../logger.js';

/**
 * @param {{ maxAgeHours?: number, dryRun?: boolean, now?: number }} [opts]
 * @returns {Promise<{ removed: string[], reconciled: string[], failed: string[], kept: number }>}
 */
export async function cleanupPendingTenants({ maxAgeHours = 48, dryRun = false, now = Date.now() } = {}) {
  const cutoff = now - maxAgeHours * 3600 * 1000;
  const result = { removed: [], reconciled: [], failed: [], kept: 0 };

  for (const tenantId of await listTenants()) {
    const tenant = await getTenant(tenantId);
    const createdAt = Number(tenant?.createdAt);
    if (!tenant || tenant.status !== 'pending' || !Number.isFinite(createdAt) || createdAt > cutoff) {
      result.kept++;
      continue;
    }

    try {
      const customerId = await getStripeCustomerId(tenantId);

      if (customerId && await hasLiveSubscription(customerId)) {
        if (!dryRun) await setStatus(tenantId, 'active');
        result.reconciled.push(tenantId);
        logger.warn({ tenantId }, '[pending-cleanup] live subscription found — reconciled to active');
        continue;
      }

      if (!dryRun) {
        if (customerId) await deleteCustomer(customerId);
        for (const key of await listKeys(tenantId)) await revokeKey(tenantId, key.keyId);
        await removeTenant(tenantId);
        await recordAuditEvent(tenantId, {
          actorId: 'pending-cleanup',
          actorType: 'system',
          action: 'tenant.cleanup',
          resourceType: 'tenant',
          resourceId: tenantId,
          detail: { reason: 'never paid', maxAgeHours, stripeCustomerId: customerId },
        }).catch((err) => logger.error({ err, tenantId }, '[pending-cleanup] audit write failed'));
      }
      result.removed.push(tenantId);
    } catch (err) {
      logger.error({ err, tenantId }, '[pending-cleanup] failed — will retry next run');
      result.failed.push(tenantId);
    }
  }

  return result;
}
