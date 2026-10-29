/**
 * bench/lib/stats.js — small, dependency-free statistics helpers.
 *
 * With the task counts a real-repo benchmark can afford (tens, not thousands),
 * a bare percentage is misleading. Every rate reported by the benchmark carries
 * a Wilson score interval so a reader can see how little "7 of 10" proves.
 */

/**
 * Wilson score interval for a binomial proportion.
 * @param {number} k  successes
 * @param {number} n  trials
 * @param {number} [z=1.96]  1.96 ≈ 95%
 * @returns {{ rate: number|null, lo: number|null, hi: number|null, k: number, n: number }}
 */
export function wilson(k, n, z = 1.96) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 0 || k < 0 || k > n) {
    throw new RangeError(`wilson: invalid counts k=${k} n=${n}`);
  }
  if (n === 0) return { rate: null, lo: null, hi: null, k, n };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { rate: p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), k, n };
}

/** @param {number[]} xs */
export function sum(xs) {
  return xs.reduce((a, b) => a + b, 0);
}

/** @param {number[]} xs  @returns {number|null} */
export function mean(xs) {
  return xs.length ? sum(xs) / xs.length : null;
}

/**
 * Linear-interpolated percentile (p in [0,1]). Returns null for empty input.
 * @param {number[]} xs
 * @param {number} p
 */
export function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export const median = (xs) => percentile(xs, 0.5);
