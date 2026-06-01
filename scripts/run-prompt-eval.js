#!/usr/bin/env node
/**
 * scripts/run-prompt-eval.js
 *
 * CI entry-point for the agent prompt evaluation harness.
 *
 * Calls evalAll() against the real Claude API, prints the full report, and
 * exits with code 1 if any agent falls below its pass-rate threshold so the
 * CI job fails the build.
 *
 * Usage
 * ─────
 *   node scripts/run-prompt-eval.js          # called by `npm run eval`
 *
 * Environment
 * ───────────
 *   ANTHROPIC_API_KEY  (required) — forwarded automatically to runAgent()
 *   REDIS_URL          (optional) — defaults to redis://localhost:6379
 */

import { evalAll } from '../engine/prompt-eval.js';

async function main() {
  console.log('[prompt-eval] Starting agent persona evaluation…\n');

  let report;
  try {
    report = await evalAll();
  } catch (err) {
    console.error('[prompt-eval] Fatal error during eval run:', err);
    process.exit(2);
  }

  // ── Print full per-case detail ──────────────────────────────────────────────
  for (const agentResult of report.agents) {
    const icon = agentResult.passed ? '✓' : '✗';
    console.log(`${icon} ${agentResult.agent} — ${agentResult.passCount}/${agentResult.totalCases} cases passed`);
    for (const c of agentResult.cases) {
      const cIcon = c.passed ? '  ✓' : '  ✗';
      console.log(`${cIcon} [${c.score}/${c.maxScore}] ${c.caseId}`);
      for (const note of c.notes) {
        console.log(`       ${note}`);
      }
      if (c.apiError) {
        console.log(`       API ERROR: ${c.apiError}`);
      }
    }
    console.log('');
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('─'.repeat(60));
  console.log(report.summary);
  console.log('─'.repeat(60));

  if (!report.passed) {
    console.error('\n[prompt-eval] FAIL — one or more agents did not meet the pass threshold.');
    process.exit(1);
  }

  console.log('\n[prompt-eval] PASS — all agents meet quality thresholds.');
  process.exit(0);
}

main();
