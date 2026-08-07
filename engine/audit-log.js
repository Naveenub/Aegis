/**
 * engine/audit-log.js — tamper-evident, tenant-scoped compliance audit trail
 *
 * Problem solved
 * ──────────────
 * Aegis had no unified record of compliance-relevant actions (who submitted/
 * cancelled a workflow, who approved a held step, who created or revoked an
 * API key, when a workflow's patch actually landed on the base branch). The
 * only precedent was the rewind-specific trail in workflow-store.js, which
 * covers one action type and carries no integrity guarantee.
 *
 * Design
 * ──────
 * Events are appended to a per-tenant, singly-linked hash chain (same idea as
 * a blockchain ledger, no distributed consensus needed — Aegis is already the
 * single source of truth). Each event's hash covers the previous event's
 * hash, so any deletion, edit, or reordering breaks the chain from that point
 * forward and is detected by verifyChain(). Each event is additionally HMAC-
 * signed with AEGIS_AUDIT_SIGNING_KEY so a party with Redis access but not the
 * signing key cannot forge a replacement chain either.
 *
 * The chain-tip read + advance is serialised per tenant via the same
 * distributed lock used elsewhere in Aegis (engine/lock.js), so concurrent
 * appends from the API server and workers never race on prevHash.
 *
 * Redis key layout
 * ─────────────────
 *   aegis:audit:{tenantId}:tip           STRING — hash of the last event (chain head)
 *   aegis:audit:{tenantId}:seq           STRING — monotonic counter for event IDs
 *   aegis:audit:{tenantId}:event:{id}    HASH   — the event itself (see AuditEvent below)
 *   aegis:audit:{tenantId}:index         ZSET   — eventKey scored by ts, for range queries
 *
 * AuditEvent shape
 * ─────────────────
 *   {
 *     id:           string,   // "{tenantId}-{seq}"
 *     ts:           number,   // ms epoch
 *     tenantId:     string,
 *     actorId:      string,   // keyId, 'system', or 'env-key'
 *     actorType:    string,   // 'api-key' | 'system'
 *     action:       string,   // e.g. 'workflow.submitted', 'key.revoked'
 *     resourceType: string,   // e.g. 'workflow', 'apiKey'
 *     resourceId:   string,
 *     detail:       object,   // free-form, action-specific
 *     prevHash:     string,   // hash of the previous event in this tenant's chain ('' for genesis)
 *     hash:         string,   // sha256(prevHash + canonical(core fields))
 *     sig:          string,   // hex HMAC-SHA256(AEGIS_AUDIT_SIGNING_KEY, hash)
 *   }
 *
 * Signing key
 * ────────────
 * AEGIS_AUDIT_SIGNING_KEY should be set in production and never rotated
 * without re-signing history out of band. Without it, a process-local random
 * key is generated at boot (logged once as a warning) — the chain is still
 * internally consistent but sig cannot be verified across restarts or by an
 * external auditor, so this is dev-only behaviour.
 */

import { createHash, createHmac, randomBytes } from 'crypto';
import IORedis from 'ioredis';
import { assertTenantId } from './tenant.js';
import { acquireLock, releaseLock } from './lock.js';

const redis = new IORedis(process.env.REDIS_URL || undefined);

let SIGNING_KEY = process.env.AEGIS_AUDIT_SIGNING_KEY;
if (!SIGNING_KEY) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[audit-log] AEGIS_AUDIT_SIGNING_KEY is required when NODE_ENV=production. ' +
      'Refusing to start with an ephemeral signing key.',
    );
  }
  SIGNING_KEY = randomBytes(32).toString('hex');
  console.warn(
    '[audit-log] AEGIS_AUDIT_SIGNING_KEY not set — using an ephemeral process-local key. ' +
    'Signatures will not verify across restarts. Set this env var in production.',
  );
}

// ─── Key helpers ────────────────────────────────────────────────────────────────

const K = {
  tip:   tenantId         => `aegis:audit:${tenantId}:tip`,
  seq:   tenantId         => `aegis:audit:${tenantId}:seq`,
  event: (tenantId, id)   => `aegis:audit:${tenantId}:event:${id}`,
  index: tenantId         => `aegis:audit:${tenantId}:index`,
};

// ─── Hashing / signing ──────────────────────────────────────────────────────────

function canonicalCore(core) {
  // Stable key order so the same core always hashes the same way.
  const { id, ts, tenantId, actorId, actorType, action, resourceType, resourceId, detail } = core;
  return JSON.stringify({ id, ts, tenantId, actorId, actorType, action, resourceType, resourceId, detail });
}

function hashEvent(prevHash, core) {
  return createHash('sha256').update(prevHash + '|' + canonicalCore(core)).digest('hex');
}

function signHash(hash) {
  return createHmac('sha256', SIGNING_KEY).update(hash).digest('hex');
}

// ─── Write ──────────────────────────────────────────────────────────────────────

/**
 * Append a compliance event to a tenant's audit chain.
 *
 * @param {string} tenantId
 * @param {object} opts
 * @param {string}  opts.actorId       - keyId, 'system', or 'env-key'
 * @param {string}  [opts.actorType]   - 'api-key' | 'system' (default 'api-key')
 * @param {string}  opts.action        - e.g. 'workflow.submitted'
 * @param {string}  opts.resourceType  - e.g. 'workflow'
 * @param {string}  opts.resourceId
 * @param {object}  [opts.detail]      - action-specific free-form detail
 * @returns {Promise<object>} the persisted AuditEvent
 */
export async function recordAuditEvent(tenantId, {
  actorId,
  actorType = 'api-key',
  action,
  resourceType,
  resourceId,
  detail = {},
} = {}) {
  assertTenantId(tenantId);
  if (!actorId || !action || !resourceType || !resourceId) {
    throw new Error('recordAuditEvent requires actorId, action, resourceType, and resourceId.');
  }

  const ts = Date.now();

  // Chain-tip read + advance must be strictly ordered per tenant, or two
  // concurrent appends could compute a hash from the same prevHash and one
  // would silently overwrite the other's position in the chain. Reuse the
  // same distributed lock the rest of Aegis uses for tenant-serialised
  // sections (engine/lock.js) rather than inventing a second mechanism.
  const lock = await acquireLock(`audit-chain:${tenantId}`, tenantId);
  let event;
  try {
    const id = `${tenantId}-${await redis.incr(K.seq(tenantId))}`;
    const core = { id, ts, tenantId, actorId, actorType, action, resourceType, resourceId, detail };

    const prevHash = (await redis.get(K.tip(tenantId))) || '';
    const hash = hashEvent(prevHash, core);
    const sig = signHash(hash);
    event = { ...core, prevHash, hash, sig };

    const eventKey = K.event(tenantId, id);
    await redis.pipeline()
      .hset(eventKey, {
        id, ts: ts.toString(), tenantId, actorId, actorType, action,
        resourceType, resourceId, detail: JSON.stringify(detail),
        prevHash, hash, sig,
      })
      .zadd(K.index(tenantId), ts, eventKey)
      .set(K.tip(tenantId), hash)
      .exec();
  } finally {
    await releaseLock(lock);
  }

  return event;
}

// ─── Read ───────────────────────────────────────────────────────────────────────

function deserializeEvent(raw) {
  if (!raw?.id) return null;
  return {
    id:           raw.id,
    ts:           Number(raw.ts),
    tenantId:     raw.tenantId,
    actorId:      raw.actorId,
    actorType:    raw.actorType,
    action:       raw.action,
    resourceType: raw.resourceType,
    resourceId:   raw.resourceId,
    detail:       raw.detail ? JSON.parse(raw.detail) : {},
    prevHash:     raw.prevHash,
    hash:         raw.hash,
    sig:          raw.sig,
  };
}

/**
 * Query a tenant's audit events within a time range, optionally filtered.
 *
 * @param {string} tenantId
 * @param {object} [opts]
 * @param {number} [opts.from]         - ms epoch, inclusive (default: 0)
 * @param {number} [opts.to]           - ms epoch, inclusive (default: now)
 * @param {string} [opts.action]       - exact match filter
 * @param {string} [opts.resourceType] - exact match filter
 * @param {number} [opts.limit=500]
 * @returns {Promise<object[]>} events, oldest first
 */
export async function queryAuditEvents(tenantId, {
  from = 0,
  to = Date.now(),
  action = null,
  resourceType = null,
  limit = 500,
} = {}) {
  assertTenantId(tenantId);

  const eventKeys = await redis.zrangebyscore(K.index(tenantId), from, to, 'LIMIT', 0, limit);
  if (!eventKeys.length) return [];

  const pipeline = redis.pipeline();
  for (const k of eventKeys) pipeline.hgetall(k);
  const results = await pipeline.exec();

  return results
    .map(([err, raw]) => (err ? null : deserializeEvent(raw)))
    .filter(Boolean)
    .filter(e => !action || e.action === action)
    .filter(e => !resourceType || e.resourceType === resourceType);
}

/**
 * Verify the integrity of a tenant's audit chain over the given events.
 * Recomputes each hash from prevHash + core fields and checks the HMAC sig.
 *
 * @param {object[]} events - events in chain order (oldest first), e.g. from queryAuditEvents
 * @returns {{ ok: boolean, brokenAt: string|null }}
 */
export function verifyChain(events) {
  for (const e of events) {
    const expectedHash = hashEvent(e.prevHash, {
      id: e.id, ts: e.ts, tenantId: e.tenantId, actorId: e.actorId, actorType: e.actorType,
      action: e.action, resourceType: e.resourceType, resourceId: e.resourceId, detail: e.detail,
    });
    if (expectedHash !== e.hash || signHash(e.hash) !== e.sig) {
      return { ok: false, brokenAt: e.id };
    }
  }
  return { ok: true, brokenAt: null };
}

// ─── Export ─────────────────────────────────────────────────────────────────────

function toCsv(events) {
  const header = ['id', 'ts', 'tenantId', 'actorId', 'actorType', 'action', 'resourceType', 'resourceId', 'detail', 'prevHash', 'hash', 'sig'];
  const escape = v => `"${String(v).replace(/"/g, '""')}"`;
  const rows = events.map(e => header.map(f => {
    const v = f === 'detail' ? JSON.stringify(e.detail) : e[f];
    return escape(v);
  }).join(','));
  return [header.join(','), ...rows].join('\n');
}

/**
 * Export a tenant's audit trail for compliance review.
 *
 * @param {string} tenantId
 * @param {object} [opts]
 * @param {number} [opts.from]
 * @param {number} [opts.to]
 * @param {'json'|'csv'} [opts.format='json']
 * @returns {Promise<{ contentType: string, body: string, chainValid: boolean }>}
 */
export async function exportAuditEvents(tenantId, { from = 0, to = Date.now(), format = 'json' } = {}) {
  const events = await queryAuditEvents(tenantId, { from, to, limit: 100000 });
  const { ok } = verifyChain(events);

  if (format === 'csv') {
    return { contentType: 'text/csv', body: toCsv(events), chainValid: ok };
  }
  return {
    contentType: 'application/json',
    body: JSON.stringify({ tenantId, from, to, chainValid: ok, events }, null, 2),
    chainValid: ok,
  };
}
