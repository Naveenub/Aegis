/**
 * In-memory stand-in for the ioredis surface used by key-store, user-store,
 * sso and audit-log. Plain Maps, no TTL expiry (EX is recorded, not enforced).
 * Usage: vi.mock('ioredis', async () => (await import('./helpers/fake-redis.js')).ioredisMock);
 */
export function createFakeRedis() {
  const kv = new Map(), hashes = new Map(), zsets = new Map(), ttl = new Map();
  const H = (k) => (hashes.has(k) ? hashes.get(k) : hashes.set(k, new Map()).get(k));
  const Z = (k) => (zsets.has(k) ? zsets.get(k) : zsets.set(k, new Map()).get(k));

  const c = {
    on: () => {},
    async get(k) { return kv.get(k) ?? null; },
    async set(k, v, mode, secs) { kv.set(k, String(v)); if (mode === 'EX') ttl.set(k, secs); return 'OK'; },
    async getdel(k) { const v = kv.get(k) ?? null; kv.delete(k); return v; },
    async del(...ks) { let n = 0; for (const k of ks) { n += kv.delete(k) ? 1 : 0; hashes.delete(k); } return n; },
    async incr(k) { const n = Number(kv.get(k) ?? 0) + 1; kv.set(k, String(n)); return n; },
    async hget(k, f) { return H(k).get(f) ?? null; },
    async hset(k, f, v) {
      if (typeof f === 'object') for (const [a, b] of Object.entries(f)) H(k).set(a, String(b));
      else H(k).set(f, String(v));
      return 1;
    },
    async hsetnx(k, f, v) { if (H(k).has(f)) return 0; H(k).set(f, String(v)); return 1; },
    async hgetall(k) { return Object.fromEntries(H(k)); },
    async zadd(k, score, m) { Z(k).set(m, score); return 1; },
    async zrangebyscore(k, min, max, _l, off, lim) {
      return [...Z(k).entries()].filter(([, s]) => s >= min && s <= max).sort((a, b) => a[1] - b[1])
        .map(([m]) => m).slice(off ?? 0, (off ?? 0) + (lim ?? Infinity));
    },
    pipeline() {
      const ops = [];
      const p = new Proxy({}, {
        get: (_t, name) => (name === 'exec'
          ? async () => { const out = []; for (const [n, a] of ops) out.push([null, await c[n](...a)]); return out; }
          : (...a) => { ops.push([name, a]); return p; }),
      });
      return p;
    },
    _kv: kv, _hashes: hashes, _ttl: ttl,
    _reset() { kv.clear(); hashes.clear(); zsets.clear(); ttl.clear(); },
  };
  return c;
}

const shared = createFakeRedis();
export const fakeRedis = shared;
export const ioredisMock = { default: function IORedis() { return shared; } };
