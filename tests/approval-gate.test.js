/**
 * tests/approval-gate.test.js
 *
 * Unit tests for engine/approval-gate.js
 *
 * Covers:
 *   needsApproval()      — step-level override (true/false), global approval modes,
 *                          autonomous mode (default), combined env var logic
 *   approvalModeActive   — reflects global config at module load time
 *
 * No Redis, no network, no filesystem. The module reads env vars at import
 * time, so each describe block re-imports the module with a fresh env via
 * vi.resetModules() + dynamic import.
 */

import { describe, it, expect, vi } from 'vitest';

// ─── helpers ──────────────────────────────────────────────────────────────────

function step(overrides = {}) {
  return { id: 'step-1', agent: 'feature-builder', description: 'do a thing', ...overrides };
}

/**
 * Re-import approval-gate with the given env vars set.
 * Clears module registry first so env is re-read fresh.
 */
async function importWithEnv(vars = {}) {
  vi.resetModules();
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const mod = await import('../engine/approval-gate.js');
  // Restore
  for (const [k, orig] of Object.entries(saved)) {
    if (orig === undefined) delete process.env[k];
    else process.env[k] = orig;
  }
  return mod;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Default autonomous mode (no special env vars)
// ═══════════════════════════════════════════════════════════════════════════════

describe('needsApproval() — autonomous mode (default)', () => {
  it('returns null for a plain step — patch may apply immediately', async () => {
    const { needsApproval } = await importWithEnv({
      CLAUDE_AUTONOMY: 'true',
      MODE: 'autonomous',
    });
    expect(needsApproval(step())).toBeNull();
  });

  it('returns null when requiresApproval is undefined', async () => {
    const { needsApproval } = await importWithEnv({ CLAUDE_AUTONOMY: 'true' });
    expect(needsApproval(step({ requiresApproval: undefined }))).toBeNull();
  });

  it('approvalModeActive is false in autonomous mode', async () => {
    const { approvalModeActive } = await importWithEnv({
      CLAUDE_AUTONOMY: 'true',
      MODE: 'autonomous',
    });
    expect(approvalModeActive).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Step-level requiresApproval: true
// ═══════════════════════════════════════════════════════════════════════════════

describe('needsApproval() — step.requiresApproval = true', () => {
  it('returns an approval object even when globally autonomous', async () => {
    const { needsApproval } = await importWithEnv({
      CLAUDE_AUTONOMY: 'true',
      MODE: 'autonomous',
    });
    const result = needsApproval(step({ requiresApproval: true }));
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('reason');
    expect(result).toHaveProperty('mode');
    expect(result.reason).toMatch(/explicitly requires human approval/);
  });

  it('result object contains mode and autonomy fields', async () => {
    const { needsApproval } = await importWithEnv({
      CLAUDE_AUTONOMY: 'true',
      MODE: 'autonomous',
    });
    const result = needsApproval(step({ requiresApproval: true }));
    expect(result).toHaveProperty('autonomy');
    expect(typeof result.mode).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Step-level requiresApproval: false (opt-out)
// ═══════════════════════════════════════════════════════════════════════════════

describe('needsApproval() — step.requiresApproval = false', () => {
  it('returns null even when global approval mode is active', async () => {
    const { needsApproval } = await importWithEnv({
      CLAUDE_AUTONOMY: 'false',
      MODE: 'approval',
    });
    expect(needsApproval(step({ requiresApproval: false }))).toBeNull();
  });

  it('step opt-out beats MODE=approval', async () => {
    const { needsApproval } = await importWithEnv({ MODE: 'approval' });
    expect(needsApproval(step({ requiresApproval: false }))).toBeNull();
  });

  it('step opt-out beats CLAUDE_AUTONOMY=false', async () => {
    const { needsApproval } = await importWithEnv({ CLAUDE_AUTONOMY: 'false' });
    expect(needsApproval(step({ requiresApproval: false }))).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Global approval via CLAUDE_AUTONOMY=false
// ═══════════════════════════════════════════════════════════════════════════════

describe('needsApproval() — CLAUDE_AUTONOMY=false', () => {
  it('returns an approval object for any ordinary step', async () => {
    const { needsApproval } = await importWithEnv({ CLAUDE_AUTONOMY: 'false' });
    const result = needsApproval(step());
    expect(result).not.toBeNull();
    expect(result.reason).toMatch(/CLAUDE_AUTONOMY/);
  });

  it('approvalModeActive is true', async () => {
    const { approvalModeActive } = await importWithEnv({ CLAUDE_AUTONOMY: 'false' });
    expect(approvalModeActive).toBe(true);
  });

  it('result includes the autonomy value in the reason string', async () => {
    const { needsApproval } = await importWithEnv({ CLAUDE_AUTONOMY: 'false' });
    const result = needsApproval(step());
    expect(result.reason).toContain('false');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Global approval via MODE=approval
// ═══════════════════════════════════════════════════════════════════════════════

describe('needsApproval() — MODE=approval', () => {
  it('returns an approval object for any ordinary step', async () => {
    const { needsApproval } = await importWithEnv({ MODE: 'approval' });
    const result = needsApproval(step());
    expect(result).not.toBeNull();
    expect(result.reason).toMatch(/MODE/);
  });

  it('approvalModeActive is true', async () => {
    const { approvalModeActive } = await importWithEnv({ MODE: 'approval' });
    expect(approvalModeActive).toBe(true);
  });

  it('result mode field matches the configured mode string', async () => {
    const { needsApproval } = await importWithEnv({ MODE: 'approval' });
    const result = needsApproval(step());
    expect(result.mode).toBe('approval');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Both vars set — approval required if either triggers it
// ═══════════════════════════════════════════════════════════════════════════════

describe('needsApproval() — combined env vars', () => {
  it('approval active when both CLAUDE_AUTONOMY=false and MODE=approval', async () => {
    const { needsApproval, approvalModeActive } = await importWithEnv({
      CLAUDE_AUTONOMY: 'false',
      MODE: 'approval',
    });
    expect(approvalModeActive).toBe(true);
    expect(needsApproval(step())).not.toBeNull();
  });

  it('autonomous when CLAUDE_AUTONOMY=true and MODE=autonomous (explicit)', async () => {
    const { needsApproval, approvalModeActive } = await importWithEnv({
      CLAUDE_AUTONOMY: 'true',
      MODE: 'autonomous',
    });
    expect(approvalModeActive).toBe(false);
    expect(needsApproval(step())).toBeNull();
  });

  it('step requiresApproval=true overrides autonomous global — approval still fires', async () => {
    const { needsApproval } = await importWithEnv({
      CLAUDE_AUTONOMY: 'true',
      MODE: 'autonomous',
    });
    expect(needsApproval(step({ requiresApproval: true }))).not.toBeNull();
  });

  it('step requiresApproval=false overrides approval global — no approval needed', async () => {
    const { needsApproval } = await importWithEnv({
      CLAUDE_AUTONOMY: 'false',
      MODE: 'approval',
    });
    expect(needsApproval(step({ requiresApproval: false }))).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Edge cases — whitespace / casing in env vars
// ═══════════════════════════════════════════════════════════════════════════════

describe('needsApproval() — env var normalisation', () => {
  it('trims whitespace from CLAUDE_AUTONOMY before comparison', async () => {
    // "  false  " should be treated as "false" → approval required
    const { approvalModeActive } = await importWithEnv({ CLAUDE_AUTONOMY: '  false  ' });
    expect(approvalModeActive).toBe(true);
  });

  it('lowercases MODE before comparison — "APPROVAL" triggers approval', async () => {
    const { approvalModeActive } = await importWithEnv({ MODE: 'APPROVAL' });
    expect(approvalModeActive).toBe(true);
  });
});
