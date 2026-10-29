import { describe, it, expect } from 'vitest';
import { buildCaseStudy, canNamePartner, MIN_PRS } from '../bench/lib/case-study.js';

const pr = (i, o = {}) => ({
  workflowId: `wf${i}`, title: `PR ${i}`, prUrl: `https://github.com/p/r/pull/${i}`,
  outcome: 'merged', costUsd: 1, wallSeconds: 300, reviewMinutes: 10, fixupMinutes: 0, baselineMinutes: 60, ...o,
});
const consent = { namedPublicly: true, approvedBy: 'Jo, CTO', approvedAt: '2026-11-01' };
const inputs = { partner: { name: 'Acme Corp', description: 'x' }, period: { from: 'a', to: 'b' }, baselineMethod: 'engineers timed last 10 comparable tickets', consent };
const many = (n, o) => Array.from({ length: n }, (_, i) => pr(i, o));

describe('buildCaseStudy', () => {
  it('is a draft and anonymised without consent, even with great numbers', () => {
    const { markdown, publishable } = buildCaseStudy(many(12), { ...inputs, consent: { namedPublicly: false } });
    expect(publishable).toBe(false);
    expect(markdown).toMatch(/DRAFT — NOT FOR PUBLICATION/);
    expect(markdown).not.toMatch(/Acme Corp/);
  });

  it('names the partner and publishes only with consent, enough PRs and measured time', () => {
    const { markdown, publishable } = buildCaseStudy(many(MIN_PRS), inputs);
    expect(publishable).toBe(true);
    expect(markdown).toMatch(/# Case study: Acme Corp/);
    expect(markdown).not.toMatch(/DRAFT/);
  });

  it('flags small samples and unmeasured time instead of estimating', () => {
    const { markdown, publishable } = buildCaseStudy(many(3, { reviewMinutes: undefined }), inputs);
    expect(publishable).toBe(false);
    expect(markdown).toMatch(/too small to generalise/);
    expect(markdown).toMatch(/Net engineer time saved \| not measured/);
  });

  it('counts closed PRs against merge rate and time saved; open PRs are excluded', () => {
    const ledger = [...many(3), pr(9, { outcome: 'closed' }), pr(10, { outcome: 'open' })];
    const { summary, markdown } = buildCaseStudy(ledger, inputs);
    expect(summary.attempted).toBe(4);
    expect(summary.verifiedMergeRate.k).toBe(3);
    expect(markdown).toMatch(/1 still open/);
    // 3×(60−10) + 1×(−10) = 140
    expect(summary.timeSaved.totalMinutes).toBe(140);
  });

  it('only prints the quote when approved', () => {
    const q = { text: 'Great tool', attribution: 'Jo' };
    expect(buildCaseStudy(many(10), { ...inputs, quote: q }).markdown).not.toMatch(/Great tool/);
    expect(buildCaseStudy(many(10), { ...inputs, quote: q, consent: { ...consent, quoteApproved: true } }).markdown).toMatch(/Great tool/);
  });

  it('rejects ledger entries that cannot be checked', () => {
    expect(() => buildCaseStudy([pr(1, { prUrl: null })], inputs)).toThrow(/prUrl/);
    expect(() => buildCaseStudy([pr(1, { outcome: 'great' })], inputs)).toThrow(/bad outcome/);
  });

  it('canNamePartner needs all three consent fields', () => {
    expect(canNamePartner(consent)).toBe(true);
    expect(canNamePartner({ namedPublicly: true })).toBe(false);
  });
});
