/**
 * tests/retry-policy.test.js
 *
 * Unit tests for engine/retry-policy.js
 *
 * Covers:
 *   RetryPreset        — shape and values of every built-in preset
 *   resolvePolicy()    — no declaration, string preset, inline object, unknown preset, bad type
 *   calcDelay()        — immediate / linear / exponential / cap / unknown fallback
 *   agentForAttempt()  — routing at attempt 1 / 2 / 3+ / null escalation / null fallback
 *
 * No Redis, no network, no filesystem — purely synchronous logic.
 */

import { describe, it, expect } from 'vitest';
import {
  RetryPreset,
  resolvePolicy,
  calcDelay,
  agentForAttempt,
} from '../engine/retry-policy.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Minimal step fixture */
function step(overrides = {}) {
  return { id: 'step-1', agent: 'feature-builder', ...overrides };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. RetryPreset — built-in preset shapes
// ═══════════════════════════════════════════════════════════════════════════════

describe('RetryPreset — built-in preset shapes', () => {
  it('STANDARD has maxAttempts=3, exponential backoff, 2 s base', () => {
    expect(RetryPreset.STANDARD).toMatchObject({
      maxAttempts: 3,
      backoff: 'exponential',
      delayMs: 2000,
      escalationAgent: 'debugger',
      fallbackAgent: 'meta-reviewer',
    });
  });

  it('IO_BOUND allows more attempts (5) and a higher base delay (3 s)', () => {
    expect(RetryPreset.IO_BOUND).toMatchObject({
      maxAttempts: 5,
      backoff: 'exponential',
      delayMs: 3000,
      escalationAgent: 'debugger',
    });
  });

  it('CODE_GEN fails fast — 2 attempts, immediate backoff, no delay', () => {
    expect(RetryPreset.CODE_GEN).toMatchObject({
      maxAttempts: 2,
      backoff: 'immediate',
      delayMs: 0,
      escalationAgent: 'refactorer',
    });
  });

  it('REVIEW is a single-shot hard-block — maxAttempts=1, null escalation agents', () => {
    expect(RetryPreset.REVIEW).toMatchObject({
      maxAttempts: 1,
      backoff: 'immediate',
      delayMs: 0,
      escalationAgent: null,
      fallbackAgent: null,
    });
  });

  it('all presets expose the five required fields', () => {
    const required = ['maxAttempts', 'backoff', 'delayMs', 'escalationAgent', 'fallbackAgent'];
    for (const [name, preset] of Object.entries(RetryPreset)) {
      for (const field of required) {
        expect(preset, `${name} missing ${field}`).toHaveProperty(field);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. resolvePolicy()
// ═══════════════════════════════════════════════════════════════════════════════

describe('resolvePolicy()', () => {
  // ── no declaration ──────────────────────────────────────────────────────────

  it('returns a copy of STANDARD when retryPolicy is undefined', () => {
    const policy = resolvePolicy(step());
    expect(policy).toEqual(RetryPreset.STANDARD);
  });

  it('returns a copy of STANDARD when retryPolicy is null', () => {
    const policy = resolvePolicy(step({ retryPolicy: null }));
    expect(policy).toEqual(RetryPreset.STANDARD);
  });

  it('returns a copy of STANDARD when retryPolicy is 0 (falsy)', () => {
    const policy = resolvePolicy(step({ retryPolicy: 0 }));
    expect(policy).toEqual(RetryPreset.STANDARD);
  });

  it('does not mutate the STANDARD preset — returns a fresh object', () => {
    const policy = resolvePolicy(step());
    policy.maxAttempts = 999;
    expect(RetryPreset.STANDARD.maxAttempts).toBe(3);
  });

  // ── string preset names ─────────────────────────────────────────────────────

  it('resolves "STANDARD" string to the STANDARD preset', () => {
    expect(resolvePolicy(step({ retryPolicy: 'STANDARD' }))).toEqual(RetryPreset.STANDARD);
  });

  it('resolves "IO_BOUND" string to the IO_BOUND preset', () => {
    expect(resolvePolicy(step({ retryPolicy: 'IO_BOUND' }))).toEqual(RetryPreset.IO_BOUND);
  });

  it('resolves "CODE_GEN" string to the CODE_GEN preset', () => {
    expect(resolvePolicy(step({ retryPolicy: 'CODE_GEN' }))).toEqual(RetryPreset.CODE_GEN);
  });

  it('resolves "REVIEW" string to the REVIEW preset', () => {
    expect(resolvePolicy(step({ retryPolicy: 'REVIEW' }))).toEqual(RetryPreset.REVIEW);
  });

  it('resolves preset string case-insensitively ("io_bound" → IO_BOUND)', () => {
    expect(resolvePolicy(step({ retryPolicy: 'io_bound' }))).toEqual(RetryPreset.IO_BOUND);
  });

  it('resolves preset string in mixed case ("Code_Gen" → CODE_GEN)', () => {
    expect(resolvePolicy(step({ retryPolicy: 'Code_Gen' }))).toEqual(RetryPreset.CODE_GEN);
  });

  it('falls back to STANDARD for an unknown preset name', () => {
    expect(resolvePolicy(step({ retryPolicy: 'NONEXISTENT' }))).toEqual(RetryPreset.STANDARD);
  });

  it('returns a fresh object for string presets — mutation does not affect the original', () => {
    const policy = resolvePolicy(step({ retryPolicy: 'IO_BOUND' }));
    policy.maxAttempts = 999;
    expect(RetryPreset.IO_BOUND.maxAttempts).toBe(5);
  });

  // ── inline object overrides ─────────────────────────────────────────────────

  it('applies inline object fields over STANDARD defaults', () => {
    const policy = resolvePolicy(step({ retryPolicy: { maxAttempts: 7 } }));
    expect(policy.maxAttempts).toBe(7);
    // non-overridden fields come from STANDARD
    expect(policy.backoff).toBe('exponential');
    expect(policy.delayMs).toBe(2000);
  });

  it('inline object can override multiple fields simultaneously', () => {
    const policy = resolvePolicy(step({
      retryPolicy: { maxAttempts: 4, backoff: 'linear', delayMs: 500 },
    }));
    expect(policy).toMatchObject({ maxAttempts: 4, backoff: 'linear', delayMs: 500 });
    expect(policy.escalationAgent).toBe('debugger'); // still from STANDARD
  });

  it('inline object can set escalationAgent to null (no escalation)', () => {
    const policy = resolvePolicy(step({ retryPolicy: { escalationAgent: null } }));
    expect(policy.escalationAgent).toBeNull();
  });

  it('inline object can override fallbackAgent', () => {
    const policy = resolvePolicy(step({ retryPolicy: { fallbackAgent: 'security-editor' } }));
    expect(policy.fallbackAgent).toBe('security-editor');
  });

  it('empty inline object resolves to all STANDARD defaults', () => {
    expect(resolvePolicy(step({ retryPolicy: {} }))).toEqual(RetryPreset.STANDARD);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. calcDelay()
// ═══════════════════════════════════════════════════════════════════════════════

describe('calcDelay()', () => {
  // ── immediate ───────────────────────────────────────────────────────────────

  it('returns 0 for immediate backoff on attempt 1', () => {
    expect(calcDelay({ backoff: 'immediate', delayMs: 1000 }, 1)).toBe(0);
  });

  it('returns 0 for immediate backoff on any attempt', () => {
    for (const attempt of [1, 2, 3, 10]) {
      expect(calcDelay({ backoff: 'immediate', delayMs: 5000 }, attempt)).toBe(0);
    }
  });

  // ── linear ──────────────────────────────────────────────────────────────────

  it('scales linearly: delayMs × attempt', () => {
    const policy = { backoff: 'linear', delayMs: 1000 };
    expect(calcDelay(policy, 1)).toBe(1000);
    expect(calcDelay(policy, 2)).toBe(2000);
    expect(calcDelay(policy, 3)).toBe(3000);
    expect(calcDelay(policy, 10)).toBe(10_000);
  });

  it('linear with delayMs=0 always returns 0', () => {
    expect(calcDelay({ backoff: 'linear', delayMs: 0 }, 5)).toBe(0);
  });

  // ── exponential ─────────────────────────────────────────────────────────────

  it('doubles each attempt for exponential backoff (2 s base)', () => {
    const policy = { backoff: 'exponential', delayMs: 2000 };
    expect(calcDelay(policy, 1)).toBe(2000);   // 2000 * 2^0
    expect(calcDelay(policy, 2)).toBe(4000);   // 2000 * 2^1
    expect(calcDelay(policy, 3)).toBe(8000);   // 2000 * 2^2
    expect(calcDelay(policy, 4)).toBe(16_000); // 2000 * 2^3
    expect(calcDelay(policy, 5)).toBe(32_000); // 2000 * 2^4
  });

  it('caps exponential delay at 60 seconds', () => {
    const policy = { backoff: 'exponential', delayMs: 2000 };
    // 2000 * 2^5 = 64 000 → capped at 60 000
    expect(calcDelay(policy, 6)).toBe(60_000);
    expect(calcDelay(policy, 20)).toBe(60_000);
  });

  it('3 s IO_BOUND base: attempt 1→3 s, attempt 2→6 s, attempt 3→12 s', () => {
    const policy = { backoff: 'exponential', delayMs: 3000 };
    expect(calcDelay(policy, 1)).toBe(3000);
    expect(calcDelay(policy, 2)).toBe(6000);
    expect(calcDelay(policy, 3)).toBe(12_000);
  });

  it('exponential with delayMs=0 always returns 0', () => {
    const policy = { backoff: 'exponential', delayMs: 0 };
    for (const attempt of [1, 2, 5]) {
      expect(calcDelay(policy, attempt)).toBe(0);
    }
  });

  // ── unknown / default ────────────────────────────────────────────────────────

  it('unknown backoff type falls back to exponential behaviour', () => {
    const policy = { backoff: 'bogus', delayMs: 1000 };
    expect(calcDelay(policy, 1)).toBe(1000);
    expect(calcDelay(policy, 2)).toBe(2000);
  });

  it('missing backoff field falls back to exponential behaviour', () => {
    const policy = { delayMs: 1000 };
    expect(calcDelay(policy, 1)).toBe(1000);
    expect(calcDelay(policy, 2)).toBe(2000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. agentForAttempt()
// ═══════════════════════════════════════════════════════════════════════════════

describe('agentForAttempt()', () => {
  const baseStep   = step({ agent: 'feature-builder' });
  const stdPolicy  = { ...RetryPreset.STANDARD }; // escalation=debugger, fallback=meta-reviewer

  // ── attempt 1 — always the step's own agent ──────────────────────────────────

  it('returns the step agent on attempt 1', () => {
    expect(agentForAttempt(baseStep, stdPolicy, 1)).toBe('feature-builder');
  });

  it('returns the step agent on attempt 1 even when escalation agents exist', () => {
    const p = { escalationAgent: 'debugger', fallbackAgent: 'meta-reviewer' };
    expect(agentForAttempt(step({ agent: 'test-writer' }), p, 1)).toBe('test-writer');
  });

  // ── attempt 2 — escalationAgent ─────────────────────────────────────────────

  it('returns escalationAgent on attempt 2 when set', () => {
    expect(agentForAttempt(baseStep, stdPolicy, 2)).toBe('debugger');
  });

  it('returns the step agent on attempt 2 when escalationAgent is null', () => {
    const p = { escalationAgent: null, fallbackAgent: null };
    expect(agentForAttempt(baseStep, p, 2)).toBe('feature-builder');
  });

  it('CODE_GEN preset: escalationAgent is refactorer on attempt 2', () => {
    expect(agentForAttempt(baseStep, RetryPreset.CODE_GEN, 2)).toBe('refactorer');
  });

  // ── attempt 3+ — fallbackAgent ──────────────────────────────────────────────

  it('returns fallbackAgent on attempt 3', () => {
    expect(agentForAttempt(baseStep, stdPolicy, 3)).toBe('meta-reviewer');
  });

  it('returns fallbackAgent on attempt 10 (any attempt beyond 2)', () => {
    expect(agentForAttempt(baseStep, stdPolicy, 10)).toBe('meta-reviewer');
  });

  it('falls back to escalationAgent when fallbackAgent is null and attempt >= 3', () => {
    const p = { escalationAgent: 'debugger', fallbackAgent: null };
    expect(agentForAttempt(baseStep, p, 3)).toBe('debugger');
  });

  it('falls back to the step agent when both escalation agents are null and attempt >= 3', () => {
    const p = { escalationAgent: null, fallbackAgent: null };
    expect(agentForAttempt(baseStep, p, 3)).toBe('feature-builder');
  });

  // ── REVIEW preset edge case ───────────────────────────────────────────────

  it('REVIEW preset always returns the step agent (both escalation agents are null)', () => {
    const reviewStep = step({ agent: 'review-guard' });
    expect(agentForAttempt(reviewStep, RetryPreset.REVIEW, 1)).toBe('review-guard');
    // attempt 2 with null escalationAgent → step agent
    expect(agentForAttempt(reviewStep, RetryPreset.REVIEW, 2)).toBe('review-guard');
  });

  // ── agent field on the step is respected ────────────────────────────────────

  it('works correctly for any agent value on the step', () => {
    const agents = ['feature-builder', 'debugger', 'refactorer', 'test-writer',
                    'security-editor', 'review-guard', 'meta-reviewer'];
    for (const agent of agents) {
      expect(agentForAttempt(step({ agent }), stdPolicy, 1)).toBe(agent);
    }
  });
});
