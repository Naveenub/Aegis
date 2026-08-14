/**
 * tests/usage-recorder.test.js
 *
 * Unit tests for engine/usage-recorder.js
 *
 * Covers:
 *   recordUsageEvent()   — happy path insert, invalid tenantId/eventType/quantity
 *                          swallowed (never throws), schema created lazily once
 *   getUnreportedUsage() — maps rows to camelCase, parses ids array
 *   markReported()       — no-op on empty ids, UPDATE otherwise
 *
 * `pg` is fully mocked — no live database required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn(async () => ({ rows: [] }));
const onMock = vi.fn();

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn().mockImplementation(() => ({
      query: queryMock,
      on: onMock,
    })),
  },
}));

vi.mock('../engine/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

let recordUsageEvent, getUnreportedUsage, markReported, EVENT_TYPES;

beforeEach(async () => {
  vi.resetModules();
  queryMock.mockReset().mockResolvedValue({ rows: [] });
  ({ recordUsageEvent, getUnreportedUsage, markReported, EVENT_TYPES } =
    await import('../engine/usage-recorder.js'));
});

describe('recordUsageEvent', () => {
  it('inserts a row for a valid event', async () => {
    await recordUsageEvent({
      tenantId: 'acme',
      eventType: EVENT_TYPES.AGENT_STEP,
      quantity: 1,
      metadata: { agent: 'coder' },
    });

    // First call creates the table/index, second call is the INSERT.
    const insertCall = queryMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO usage_events'));
    expect(insertCall).toBeTruthy();
    expect(insertCall[1]).toEqual(['acme', 'agent_step', 1, JSON.stringify({ agent: 'coder' })]);
  });

  it('never throws on an invalid tenantId', async () => {
    await expect(
      recordUsageEvent({ tenantId: '../etc/passwd', eventType: EVENT_TYPES.WORKFLOW_RUN, quantity: 1 })
    ).resolves.toBeUndefined();
    expect(queryMock.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
  });

  it('never throws on an unknown eventType', async () => {
    await expect(
      recordUsageEvent({ tenantId: 'acme', eventType: 'not_a_real_type', quantity: 1 })
    ).resolves.toBeUndefined();
    expect(queryMock.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
  });

  it('never throws on a negative or non-numeric quantity', async () => {
    await recordUsageEvent({ tenantId: 'acme', eventType: EVENT_TYPES.TOKENS, quantity: -5 });
    await recordUsageEvent({ tenantId: 'acme', eventType: EVENT_TYPES.TOKENS, quantity: NaN });
    expect(queryMock.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
  });

  it('swallows a Postgres query error rather than propagating it', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (sql.includes('CREATE TABLE')) return { rows: [] };
      throw new Error('connection refused');
    });

    await expect(
      recordUsageEvent({ tenantId: 'acme', eventType: EVENT_TYPES.WORKFLOW_RUN, quantity: 1 })
    ).resolves.toBeUndefined();
  });
});

describe('getUnreportedUsage', () => {
  it('maps snake_case rows to camelCase and parses ids', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (sql.includes('CREATE TABLE')) return { rows: [] };
      return {
        rows: [
          { tenant_id: 'acme', event_type: 'tokens', quantity: '1234', ids: [1, 2, 3] },
        ],
      };
    });

    const groups = await getUnreportedUsage();
    expect(groups).toEqual([
      { tenantId: 'acme', eventType: 'tokens', quantity: 1234, ids: [1, 2, 3] },
    ]);
  });
});

describe('markReported', () => {
  it('is a no-op for an empty id list', async () => {
    await markReported([], 'sur_123');
    expect(queryMock.mock.calls.some(([sql]) => sql.includes('UPDATE'))).toBe(false);
  });

  it('issues an UPDATE for a non-empty id list', async () => {
    await markReported([1, 2], 'sur_123');
    const updateCall = queryMock.mock.calls.find(([sql]) => sql.includes('UPDATE usage_events'));
    expect(updateCall).toBeTruthy();
    expect(updateCall[1]).toEqual([[1, 2], 'sur_123']);
  });
});
