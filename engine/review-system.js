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

export function runReviewPipeline(patch) {
  // 1. structural + path validation
  const base = validatePatch(patch);
  if (!base.ok) return base;

  // 2. lint check
  const lint = runLint();
  if (!lint.success) {
    return reject('Lint failed:\n' + lint.output);
  }

  // 3. test check
  const tests = runTests();
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