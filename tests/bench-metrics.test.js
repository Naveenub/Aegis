import { describe, it, expect } from 'vitest';
import { wilson, median, percentile } from '../bench/lib/stats.js';
import { summarize, timeSavedMinutes, summarizeByRepo } from '../bench/lib/metrics.js';
import { validateTask } from '../bench/lib/tasks.js';
import { renderReport } from '../bench/report.js';

const rec = (o) => ({ taskId: 't', repo: 'a/b', outcome: 'accepted', costUsd: 1, wallSeconds: 60, ...o });

describe('stats', () => {
  it('wilson interval brackets the point estimate and is wide for small n', () => {
    const w = wilson(7, 10);
    expect(w.rate).toBeCloseTo(0.7);
    expect(w.lo).toBeCloseTo(0.397, 2);
    expect(w.hi).toBeCloseTo(0.892, 2);
  });
  it('wilson handles n=0 and the extremes', () => {
    expect(wilson(0, 0).rate).toBeNull();
    expect(wilson(0, 5).lo).toBe(0);
    expect(wilson(5, 5).hi).toBe(1);
    expect(() => wilson(6, 5)).toThrow(RangeError);
  });
  it('percentile/median interpolate and tolerate empty input', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe('summarize', () => {
  it('separates merge rate from verified merge rate', () => {
    const s = summarize([
      rec({ outcome: 'accepted' }), rec({ outcome: 'merged_bad' }), rec({ outcome: 'not_merged' }), rec({ outcome: 'not_merged' }),
    ]);
    expect(s.mergeRate.k).toBe(2);
    expect(s.verifiedMergeRate.k).toBe(1);
    expect(s.attempted).toBe(4);
  });

  it('charges failed attempts to the merged PRs (cost per merged PR)', () => {
    const s = summarize([
      rec({ outcome: 'accepted', costUsd: 1 }),
      rec({ outcome: 'not_merged', costUsd: 3 }),
    ]);
    expect(s.cost.totalUsd).toBe(4);
    expect(s.cost.perMergedPrUsd).toBe(4); // not 1
  });

  it('cost per merged PR is null when nothing was accepted', () => {
    expect(summarize([rec({ outcome: 'not_merged' })]).cost.perMergedPrUsd).toBeNull();
  });

  it('excludes infra errors from every rate but reports them', () => {
    const s = summarize([rec({ outcome: 'accepted' }), rec({ outcome: 'infra_error', costUsd: 9 })]);
    expect(s.attempted).toBe(1);
    expect(s.excludedInfraErrors).toBe(1);
    expect(s.verifiedMergeRate.rate).toBe(1);
    expect(s.cost.totalUsd).toBe(1);
  });

  it('does not invent time saved without both baseline and review time', () => {
    const s = summarize([rec({ baselineMinutes: 60 }), rec({ reviewMinutes: 5 })]);
    expect(s.timeSaved.n).toBe(0);
    expect(s.timeSaved.totalMinutes).toBeNull();
    expect(s.timeSaved.netValueUsd).toBeUndefined();
  });

  it('computes net time saved, counting failures as lost review time', () => {
    expect(timeSavedMinutes(rec({ outcome: 'accepted', baselineMinutes: 60, reviewMinutes: 10, fixupMinutes: 5 }))).toBe(45);
    expect(timeSavedMinutes(rec({ outcome: 'merged_bad', baselineMinutes: 60, reviewMinutes: 10 }))).toBe(-10);
    expect(timeSavedMinutes(rec({ outcome: 'not_merged', baselineMinutes: 60 }))).toBeNull();
  });

  it('net value uses the supplied hourly rate and only the timed tasks', () => {
    const s = summarize([
      rec({ outcome: 'accepted', costUsd: 2, baselineMinutes: 60, reviewMinutes: 10 }), // +50 min
      rec({ outcome: 'accepted', costUsd: 100 }), // not timed: cost must not leak in
    ], { hourlyUsd: 120 });
    expect(s.timeSaved.n).toBe(1);
    expect(s.timeSaved.valueUsd).toBeCloseTo(100);
    expect(s.timeSaved.netValueUsd).toBeCloseTo(98);
  });

  it('groups by repo', () => {
    const by = summarizeByRepo([rec({ repo: 'x/a' }), rec({ repo: 'x/b', outcome: 'not_merged' })]);
    expect(by['x/a'].verifiedMergeRate.rate).toBe(1);
    expect(by['x/b'].verifiedMergeRate.rate).toBe(0);
  });
});

describe('validateTask', () => {
  const good = {
    id: 'lib-fix-1', repo: 'o/r', baseSha: 'a'.repeat(40), language: 'python',
    source: { type: 'pull_request', url: 'https://github.com/o/r/pull/1', mergedAt: '2026-01-01T00:00:00Z' },
    prompt: 'x'.repeat(50), setup: [], fail_to_pass: 'pytest', baseline: { minutes: null, source: null },
  };
  it('accepts a well-formed task', () => expect(validateTask(good, 'lib-fix-1')).toEqual([]));
  it('rejects bad sha, id/dir mismatch, and baseline without source', () => {
    expect(validateTask({ ...good, baseSha: 'abc' }, 'lib-fix-1').length).toBe(1);
    expect(validateTask(good, 'other').length).toBe(1);
    expect(validateTask({ ...good, baseline: { minutes: 30, source: null } }, 'lib-fix-1').length).toBe(1);
  });
});

describe('renderReport', () => {
  const meta = { engine: 'aegis', synthetic: false, models: { build: 'm', cheap: 'c' }, startedAt: 'now', aegisCommit: null };
  it('says time saved is not measured instead of estimating it', () => {
    const { markdown } = renderReport({ records: [rec({})], meta });
    expect(markdown).toMatch(/Not measured/);
    expect(markdown).not.toMatch(/SYNTHETIC/);
  });
  it('stamps synthetic runs as not evidence', () => {
    const { markdown } = renderReport({ records: [rec({})], meta: { ...meta, synthetic: true, engine: 'oracle' } });
    expect(markdown).toMatch(/SYNTHETIC RUN — NOT EVIDENCE/);
  });
});
