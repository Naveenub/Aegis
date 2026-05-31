import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import IORedis from 'ioredis';
import Redlock from 'redlock';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';

/**
 * git.js — one Git worktree per workflow
 *
 * Previous model (one worktree per tenant):
 *   .aegis-worktrees/
 *     acme/            ← all of acme's concurrent workflows share this dir
 *     org_xyz/
 *
 *   Problem: every step of every workflow for tenant "acme" serialized on a
 *   single Redlock because only one checkout can be active in a directory at a
 *   time.  Two workflows touching different files still blocked each other.
 *
 * New model (one worktree per workflow):
 *   .aegis-worktrees/
 *     acme/
 *       wf-abc123/     ← workflow A has its own directory and branch
 *       wf-def456/     ← workflow B runs in parallel, zero contention
 *     org_xyz/
 *       wf-ghi789/
 *
 *   Each workflow worktree is created from the tenant base branch, lives for
 *   the lifetime of the workflow, and is removed (git worktree remove) once
 *   the workflow is finalised or cancelled.
 *
 * Locking model:
 *   - The per-tenant Redlock is kept but is now only held during worktree
 *     creation and finalisation — short-lived git admin operations.
 *   - Within a worktree, each step holds its own worktree-scoped lock
 *     (aegis:git:wt:{workflowId}) for the duration of apply+commit. Steps
 *     within the same workflow still serialize (correct — they share a branch),
 *     but steps in *different* workflows are completely independent.
 *
 * Exported surface (unchanged from caller perspective):
 *   worktreeDir(tenantId, workflowId)  — path computation only, no creation
 *   ensureWorkflowBranch(workflowId, tenantId) → { branch, cwd, lock }
 *   commitChanges(message, cwd)
 *   rollbackLastCommit(cwd)
 *   finaliseWorkflow(workflowId, tenantId)
 *   softTag(name, tenantId)            — unchanged
 *
 * Note: worktreeDir now accepts an optional workflowId. Callers that already
 * pass workflowId get the per-workflow path; callers that omit it receive the
 * tenant root directory (used only for the base-branch worktree).
 */

const WORKTREES_ROOT = '.aegis-worktrees';

// ─── Redlock setup ────────────────────────────────────────────────────────────

const redis   = new IORedis();
const redlock = new Redlock([redis], {
  retryCount : 20,
  retryDelay : 300,
  retryJitter: 100,
});

// Tenant-level lock TTL: only held during worktree add/remove (fast git ops).
const TENANT_LOCK_TTL    = parseInt(process.env.AEGIS_GIT_TENANT_LOCK_TTL_MS  ?? '10000');

// Workflow-level lock TTL: held during apply+commit for a single step.
// Must exceed the longest expected apply+commit wall-time.
const WORKFLOW_LOCK_TTL  = parseInt(process.env.AEGIS_GIT_LOCK_TTL_MS         ?? '15000');

// ─── Lock helpers ─────────────────────────────────────────────────────────────

/**
 * Tenant-level lock — guards worktree creation and deletion.
 * Short TTL; only held for the duration of `git worktree add/remove`.
 */
async function lockTenant(tenantId) {
  return redlock.acquire([`aegis:git:tenant:${tenantId}`], TENANT_LOCK_TTL);
}

/**
 * Workflow-level lock — guards apply+commit within a single worktree.
 * Multiple steps of the same workflow serialize here; steps of different
 * workflows never contend on this lock (different key).
 */
async function lockWorkflow(workflowId) {
  return redlock.acquire([`aegis:git:wt:${workflowId}`], WORKFLOW_LOCK_TTL);
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

function run(cmd, cwd = process.cwd()) {
  return execSync(cmd, { stdio: 'pipe', cwd }).toString();
}

/**
 * worktreeDir(tenantId, workflowId?)
 *
 * Returns the absolute path for a worktree.
 *
 *   worktreeDir('acme', 'wf-abc')  → <root>/.aegis-worktrees/acme/wf-abc
 *   worktreeDir('acme')            → <root>/.aegis-worktrees/acme   (tenant root, not a worktree)
 *
 * Exported so callers can compute the path without coupling to the internal
 * constant.  Does NOT create anything on disk.
 */
export function worktreeDir(tenantId, workflowId) {
  return workflowId
    ? path.resolve(WORKTREES_ROOT, tenantId, workflowId)
    : path.resolve(WORKTREES_ROOT, tenantId);
}

// ─── Tenant base-branch bootstrap ─────────────────────────────────────────────

/**
 * Ensure the tenant's base branch exists in the repo.
 * Called once when the first workflow for a tenant is created.
 * Caller MUST hold the tenant lock.
 *
 * The base branch (`aegis-tenant/{tenantId}`) is the branch that all workflow
 * branches are forked from and squash-merged back into.  It is NOT a worktree
 * directory — it exists only in the main .git object store.
 */
function ensureTenantBaseBranch(tenantId) {
  const baseBranch = `aegis-tenant/${tenantId}`;
  try {
    run(`git rev-parse --verify ${baseBranch}`);
  } catch {
    // Branch doesn't exist yet — create it from main (or current HEAD).
    try {
      run(`git branch ${baseBranch} main`);
    } catch {
      run(`git branch ${baseBranch} HEAD`);
    }
  }
  return baseBranch;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * ensureWorkflowBranch(workflowId, tenantId)
 *
 * Create a dedicated Git worktree for this workflow, forked from the tenant
 * base branch.  Returns { branch, cwd, lock } — callers MUST release lock
 * in a finally block.
 *
 * Idempotent: if the worktree already exists (e.g. a retry of the same step),
 * it is reused and the lock is acquired on the existing directory.
 *
 * Lock semantics:
 *   - Worktree CREATION uses the short-lived tenant lock (fast git admin op).
 *   - The returned `lock` is the per-workflow lock that the caller holds for
 *     the entire apply+commit window. Multiple retries of the same step
 *     serialize here; different workflows are unaffected.
 *
 * @param {string} workflowId
 * @param {string} tenantId
 * @returns {Promise<{ branch: string, cwd: string, lock: Lock }>}
 */
export async function ensureWorkflowBranch(workflowId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);

  const cwd    = worktreeDir(tenantId, workflowId);
  const branch = `aegis/${tenantId}/${workflowId}`;

  // ── Step 1: create the worktree if it doesn't exist (tenant lock, short) ──
  if (!fs.existsSync(cwd)) {
    const tenantLock = await lockTenant(tenantId);
    try {
      // Double-check under the lock — another worker may have raced here.
      if (!fs.existsSync(cwd)) {
        fs.mkdirSync(cwd, { recursive: true });

        const baseBranch = ensureTenantBaseBranch(tenantId);

        try {
          // Add a new worktree on an existing branch (retry scenario).
          run(`git rev-parse --verify ${branch}`);
          run(`git worktree add ${cwd} ${branch}`);
        } catch {
          // Branch doesn't exist yet — create it now.
          run(`git worktree add -b ${branch} ${cwd} ${baseBranch}`);
        }
      }
    } catch (err) {
      // Clean up the directory we may have created so the next attempt retries.
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best-effort */ }
      throw err;
    } finally {
      try { await tenantLock.release(); } catch { /* best-effort */ }
    }
  }

  // ── Step 2: acquire the per-workflow lock (held through apply+commit) ──────
  // This is what the caller will release in its finally block.
  const lock = await lockWorkflow(workflowId);

  return { branch, cwd, lock };
}

/**
 * commitChanges(message, cwd)
 * Caller must hold the workflow lock.
 */
export function commitChanges(message, cwd) {
  run('git add -A', cwd);
  try {
    run(`git commit -m "${message}"`, cwd);
  } catch {
    // nothing to commit — no-op
  }
}

/**
 * rollbackLastCommit(cwd)
 * Caller must hold the workflow lock.
 */
export function rollbackLastCommit(cwd) {
  try {
    run('git reset --hard HEAD~1', cwd);
  } catch {
    // nothing to rollback
  }
}

/**
 * finaliseWorkflow(workflowId, tenantId)
 *
 * Squash-merge the workflow branch into the tenant base branch, then remove
 * the dedicated worktree and delete the workflow branch.
 *
 * Uses the tenant lock (short) for the merge + cleanup — the workflow lock is
 * NOT acquired here because the caller (agent-worker) already released it
 * before calling this function to avoid a self-deadlock.
 *
 * @param {string} workflowId
 * @param {string} tenantId
 */
export async function finaliseWorkflow(workflowId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);

  const cwd        = worktreeDir(tenantId, workflowId);
  const branch     = `aegis/${tenantId}/${workflowId}`;
  const baseBranch = `aegis-tenant/${tenantId}`;

  // Nothing to finalise if the worktree was never created.
  if (!fs.existsSync(cwd)) return;

  const tenantLock = await lockTenant(tenantId);

  try {
    // Verify the workflow branch still exists.
    try {
      run(`git rev-parse --verify ${branch}`);
    } catch {
      // Already cleaned up — remove the directory if it lingers and return.
      await _removeWorktree(cwd, branch, false);
      return;
    }

    // Merge back into the tenant base branch using a temporary bare checkout.
    // We do NOT switch the workflow worktree to baseBranch — it may still be
    // in use by a concurrent step on another process. Instead, perform the
    // merge in the main worktree (process.cwd()), which is always on main/HEAD
    // and is safe to use for a transient merge operation under the tenant lock.
    const mainCwd = process.cwd();

    // Ensure baseBranch exists (it always should by this point, but be safe).
    ensureTenantBaseBranch(tenantId);

    // Squash-merge: capture all workflow commits as a single commit on baseBranch.
    // Use --no-ff to always produce a merge commit even if fast-forward is possible.
    run(`git checkout ${baseBranch}`, mainCwd);
    run(`git merge --squash ${branch}`, mainCwd);
    try {
      run(`git commit -m "Aegis merge: ${branch}"`, mainCwd);
    } catch {
      // Nothing new to merge (all patches were no-ops / rolled back) — fine.
    }
    // Return main worktree to its default branch so we don't leave it on baseBranch.
    try { run('git checkout -', mainCwd); } catch { /* best-effort */ }

    // Remove the worktree directory and delete the branch.
    await _removeWorktree(cwd, branch, true);

  } finally {
    try { await tenantLock.release(); } catch { /* best-effort */ }
  }
}

/**
 * _removeWorktree(cwd, branch, deleteBranch)
 *
 * Internal helper: `git worktree remove` + optional `git branch -D`.
 * Does NOT acquire any lock — callers are responsible for holding one.
 */
async function _removeWorktree(cwd, branch, deleteBranch) {
  try {
    // --force handles the case where the worktree has uncommitted changes
    // (e.g. a crash mid-apply). We want it gone regardless.
    run(`git worktree remove --force ${cwd}`);
  } catch {
    // Fallback: manual directory removal if git worktree remove fails
    // (e.g. the directory was already gone).
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  if (deleteBranch) {
    try {
      run(`git branch -D ${branch}`);
    } catch {
      // Already deleted — fine.
    }
  }
}

/**
 * removeWorkflowWorktree(workflowId, tenantId)
 *
 * Force-remove a workflow's worktree without merging — used when a workflow
 * is cancelled before completion so its directory doesn't accumulate.
 * Acquires the tenant lock internally.
 *
 * @param {string} workflowId
 * @param {string} tenantId
 */
export async function removeWorkflowWorktree(workflowId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);

  const cwd    = worktreeDir(tenantId, workflowId);
  const branch = `aegis/${tenantId}/${workflowId}`;

  if (!fs.existsSync(cwd)) return;

  const tenantLock = await lockTenant(tenantId);
  try {
    await _removeWorktree(cwd, branch, true);
  } finally {
    try { await tenantLock.release(); } catch { /* best-effort */ }
  }
}

/**
 * softTag(name, tenantId)
 * Unchanged — tags are on the main repo, not a worktree.
 */
export async function softTag(name, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  try {
    run(`git tag ${name}`);
  } catch {
    // tag already exists or git error — non-fatal
  }
}
