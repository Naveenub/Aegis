/**
 * engine/billing/spend-guard.js — HARD per-tenant LLM spend control
 *
 * allowance.js is informational. This is the enforcement layer for calls made
 * on the shared platform ANTHROPIC_API_KEY. Every call must RESERVE its
 * worst-case cost before it is sent and SETTLE to actual cost after.
 *
 *   reserve → call → settle   (or release on failure)
 *
 * Reservation is one atomic Lua script, so concurrent workers cannot jointly
 * overshoot. Retries (step retry loop, planner re-plans) each reserve again,
 * so retry storms are bounded by the cap by construction.
 *
 * Modes (per tenant, setSpendConfig)
 *   capped   (default)  monthly UTC ceiling; usage is invoiced in arrears.
 *                       cap = override ?? tier.spend.capUsd
 *                       Until the first PAID invoice (invoice.paid, amount>0)
 *                       a Stripe-backed tenant is held to UNVERIFIED_CAP_USD.
 *   prepaid             balance in credits; reserve debits, settle refunds the
 *                       difference. Zero arrears exposure. Topped up by Stripe
 *                       Checkout (stripe-webhook.js) or an operator grant.
 *   BYOK                resolved in agent-runner via byok.js; never reaches here.
 *
 * Also gates on tenant status: a suspended/pending tenant (payment failed)
 * cannot spend from an already-running workflow — auth.js only gates new requests.
 *
 * Fails CLOSED: if Redis is unreachable the call is refused.
 *
 * Money is integer micro-USD (1 USD = 1_000_000) — no float drift in Redis.
 *
 * Redis
 *   aegis:spend:{tenant}:{YYYY-MM}   Hash  spent, reserved   (µUSD, 40d TTL)
 *   aegis:spend:res:{tenant}         ZSet  "{id}:{µUSD}" scored by expiry ms
 *   aegis:credits:{tenant}           String balance µUSD
 *   aegis:credits:applied:{ref}      String idempotency marker for top-ups
 *
 * An unsettled reservation (worker crash) is swept after RESERVATION_TTL_MS and
 * counted as SPENT — the conservative direction.
 */

import IORedis from 'ioredis';
import { randomBytes } from 'crypto';
import { assertTenantId } from '../tenant.js';
import { getTier, getStatus, getSpendConfig, getFirstPaid, getStripeCustomerId } from '../tenant-registry.js';
import { getTierConfig } from './tiers.js';
import { computeCostUsd } from '../metrics.js';

const redis = new IORedis(process.env.REDIS_URL || undefined, {
  lazyConnect:          true,
  enableOfflineQueue:   false,
  maxRetriesPerRequest: 1,
  connectTimeout:       3000,
  retryStrategy:        () => null,
});
redis.on('error', () => {});

export const RESERVATION_TTL_MS = 6 * 60_000; // > Anthropic client timeout (5 min)
const MICRO = 1_000_000;
const toMicro = (usd) => Math.ceil(usd * MICRO);
const toUsd   = (micro) => micro / MICRO;

/** Cap applied to a Stripe-backed tenant before its first paid invoice clears. */
const unverifiedCapUsd = () => Number(process.env.AEGIS_UNVERIFIED_CAP_USD ?? 5);

export class SpendGuardError extends Error {
  /** @param {'SPEND_CAP_REACHED'|'CREDITS_EXHAUSTED'|'TENANT_INACTIVE'|'GUARD_UNAVAILABLE'} code */
  constructor(message, code, meta = {}) {
    super(message);
    this.name = 'SpendGuardError';
    this.code = code;
    this.meta = meta;
  }
}

const periodKey = (t, d = new Date()) =>
  `aegis:spend:${t}:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const resKey     = (t) => `aegis:spend:res:${t}`;
const creditsKey = (t) => `aegis:credits:${t}`;

// ─── Lua (atomic) ─────────────────────────────────────────────────────────────

// KEYS: period hash, reservation zset
// ARGV: reserveµ, capµ, nowMs, expiryMs, member
const RESERVE_CAPPED = `
local exp = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[3])
for _, m in ipairs(exp) do
  local amt = tonumber(string.match(m, ':(%d+)$'))
  redis.call('HINCRBY', KEYS[1], 'reserved', -amt)
  redis.call('HINCRBY', KEYS[1], 'spent', amt)
  redis.call('ZREM', KEYS[2], m)
end
local spent    = tonumber(redis.call('HGET', KEYS[1], 'spent') or '0')
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
if spent + reserved + tonumber(ARGV[1]) > tonumber(ARGV[2]) then
  return {0, spent, reserved}
end
redis.call('HINCRBY', KEYS[1], 'reserved', ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])
redis.call('EXPIRE', KEYS[1], 3456000)
return {1, spent, reserved + tonumber(ARGV[1])}
`;

// KEYS: period hash, reservation zset ; ARGV: member, reserveµ, actualµ
const SETTLE_CAPPED = `
if redis.call('ZREM', KEYS[2], ARGV[1]) == 1 then
  redis.call('HINCRBY', KEYS[1], 'reserved', -tonumber(ARGV[2]))
  redis.call('HINCRBY', KEYS[1], 'spent', ARGV[3])
  return 1
end
-- already swept (counted as spent at reserve size): only charge any excess
local extra = tonumber(ARGV[3]) - tonumber(ARGV[2])
if extra > 0 then redis.call('HINCRBY', KEYS[1], 'spent', extra) end
return 0
`;

// KEYS: credits ; ARGV: reserveµ
const RESERVE_PREPAID = `
local bal = tonumber(redis.call('GET', KEYS[1]) or '0')
if bal < tonumber(ARGV[1]) then return {0, bal} end
redis.call('DECRBY', KEYS[1], ARGV[1])
return {1, bal - tonumber(ARGV[1])}
`;

// ─── Policy ───────────────────────────────────────────────────────────────────

async function resolveLimits(tenantId) {
  const [tier, cfg, firstPaid, customerId] = await Promise.all([
    getTier(tenantId), getSpendConfig(tenantId), getFirstPaid(tenantId), getStripeCustomerId(tenantId),
  ]);
  const mode = cfg.mode ?? 'capped';
  let capUsd = cfg.capUsd ?? getTierConfig(tier).spend.capUsd;
  const unverified = mode === 'capped' && !!customerId && !firstPaid;
  if (unverified) capUsd = Math.min(capUsd, unverifiedCapUsd());
  return { mode, capUsd, unverified };
}

/** Throws unless the tenant account is active (payment current). */
export async function assertTenantActive(tenantId) {
  assertTenantId(tenantId);
  let status;
  try { status = await getStatus(tenantId); }
  catch (err) { throw new SpendGuardError('Billing state unavailable.', 'GUARD_UNAVAILABLE', { cause: err.message }); }
  if (status !== 'active') {
    throw new SpendGuardError(`Tenant "${tenantId}" is ${status}; resolve billing to continue.`, 'TENANT_INACTIVE', { status });
  }
}

// ─── Reserve / settle / release ───────────────────────────────────────────────

/**
 * Worst-case cost of one call: estimated input tokens (chars/3, deliberately
 * pessimistic) plus the full max_tokens output.
 */
export function estimateCostMicro({ model, inputChars, maxOutputTokens }) {
  return toMicro(computeCostUsd(model, Math.ceil(inputChars / 3), maxOutputTokens));
}

/**
 * @param {{ tenantId: string, model: string, inputChars: number, maxOutputTokens: number }} p
 * @returns {Promise<object>} opaque reservation — pass to settleSpend()/releaseSpend()
 * @throws {SpendGuardError}
 */
export async function reserveSpend({ tenantId, model, inputChars, maxOutputTokens }) {
  assertTenantId(tenantId);
  await assertTenantActive(tenantId);

  const amount = estimateCostMicro({ model, inputChars, maxOutputTokens });
  const id = randomBytes(8).toString('hex');
  const now = Date.now();

  try {
    const { mode, capUsd, unverified } = await resolveLimits(tenantId);

    if (mode === 'prepaid') {
      const [ok, balance] = await redis.eval(RESERVE_PREPAID, 1, creditsKey(tenantId), amount);
      if (!ok) {
        throw new SpendGuardError(
          `Prepaid credits exhausted for tenant "${tenantId}". Top up to continue.`,
          'CREDITS_EXHAUSTED', { balanceUsd: toUsd(balance), neededUsd: toUsd(amount) }
        );
      }
      return { tenantId, mode, id, amount, model };
    }

    const pk = periodKey(tenantId);
    const member = `${id}:${amount}`;
    const [ok, spent, reserved] = await redis.eval(
      RESERVE_CAPPED, 2, pk, resKey(tenantId),
      amount, toMicro(capUsd), now, now + RESERVATION_TTL_MS, member
    );
    if (!ok) {
      throw new SpendGuardError(
        unverified
          ? `Spend limit reached before first payment cleared for tenant "${tenantId}".`
          : `Monthly spend cap reached for tenant "${tenantId}" ($${capUsd}).`,
        'SPEND_CAP_REACHED',
        { capUsd, spentUsd: toUsd(spent), reservedUsd: toUsd(reserved), unverified }
      );
    }
    return { tenantId, mode, id, amount, model, member, periodKey: pk };
  } catch (err) {
    if (err instanceof SpendGuardError) throw err;
    throw new SpendGuardError('Spend guard unavailable; refusing call.', 'GUARD_UNAVAILABLE', { cause: err.message });
  }
}

async function finalize(reservation, actualMicro) {
  const r = reservation;
  if (r.mode === 'prepaid') {
    // refund (reserve - actual); negative = actual overran the estimate
    await redis.incrby(creditsKey(r.tenantId), r.amount - actualMicro);
    return;
  }
  await redis.eval(SETTLE_CAPPED, 2, r.periodKey, resKey(r.tenantId), r.member, r.amount, actualMicro);
}

/** Replace the reservation with the real cost from response.usage. */
export async function settleSpend(reservation, { model, inputTokens = 0, outputTokens = 0 }) {
  await finalize(reservation, toMicro(computeCostUsd(model ?? reservation.model, inputTokens, outputTokens)));
}

/**
 * Call failed. API rejections (4xx/5xx/429) are not billed → release in full.
 * Timeouts / dropped connections may have been billed server-side → keep the
 * input-side estimate charged.
 */
export async function releaseSpend(reservation, err, { inputChars = 0 } = {}) {
  const ambiguous = /timeout|abort|connection/i.test(`${err?.name ?? ''} ${err?.constructor?.name ?? ''}`);
  const keep = ambiguous
    ? toMicro(computeCostUsd(reservation.model, Math.ceil(inputChars / 3), 0))
    : 0;
  await finalize(reservation, Math.min(keep, reservation.amount));
}

// ─── Prepaid credits ──────────────────────────────────────────────────────────

/**
 * Add credits. Idempotent on `ref` (Stripe event id / operator ref), so webhook
 * retries never double-grant.
 * @returns {Promise<{ applied: boolean, balanceUsd: number }>}
 */
export async function addCredits(tenantId, usd, ref) {
  assertTenantId(tenantId);
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) throw new Error(`Invalid credit amount: ${usd}`);
  if (!ref || typeof ref !== 'string') throw new Error('addCredits requires an idempotency `ref`.');
  const first = await redis.set(`aegis:credits:applied:${ref}`, tenantId, 'EX', 90 * 86400, 'NX');
  if (!first) return { applied: false, balanceUsd: toUsd(Number(await redis.get(creditsKey(tenantId)) ?? 0)) };
  const bal = await redis.incrby(creditsKey(tenantId), toMicro(usd));
  return { applied: true, balanceUsd: toUsd(bal) };
}

// ─── Read model ───────────────────────────────────────────────────────────────

export async function getSpendStatus(tenantId) {
  assertTenantId(tenantId);
  const [limits, h, credits] = await Promise.all([
    resolveLimits(tenantId),
    redis.hgetall(periodKey(tenantId)),
    redis.get(creditsKey(tenantId)),
  ]);
  const spent = Number(h?.spent ?? 0), reserved = Number(h?.reserved ?? 0);
  return {
    tenantId,
    mode: limits.mode,
    capUsd: limits.mode === 'capped' ? limits.capUsd : null,
    unverified: limits.unverified,
    spentUsd: toUsd(spent),
    reservedUsd: toUsd(reserved),
    remainingUsd: limits.mode === 'capped'
      ? Math.max(0, limits.capUsd - toUsd(spent + reserved))
      : toUsd(Number(credits ?? 0)),
    creditsUsd: toUsd(Number(credits ?? 0)),
  };
}
