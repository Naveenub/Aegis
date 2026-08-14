/**
 * tests/review-system.test.js
 *
 * Unit tests for engine/review-system.js
 *
 * Covers:
 *   validatePatch()       — valid patches, missing fields, bad JSON, path traversal,
 *                           oversized content, non-string file field
 *   runReviewPipeline()   — delegates to validatePatch → lint → tests, short-circuits
 *                           on each failure, passes cwd through correctly
 *
 * lint-runner and test-runner are fully mocked — no filesystem, no subprocesses.
 * code-writer is partially mocked so validateTargetPath stays testable.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock lint-runner ─────────────────────────────────────────────────────────

vi.mock('../engine/lint-runner.js', () => ({
  runLint: vi.fn(() => ({ success: true, output: '' })),
}));

// ─── Mock test-runner ─────────────────────────────────────────────────────────

vi.mock('../engine/test-runner.js', () => ({
  runTests: vi.fn(() => ({ success: true, output: '' })),
}));

// ─── Mock code-writer (validateTargetPath) ───────────────────────────────────
// Default: every path is safe. Individual tests override as needed.

vi.mock('../engine/code-writer.js', () => ({
  validateTargetPath: vi.fn(() => null), // null = safe
}));

import { validatePatch, runReviewPipeline } from '../engine/review-system.js';
import { runLint } from '../engine/lint-runner.js';
import { runTests } from '../engine/test-runner.js';
import { validateTargetPath } from '../engine/code-writer.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

const VALID_PATCH = JSON.stringify({
  file: 'src/foo.js',
  content: 'console.log("hello");',
});

const LARGE_CONTENT = 'x'.repeat(50_001);

beforeEach(() => {
  vi.clearAllMocks();
  // Reset to safe defaults
  validateTargetPath.mockReturnValue(null);
  runLint.mockReturnValue({ success: true, output: '' });
  runTests.mockReturnValue({ success: true, output: '' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. validatePatch() — structural validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('validatePatch() — valid input', () => {
  it('returns { ok: true } for a well-formed patch', () => {
    const result = validatePatch(VALID_PATCH);
    expect(result.ok).toBe(true);
  });

  it('accepts a minimal patch with file and content', () => {
    const patch = JSON.stringify({ file: 'a.js', content: '// ok' });
    expect(validatePatch(patch).ok).toBe(true);
  });
});

describe('validatePatch() — missing / invalid fields', () => {
  it('rejects when file field is missing', () => {
    const patch = JSON.stringify({ content: 'x' });
    const result = validatePatch(patch);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/REJECTED/);
  });

  it('rejects when content field is missing', () => {
    const patch = JSON.stringify({ file: 'a.js' });
    const result = validatePatch(patch);
    expect(result.ok).toBe(false);
  });

  it('rejects when file is not a string (number)', () => {
    const patch = JSON.stringify({ file: 42, content: 'x' });
    const result = validatePatch(patch);
    expect(result.ok).toBe(false);
  });

  it('rejects when file is null', () => {
    const patch = JSON.stringify({ file: null, content: 'x' });
    const result = validatePatch(patch);
    expect(result.ok).toBe(false);
  });

  it('rejects malformed JSON', () => {
    const result = validatePatch('not-json{{{');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Invalid JSON/);
  });

  it('rejects empty string input', () => {
    const result = validatePatch('');
    expect(result.ok).toBe(false);
  });
});

describe('validatePatch() — content size limit', () => {
  it('rejects content exceeding 50 000 characters', () => {
    const patch = JSON.stringify({ file: 'a.js', content: LARGE_CONTENT });
    const result = validatePatch(patch);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/too large/i);
  });

  it('accepts content exactly at the 50 000 character boundary', () => {
    const patch = JSON.stringify({ file: 'a.js', content: 'x'.repeat(50_000) });
    expect(validatePatch(patch).ok).toBe(true);
  });
});

describe('validatePatch() — path safety', () => {
  it('rejects when validateTargetPath returns an error string', () => {
    validateTargetPath.mockReturnValue('Path traversal blocked: /etc/passwd');
    const patch = JSON.stringify({ file: '/etc/passwd', content: 'evil' });
    const result = validatePatch(patch);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Unsafe file path/);
  });

  it('passes when validateTargetPath returns null (safe)', () => {
    validateTargetPath.mockReturnValue(null);
    const result = validatePatch(VALID_PATCH);
    expect(result.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. runReviewPipeline() — orchestration
// ═══════════════════════════════════════════════════════════════════════════════

describe('runReviewPipeline() — happy path', () => {
  it('returns { ok: true, message: "APPROVED" } when all checks pass', () => {
    const result = runReviewPipeline(VALID_PATCH);
    expect(result.ok).toBe(true);
    expect(result.message).toBe('APPROVED');
  });

  it('calls runLint once', () => {
    runReviewPipeline(VALID_PATCH);
    expect(runLint).toHaveBeenCalledTimes(1);
  });

  it('calls runTests once', () => {
    runReviewPipeline(VALID_PATCH);
    expect(runTests).toHaveBeenCalledTimes(1);
  });
});

describe('runReviewPipeline() — cwd propagation', () => {
  it('passes cwd to runLint when provided', () => {
    runReviewPipeline(VALID_PATCH, '/tmp/worktree-abc');
    expect(runLint).toHaveBeenCalledWith('/tmp/worktree-abc', expect.any(Array), undefined);
  });

  it('passes cwd to runTests when provided', () => {
    runReviewPipeline(VALID_PATCH, '/tmp/worktree-abc');
    expect(runTests).toHaveBeenCalledWith('/tmp/worktree-abc', [], undefined);
  });

  it('passes the file path to runLint as scoped lint target', () => {
    runReviewPipeline(VALID_PATCH, '/tmp/worktree', 'src/foo.js');
    const [, files] = runLint.mock.calls[0];
    expect(files).toContain('src/foo.js');
  });

  it('passes empty files array to runLint when file is omitted', () => {
    runReviewPipeline(VALID_PATCH, '/tmp/worktree');
    const [, files] = runLint.mock.calls[0];
    expect(files).toEqual([]);
  });

  it('falls back to process.cwd() for lint when cwd is omitted', () => {
    runReviewPipeline(VALID_PATCH);
    expect(runLint).toHaveBeenCalledWith(process.cwd(), [], undefined);
  });

  it('falls back to process.cwd() for tests when cwd is omitted', () => {
    runReviewPipeline(VALID_PATCH);
    expect(runTests).toHaveBeenCalledWith(process.cwd(), [], undefined);
  });

  it('passes tenantId through to runLint and runTests when provided', () => {
    runReviewPipeline(VALID_PATCH, '/tmp/worktree-abc', undefined, 'acme');
    expect(runLint).toHaveBeenCalledWith('/tmp/worktree-abc', [], 'acme');
    expect(runTests).toHaveBeenCalledWith('/tmp/worktree-abc', [], 'acme');
  });
});

describe('runReviewPipeline() — short-circuit on structural failure', () => {
  it('does not call lint when validatePatch fails', () => {
    runReviewPipeline('bad-json');
    expect(runLint).not.toHaveBeenCalled();
    expect(runTests).not.toHaveBeenCalled();
  });

  it('returns a REJECTED message for invalid patches', () => {
    const result = runReviewPipeline('bad-json');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/REJECTED/);
  });
});

describe('runReviewPipeline() — lint failure', () => {
  it('returns { ok: false } and does not call runTests when lint fails', () => {
    runLint.mockReturnValue({ success: false, output: 'SyntaxError: unexpected token' });
    const result = runReviewPipeline(VALID_PATCH);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Lint failed/);
    expect(runTests).not.toHaveBeenCalled();
  });

  it('includes lint output in the rejection message', () => {
    runLint.mockReturnValue({ success: false, output: 'missing semicolon' });
    const result = runReviewPipeline(VALID_PATCH);
    expect(result.message).toContain('missing semicolon');
  });
});

describe('runReviewPipeline() — test failure', () => {
  it('returns { ok: false } when tests fail', () => {
    runTests.mockReturnValue({ success: false, output: '3 tests failed' });
    const result = runReviewPipeline(VALID_PATCH);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Tests failed/);
  });

  it('includes test output in the rejection message', () => {
    runTests.mockReturnValue({ success: false, output: 'AssertionError at line 42' });
    const result = runReviewPipeline(VALID_PATCH);
    expect(result.message).toContain('AssertionError at line 42');
  });

  it('calls lint before tests (lint is a prerequisite)', () => {
    const callOrder = [];
    runLint.mockImplementation(() => { callOrder.push('lint'); return { success: true, output: '' }; });
    runTests.mockImplementation(() => { callOrder.push('tests'); return { success: false, output: 'err' }; });
    runReviewPipeline(VALID_PATCH);
    expect(callOrder).toEqual(['lint', 'tests']);
  });
});
