/**
 * tests/pricing-model.test.js
 *
 * engine/billing/pricing-model.js — pure pricing math. The inputs here are
 * synthetic, chosen to make the arithmetic checkable by hand; they say nothing
 * about what a real workflow costs.
 */
import { describe, it, expect } from 'vitest';
import {
  percentile, summarizeWorkflows, proposePricing, unitCostsFromEnv, ceilSig, allowanceCostUsd, MIN_SAMPLES,
} from '../engine/billing/pricing-model.js';
import { TIERS } from '../engine/billing/tiers.js';

// $3/M in, $15/M out, $0.002/sandbox minute, no run/step overhead.
const unit = unitCostsFromEnv({ AEGIS_COST_SANDBOX_PER_MIN: '0.002' });

// 40 workflows, each 100k in / 10k out → $0.30 + $0.15 = $0.45 each.
const flat = Array.from({ length: 40 }, (_, i) => ({ workflowId: `w${i}`, tokensIn: 100_000, tokensOut: 10_000, steps: 8 }));
const measured = summarizeWorkflows(flat, unit, { sandboxMinutes: 80, runs: 40 });

describe('stats', () => {
  it('percentile is nearest-rank on sorted input', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 90)).toBe(9);
    expect(percentile(v, 100)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });

  it('ceilSig always rounds up and never loses margin', () => {
    expect(ceilSig(0.0000063)).toBe(0.000006300);
    expect(ceilSig(0.00001234567)).toBe(0.00001235);
    expect(ceilSig(0)).toBe(0);
    expect(ceilSig(12.3456, 3)).toBe(12.4);
  });
});

describe('unitCostsFromEnv', () => {
  it('defaults token prices to list price and requires the sandbox cost', () => {
    expect(unit.tokens_in).toBeCloseTo(3e-6, 12);
    expect(unit.tokens_out).toBeCloseTo(15e-6, 12);
    expect(unit.workflow_run).toBe(0);
    expect(() => unitCostsFromEnv({})).toThrow('AEGIS_COST_SANDBOX_PER_MIN is required');
    expect(() => unitCostsFromEnv({ AEGIS_COST_SANDBOX_PER_MIN: '-1' })).toThrow('non-negative');
  });
});

describe('summarizeWorkflows', () => {
  it('computes LLM cost per workflow from tokens', () => {
    expect(measured.n).toBe(40);
    expect(measured.costUsd.mean).toBeCloseTo(0.45, 10);
    expect(measured.costUsd.p90).toBeCloseTo(0.45, 10);
    expect(measured.sandboxMinutesPerWorkflow).toBe(2);
  });

  it('excludes workflows with no platform-key tokens instead of averaging them in as $0', () => {
    const m = summarizeWorkflows(
      [...flat, { workflowId: 'byok', tokensIn: 0, tokensOut: 0, steps: 5 }], unit,
    );
    expect(m.n).toBe(40);
    expect(m.withoutTokens).toBe(1);
    expect(m.costUsd.mean).toBeCloseTo(0.45, 10);
  });

  it('reports sandbox time as null when there are no runs to divide by', () => {
    expect(summarizeWorkflows(flat, unit, { sandboxMinutes: 5, runs: 0 }).sandboxMinutesPerWorkflow).toBeNull();
  });
});

describe('proposePricing', () => {
  it('refuses a measurement with too few workflows', () => {
    const few = summarizeWorkflows(flat.slice(0, 5), unit);
    expect(() => proposePricing({ tiers: TIERS, measured: few, unit, margin: 0.6 })).toThrow(/need at least 30/);
    expect(MIN_SAMPLES).toBe(30);
  });

  it.each([-0.1, 0.95, NaN])('refuses margin %s', (margin) => {
    expect(() => proposePricing({ tiers: TIERS, measured, unit, margin })).toThrow(/margin/);
  });

  it('prices overage at unit cost / (1 - margin)', () => {
    const { env } = proposePricing({ tiers: TIERS, measured, unit, margin: 0.5 });
    expect(Number(env.OVERAGE_USD_TOKENS_IN)).toBeCloseTo(6e-6, 12);
    expect(Number(env.OVERAGE_USD_TOKENS_OUT)).toBeCloseTo(30e-6, 12);
    expect(Number(env.OVERAGE_USD_SANDBOX_MINUTES)).toBeCloseTo(0.004, 12);
  });

  it('never prices overage below cost, so stripe-setup.js accepts it', () => {
    for (const margin of [0, 0.3, 0.6, 0.9]) {
      const { env } = proposePricing({ tiers: TIERS, measured, unit, margin });
      expect(Number(env.OVERAGE_USD_TOKENS_IN)).toBeGreaterThanOrEqual(unit.tokens_in);
      expect(Number(env.OVERAGE_USD_TOKENS_OUT)).toBeGreaterThanOrEqual(unit.tokens_out);
      expect(Number(env.OVERAGE_USD_SANDBOX_MINUTES)).toBeGreaterThanOrEqual(unit.sandbox_minutes);
    }
  });

  it('emits base prices for paid tiers only', () => {
    const { env } = proposePricing({ tiers: TIERS, measured, unit, margin: 0.5 });
    expect(env).toHaveProperty('BASE_USD_STARTER');
    expect(env).toHaveProperty('BASE_USD_PRO');
    expect(env).toHaveProperty('BASE_USD_ENTERPRISE');
    expect(env).not.toHaveProperty('BASE_USD_FREE');
  });

  it('base floor = allowance cost / (1 - margin), rounded up to whole dollars', () => {
    const { tiers } = proposePricing({ tiers: TIERS, measured, unit, margin: 0.5 });
    const cost = allowanceCostUsd(TIERS.starter, unit);
    expect(tiers.starter.allowanceCostUsd).toBeCloseTo(cost, 10);
    expect(tiers.starter.baseFloorUsd).toBe(Math.ceil(cost / 0.5));
  });

  it('builds the unlimited tier floor from its spend cap and says so', () => {
    const { tiers } = proposePricing({ tiers: TIERS, measured, unit, margin: 0.5 });
    expect(tiers.enterprise.allowanceCostUsd).toBeNull();
    expect(tiers.enterprise.baseFloorUsd).toBe(Math.ceil(TIERS.enterprise.spend.capUsd / 0.5));
    expect(tiers.enterprise.note).toMatch(/quote individually/);
  });

  it('warns that run/step overage is $0 when no platform overhead was given', () => {
    const { warnings } = proposePricing({ tiers: TIERS, measured, unit, margin: 0.5 });
    expect(warnings.some((w) => w.includes('workflow_run overage is $0'))).toBe(true);
  });

  it('warns when a spend cap is below the cost of its own allowance', () => {
    const tight = { ...TIERS, starter: { ...TIERS.starter, spend: { capUsd: 1, byok: false } } };
    const { warnings } = proposePricing({ tiers: tight, measured, unit, margin: 0.5 });
    expect(warnings.some((w) => w.startsWith('starter: spend.capUsd'))).toBe(true);
  });

  it('warns when the token allowance runs out before the advertised runs', () => {
    // 100k in per workflow: starter's 1.5M input tokens cover 15 workflows, not 500.
    const { warnings, tiers } = proposePricing({ tiers: TIERS, measured, unit, margin: 0.5 });
    expect(tiers.starter.workflowsTheTokenAllowanceCovers).toBe(15);
    expect(warnings.some((w) => w.startsWith('starter: the token allowance covers ~15'))).toBe(true);
  });

  it('reports the free tier worst case per tenant and warns when p90 runs exceed its cap', () => {
    const { tiers, warnings } = proposePricing({ tiers: TIERS, measured, unit, margin: 0.5 });
    expect(tiers.free.worstCaseCostPerTenantUsd).toBeLessThanOrEqual(TIERS.free.spend.capUsd);
    // 25 runs × $0.45 = $11.25 against a $2 cap
    expect(tiers.free.expectedLlmCostAtP90).toBeCloseTo(11.25, 6);
    expect(warnings.some((w) => w.startsWith('free: 25 runs at the measured p90'))).toBe(true);
  });
});
