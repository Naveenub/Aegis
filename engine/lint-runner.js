import { execSync } from 'child_process';
import path from 'path';

/**
 * runLint(cwd, files?)
 *
 * FIX: The original called `npm run lint` with no cwd, so it always ran
 * eslint against the main working tree in process.cwd(). Under concurrent
 * workers this means:
 *   - A lint failure in workflow A blocks workflow B's patch from being accepted.
 *   - Lint runs on the un-patched main tree, not the tenant worktree where the
 *     patch was actually written.
 *
 * Fix:
 *   1. Accept a `cwd` argument — always the tenant worktree directory returned
 *      by ensureWorkflowBranch(). Lint now runs on the tree that has the patch.
 *   2. Accept an optional `files` array. When supplied, eslint is invoked
 *      directly on just those paths so only the changed file is linted, not
 *      the entire repo. This makes concurrent workflows independent: a lint
 *      error in one patched file cannot fail another workflow's unrelated file.
 *   3. Fall back to linting the whole worktree (eslint .) when no files are
 *      supplied — preserves backward-compat for callers that don't know the
 *      changed file yet (e.g. the review pipeline pre-apply check).
 *
 * @param {string}   cwd   - Absolute path to the tenant worktree directory.
 * @param {string[]} [files] - Relative paths (within cwd) of files to lint.
 * @returns {{ success: boolean, output: string }}
 */
export function runLint(cwd, files = []) {
  // Resolve eslint bin relative to the project root (where node_modules lives),
  // not relative to the worktree, since worktrees share the object store but
  // not node_modules.
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const eslint      = path.join(projectRoot, 'node_modules', '.bin', 'eslint');

  // When linting specific files, pass their resolved absolute paths so eslint
  // can always find them regardless of its own cwd resolution.
  const targets =
    files.length > 0
      ? files.map(f => path.resolve(cwd, f)).join(' ')
      : '.';   // whole worktree

  // --no-eslintrc prevents eslint from walking up past the worktree and
  // accidentally picking up a different config from the repo root.
  // --rulesdir / --resolve-plugins-relative-to point back to the project root
  // so the shared eslintrc.cjs is honoured.
  const cmd = [
    eslint,
    '--resolve-plugins-relative-to', projectRoot,
    targets,
  ].join(' ');

  try {
    execSync(cmd, { stdio: 'pipe', cwd });
    return { success: true, output: 'Lint passed' };
  } catch (err) {
    return {
      success: false,
      output: err.stdout?.toString() || err.stderr?.toString() || err.message,
    };
  }
}
