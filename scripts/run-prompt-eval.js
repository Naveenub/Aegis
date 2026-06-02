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

// ── Pre-flight: check required env vars before importing anything ─────────────
// Catching this here (rather than deep inside the SDK on the first API call)
// gives operators an immediately actionable error message.
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    '[prompt-eval] ✖  ANTHROPIC_API_KEY is not set — cannot call the Claude API.\n\n' +
    '  Local dev:\n' +
    '    Add ANTHROPIC_API_KEY=sk-ant-... to your .env file\n\n' +
    '  GitHub Actions (CI):\n' +
    '    1. Go to your repo → Settings → Secrets and variables → Actions\n' +
    '    2. Click "New repository secret"\n' +
    '    3. Name: ANTHROPIC_API_KEY   Value: sk-ant-<your-key>\n' +
    '    4. The ci.yml workflow already reads it via ${{ secrets.ANTHROPIC_API_KEY }}\n'
  );
  process.exit(2);
}

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
