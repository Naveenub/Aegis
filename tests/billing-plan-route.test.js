/**
 * tests/billing-plan-route.test.js
 *
 * server.js has no exported app, so route wiring is pinned at the source level.
 * changePlan() was fully implemented and unit-tested while no route called it,
 * so POST /billing/plan (documented in the API reference and on the landing
 * page) returned 404. This keeps that from regressing silently.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const line = src.split('\n').find((l) => l.includes("app.post('/billing/plan'")) ?? '';

describe('POST /billing/plan wiring', () => {
  it('is registered', () => {
    expect(line).not.toBe('');
  });

  it('requires an API key and tenant.admin', () => {
    expect(line).toContain('requireApiKey');
    expect(line).toContain("requirePermission('tenant.admin')");
  });

  it('is rate-limited', () => {
    expect(line).toContain('taskRateLimiter');
  });

  it('does not bypass the billing gate (pending/suspended tenants use /billing/portal)', () => {
    expect(line).not.toContain('allowInactiveTenant');
  });

  it('delegates to changePlan with the resolved tenant, not a body-supplied one', () => {
    expect(src).toContain("import { changePlan } from './engine/billing/plan-change.js'");
    expect(src).toMatch(/changePlan\(\{\s*tenantId: req\.resolvedTenantId/);
  });
});
