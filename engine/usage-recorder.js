/**
 * engine/usage-recorder.js
 *
 * Metering → billing bridge.
 *
 * tenant-quota.js tracks *live* counters (active workflows, queued jobs) in
 * Redis for rate-limiting — those counters are mutated and decremented, so
 * they can never be replayed into an invoice. This module is the append-only
 * companion: every billable action is written once, as an immutable row, to
 * Postgres. billing/stripe-reporter.js later aggregates and reports rows to
 * Stripe's Usage Records API and marks them reported.
 *
 * Table (created on first use):
 *   usage_events(
 *     id              BIGSERIAL PRIMARY KEY,
 *     tenant_id       TEXT        NOT NULL,
 *     event_type      TEXT        NOT NULL,   -- see EVENT_TYPES
 *     quantity        NUMERIC     NOT NULL,
 *     metadata        JSONB       NOT NULL DEFAULT '{}',
 *     occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
 *     reported_at     TIMESTAMPTZ,             -- NULL until pushed to Stripe
 *     stripe_usage_record_id TEXT
 *   )
 *
 * Recording is best-effort: a Postgres hiccup must never fail the workflow,
 * agent call, or sandbox run it's metering. Every export here swallows its
 * own errors and logs, matching the pattern already used by
 * engine/metrics.js recordAgentCost().
 *
 * Configuration: DATABASE_URL (standard libpq connection string).
 */

import pg from 'pg';
import { assertTenantId } from './tenant.js';
import { logger } from './logger.js';

const { Pool } = pg;

export const EVENT_TYPES = Object.freeze({
  WORKFLOW_RUN:    'workflow_run',
  AGENT_STEP:      'agent_step',
  TOKENS:          'tokens',
  SANDBOX_MINUTES: 'sandbox_minutes',
});

// ─── Lazy pool + schema init ───────────────────────────────────────────────────
// Constructed on first use, not at module load, so importing this module
// (e.g. transitively in tests) never opens a connection by itself.

let _pool = null;
let _schemaReady = null;

function getPool() {
  if (!_pool) {
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
    _pool.on('error', (err) => {
      // Idle client errors must not crash the process — same rationale as
      // the ioredis 'error' listener in metrics.js / tenant-quota.js.
      logger.error({ err }, '[usage-recorder] Postgres pool error');
    });
  }
  return _pool;
}

function ensureSchema() {
  if (!_schemaReady) {
    _schemaReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id                      BIGSERIAL PRIMARY KEY,
        tenant_id               TEXT NOT NULL,
        event_type              TEXT NOT NULL,
        quantity                NUMERIC NOT NULL,
        metadata                JSONB NOT NULL DEFAULT '{}',
        occurred_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        reported_at             TIMESTAMPTZ,
        stripe_usage_record_id  TEXT
      );
      CREATE INDEX IF NOT EXISTS usage_events_unreported_idx
        ON usage_events (tenant_id, event_type)
        WHERE reported_at IS NULL;
    `).catch((err) => {
      _schemaReady = null; // allow retry on next call
      throw err;
    });
  }
  return _schemaReady;
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Record one metered event. Fire-and-forget safe — never throws.
 *
 * @param {object} event
 * @param {string} event.tenantId
 * @param {string} event.eventType   - one of EVENT_TYPES
 * @param {number} event.quantity    - metered amount (e.g. 1 run, 1 step, N tokens, N minutes)
 * @param {object} [event.metadata]  - arbitrary JSON context (workflowId, agent, model, ...)
 * @returns {Promise<void>}
 */
export async function recordUsageEvent({ tenantId, eventType, quantity, metadata = {} }) {
  try {
    assertTenantId(tenantId);
    if (!Object.values(EVENT_TYPES).includes(eventType)) {
      throw new Error(`Unknown eventType: "${eventType}"`);
    }
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) {
      throw new Error(`Invalid quantity: ${quantity}`);
    }

    await ensureSchema();
    await getPool().query(
      `INSERT INTO usage_events (tenant_id, event_type, quantity, metadata)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, eventType, quantity, JSON.stringify(metadata)]
    );
  } catch (err) {
    logger.error({ err, tenantId, eventType }, '[usage-recorder] failed to record usage event');
  }
}

// ─── Read (for the Stripe reporter) ────────────────────────────────────────────

/**
 * Sum unreported quantity per tenant/event_type, for pushing to Stripe.
 *
 * @returns {Promise<Array<{ tenantId: string, eventType: string, quantity: number, ids: number[] }>>}
 */
export async function getUnreportedUsage() {
  await ensureSchema();
  const { rows } = await getPool().query(`
    SELECT tenant_id, event_type, SUM(quantity) AS quantity, array_agg(id) AS ids
    FROM usage_events
    WHERE reported_at IS NULL
    GROUP BY tenant_id, event_type
  `);
  return rows.map(r => ({
    tenantId:  r.tenant_id,
    eventType: r.event_type,
    quantity:  Number(r.quantity),
    ids:       r.ids,
  }));
}

/**
 * Sum a tenant's usage for one event type since a given timestamp, regardless
 * of report status. Used by billing/allowance.js to check consumption against
 * a tier's included allowance for the current billing period.
 *
 * @param {string} tenantId
 * @param {string} eventType  - one of EVENT_TYPES
 * @param {Date}   since      - start of the current billing period
 * @returns {Promise<number>}
 */
export async function getUsageInPeriod(tenantId, eventType, since) {
  assertTenantId(tenantId);
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT COALESCE(SUM(quantity), 0) AS quantity
     FROM usage_events
     WHERE tenant_id = $1 AND event_type = $2 AND occurred_at >= $3`,
    [tenantId, eventType, since]
  );
  return Number(rows[0].quantity);
}

/**
 * Mark a batch of rows as reported once Stripe has accepted the usage record.
 *
 * @param {number[]} ids
 * @param {string}   stripeUsageRecordId
 */
export async function markReported(ids, stripeUsageRecordId) {
  if (ids.length === 0) return;
  await ensureSchema();
  await getPool().query(
    `UPDATE usage_events
     SET reported_at = now(), stripe_usage_record_id = $2
     WHERE id = ANY($1::bigint[])`,
    [ids, stripeUsageRecordId]
  );
}
