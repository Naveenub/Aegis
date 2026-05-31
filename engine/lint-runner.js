import path from 'path';
import { runInSandbox } from './sandbox.js';

/**
 * runLint(cwd, files?)
 *
 * Runs ESLint inside a Docker sandbox (see engine/sandbox.js).
 *
 * Security change: lint no longer executes on the host via execSync.
 * Instead, it runs inside a container with:
 *   - no network access
 *   - read-only rootfs (worktree mounted rw, node_modules ro)
 *   - 512 MB RAM / 1 CPU cap
 *   - 60-second timeout
 *
 * All previous behaviour (cwd scoping, file-scoped vs whole-worktree lint,
 * eslint binary resolved from project root) is preserved.
 *
 * @param {string}   cwd     - Absolute path to the tenant worktree directory.
 * @param {string[]} [files] - Relative paths (within cwd) of files to lint.
 * @returns {{ success: boolean, output: string }}
 */
export function runLint(cwd, files = []) {
  const projectRoot = path.resolve(import.meta.dirname, '..');

  // Resolve the eslint binary path as seen inside the container.
  // The bind mount maps absNodeModules → absNodeModules, so the path is identical
  // inside the container — no path translation needed.
  const eslint = path.join(projectRoot, 'node_modules', '.bin', 'eslint');

  const targets =
    files.length > 0
      ? files.map(f => path.resolve(cwd, f)).join(' ')
      : '.';

  // --resolve-plugins-relative-to points eslint at the project root so the
  // shared eslintrc.cjs is honoured even when cwd is a worktree subdirectory.
  const cmd = [
    eslint,
    '--resolve-plugins-relative-to', projectRoot,
    targets,
  ].join(' ');

  return runInSandbox(cmd, cwd, projectRoot);
}
