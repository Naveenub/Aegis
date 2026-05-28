import { runLint } from './lint-runner.js';
import { runTests } from './test-runner.js';
import { validateTargetPath } from './code-writer.js';
import path from 'path';

const MAX_PATCH_SIZE = 50000; // chars

export function validatePatch(patch) {
  try {
    const parsed = JSON.parse(patch);

    if (!parsed.file || !parsed.content) {
      return reject('Invalid patch format');
    }

    if (typeof parsed.file !== 'string') {
      return reject('Patch file must be a string');
    }

    // Validate the target path at review time — before the patch ever reaches
    // applyPatch(). This is the earliest point we can catch a malicious file
    // field (e.g. "/etc/passwd", "../../.env") and block it with a clear
    // rejection reason rather than a silent no-op in code-writer.
    const resolved = path.resolve(parsed.file);
    const pathError = validateTargetPath(resolved);
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
 * runReviewPipeline(patch, cwd?)
 *
 * FIX: lint and test now accept a `cwd` so they run inside the tenant
 * worktree rather than process.cwd().
 *
 * This function is called BEFORE applyPatch (structural pre-flight), so the
 * worktree hasn't been mutated yet. That means:
 *  - Lint runs on the current worktree state (catches syntax errors in
 *    existing files that would make the patch context invalid).
 *  - Tests run as a baseline check. The post-apply test in agent-worker.js
 *    is the authoritative pass/fail gate — this is a fast pre-flight.
 *
 * When `cwd` is omitted (e.g. unit tests or callers that haven't checked out
 * a worktree yet) both runners fall back to process.cwd() and run the full
 * suite — same behaviour as before the fix, so no existing caller breaks.
 *
 * @param {string} patch   - Raw patch JSON string.
 * @param {string} [cwd]   - Tenant worktree directory (from ensureWorkflowBranch).
 * @param {string} [file]  - Relative path of the file being patched (for scoped lint).
 */
export function runReviewPipeline(patch, cwd, file) {
  // 1. structural + path validation (unchanged)
  const base = validatePatch(patch);
  if (!base.ok) return base;

  // 2. lint — scoped to the patched file when we know it, whole worktree otherwise
  const lintFiles = file ? [file] : [];
  const lint = cwd
    ? runLint(cwd, lintFiles)
    : runLint(process.cwd(), lintFiles);

  if (!lint.success) {
    return reject('Lint failed:\n' + lint.output);
  }

  // 3. pre-apply baseline test — full suite in the worktree
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
