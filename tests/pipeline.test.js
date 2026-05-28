/**
 * tests/pipeline.test.js
 *
 * Full pipeline test suite.
 *
 * Modules covered:
 *   review-system   — validatePatch (existing + expanded)
 *   retry-policy    — resolvePolicy, calcDelay, agentForAttempt
 *   orchestrator    — parsePlan / stripFences (logic replicated for unit testing)
 *   workflow-store  — getRunnableSteps DAG logic (Redis mocked)
 *   code-writer     — validateTargetPath, parsePatch
 *   tenant          — assertTenantId
 *   idempotency     — getOperationId determinism
 *
 * Modules intentionally excluded (require live Redis / git / AI API):
 *   concurrency, git, agent-runner, queue, job-store, metrics, tracer
 */

import { describe, it, expect, vi } from 'vitest';
import { resolve }                  from 'path';
import { fileURLToPath }            from 'url';

// ─── mock IORedis before any module that imports it ──────────────────────────

vi.mock('ioredis', () => {
  const store  = new Map();
  const hstore = new Map();

  const client = {
    get:             vi.fn(async k => store.get(k) ?? null),
    set:             vi.fn(async (k, v) => { store.set(k, v); return 'OK'; }),
    exists:          vi.fn(async k => (store.has(k) ? 1 : 0)),
    hset:            vi.fn(async (k, f, v) => {
      if (!hstore.has(k)) hstore.set(k, new Map());
      hstore.get(k).set(f, v);
      return 1;
    }),
    hgetall: vi.fn(async k => {
      const h = hstore.get(k);
      if (!h) return {};
      return Object.fromEntries(h);
    }),
    pipeline: vi.fn(() => ({
      hset: vi.fn().mockReturnThis(),
      set:  vi.fn().mockReturnThis(),
      exec: vi.fn(async () => []),
    })),
    // concurrency stubs — not exercised here but required for clean import
    zadd:            vi.fn(async () => 1),
    zcard:           vi.fn(async () => 0),
    zrange:          vi.fn(async () => []),
    zrem:            vi.fn(async () => 1),
    zremrangebyscore:vi.fn(async () => 0),
    pexpire:         vi.fn(async () => 1),
    del:             vi.fn(async () => 1),
    _store:  store,
    _hstore: hstore,
    _reset() { store.clear(); hstore.clear(); },
  };

  return { default: vi.fn(() => client), __client: client };
});

// ─── imports (after mock) ────────────────────────────────────────────────────

import { validatePatch }                          from '../engine/review-system.js';
import { resolvePolicy, calcDelay, agentForAttempt, RetryPreset }
                                                  from '../engine/retry-policy.js';
import { validateTargetPath, parsePatch }         from '../engine/code-writer.js';
import { assertTenantId, DEFAULT_TENANT }         from '../engine/tenant.js';
import { getOperationId }                         from '../engine/idempotency.js';
import { getRunnableSteps }                       from '../engine/workflow-store.js';

// ─── project root (mirrors the constant inside code-writer.js) ───────────────

const _engineDir  = fileURLToPath(new URL('../engine', import.meta.url));
const PROJECT_ROOT = resolve(_engineDir, '..');

// ─── parsePlan — orchestrator keeps it private, replicated here for unit tests

const VALID_AGENTS = new Set([
  'feature-builder', 'debugger', 'refactorer',
  'test-writer', 'security-editor', 'review-guard',
]);

function stripFences(raw) {
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

function parsePlan(raw) {
  let plan;
  try { plan = JSON.parse(stripFences(raw)); }
  catch (err) { throw new Error(`Planner returned invalid JSON: ${err.message}`); }

  if (plan === null || typeof plan !== 'object' || Array.isArray(plan))
    throw new Error('Planner JSON must be an object with a "tasks" array');
  if (!Array.isArray(plan.tasks))
    throw new Error('Planner output missing "tasks" array');
  if (plan.tasks.length === 0)
    throw new Error('Planner returned an empty tasks array');

  const seenIds = new Set();
  for (let i = 0; i < plan.tasks.length; i++) {
    const t   = plan.tasks[i];
    const loc = `tasks[${i}]`;
    if (t === null || typeof t !== 'object')
      throw new Error(`${loc} is not an object`);
    if (typeof t.id !== 'string' || t.id.trim() === '')
      throw new Error(`${loc}.id must be a non-empty string`);
    if (seenIds.has(t.id))
      throw new Error(`${loc}.id "${t.id}" is duplicated`);
    seenIds.add(t.id);
    if (!VALID_AGENTS.has(t.agent))
      throw new Error(`${loc} has unknown agent "${t.agent}"`);
    if (typeof t.description !== 'string' || t.description.trim() === '')
      throw new Error(`${loc} must have a non-empty description string`);
    if (!Array.isArray(t.depends_on))
      throw new Error(`${loc} "depends_on" must be an array`);
    for (const dep of t.depends_on) {
      if (!seenIds.has(dep))
        throw new Error(`${loc} depends_on "${dep}" which is not defined before this task`);
    }
    if (t.files !== undefined) {
      if (!Array.isArray(t.files) || t.files.some(f => typeof f !== 'string'))
        throw new Error(`${loc} "files" must be an array of strings`);
    }
  }
  return plan;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function task(overrides = {}) {
  return { id: 'step-1', agent: 'feature-builder',
           description: 'Do something useful', depends_on: [], ...overrides };
}

function planJSON(tasks) {
  return JSON.stringify({ tasks });
}

async function seedWorkflow(workflowId, steps) {
  const ioredis = await import('ioredis');
  const client  = ioredis.__client;
  client._reset();
  const key = `aegis:workflow:${workflowId}`;
  for (const s of steps) {
    await client.hset(key, s.id, JSON.stringify(s));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. validatePatch
// ═══════════════════════════════════════════════════════════════════════════════

describe('validatePatch', () => {
  it('rejects non-JSON input', () => {
    const r = validatePatch('not json');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/REJECTED/);
  });

  it('rejects a patch missing the content field', () => {
    expect(validatePatch(JSON.stringify({ file: 'src/foo.js' })).ok).toBe(false);
    expect(validatePatch(JSON.stringify({ file: 'src/foo.js' })).message).toMatch(/Invalid patch format/);
  });

  it('rejects a patch missing the file field', () => {
    expect(validatePatch(JSON.stringify({ content: 'x' })).ok).toBe(false);
  });

  it('rejects path traversal in the file field', () => {
    const r = validatePatch(JSON.stringify({ file: '../../etc/passwd', content: 'x' }));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Unsafe file path/);
  });

  it('rejects content exceeding the size limit', () => {
    const r = validatePatch(JSON.stringify({ file: 'src/foo.js', content: 'x'.repeat(50001) }));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Patch too large/);
  });

  it('accepts content at exactly the size limit', () => {
    const r = validatePatch(JSON.stringify({ file: 'src/foo.js', content: 'x'.repeat(50000) }));
    expect(r.ok).toBe(true);
  });

  it('rejects a non-string file field', () => {
    expect(validatePatch(JSON.stringify({ file: 42, content: 'x' })).ok).toBe(false);
  });

  it('rejects .env via blocked name', () => {
    const r = validatePatch(JSON.stringify({ file: 'src/.env', content: 'SECRET=x' }));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Unsafe file path/);
  });

  it('rejects secrets via blocked name', () => {
    expect(validatePatch(JSON.stringify({ file: 'config/secrets', content: 'x' })).ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. resolvePolicy
// ═══════════════════════════════════════════════════════════════════════════════

describe('resolvePolicy', () => {
  it('returns STANDARD defaults when no retryPolicy is set', () => {
    const p = resolvePolicy({ id: 's1', agent: 'feature-builder' });
    expect(p.maxAttempts).toBe(3);
    expect(p.backoff).toBe('exponential');
    expect(p.delayMs).toBe(2000);
    expect(p.escalationAgent).toBe('debugger');
  });

  it('resolves IO_BOUND preset string', () => {
    const p = resolvePolicy({ id: 's1', retryPolicy: 'IO_BOUND' });
    expect(p.maxAttempts).toBe(5);
    expect(p.backoff).toBe('exponential');
  });

  it('resolves preset string case-insensitively', () => {
    const p = resolvePolicy({ id: 's1', retryPolicy: 'code_gen' });
    expect(p.maxAttempts).toBe(2);
    expect(p.backoff).toBe('immediate');
  });

  it('falls back to STANDARD for an unknown preset name', () => {
    const p = resolvePolicy({ id: 's1', retryPolicy: 'NONEXISTENT' });
    expect(p.maxAttempts).toBe(RetryPreset.STANDARD.maxAttempts);
  });

  it('merges an inline policy object over STANDARD defaults', () => {
    const p = resolvePolicy({ id: 's1', retryPolicy: { maxAttempts: 7, delayMs: 500 } });
    expect(p.maxAttempts).toBe(7);
    expect(p.delayMs).toBe(500);
    expect(p.backoff).toBe('exponential'); // default survives merge
  });

  it('REVIEW preset has maxAttempts=1 and null escalation', () => {
    const p = resolvePolicy({ id: 's1', retryPolicy: 'REVIEW' });
    expect(p.maxAttempts).toBe(1);
    expect(p.escalationAgent).toBeNull();
    expect(p.fallbackAgent).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. calcDelay
// ═══════════════════════════════════════════════════════════════════════════════

describe('calcDelay', () => {
  it('returns 0 for immediate backoff regardless of attempt', () => {
    expect(calcDelay({ backoff: 'immediate', delayMs: 1000 }, 1)).toBe(0);
    expect(calcDelay({ backoff: 'immediate', delayMs: 1000 }, 5)).toBe(0);
  });

  it('scales linearly: delayMs × attempt', () => {
    expect(calcDelay({ backoff: 'linear', delayMs: 1000 }, 1)).toBe(1000);
    expect(calcDelay({ backoff: 'linear', delayMs: 1000 }, 3)).toBe(3000);
  });

  it('doubles each attempt for exponential backoff', () => {
    const p = { backoff: 'exponential', delayMs: 2000 };
    expect(calcDelay(p, 1)).toBe(2000);
    expect(calcDelay(p, 2)).toBe(4000);
    expect(calcDelay(p, 3)).toBe(8000);
  });

  it('caps exponential at 60 seconds', () => {
    expect(calcDelay({ backoff: 'exponential', delayMs: 2000 }, 20)).toBe(60_000);
  });

  it('defaults to exponential for an unknown backoff type', () => {
    expect(calcDelay({ backoff: 'unknown', delayMs: 1000 }, 2)).toBe(2000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. agentForAttempt
// ═══════════════════════════════════════════════════════════════════════════════

describe('agentForAttempt', () => {
  const step   = { id: 's1', agent: 'feature-builder' };
  const policy = { escalationAgent: 'debugger', fallbackAgent: 'meta-reviewer' };

  it('returns the step agent on attempt 1', () => {
    expect(agentForAttempt(step, policy, 1)).toBe('feature-builder');
  });

  it('escalates to escalationAgent on attempt 2', () => {
    expect(agentForAttempt(step, policy, 2)).toBe('debugger');
  });

  it('uses fallbackAgent on attempt 3 and beyond', () => {
    expect(agentForAttempt(step, policy, 3)).toBe('meta-reviewer');
    expect(agentForAttempt(step, policy, 10)).toBe('meta-reviewer');
  });

  it('falls back to escalationAgent when fallbackAgent is null', () => {
    expect(agentForAttempt(step, { escalationAgent: 'debugger', fallbackAgent: null }, 3))
      .toBe('debugger');
  });

  it('falls back to step agent when both escalation agents are null', () => {
    expect(agentForAttempt(step, { escalationAgent: null, fallbackAgent: null }, 2))
      .toBe('feature-builder');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. parsePlan (orchestrator validation logic)
// ═══════════════════════════════════════════════════════════════════════════════

describe('parsePlan', () => {
  it('parses a minimal valid single-task plan', () => {
    const plan = parsePlan(planJSON([task()]));
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].id).toBe('step-1');
  });

  it('strips ```json fences before parsing', () => {
    expect(() => parsePlan('```json\n' + planJSON([task()]) + '\n```')).not.toThrow();
  });

  it('strips plain ``` fences before parsing', () => {
    expect(() => parsePlan('```\n' + planJSON([task()]) + '\n```')).not.toThrow();
  });

  it('throws on non-JSON input', () => {
    expect(() => parsePlan('not json')).toThrow(/invalid JSON/);
  });

  it('throws when root is an array', () => {
    expect(() => parsePlan(JSON.stringify([task()]))).toThrow(/must be an object/);
  });

  it('throws when tasks key is missing', () => {
    expect(() => parsePlan(JSON.stringify({ steps: [] }))).toThrow(/missing "tasks"/);
  });

  it('throws on an empty tasks array', () => {
    expect(() => parsePlan(JSON.stringify({ tasks: [] }))).toThrow(/empty tasks array/);
  });

  it('throws on duplicate task ids', () => {
    expect(() => parsePlan(planJSON([task(), task()]))).toThrow(/duplicated/);
  });

  it('throws on an unknown agent', () => {
    expect(() => parsePlan(planJSON([task({ agent: 'rogue-agent' })]))).toThrow(/unknown agent/);
  });

  it('throws when description is blank', () => {
    expect(() => parsePlan(planJSON([task({ description: '  ' })]))).toThrow(/description/);
  });

  it('throws when depends_on is not an array', () => {
    expect(() => parsePlan(planJSON([task({ depends_on: 'step-0' })]))).toThrow(/depends_on.*must be an array/);
  });

  it('throws when depends_on references an undefined id', () => {
    expect(() => parsePlan(planJSON([task({ id: 'a', depends_on: ['missing'] })]))).toThrow(/not defined before/);
  });

  it('accepts a valid two-step linear dependency chain', () => {
    const plan = parsePlan(planJSON([
      task({ id: 'a', depends_on: [] }),
      task({ id: 'b', depends_on: ['a'] }),
    ]));
    expect(plan.tasks).toHaveLength(2);
  });

  it('throws when files contains a non-string element', () => {
    expect(() => parsePlan(planJSON([task({ files: [42] })]))).toThrow(/files.*must be an array of strings/);
  });

  it('accepts valid optional files array', () => {
    const plan = parsePlan(planJSON([task({ files: ['src/a.js', 'src/b.js'] })]));
    expect(plan.tasks[0].files).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. getRunnableSteps — DAG progression
// ═══════════════════════════════════════════════════════════════════════════════

describe('getRunnableSteps — DAG progression', () => {
  it('returns all root steps when all are pending', async () => {
    await seedWorkflow('wf-1', [
      { id: 'a', status: 'pending', depends_on: [] },
      { id: 'b', status: 'pending', depends_on: [] },
    ]);
    const ids = (await getRunnableSteps('wf-1')).map(s => s.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('withholds a step whose dependency is still pending', async () => {
    await seedWorkflow('wf-2', [
      { id: 'a', status: 'pending', depends_on: [] },
      { id: 'b', status: 'pending', depends_on: ['a'] },
    ]);
    const ids = (await getRunnableSteps('wf-2')).map(s => s.id);
    expect(ids).toEqual(['a']);
  });

  it('unlocks a step once its dependency is completed', async () => {
    await seedWorkflow('wf-3', [
      { id: 'a', status: 'completed', depends_on: [] },
      { id: 'b', status: 'pending',   depends_on: ['a'] },
    ]);
    const ids = (await getRunnableSteps('wf-3')).map(s => s.id);
    expect(ids).toEqual(['b']);
  });

  it('returns nothing when all steps are already completed', async () => {
    await seedWorkflow('wf-4', [
      { id: 'a', status: 'completed', depends_on: [] },
      { id: 'b', status: 'completed', depends_on: ['a'] },
    ]);
    expect(await getRunnableSteps('wf-4')).toHaveLength(0);
  });

  it('skips a step whose status is running (not pending)', async () => {
    await seedWorkflow('wf-5', [
      { id: 'a', status: 'running', depends_on: [] },
    ]);
    expect(await getRunnableSteps('wf-5')).toHaveLength(0);
  });

  it('handles a diamond DAG: A→B, A→C, B+C→D', async () => {
    await seedWorkflow('wf-6', [
      { id: 'A', status: 'completed', depends_on: [] },
      { id: 'B', status: 'completed', depends_on: ['A'] },
      { id: 'C', status: 'completed', depends_on: ['A'] },
      { id: 'D', status: 'pending',   depends_on: ['B', 'C'] },
    ]);
    const ids = (await getRunnableSteps('wf-6')).map(s => s.id);
    expect(ids).toEqual(['D']);
  });

  it('keeps D blocked when only one of its two deps is complete', async () => {
    await seedWorkflow('wf-7', [
      { id: 'A', status: 'completed', depends_on: [] },
      { id: 'B', status: 'completed', depends_on: ['A'] },
      { id: 'C', status: 'pending',   depends_on: ['A'] },
      { id: 'D', status: 'pending',   depends_on: ['B', 'C'] },
    ]);
    const ids = (await getRunnableSteps('wf-7')).map(s => s.id);
    expect(ids).toEqual(['C']); // D still blocked by C
  });

  it('fans out correctly — three independent successors of one completed step', async () => {
    await seedWorkflow('wf-8', [
      { id: 'root', status: 'completed', depends_on: [] },
      { id: 'b',    status: 'pending',   depends_on: ['root'] },
      { id: 'c',    status: 'pending',   depends_on: ['root'] },
      { id: 'd',    status: 'pending',   depends_on: ['root'] },
    ]);
    const ids = (await getRunnableSteps('wf-8')).map(s => s.id).sort();
    expect(ids).toEqual(['b', 'c', 'd']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. validateTargetPath (code-writer)
// ═══════════════════════════════════════════════════════════════════════════════

describe('validateTargetPath', () => {
  it('accepts a path inside the project root', () => {
    expect(validateTargetPath(resolve(PROJECT_ROOT, 'src', 'foo.js'))).toBeNull();
  });

  it('blocks a path outside the project root', () => {
    const outside = resolve(PROJECT_ROOT, '..', 'etc', 'passwd');
    expect(validateTargetPath(outside)).toMatch(/Path traversal blocked/);
  });

  it('blocks .env filename', () => {
    expect(validateTargetPath(resolve(PROJECT_ROOT, 'src', '.env')))
      .toMatch(/Blocked filename pattern/);
  });

  it('blocks a file named secrets', () => {
    expect(validateTargetPath(resolve(PROJECT_ROOT, 'config', 'secrets')))
      .toMatch(/Blocked filename pattern/);
  });

  it('blocks a file whose name contains secrets', () => {
    expect(validateTargetPath(resolve(PROJECT_ROOT, 'config', 'my.secrets.json')))
      .toMatch(/Blocked filename pattern/);
  });

  it('allows secretary.js — contains "secret" but not "secrets"', () => {
    expect(validateTargetPath(resolve(PROJECT_ROOT, 'src', 'secretary.js'))).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. parsePatch (code-writer)
// ═══════════════════════════════════════════════════════════════════════════════

describe('parsePatch', () => {
  it('parses a valid JSON patch string', () => {
    const r = parsePatch(JSON.stringify({ file: 'src/foo.js', content: 'hello' }));
    expect(r.file).toBe('src/foo.js');
    expect(r.content).toBe('hello');
  });

  it('throws on invalid JSON', () => {
    expect(() => parsePatch('not json')).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. assertTenantId (tenant)
// ═══════════════════════════════════════════════════════════════════════════════

describe('assertTenantId', () => {
  it('accepts valid identifiers', () => {
    expect(assertTenantId('default')).toBe('default');
    expect(assertTenantId('acme')).toBe('acme');
    expect(assertTenantId('org_abc123')).toBe('org_abc123');
    expect(assertTenantId('tenant-99')).toBe('tenant-99');
  });

  it('accepts DEFAULT_TENANT', () => {
    expect(() => assertTenantId(DEFAULT_TENANT)).not.toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => assertTenantId('')).toThrow(/Invalid tenantId/);
  });

  it('rejects a string longer than 64 characters', () => {
    expect(() => assertTenantId('a'.repeat(65))).toThrow(/Invalid tenantId/);
  });

  it('rejects strings with spaces', () => {
    expect(() => assertTenantId('tenant id')).toThrow(/Invalid tenantId/);
  });

  it('rejects strings with path separators', () => {
    expect(() => assertTenantId('tenant/id')).toThrow(/Invalid tenantId/);
    expect(() => assertTenantId('../../etc')).toThrow(/Invalid tenantId/);
  });

  it('rejects non-string types', () => {
    expect(() => assertTenantId(null)).toThrow(/Invalid tenantId/);
    expect(() => assertTenantId(undefined)).toThrow(/Invalid tenantId/);
    expect(() => assertTenantId(42)).toThrow(/Invalid tenantId/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. getOperationId (idempotency)
// ═══════════════════════════════════════════════════════════════════════════════

describe('getOperationId', () => {
  it('returns a 64-character hex string (SHA-256)', () => {
    expect(getOperationId('wf-1', 'step-1', 'patch')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same inputs produce the same output', () => {
    expect(getOperationId('wf-1', 'step-1', 'patch'))
      .toBe(getOperationId('wf-1', 'step-1', 'patch'));
  });

  it('differs when workflowId changes', () => {
    expect(getOperationId('wf-A', 'step-1', 'patch'))
      .not.toBe(getOperationId('wf-B', 'step-1', 'patch'));
  });

  it('differs when stepId changes', () => {
    expect(getOperationId('wf-1', 'step-A', 'patch'))
      .not.toBe(getOperationId('wf-1', 'step-B', 'patch'));
  });

  it('differs when patch content changes', () => {
    expect(getOperationId('wf-1', 'step-1', 'patch-v1'))
      .not.toBe(getOperationId('wf-1', 'step-1', 'patch-v2'));
  });

  it('produces distinct ids for the same logical step across tenants', () => {
    expect(getOperationId('tenantA:wf-1', 'step-1', 'patch'))
      .not.toBe(getOperationId('tenantB:wf-1', 'step-1', 'patch'));
  });
});
