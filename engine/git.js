/**
 * engine/git.js — Git operations for per-workflow worktrees
 *
 * Each workflow runs in an isolated git worktree so concurrent workflows never
 * touch the same working directory.  All functions that shell out to git are
 * synchronous (spawnSync) because they are called inside BullMQ job handlers
 * where async git subprocess management adds no value.
 *
 * Exports
 * ───────
 *   worktreeDir(tenantId)                         → string | null
 *   ensureWorkflowBranch(workflowId, tenantId)    → { cwd, lock }
 *   commitChanges(message, cwd)                   → void
 *   rollbackLastCommit(cwd)                       → void
 *   revertStepCommit(workflowId, stepId, cwd)     → { reverted, commitHash } (NEW)
 *   finaliseWorkflow(workflowId, tenantId)        → { merged, conflicts }
 *   removeWorkflowWorktree(workflowId, tenantId)  → Promise<void>
 */

import { execFileSync, spawnSync } from 'child_process';
import fs   from 'fs';
import path from 'path';
import { acquireLock, releaseLock } from './lock.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const REPO_ROOT      = path.resolve(process.env.AEGIS_REPO_ROOT ?? process.cwd());
const WORKTREES_BASE = path.resolve(process.env.AEGIS_WORKTREES ?? path.join(REPO_ROOT, '.aegis-worktrees'));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function git(args, cwd = REPO_ROOT) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${(result.stderr ?? '').trim()}`);
  }
  return (result.stdout ?? '').trim();
}

/**
 * Return the absolute path of a tenant's base worktree, or null when the
 * worktrees directory does not exist yet (first workflow run).
 */
export function worktreeDir(tenantId) {
  const dir = path.join(WORKTREES_BASE, tenantId);
  return fs.existsSync(dir) ? dir : null;
}

// ─── Per-workflow branch ──────────────────────────────────────────────────────

/**
 * Ensure the per-workflow branch + worktree exist and return the cwd together
 * with a held lock.  The lock prevents two steps of the same workflow from
 * writing concurrently.
 *
 * Branch name:   aegis/<tenantId>/<workflowId>
 * Worktree path: <WORKTREES_BASE>/<tenantId>/<workflowId>
 */
export async function ensureWorkflowBranch(workflowId, tenantId) {
  const branch   = `aegis/${tenantId}/${workflowId}`;
  const cwd      = path.join(WORKTREES_BASE, tenantId, workflowId);
  const lockName = `worktree:${workflowId}`;

  const lock = await acquireLock(lockName, tenantId);

  try {
    if (!fs.existsSync(cwd)) {
      // Create the base worktree directory for the tenant if needed
      fs.mkdirSync(path.join(WORKTREES_BASE, tenantId), { recursive: true });

      // Create an isolated worktree on a new branch tracking tenant base
      const baseBranch = `aegis-tenant/${tenantId}`;
      const baseExists = spawnSync('git', ['rev-parse', '--verify', baseBranch], {
        cwd: REPO_ROOT, encoding: 'utf-8',
      }).status === 0;

      if (baseExists) {
        git(['worktree', 'add', '-b', branch, cwd, baseBranch]);
      } else {
        // First workflow for this tenant — branch from HEAD
        git(['worktree', 'add', '-b', branch, cwd, 'HEAD']);
      }
    }
  } catch (err) {
    await releaseLock(lock);
    throw err;
  }

  return { cwd, lock };
}

// ─── Commit / rollback ────────────────────────────────────────────────────────

/**
 * Stage all changes in `cwd` and create a commit with the given message.
 * The message is also used by revertStepCommit() to identify the right commit,
 * so always use the canonical format "Aegis: <stepId>".
 */
export function commitChanges(message, cwd) {
  git(['add', '-A'], cwd);
  git(['commit', '--allow-empty', '-m', message], cwd);
}

/**
 * Undo the most recent commit in the worktree (test-failure rollback path).
 * Working-tree changes are discarded; the branch tip moves back one commit.
 */
export function rollbackLastCommit(cwd) {
  git(['reset', '--hard', 'HEAD~1'], cwd);
}

// ─── Step-level rewind (NEW) ──────────────────────────────────────────────────

/**
 * Revert the commit that was created for a specific step, without rewinding
 * any commits that came after it (i.e. a proper `git revert`, not a reset).
 *
 * Strategy
 * ────────
 * 1. Walk the log of the workflow branch looking for the commit whose message
 *    matches "Aegis: <stepId>".
 * 2. Run `git revert --no-edit <hash>` to create a new "undo" commit while
 *    preserving later history.
 * 3. Return the original commit hash so the caller can store it in the step
 *    record for audit / re-apply purposes.
 *
 * If the commit is not found (step never committed, or already reverted) the
 * function returns { reverted: false, commitHash: null }.
 *
 * @param {string} workflowId
 * @param {string} stepId
 * @param {string} cwd   - absolute path to the workflow worktree
 * @returns {{ reverted: boolean, commitHash: string|null }}
 */
export function revertStepCommit(workflowId, stepId, cwd) {
  const expectedMsg = `Aegis: ${stepId}`;

  // git log --format="%H %s" lists "<hash> <subject>" one per line
  let log;
  try {
    log = git(['log', '--format=%H %s', '--ancestry-path'], cwd);
  } catch {
    return { reverted: false, commitHash: null };
  }

  const commitHash = log
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .find(line => line.slice(41) === expectedMsg)   // 40-char hash + space
    ?.slice(0, 40) ?? null;

  if (!commitHash) {
    return { reverted: false, commitHash: null };
  }

  try {
    git(['revert', '--no-edit', commitHash], cwd);
  } catch (err) {
    // Revert may fail if there are merge conflicts — surface the error
    throw new Error(`git revert failed for step "${stepId}" (commit ${commitHash}): ${err.message}`);
  }

  return { reverted: true, commitHash };
}

// ─── Finalise / cleanup ───────────────────────────────────────────────────────

/**
 * Merge the workflow branch into the tenant base branch.
 * Acquires the tenant-level lock to serialise concurrent merges.
 *
 * @returns {{ merged: boolean, conflicts: string[] }}
 */
export async function finaliseWorkflow(workflowId, tenantId) {
  const branch     = `aegis/${tenantId}/${workflowId}`;
  const baseBranch = `aegis-tenant/${tenantId}`;
  const lockName   = `tenant-merge:${tenantId}`;

  const lock = await acquireLock(lockName, tenantId);

  try {
    // Ensure the base branch exists (create it on first workflow for this tenant)
    const baseExists = spawnSync('git', ['rev-parse', '--verify', baseBranch], {
      cwd: REPO_ROOT, encoding: 'utf-8',
    }).status === 0;

    if (!baseExists) {
      git(['branch', baseBranch, 'HEAD']);
    }

    // Merge the workflow branch; --no-ff preserves history
    try {
      execFileSync('git', ['merge', '--no-ff', '-m', `Aegis merge: ${workflowId}`, branch], {
        cwd: REPO_ROOT, encoding: 'utf-8',
      });
    } catch {
      // Collect conflicting files and abort
      const conflicts = git(['diff', '--name-only', '--diff-filter=U'], REPO_ROOT)
        .split('\n').filter(Boolean);
      git(['merge', '--abort'], REPO_ROOT);
      return { merged: false, conflicts };
    }

    return { merged: true, conflicts: [] };
  } finally {
    await releaseLock(lock);
  }
}

/**
 * Remove the per-workflow worktree and delete the workflow branch.
 * Best-effort — does not throw on failure.
 */
export async function removeWorkflowWorktree(workflowId, tenantId) {
  const worktreePath = path.join(WORKTREES_BASE, tenantId, workflowId);
  const branch       = `aegis/${tenantId}/${workflowId}`;

  try {
    git(['worktree', 'remove', '--force', worktreePath]);
  } catch { /* already removed or never created */ }

  try {
    git(['branch', '-D', branch]);
  } catch { /* branch may already be deleted */ }
}
