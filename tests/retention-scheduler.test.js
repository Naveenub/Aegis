import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../engine/retention.js', () => ({ runRetentionSweep: vi.fn(async () => ({ tenants: {}, errors: [] })) }));

describe('startRetentionScheduler', () => {
  afterEach(() => { delete process.env.AEGIS_RETENTION_INPROCESS; });

  it('returns null when disabled', async () => {
    process.env.AEGIS_RETENTION_INPROCESS = 'off';
    const { startRetentionScheduler } = await import('../engine/retention-scheduler.js');
    expect(startRetentionScheduler()).toBeNull();
  });

  it('returns a stoppable handle when enabled', async () => {
    const { startRetentionScheduler } = await import('../engine/retention-scheduler.js');
    const h = startRetentionScheduler({ intervalMs: 3600_000 });
    expect(typeof h.stop).toBe('function');
    h.stop();
  });
});
