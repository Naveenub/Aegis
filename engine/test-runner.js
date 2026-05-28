import { execSync } from 'child_process';
import path from 'path';

/**
 * runTests(cwd, files?)
 *
 * FIX: The original called `npm test` with no cwd, so vitest always ran
 * against the main working tree in process.cwd(). Under concurrent workers:
 *   - A test failure caused by workflow A's patch fails workflow B's post-apply
 *     check even when B's patch is completely correct.
 *   - Tests ran on the un-patched main tree, not the tenant worktree where
 *     the patch was written — meaning the post-apply test was effectively a no-op.
 *
 * Fix:
 *   1. Accept a `cwd` argument — always the tenant worktree directory returned
 *      by ensureWorkflowBranch(). Tests now run on the tree that has the patch.
 *   2. Accept an optional `files` array. When supplied, vitest is given those
 *      specific test file patterns (matched via vitest's positional filter arg)
 *      so only tests relevant to the changed file run. Concurrent workflows
 *      no longer share a global test run.
 *   3. Fall back to running the full suite (vitest run) when no files are
 *      supplied — backward-compat for callers that don't scope by file.
 *
 * Vitest is invoked via its binary (not `npm test`) so the cwd flag is
 * respected and there's no npm script indirection that could override cwd.
 *
 * @param {string}   cwd   - Absolute path to the tenant worktree directory.
 * @param {string[]} [files] - Test file patterns to run (vitest positional args).
 * @returns {{ success: boolean, output: string }}
 */
export function runTests(cwd, files = []) {
  // Resolve vitest bin from the project root (node_modules lives there,
  // not in the worktree).
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const vitest      = path.join(projectRoot, 'node_modules', '.bin', 'vitest');

  // Vitest positional args filter by file name / pattern.
  // Pass the resolved absolute paths so vitest finds them from any cwd.
  const targets = files.map(f => path.resolve(cwd, f)).join(' ');

  // --root points vitest at the worktree so it discovers test files there,
  // not in the main working directory.
  // --reporter=verbose gives structured per-test output for the failure log.
  const cmd = [
    vitest,
    'run',
    '--root', cwd,
    '--reporter=verbose',
    targets,  // empty string is fine — vitest ignores it when blank
  ].filter(Boolean).join(' ');

  try {
    execSync(cmd, { stdio: 'pipe', cwd });
    return { success: true, output: 'All tests passed' };
  } catch (err) {
    return {
      success: false,
      output: err.stdout?.toString() || err.stderr?.toString() || err.message,
    };
  }
}
