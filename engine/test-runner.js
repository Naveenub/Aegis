import path from 'path';
import { scanRepoSync } from './repo-scanner.js';
import {
  detectToolchains,
  prepareToolchain,
  runToolchainCommand,
  noToolchainResult,
} from './toolchains.js';

// ─── Test-file discovery ──────────────────────────────────────────────────────

/**
 * Return all test files found under `root` for one toolchain, absolute paths.
 * Excludes node_modules, .git, vendor, virtualenvs etc. (handled by scanRepoSync).
 *
 * Uses scanRepoSync because runTests() is called from runInSandbox() via
 * child_process.execSync — a synchronous context where async I/O is not
 * available. This is the only legitimate caller of the sync scanner;
 * all other callers must use the async scanRepo().
 *
 * @param {string[]} allFiles - Result of scanRepoSync(root)
 * @param {object}   tc       - Toolchain (see engine/toolchains.js)
 * @returns {string[]}
 */
function findTestFiles(allFiles, tc) {
  return allFiles.filter(f => tc.testFileRe.test(f));
}

// ─── Per-toolchain runner ─────────────────────────────────────────────────────

/**
 * Two passes for one language:
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
 * @returns {{ success: boolean, output: string }}
 */
function runToolchainTests(tc, cwd, projectRoot, files, allFiles, tenantId) {
  // Dependencies are installed once (with network, in a separate step) and
  // mounted read-only into every test run below — see engine/deps-cache.js.
  let prep = null;
  const run = (targets, scoped) => {
    prep ??= prepareToolchain(tc, { cwd, projectRoot, tenantId });
    if (prep.error) return { success: false, output: prep.error };
    const cmd = tc.testCommand({ cwd, projectRoot, targets, scoped, deps: prep.deps });
    return runToolchainCommand(tc, cmd, { cwd, projectRoot, tenantId, deps: prep.deps });
  };

  const allTests = findTestFiles(allFiles, tc);

  // ── Pass 1: scoped run ────────────────────────────────────────────────────
  // Resolve each patched source file to its corresponding test file(s) by base
  // name: `engine/job-store.js` → `tests/job-store.test.js`, `pkg/foo.py` →
  // `tests/test_foo.py`, `foo.go` → `foo_test.go`, `Foo.java` → `FooTest.java`.
  // A patched file that is itself a test file is included directly.
  let scopedResult = null;

  if (files.length > 0) {
    const scopedTargets = new Set();

    for (const src of files) {
      const srcAbs = path.resolve(cwd, src);

      if (tc.testFileRe.test(srcAbs)) {
        scopedTargets.add(srcAbs);
        continue;
      }
      if (!tc.sourceRe.test(srcAbs)) continue; // another language's file

      const baseName = tc.baseName(srcAbs);
      for (const tf of allTests) {
        if (tc.baseName(tf) === baseName) scopedTargets.add(tf);
      }
    }

    if (scopedTargets.size > 0) {
      scopedResult = run([...scopedTargets], true);

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

  const fullResult = run(allTests, false);

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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * runTests(cwd, files?)
 *
 * Runs the tests of every language detected at the worktree root inside the
 * Docker sandbox (see engine/sandbox.js, engine/toolchains.js):
 *
 *   node    → Vitest      python → pytest (or unittest)
 *   go      → go test     java   → Maven surefire / Gradle test
 *
 * Each language gets the scoped-then-full two-pass run described on
 * runToolchainTests. All languages must pass for the overall result to be
 * { success: true }; outputs are concatenated so the caller (agent-worker) has
 * the full picture when deciding to roll back or retry.
 *
 * Security: test execution runs inside a Docker sandbox — no network,
 * read-only rootfs, memory/CPU cap, wall-clock timeout.
 *
 * @param {string}   cwd     - Absolute path to the tenant worktree directory.
 * @param {string[]} [files] - Source files that were patched. If empty, only the
 *                             full-suite pass runs.
 * @param {string}   [tenantId] - Tenant to attribute sandbox-minutes usage to.
 * @returns {{ success: boolean, output: string }}
 */
export function runTests(cwd, files = [], tenantId) {
  const projectRoot = path.resolve(import.meta.dirname, '..');

  const toolchains = detectToolchains(cwd);
  if (toolchains.length === 0) {
    return noToolchainResult('tests');
  }

  const allFiles = scanRepoSync(cwd);
  const results = toolchains.map(tc => ({
    tc,
    result: runToolchainTests(tc, cwd, projectRoot, files, allFiles, tenantId),
  }));

  // A single toolchain returns its output untouched (the original format).
  if (results.length === 1) return results[0].result;

  return {
    success: results.every(r => r.result.success),
    output: results
      .map(({ tc, result }) => `[tests:${tc.id} ${result.success ? 'PASSED' : 'FAILED'}]\n\n${result.output}`)
      .join('\n\n' + '═'.repeat(60) + '\n\n'),
  };
}
