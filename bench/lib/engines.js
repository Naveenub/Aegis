/**
 * bench/lib/engines.js — engine adapters for the runner.
 *
 * An engine is `{ name, synthetic, execute(job) }` where
 *   job    = { task, repoDir, worktreesDir, tenantId, timeoutSec }
 *   result = { status, workflowId?, steps?, retries?, costUsd, tokensIn, tokensOut,
 *              llmCalls?, error?, reason? }
 *   status ∈ completed | failed | cancelled | needs_review | timeout | infra_error
 *
 * aegisEngine   the real thing: a worker process + the orchestrator, exactly the
 *               code path customers hit. Needs Redis, ANTHROPIC_API_KEY, Docker.
 * oracleEngine  applies the task's gold patch and commits it to the tenant
 *               branch. No LLM. It exists to prove the harness plumbing
 *               (checkout → merge detection → held-out validation → metrics):
 *               it must score 100% accepted, $0. Its output is flagged
 *               `synthetic` and is NEVER evidence about Aegis.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { git, applyPatch } from './exec.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..', '..');

export const tenantBranch = (tenantId) => `aegis-tenant/${tenantId}`;

export function oracleEngine() {
  return {
    name: 'oracle',
    synthetic: true,
    async execute({ task, repoDir, tenantId }) {
      const branch = tenantBranch(tenantId);
      git(['checkout', '-q', '-b', branch], repoDir);
      applyPatch(repoDir, path.join(task.dir, 'gold.patch'));
      git(['commit', '-q', '-m', `oracle: ${task.id}`], repoDir);
      git(['checkout', '-q', 'main'], repoDir);
      return { status: 'completed', steps: 1, retries: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, llmCalls: 0 };
    },
  };
}

export function aegisEngine({ env = {} } = {}) {
  return {
    name: 'aegis',
    synthetic: false,
    async execute({ task, repoDir, worktreesDir, tenantId, timeoutSec }) {
      const childEnv = {
        ...process.env,
        AEGIS_REPO_ROOT: repoDir,
        AEGIS_WORKTREES: worktreesDir,
        AEGIS_TENANTS: tenantId,
        CLAUDE_AUTONOMY: 'true', // no human in the loop: measure the autonomous path
        ...env,
      };
      // Safety net: cwd for the engine is the project (agent personas load from
      // .claude/agents relative to cwd); the target repo is AEGIS_REPO_ROOT.
      const worker = spawn(process.execPath, ['workers/agent-worker.js'], {
        cwd: PROJECT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let workerLog = '';
      worker.stdout.on('data', (d) => { workerLog = (workerLog + d).slice(-20_000); });
      worker.stderr.on('data', (d) => { workerLog = (workerLog + d).slice(-20_000); });
      await new Promise((r) => setTimeout(r, 2500)); // let the BullMQ worker attach

      const promptFile = path.join(path.dirname(repoDir), 'prompt.txt');
      fs.writeFileSync(promptFile, task.prompt);

      try {
        const stdout = await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['bench/lib/submit-child.js', tenantId, promptFile, String(timeoutSec)], {
            cwd: PROJECT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
          });
          let buf = '';
          child.stdout.on('data', (d) => { buf += d; });
          child.stderr.on('data', (d) => { workerLog = (workerLog + d).slice(-20_000); });
          child.on('error', reject);
          child.on('close', () => resolve(buf));
        });
        const line = stdout.split('\n').find((l) => l.startsWith('@@RESULT@@'));
        if (!line) return { status: 'infra_error', costUsd: 0, tokensIn: 0, tokensOut: 0, error: `no result from submit child; worker log tail: ${workerLog.slice(-800)}` };
        return JSON.parse(line.slice('@@RESULT@@'.length));
      } finally {
        worker.kill('SIGTERM');
      }
    },
  };
}
