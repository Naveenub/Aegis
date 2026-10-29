#!/usr/bin/env node
/**
 * bench/lib/submit-child.js — runs ONE task through the real Aegis engine and
 * prints a single JSON line to stdout.
 *
 * Executed as a child process (never imported by the harness) so the engine's
 * Redis connections and env-captured config stay out of the benchmark process,
 * and so AEGIS_REPO_ROOT can differ per task.
 *
 * Cost is the DELTA of the engine's own all-time cost counter
 * (aegis:metrics:cost:totals) across the run. That is the complete spend —
 * planner re-plans, retries and failed steps included, and it also covers a
 * run that dies before a workflowId exists. It is only correct when nothing
 * else is calling the engine on that Redis; bench/run.js documents this.
 *
 * argv: <tenantId> <taskPromptFile> <timeoutSec>
 */
import fs from 'fs';
import IORedis from 'ioredis';

const [tenantId, promptFile, timeoutSecRaw] = process.argv.slice(2);
const timeoutMs = Number(timeoutSecRaw) * 1000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const INFRA_RE = /credit balance|invalid x-api-key|authentication|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|overloaded|529|rate.?limit|SPEND_CAP|CREDITS_EXHAUSTED|GUARD_UNAVAILABLE/i;

const redis = new IORedis(process.env.REDIS_URL || undefined);
const readTotals = async () => {
  const h = await redis.hgetall('aegis:metrics:cost:totals');
  return { costUsd: Number(h.costUsd ?? 0), tokensIn: Number(h.tokensIn ?? 0), tokensOut: Number(h.tokensOut ?? 0), calls: Number(h.calls ?? 0) };
};
const out = (o) => { process.stdout.write(`\n@@RESULT@@${JSON.stringify(o)}\n`); };

try {
  const { runSystem } = await import('../../engine/orchestrator.js');
  const { getWorkflow } = await import('../../engine/workflow-store.js');

  const before = await readTotals();
  const prompt = fs.readFileSync(promptFile, 'utf-8');
  let workflowId = null;
  let status = 'failed';
  let error = null;
  let wf = null;

  try {
    workflowId = await runSystem(prompt, { tenantId });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      wf = await getWorkflow(workflowId);
      if (wf && TERMINAL.has(wf.status)) { status = wf.status; break; }
      // A step parked for human approval will never finish unattended.
      if (wf?.steps?.some((s) => s.status === 'needs-review')) { status = 'needs_review'; break; }
      if (Date.now() > deadline) { status = 'timeout'; break; }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (err) {
    error = String(err?.message ?? err);
    status = INFRA_RE.test(error) ? 'infra_error' : 'failed';
  }

  const after = await readTotals();
  out({
    status, error, workflowId,
    reason: wf?.reason ?? wf?.cancelReason ?? null,
    steps: wf?.steps?.length ?? 0,
    stepsCompleted: wf?.steps?.filter((s) => s.status === 'completed').length ?? 0,
    retries: wf?.steps?.reduce((n, s) => n + (s.retries ?? s.attempts ?? 0), 0) ?? 0,
    costUsd: after.costUsd - before.costUsd,
    tokensIn: after.tokensIn - before.tokensIn,
    tokensOut: after.tokensOut - before.tokensOut,
    llmCalls: after.calls - before.calls,
  });
} catch (err) {
  out({ status: 'infra_error', error: String(err?.stack ?? err) });
} finally {
  redis.disconnect();
  setTimeout(() => process.exit(0), 200);
}
