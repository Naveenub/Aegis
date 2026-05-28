import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import IORedis from 'ioredis';
import Redlock from 'redlock';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';

/**
 * Each tenant gets an isolated Git worktree rooted at:
 *   .aegis-worktrees/{tenantId}/
 *
 * Worktrees share the same underlying object store (.git) so history
 * is not duplicated, but the working directory — and therefore all
 * file reads/writes performed by agents — is fully isolated per tenant.
 *
 * Layout:
 *   <repo root>/.aegis-worktrees/
 *     acme/          ← tenant "acme" worktree
 *     org_xyz/       ← tenant "org_xyz" worktree
 *
 * FIX: ensureWorkflowBranch previously did a `git checkout` with no
 * coordination between workers. Two workers handling different steps of
 * the same workflow would both call ensureWorkflowBranch, one would
 * checkout while the other was mid-commit, corrupting the working tree.
 *
 * Solution: every operation that mutates the worktree (checkout, commit,
 * rollback, merge, cleanup) acquires a per-worktree Redlock before touching
 * git. The lock is scoped to the tenant worktree, not the workflow branch,
 * so different tenants never block each other.
 */

const WORKTREES_ROOT = '.aegis-worktrees';

// ─── Redlock setup ────────────────────────────────────────────────────────────

const redis   = new IORedis();
const redlock = new Redlock([redis], {
  retryCount : 20,
  retryDelay : 300,
  retryJitter: 100,
});

// How long (ms) to hold the worktree lock.
// Must exceed the longest expected git operation (commit, merge).
const WORKTREE_LOCK_TTL = parseInt(process.env.AEGIS_GIT_LOCK_TTL_MS ?? '15000');

/**
 * Acquire an exclusive lock on a tenant's worktree directory.
 * Returns a Redlock lock instance — callers MUST release it in a finally block.
 *
 * @param {string} tenantId
 * @returns {Promise<Lock>}
 */
async function lockWorktree(tenantId) {
  return redlock.acquire([`aegis:git:worktree:${tenantId}`], WORKTREE_LOCK_TTL);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function run(cmd, cwd = process.cwd()) {
  return execSync(cmd, { stdio: 'pipe', cwd }).toString();
}

function worktreeDir(tenantId) {
  return path.resolve(WORKTREES_ROOT, tenantId);
}

/**
 * Ensure the tenant's worktree exists, then return its absolute path.
 * Creates the worktree from main if it doesn't exist yet.
 *
 * MUST be called while the caller already holds the worktree lock.
 */
function ensureTenantWorktree(tenantId) {
  assertTenantId(tenantId);
  const dir = worktreeDir(tenantId);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });

    const baseBranch = `aegis-tenant/${tenantId}`;

    try {
      run(`git worktree add ${dir} ${baseBranch}`);
    } catch {
      run(`git worktree add -b ${baseBranch} ${dir} main`);
    }
  }

  return dir;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * 🌿 Create or checkout a workflow branch inside the tenant's worktree.
 *
 * FIX: Acquires a per-tenant worktree Redlock before any git operation.
 * Returns { branch, cwd, lock } — callers MUST call lock.release() in finally.
 *
 * Pattern:
 *   const { cwd, lock } = await ensureWorkflowBranch(workflowId, tenant);
 *   try {
 *     applyPatch(...);
 *     commitChanges(..., cwd);
 *   } finally {
 *     await lock.release();
 *   }
 */
export async function ensureWorkflowBranch(workflowId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);

  const lock = await lockWorktree(tenantId);

  try {
    const cwd    = ensureTenantWorktree(tenantId);
    const branch = `aegis/${tenantId}/${workflowId}`;

    try {
      run(`git rev-parse --verify ${branch}`, cwd);
      run(`git checkout ${branch}`, cwd);
    } catch {
      run(`git checkout -b ${branch}`, cwd);
    }

    // Return the lock — caller releases it after patch + commit are done.
    // Do NOT release here; the worktree must stay on this branch until committed.
    return { branch, cwd, lock };

  } catch (err) {
    // Checkout itself failed — release lock before propagating
    try { await lock.release(); } catch { /* best-effort */ }
    throw err;
  }
}

/**
 * 📸 Commit changes inside the tenant's worktree.
 * Caller must already hold the worktree lock.
 */
export function commitChanges(message, cwd) {
  run('git add -A', cwd);
  try {
    run(`git commit -m "${message}"`, cwd);
  } catch {
    // nothing to commit
  }
}

/**
 * 🔁 Rollback last commit (safe inside branch).
 * Caller must already hold the worktree lock.
 */
export function rollbackLastCommit(cwd) {
  try {
    run('git reset --hard HEAD~1', cwd);
  } catch {
    // nothing to rollback
  }
}

/**
 * 🔀 Squash-merge a completed workflow branch into the tenant base branch,
 * then delete the workflow branch.
 *
 * FIX: This was never called after step success. Now called by agent-worker
 * when the last step of a workflow completes (nextSteps is empty).
 *
 * Acquires the worktree lock internally — do NOT call while already holding it.
 *
 * @param {string} workflowId
 * @param {string} tenantId
 */
export async function finaliseWorkflow(workflowId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);

  const lock = await lockWorktree(tenantId);

  try {
    const cwd        = worktreeDir(tenantId);
    const branch     = `aegis/${tenantId}/${workflowId}`;
    const baseBranch = `aegis-tenant/${tenantId}`;

    // Verify the workflow branch exists before trying to merge
    try {
      run(`git rev-parse --verify ${branch}`, cwd);
    } catch {
      // Branch was already cleaned up or never created (no-patch workflow) — fine
      return;
    }

    // Switch to the tenant base branch, squash-merge, commit, then delete
    run(`git checkout ${baseBranch}`, cwd);
    run(`git merge --squash ${branch}`, cwd);

    try {
      run(`git commit -m "Aegis merge: ${branch}"`, cwd);
    } catch {
      // Nothing to merge (all patches were no-ops) — still clean up the branch
    }

    try {
      run(`git branch -D ${branch}`, cwd);
    } catch {
      // Already deleted — fine
    }

  } finally {
    try { await lock.release(); } catch { /* best-effort */ }
  }
}

/**
 * 📌 Optional tag (debugging / checkpoints).
 * Acquires the worktree lock internally.
 */
export async function softTag(name, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);

  const lock = await lockWorktree(tenantId);
  try {
    const cwd = worktreeDir(tenantId);
    run(`git tag ${name}`, cwd);
  } catch {
    // tag already exists or git error — non-fatal
  } finally {
    try { await lock.release(); } catch { /* best-effort */ }
  }
}
