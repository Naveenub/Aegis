/**
 * tests/stripe-reporter.test.js
 *
 * Unit tests for engine/billing/stripe-reporter.js
 *
 * Covers:
 *   flushUsageToStripe() — reports each unreported group with a configured
 *                          subscription item, skips groups with no config,
 *                          counts failures without aborting the batch
 *
 * Stripe SDK, usage-recorder, and tenant-registry are fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const createUsageRecordMock = vi.fn();

vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation(() => ({
    subscriptionItems: { createUsageRecord: createUsageRecordMock },
  })),
}));

const getUnreportedUsageMock = vi.fn();
const markReportedMock = vi.fn();

vi.mock('../engine/usage-recorder.js', () => ({
  getUnreportedUsage: getUnreportedUsageMock,
  markReported: markReportedMock,
}));

const getBillingConfigMock = vi.fn();

vi.mock('../engine/tenant-registry.js', () => ({
  getBillingConfig: getBillingConfigMock,
}));

vi.mock('../engine/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

let flushUsageToStripe;

beforeEach(async () => {
  vi.resetModules();
  createUsageRecordMock.mockReset();
  getUnreportedUsageMock.mockReset();
  markReportedMock.mockReset();
  getBillingConfigMock.mockReset();
  ({ flushUsageToStripe } = await import('../engine/billing/stripe-reporter.js'));
});

describe('flushUsageToStripe', () => {
  it('reports a configured group and marks it reported', async () => {
    getUnreportedUsageMock.mockResolvedValue([
      { tenantId: 'acme', eventType: 'tokens', quantity: 1500.4, ids: [1, 2] },
    ]);
    getBillingConfigMock.mockResolvedValue({ tokens: 'si_tokens_acme' });
    createUsageRecordMock.mockResolvedValue({ id: 'sur_abc' });

    const result = await flushUsageToStripe();

    expect(createUsageRecordMock).toHaveBeenCalledWith(
      'si_tokens_acme',
      expect.objectContaining({ quantity: 1501, action: 'increment' })
    );
    expect(markReportedMock).toHaveBeenCalledWith([1, 2], 'sur_abc');
    expect(result).toEqual({ reported: 1, skipped: 0, failed: 0 });
  });

  it('skips a group with no billing config and does not mark it reported', async () => {
    getUnreportedUsageMock.mockResolvedValue([
      { tenantId: 'no-config-tenant', eventType: 'workflow_run', quantity: 3, ids: [5] },
    ]);
    getBillingConfigMock.mockResolvedValue(null);

    const result = await flushUsageToStripe();

    expect(createUsageRecordMock).not.toHaveBeenCalled();
    expect(markReportedMock).not.toHaveBeenCalled();
    expect(result).toEqual({ reported: 0, skipped: 1, failed: 0 });
  });

  it('counts a Stripe API failure without aborting the rest of the batch', async () => {
    getUnreportedUsageMock.mockResolvedValue([
      { tenantId: 'acme', eventType: 'tokens', quantity: 10, ids: [1] },
      { tenantId: 'acme', eventType: 'agent_step', quantity: 2, ids: [2] },
    ]);
    getBillingConfigMock.mockResolvedValue({ tokens: 'si_tokens', agent_step: 'si_steps' });
    createUsageRecordMock
      .mockRejectedValueOnce(new Error('Stripe API down'))
      .mockResolvedValueOnce({ id: 'sur_ok' });

    const result = await flushUsageToStripe();

    expect(result).toEqual({ reported: 1, skipped: 0, failed: 1 });
    expect(markReportedMock).toHaveBeenCalledTimes(1);
    expect(markReportedMock).toHaveBeenCalledWith([2], 'sur_ok');
  });
});
