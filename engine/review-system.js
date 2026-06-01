import { runLint } from './lint-runner.js';
import { runTests } from './test-runner.js';
import { validateTargetPath } from './code-writer.js';
import path from 'path';

const MAX_PATCH_SIZE = 50000; // chars

/**
 * @param {string} patch  - Raw patch JSON string.
 * @param {string} [root] - Absolute path of the tenant worktree that the patch
 *                          must stay inside.  When omitted the check falls back
 *                          to validateTargetPath's own PROJECT_ROOT default,
 *                          which is the repo root -- safe for direct/test callers
 *                          but MUST be supplied in production so the resolved
 *                          path is anchored to the correct worktree, not to
 *                          process.cwd() of the server process.
 */
export function validatePatch(patch, root) {
  try {
    const parsed = JSON.parse(patch);

    if (!parsed.file || !parsed.content) {
      return reject('Invalid patch format');
    }

    if (typeof parsed.file !== 'string') {
      return reject('Patch file must be a string');
    }

    // Validate the target path at review time -- before the patch ever reaches
    // applyPatch(). Resolve relative to `root` (the tenant worktree) so that
    // path-traversal strings like "../../engine/git.js" are caught against the
    // correct boundary rather than against process.cwd() of the server process.
    const resolveBase = root ? path.resolve(root) : undefined;
    const resolved    = resolveBase
      ? path.resolve(resolveBase, parsed.file)
      : path.resolve(parsed.file);
    const pathError = resolveBase
      ? validateTargetPath(resolved, resolveBase)
      : validateTargetPath(resolved);
    if (pathError) {
      return reject(`Unsafe file path: ${pathError}`);
    }

    if (parsed.content.length > MAX_PATCH_SIZE) {
      return reject('Patch too large');
    }

    return { ok: true };
  } catch {
    return reject('Invalid JSON patch');
  }
}

/**
 * runReviewPipeline(patch, cwd?, file?)
 *
 * lint and test now accept a `cwd` so they run inside the tenant
 * worktree rather than process.cwd().
 *
 * This function is called BEFORE applyPatch (structural pre-flight), so the
 * worktree hasn't been mutated yet. That means:
 *  - Lint runs on the current worktree state (catches syntax errors in
 *    existing files that would make the patch context invalid).
 *  - Tests run as a baseline check. The post-apply test in agent-worker.js
 *    is the authoritative pass/fail gate -- this is a fast pre-flight.
 *
 * When `cwd` is omitted (e.g. unit tests or callers that haven't checked out
 * a worktree yet) both runners fall back to process.cwd() and run the full
 * suite -- same behaviour as before the fix, so no existing caller breaks.
 *
 * @param {string} patch   - Raw patch JSON string.
 * @param {string} [cwd]   - Tenant worktree directory (from ensureWorkflowBranch).
 * @param {string} [file]  - Relative path of the file being patched (for scoped lint).
 */
export function runReviewPipeline(patch, cwd, file) {
  // 1. structural + path validation -- pass cwd as root so path.resolve uses
  //    the worktree as the anchor, not process.cwd() of the server process.
  const base = validatePatch(patch, cwd);
  if (!base.ok) return base;

  // 2. lint -- scoped to the patched file when we know it, whole worktree otherwise
  const lintFiles = file ? [file] : [];
  const lint = cwd
    ? runLint(cwd, lintFiles)
    : runLint(process.cwd(), lintFiles);

  if (!lint.success) {
    return reject('Lint failed:\n' + lint.output);
  }

  // 3. pre-apply baseline test -- full suite in the worktree
  const tests = cwd
    ? runTests(cwd)
    : runTests(process.cwd());

  if (!tests.success) {
    return reject('Tests failed:\n' + tests.output);
  }

  return approve();
}

function approve() {
  return { ok: true, message: 'APPROVED' };
}

function reject(reason) {
  return { ok: false, message: `REJECTED\nReason: ${reason}` };
}
