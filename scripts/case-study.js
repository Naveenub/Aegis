#!/usr/bin/env node
/**
 * scripts/case-study.js — design-partner case study from real PR outcomes.
 *
 *   node scripts/case-study.js export <tenantId> [--out ledger.json]
 *       Skeleton ledger from the engine: one entry per workflow for that tenant,
 *       with LLM cost and wall time from Aegis's own metering. You then fill in,
 *       per PR: prUrl, outcome (merged|merged_edited|closed|open), reviewMinutes,
 *       fixupMinutes, baselineMinutes — facts only the partner knows.
 *
 *   node scripts/case-study.js render <ledger.json> <partner.json> [--out study.md]
 *       Render the case study. Refuses to name the partner without recorded
 *       consent; prints "not measured" for anything missing; marks the result
 *       DRAFT until it is publishable. See docs-site/docs/case-studies/.
 */
import fs from 'fs';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };

if (cmd === 'export') {
  const tenantId = rest[0];
  if (!tenantId || tenantId.startsWith('--')) { console.error('usage: case-study.js export <tenantId> [--out ledger.json]'); process.exit(2); }
  const { listWorkflows } = await import('../engine/workflow-store.js');
  const { default: IORedis } = await import('ioredis');
  const redis = new IORedis(process.env.REDIS_URL || undefined);
  const { workflows } = await listWorkflows({ tenantId, limit: 1000 });
  const ledger = [];
  for (const w of workflows.sort((a, b) => a.createdAt - b.createdAt)) {
    const c = await redis.hgetall(`aegis:metrics:cost:workflow:${w.id}`);
    const end = w.completedAt ?? w.failedAt ?? null;
    ledger.push({
      workflowId: w.id,
      title: null,
      prUrl: null,           // FILL IN
      outcome: 'open',       // FILL IN: merged | merged_edited | closed | open
      aegisStatus: w.status,
      costUsd: c.costUsd ? Number(c.costUsd) : null,
      wallSeconds: end && w.startedAt ? (end - w.startedAt) / 1000 : null,
      reviewMinutes: null,   // FILL IN
      fixupMinutes: null,    // FILL IN (0 if merged as-is)
      baselineMinutes: null, // FILL IN
    });
  }
  redis.disconnect();
  const out = flag('--out') ?? `case-study-ledger-${tenantId}.json`;
  fs.writeFileSync(out, JSON.stringify(ledger, null, 2) + '\n');
  console.info(`wrote ${ledger.length} workflow(s) → ${out}\nFill in the FILL IN fields from the partner's repo, then run render.`);
  process.exit(0);
} else if (cmd === 'render') {
  const [ledgerPath, partnerPath] = rest;
  if (!ledgerPath || !partnerPath) { console.error('usage: case-study.js render <ledger.json> <partner.json> [--out study.md]'); process.exit(2); }
  const { buildCaseStudy } = await import('../bench/lib/case-study.js');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
  const inputs = JSON.parse(fs.readFileSync(partnerPath, 'utf-8'));
  const { markdown, publishable, problems } = buildCaseStudy(ledger, inputs);
  const out = flag('--out') ?? 'case-study.md';
  fs.writeFileSync(out, markdown);
  console.info(`wrote ${out} — ${publishable ? 'PUBLISHABLE' : 'DRAFT (not publishable)'}`);
  for (const p of problems) console.info(`  ✗ ${p}`);
  process.exit(0);
} else {
  console.error('usage: case-study.js <export|render> ...');
  process.exit(2);
}
