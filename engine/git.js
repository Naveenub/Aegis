import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
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
 */

const WORKTREES_ROOT = '.aegis-worktrees';

function run(cmd, cwd = process.cwd()) {
  return execSync(cmd, { stdio: 'pipe', cwd }).toString();
}

function worktreeDir(tenantId) {
  return path.resolve(WORKTREES_ROOT, tenantId);
}

/**
 * Ensure the tenant's worktree exists, then return its absolute path.
 * Creates the worktree from main if it doesn't exist yet.
 */
function ensureTenantWorktree(tenantId) {
  assertTenantId(tenantId);
  const dir = worktreeDir(tenantId);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });

    // Use a dedicated branch per tenant so their commits never share a branch
    const baseBranch = `aegis-tenant/${tenantId}`;

    try {
      // Branch already exists (e.g. server restart) — just add the worktree
      run(`git worktree add ${dir} ${baseBranch}`);
    } catch {
      // First time: create branch from main, then add worktree
      run(`git worktree add -b ${baseBranch} ${dir} main`);
    }
  }

  return dir;
}

/**
 * 🌿 Create or checkout a workflow branch inside the tenant's worktree.
 * Returns { branch, cwd } — callers must pass cwd to all subsequent git ops.
 */
export function ensureWorkflowBranch(workflowId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const cwd    = ensureTenantWorktree(tenantId);
  const branch = `aegis/${tenantId}/${workflowId}`;

  try {
    run(`git rev-parse --verify ${branch}`, cwd);
    run(`git checkout ${branch}`, cwd);
  } catch {
    run(`git checkout -b ${branch}`, cwd);
  }

  return { branch, cwd };
}

/**
 * 📸 Commit changes inside the tenant's worktree.
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
 */
export function rollbackLastCommit(cwd) {
  try {
    run('git reset --hard HEAD~1', cwd);
  } catch {
    // nothing to rollback
  }
}

/**
 * 🔀 Merge workflow branch into the tenant base branch (squash).
 */
export function mergeWorkflow(workflowId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const cwd        = worktreeDir(tenantId);
  const branch     = `aegis/${tenantId}/${workflowId}`;
  const baseBranch = `aegis-tenant/${tenantId}`;

  run(`git checkout ${baseBranch}`, cwd);
  run(`git merge --squash ${branch}`, cwd);
  run(`git commit -m "Aegis merge: ${branch}"`, cwd);
}

/**
 * 🧹 Delete workflow branch after merge.
 */
export function cleanupWorkflowBranch(workflowId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const cwd    = worktreeDir(tenantId);
  const branch = `aegis/${tenantId}/${workflowId}`;

  try {
    run(`git branch -D ${branch}`, cwd);
  } catch {
    // already deleted
  }
}

/**
 * 📌 Optional tag (debugging / checkpoints).
 */
export function softTag(name, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const cwd = worktreeDir(tenantId);
  try {
    run(`git tag ${name}`, cwd);
  } catch {}
}