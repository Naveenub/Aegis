import { runLint } from './lint-runner.js';
import { runTests } from './test-runner.js';

const MAX_PATCH_SIZE = 50000; // chars

export function validatePatch(patch) {
  try {
    const parsed = JSON.parse(patch);

    if (!parsed.file || !parsed.content) {
      return reject('Invalid patch format');
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
  // 1. structural validation
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
