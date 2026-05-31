import path from 'path';
import { runInSandbox } from './sandbox.js';

/**
 * runTests(cwd, files?)
 *
 * Runs Vitest inside a Docker sandbox (see engine/sandbox.js).
 *
 * Security change: test execution no longer runs on the host via execSync.
 * Instead it runs inside a container with:
 *   - no network access
 *   - read-only rootfs (worktree mounted rw, node_modules ro)
 *   - 512 MB RAM / 1 CPU cap
 *   - 60-second timeout
 *
 * All previous behaviour (cwd scoping, file-scoped vs full-suite runs,
 * vitest binary resolved from project root) is preserved.
 *
 * @param {string}   cwd     - Absolute path to the tenant worktree directory.
 * @param {string[]} [files] - Test file patterns to run (vitest positional args).
 * @returns {{ success: boolean, output: string }}
 */
export function runTests(cwd, files = []) {
  const projectRoot = path.resolve(import.meta.dirname, '..');

  // Resolve the vitest binary path as seen inside the container.
  // The bind mount maps absNodeModules → absNodeModules identically.
  const vitest = path.join(projectRoot, 'node_modules', '.bin', 'vitest');

  const targets = files.map(f => path.resolve(cwd, f)).join(' ');

  // --root scopes vitest to the worktree so it discovers test files there,
  // not in the main working directory.
  // --reporter=verbose gives structured per-test output for the failure log.
  const cmd = [
    vitest,
    'run',
    '--root', cwd,
    '--reporter=verbose',
    targets,
  ].filter(Boolean).join(' ');

  return runInSandbox(cmd, cwd, projectRoot);
}
