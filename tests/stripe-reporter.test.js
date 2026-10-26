/**
 * tests/stripe-reporter.test.js
 *
 * Unit tests for engine/billing/stripe-reporter.js
 *
 * Covers:
 *   flushUsageToStripe() — reports each unreported group as a Billing Meter
 *                          event, skips tenants with no Stripe customer,
 *                          counts failures without aborting the batch
 *
 * Stripe SDK, usage-recorder, and tenant-registry are fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const meterEventsCreateMock = vi.fn();

vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation(() => ({
    billing: { meterEvents: { create: meterEventsCreateMock } },
  })),
}));

const getUnreportedUsageMock = vi.fn();
const markReportedMock = vi.fn();

vi.mock('../engine/usage-recorder.js', () => ({
  EVENT_TYPES: {
    WORKFLOW_RUN: 'workflow_run',
    AGENT_STEP: 'agent_step',
    TOKENS: 'tokens',
    SANDBOX_MINUTES: 'sandbox_minutes',
  },
  getUnreportedUsage: getUnreportedUsageMock,
  markReported: markReportedMock,
}));

const getStripeCustomerIdMock = vi.fn();

vi.mock('../engine/tenant-registry.js', () => ({
  getStripeCustomerId: getStripeCustomerIdMock,
}));

vi.mock('../engine/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

let flushUsageToStripe;

beforeEach(async () => {
  vi.resetModules();
  meterEventsCreateMock.mockReset();
  getUnreportedUsageMock.mockReset();
  markReportedMock.mockReset();
  getStripeCustomerIdMock.mockReset();
  ({ flushUsageToStripe } = await import('../engine/billing/stripe-reporter.js'));
});

describe('flushUsageToStripe', () => {
  it('reports a configured group and marks it reported', async () => {
    getUnreportedUsageMock.mockResolvedValue([
      { tenantId: 'acme', eventType: 'tokens', quantity: 1500.4, ids: [1, 2] },
    ]);
    getStripeCustomerIdMock.mockResolvedValue('cus_acme');
    meterEventsCreateMock.mockResolvedValue({ identifier: 'aegis-acme-tokens-1-2' });

    const result = await flushUsageToStripe();

    expect(meterEventsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: 'aegis_tokens',
        identifier: 'aegis-acme-tokens-1-2',
        payload: { stripe_customer_id: 'cus_acme', value: '1501' },
      })
    );
    expect(markReportedMock).toHaveBeenCalledWith([1, 2], 'aegis-acme-tokens-1-2');
    expect(result).toEqual({ reported: 1, skipped: 0, failed: 0 });
  });

  it('skips a tenant with no Stripe customer and does not mark it reported', async () => {
    getUnreportedUsageMock.mockResolvedValue([
      { tenantId: 'no-config-tenant', eventType: 'workflow_run', quantity: 3, ids: [5] },
    ]);
    getStripeCustomerIdMock.mockResolvedValue(null);

    const result = await flushUsageToStripe();

    expect(meterEventsCreateMock).not.toHaveBeenCalled();
    expect(markReportedMock).not.toHaveBeenCalled();
    expect(result).toEqual({ reported: 0, skipped: 1, failed: 0 });
  });

  it('counts a Stripe API failure without aborting the rest of the batch', async () => {
    getUnreportedUsageMock.mockResolvedValue([
      { tenantId: 'acme', eventType: 'tokens', quantity: 10, ids: [1] },
      { tenantId: 'acme', eventType: 'agent_step', quantity: 2, ids: [2] },
    ]);
    getStripeCustomerIdMock.mockResolvedValue('cus_acme');
    meterEventsCreateMock
      .mockRejectedValueOnce(new Error('Stripe API down'))
      .mockResolvedValueOnce({ identifier: 'aegis-acme-agent_step-2-2' });

    const result = await flushUsageToStripe();

    expect(result).toEqual({ reported: 1, skipped: 0, failed: 1 });
    expect(markReportedMock).toHaveBeenCalledTimes(1);
    expect(markReportedMock).toHaveBeenCalledWith([2], 'aegis-acme-agent_step-2-2');
  });
});
