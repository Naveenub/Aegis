import path from 'path';
import {
  detectToolchains,
  commandContext,
  runToolchainCommand,
  NO_TOOLCHAIN_NOTICE,
} from './toolchains.js';

/**
 * runLint(cwd, files?)
 *
 * Lints the tenant worktree inside the Docker sandbox (see engine/sandbox.js),
 * once per language detected at the worktree root (see engine/toolchains.js):
 *
 *   node    → ESLint  (Aegis's own binary, host node_modules mounted read-only)
 *   python  → ruff when the image has it, otherwise a stdlib syntax check
 *   go      → gofmt -l + go vet
 *   java    → mvn test-compile / gradle classes testClasses
 *
 * Every run has no network access, a read-only rootfs (worktree mounted rw),
 * a memory/CPU cap and a wall-clock timeout. Scoping is preserved: when
 * `files` is given only those files are linted, and a toolchain with nothing
 * in scope is skipped. A worktree with no supported language passes with a
 * notice, the same way a worktree with no tests does.
 *
 * @param {string}   cwd     - Absolute path to the tenant worktree directory.
 * @param {string[]} [files] - Relative paths (within cwd) of files to lint.
 * @param {string}   [tenantId] - Tenant to attribute sandbox-minutes usage to.
 * @returns {{ success: boolean, output: string }}
 */
export function runLint(cwd, files = [], tenantId) {
  const projectRoot = path.resolve(import.meta.dirname, '..');

  const toolchains = detectToolchains(cwd);
  if (toolchains.length === 0) {
    return { success: true, output: NO_TOOLCHAIN_NOTICE };
  }

  const sections = [];
  let success = true;
  let ran = 0;

  for (const tc of toolchains) {
    const cmd = tc.lintCommand(commandContext(tc, { cwd, files, projectRoot }));
    if (cmd == null) continue; // nothing in scope for this language

    const result = runToolchainCommand(tc, cmd, { cwd, projectRoot, tenantId });
    ran += 1;
    sections.push({ tc, result });
    if (!result.success) success = false;
  }

  if (ran === 0) {
    return { success: true, output: '[lint] No lintable files in scope — skipped.' };
  }

  // A single toolchain returns its output untouched (the original format).
  if (sections.length === 1) return sections[0].result;

  return {
    success,
    output: sections
      .map(({ tc, result }) => `[lint:${tc.id} ${result.success ? 'PASSED' : 'FAILED'}]\n${result.output}`)
      .join('\n\n'),
  };
}
