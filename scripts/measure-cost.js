#!/usr/bin/env node
/**
 * scripts/measure-cost.js
 *
 * Measures what a workflow actually costs, from the usage_events table the
 * billing pipeline already writes (engine/usage-recorder.js). Run it against
 * the database of a deployment that has run REAL workloads — a staging box
 * running your own repos is fine; an empty database is refused downstream.
 *
 *   DATABASE_URL=postgres://... node scripts/measure-cost.js --days=30 --out=measured-cost.json
 *   flags: --days=<n>               window (default 30)
 *          --tenants=a,b            only these tenants
 *          --exclude-tenants=a,b    drop test / load-test tenants
 *
 * What is measured per workflow that started in the window: input tokens,
 * output tokens, agent steps → LLM cost at the unit prices in
 * AEGIS_COST_INPUT_PER_MTOK / AEGIS_COST_OUTPUT_PER_MTOK (default 3 / 15).
 *
 * Two limits, both printed in the output:
 *  - sandbox_minutes events carry no workflowId, so sandbox time is reported as
 *    window total ÷ workflows started, not per workflow.
 *  - BYOK tenants' tokens are not recorded (the platform doesn't pay for them);
 *    workflows with no recorded tokens are excluded and counted, not averaged in as $0.
 *
 * Then: node scripts/propose-pricing.js --measured=measured-cost.json
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
import pg from 'pg';
import { EVENT_TYPES as EV } from '../engine/usage-recorder.js';
import { summarizeWorkflows } from '../engine/billing/pricing-model.js';

dotenv.config();

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);
const days = Number(arg('days') ?? 30);
if (!Number.isFinite(days) || days <= 0) { console.error('[measure-cost] --days must be a positive number.'); process.exit(2); }
if (!process.env.DATABASE_URL) { console.error('[measure-cost] DATABASE_URL is required.'); process.exit(2); }

const unit = {
  [EV.TOKENS_IN]:  Number(process.env.AEGIS_COST_INPUT_PER_MTOK  ?? 3)  / 1e6,
  [EV.TOKENS_OUT]: Number(process.env.AEGIS_COST_OUTPUT_PER_MTOK ?? 15) / 1e6,
};
const since = new Date(Date.now() - days * 86_400_000);
const include = list(arg('tenants'));
const exclude = list(arg('exclude-tenants'));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const { rows } = await pool.query(
    `SELECT metadata->>'workflowId' AS workflow_id, event_type, SUM(quantity)::float8 AS qty
       FROM usage_events
      WHERE occurred_at >= $1
        AND metadata ? 'workflowId'
        AND event_type = ANY($4::text[])
        AND ($2::text[] IS NULL OR tenant_id = ANY($2))
        AND ($3::text[] IS NULL OR NOT (tenant_id = ANY($3)))
      GROUP BY 1, 2`,
    [since, include, exclude, [EV.WORKFLOW_RUN, EV.AGENT_STEP, EV.TOKENS_IN, EV.TOKENS_OUT]]
  );

  const byWf = new Map();
  for (const r of rows) {
    const w = byWf.get(r.workflow_id) ?? { workflowId: r.workflow_id, started: false, tokensIn: 0, tokensOut: 0, steps: 0 };
    if (r.event_type === EV.WORKFLOW_RUN) w.started = true;
    if (r.event_type === EV.TOKENS_IN)  w.tokensIn  = r.qty;
    if (r.event_type === EV.TOKENS_OUT) w.tokensOut = r.qty;
    if (r.event_type === EV.AGENT_STEP) w.steps     = r.qty;
    byWf.set(r.workflow_id, w);
  }
  // Only workflows that started inside the window, so a workflow's tokens are not
  // counted without its run (or the reverse).
  const workflows = [...byWf.values()].filter((w) => w.started);

  const { rows: [sb] } = await pool.query(
    `SELECT
       COALESCE(SUM(quantity) FILTER (WHERE event_type = $4), 0)::float8 AS minutes,
       COUNT(*)               FILTER (WHERE event_type = $5)              AS runs
     FROM usage_events
     WHERE occurred_at >= $1
       AND ($2::text[] IS NULL OR tenant_id = ANY($2))
       AND ($3::text[] IS NULL OR NOT (tenant_id = ANY($3)))`,
    [since, include, exclude, EV.SANDBOX_MINUTES, EV.WORKFLOW_RUN]
  );

  const measured = {
    window: { days, since: since.toISOString(), tenants: include, excludedTenants: exclude },
    unitCostsUsedPerToken: unit,
    ...summarizeWorkflows(workflows, unit, { sandboxMinutes: sb.minutes, runs: Number(sb.runs) }),
  };

  const json = JSON.stringify(measured, null, 2);
  const out = arg('out');
  if (out) fs.writeFileSync(out, json + '\n');
  console.log(json);
  console.error(
    `\n[measure-cost] ${measured.n} workflows measured` +
    (measured.withoutTokens ? `, ${measured.withoutTokens} excluded (no platform-key tokens recorded)` : '') +
    (out ? ` → ${out}` : '')
  );
} finally {
  await pool.end();
}
