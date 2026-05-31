import path from 'path';
import { scanRepoSync } from './repo-scanner.js';
import { runInSandbox } from './sandbox.js';

// ─── Test-file discovery ──────────────────────────────────────────────────────

// Patterns that identify test files (matches vitest defaults + common conventions)
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Return all test files found under `root`, repo-relative.
 * Excludes node_modules and .git (handled by scanRepoSync).
 *
 * Uses scanRepoSync because runTests() is called from runInSandbox() via
 * child_process.execSync — a synchronous context where async I/O is not
 * available. This is the only legitimate caller of the sync scanner;
 * all other callers must use the async scanRepo().
 *
 * @param {string} root  - Absolute path to scan (tenant worktree)
 * @returns {string[]}   - Absolute paths to test files
 */
function findTestFiles(root) {
  return scanRepoSync(root).filter(f => TEST_FILE_RE.test(f));
}

// ─── Core runner ──────────────────────────────────────────────────────────────

/**
 * Build and execute a vitest command inside the sandbox.
 *
 * @param {string}   cwd         - Worktree root (vitest --root)
 * @param {string}   projectRoot - Host project root (for binary + node_modules)
 * @param {string[]} targets     - Absolute file paths to pass as positional args.
 *                                 Empty = run the full discovered suite.
 * @returns {{ success: boolean, output: string }}
 */
function vitestRun(cwd, projectRoot, targets = []) {
  const vitest = path.join(projectRoot, 'node_modules', '.bin', 'vitest');

  const cmd = [
    vitest,
    'run',
    '--root', cwd,
    '--reporter=verbose',
    ...targets,
  ].join(' ');

  return runInSandbox(cmd, cwd, projectRoot);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * runTests(cwd, files?)
 *
 * Runs Vitest inside a Docker sandbox in two passes:
 *
 *   Pass 1 — scoped (fast-fail)
 *     Runs only the test files for the patched source file(s).
 *     If this fails we know the direct breakage immediately.
 *
 *   Pass 2 — full suite
 *     Runs every test file found in the worktree regardless of which source
 *     file was patched.  This catches regressions where an agent's change
 *     breaks a module it didn't declare in `files` — the original bug.
 *
 * Both passes must succeed for the overall result to be { success: true }.
 * Outputs from both passes are concatenated so the caller (agent-worker) has
 * the full picture when deciding to roll back or retry.
 *
 * Security change: test execution runs inside a Docker sandbox (see
 * engine/sandbox.js) — no network, read-only rootfs, 512 MB / 1 CPU cap,
 * 60-second timeout.
 *
 * @param {string}   cwd     - Absolute path to the tenant worktree directory.
 * @param {string[]} [files] - Source files that were patched (vitest resolves
 *                             related test files via its coverage/relation map).
 *                             If empty, only the full-suite pass runs.
 * @returns {{ success: boolean, output: string }}
 */
export function runTests(cwd, files = []) {
  const projectRoot = path.resolve(import.meta.dirname, '..');

  // ── Pass 1: scoped run ────────────────────────────────────────────────────
  // Resolve each patched source file to its corresponding test file(s).
  // Convention: `engine/foo.js` → `tests/foo.test.js` (and variants).
  // We also accept the patched file itself if it IS a test file.
  let scopedResult = null;

  if (files.length > 0) {
    const allTestFiles = findTestFiles(cwd);

    const scopedTargets = new Set();

    for (const src of files) {
      const srcAbs = path.resolve(cwd, src);

      // If the patched file is itself a test file, include it directly.
      if (TEST_FILE_RE.test(srcAbs)) {
        scopedTargets.add(srcAbs);
        continue;
      }

      // Derive the base name without extension to match test file variants:
      //   engine/job-store.js  →  job-store
      // then look for tests/job-store.test.js, tests/job-store.spec.ts, etc.
      const baseName = path.basename(srcAbs).replace(/\.[cm]?[jt]sx?$/, '');

      for (const tf of allTestFiles) {
        const tfBase = path.basename(tf).replace(TEST_FILE_RE, '');
        if (tfBase === baseName) {
          scopedTargets.add(tf);
        }
      }
    }

    if (scopedTargets.size > 0) {
      scopedResult = vitestRun(cwd, projectRoot, [...scopedTargets]);

      // Fast-fail: if the directly-related tests already break, no need to
      // spend time on the full suite.  The worker will roll back immediately.
      if (!scopedResult.success) {
        return {
          success: false,
          output:  `[scoped tests FAILED — full suite skipped]\n\n${scopedResult.output}`,
        };
      }
    }
  }

  // ── Pass 2: full suite ────────────────────────────────────────────────────
  // Run every test file in the worktree to catch cross-module regressions.
  const allTests = findTestFiles(cwd);

  // If there are no test files in the worktree at all, treat as a pass with
  // a clear notice rather than silently succeeding.
  if (allTests.length === 0) {
    const notice = '[test-runner] No test files found in worktree — skipping full suite.';
    return {
      success: true,
      output:  scopedResult
        ? `${scopedResult.output}\n\n${notice}`
        : notice,
    };
  }

  const fullResult = vitestRun(cwd, projectRoot, allTests);

  // ── Combine outputs ───────────────────────────────────────────────────────
  const sections = [];
  if (scopedResult) sections.push(`[scoped tests PASSED]\n\n${scopedResult.output}`);
  sections.push(
    `[full suite ${fullResult.success ? 'PASSED' : 'FAILED'}]\n\n${fullResult.output}`
  );

  return {
    success: fullResult.success,
    output:  sections.join('\n\n' + '─'.repeat(60) + '\n\n'),
  };
}
