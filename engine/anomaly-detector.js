/**
 * engine/anomaly-detector.js
 *
 * In-process anomaly detection for Aegis metrics.
 *
 * Problem solved
 * ──────────────
 * Prometheus metrics were exported correctly but nothing evaluated them at
 * runtime. If the success rate dropped to 20% at 3 AM, the only way to know
 * was to look at a dashboard that nobody had open. This module closes that gap
 * without requiring a full Prometheus + Alertmanager stack.
 *
 * What it does
 * ────────────
 * A single setInterval loop (configurable cadence, default 60 s) reads the
 * live metric snapshot from getMetrics() and evaluates a set of rules.  Each
 * rule fires when its condition is true AND the metric has been outside the
 * safe range for at least `sustainedMs` milliseconds (hysteresis — prevents
 * alert storms on transient spikes).  When a rule fires it:
 *
 *   1. Emits a structured JSON alert to stderr (same format as dlq-worker.js)
 *   2. POSTs the alert to AEGIS_ALERT_WEBHOOK when the env var is set
 *   3. Records the alert in Redis with a TTL so GET /anomalies can surface it
 *
 * Rules implemented
 * ─────────────────
 *   low_success_rate_5m   — 5m success rate < ANOMALY_SUCCESS_RATE_WARN (default 80%)
 *   critical_success_rate — 5m success rate < ANOMALY_SUCCESS_RATE_CRIT (default 50%)
 *   high_p95_latency      — 5m p95 latency  > ANOMALY_P95_WARN_MS      (default 30 000)
 *   latency_spike         — 5m p95 is >     ANOMALY_SPIKE_RATIO × 1h p95 (default 3×)
 *   high_retry_rate       — retries/total   > ANOMALY_RETRY_RATE        (default 0.20)
 *
 * All thresholds are configurable via env vars so you can tune without touching code.
 *
 * Usage (called once at server / worker startup)
 * ───────────────────────────────────────────────
 *   import { startAnomalyDetector, stopAnomalyDetector } from './engine/anomaly-detector.js';
 *   startAnomalyDetector();          // begins the evaluation loop
 *   // on graceful shutdown:
 *   stopAnomalyDetector();
 *
 * GET /anomalies
 * ─────────────
 * Returns the last 50 anomaly events from Redis (newest first).
 * Wire this route in server.js — see the bottom of this file for the handler.
 */

import IORedis from 'ioredis';
import { getMetrics } from './metrics.js';

const redis = new IORedis(process.env.REDIS_URL || undefined);

// ─── Configuration ────────────────────────────────────────────────────────────

function envInt(name, fallback)   { const v = parseInt(process.env[name],  10); return Number.isFinite(v) ? v : fallback; }
function envFloat(name, fallback) { const v = parseFloat(process.env[name]);   return Number.isFinite(v) ? v : fallback; }

const CFG = {
  intervalMs:       envInt('ANOMALY_INTERVAL_MS',      60_000),   // evaluation cadence
  sustainedMs:      envInt('ANOMALY_SUSTAINED_MS',     120_000),  // must be breached for this long to fire
  successWarn:      envFloat('ANOMALY_SUCCESS_RATE_WARN', 80),    // % — 5m success rate warning
  successCrit:      envFloat('ANOMALY_SUCCESS_RATE_CRIT', 50),    // % — 5m success rate critical
  p95WarnMs:        envInt('ANOMALY_P95_WARN_MS',      30_000),   // ms — 5m p95 latency warning
  spikeRatio:       envFloat('ANOMALY_SPIKE_RATIO',    3),        // ×  — 5m p95 / 1h p95
  retryRateWarn:    envFloat('ANOMALY_RETRY_RATE',     0.20),     // fraction — retries / total
  alertTtlS:        envInt('ANOMALY_ALERT_TTL_S',      86_400),   // Redis TTL for stored alerts (1 day)
  maxStoredAlerts:  envInt('ANOMALY_MAX_STORED',       200),      // max alerts in the index
};

const WEBHOOK_URL = process.env.AEGIS_ALERT_WEBHOOK ?? '';

// ─── Redis key layout ─────────────────────────────────────────────────────────

const ALERT_PREFIX = 'aegis:anomaly:alert:';
const ALERT_INDEX  = 'aegis:anomaly:index';   // ZSET  score=timestamp, member=alert key

// ─── Rule breach tracking (in-process, resets on restart) ────────────────────
// Map<ruleId, firstBreachMs>  — records when each rule first entered the breached state

const _firstBreach = new Map();

// ─── Alert delivery ───────────────────────────────────────────────────────────

/**
 * Persist an alert to Redis and deliver it to stderr + webhook.
 *
 * @param {string} ruleId
 * @param {string} severity   'warning' | 'critical'
 * @param {string} summary
 * @param {object} details    arbitrary key/value context
 */
async function fireAlert(ruleId, severity, summary, details = {}) {
  const now   = Date.now();
  const alert = {
    ruleId,
    severity,
    summary,
    details,
    firedAt:    now,
    firedAtIso: new Date(now).toISOString(),
    source:     'aegis-anomaly-detector',
  };

  // 1. Structured JSON to stderr (same format as dlq-worker.js emitAlert)
  process.stderr.write(JSON.stringify(alert) + '\n');

  // 2. Webhook delivery (best-effort, non-blocking)
  if (WEBHOOK_URL) {
    fetch(WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(alert),
    }).catch((err) => {
      process.stderr.write(JSON.stringify({
        level: 'error',
        msg:   'Anomaly alert webhook delivery failed',
        url:   WEBHOOK_URL,
        error: err.message,
      }) + '\n');
    });
  }

  // 3. Persist to Redis for GET /anomalies
  const alertKey = `${ALERT_PREFIX}${ruleId}:${now}`;
  try {
    await redis.pipeline()
      .set(alertKey, JSON.stringify(alert), 'EX', CFG.alertTtlS)
      .zadd(ALERT_INDEX, now, alertKey)
      // Trim the index to the most recent maxStoredAlerts entries
      .zremrangebyrank(ALERT_INDEX, 0, -(CFG.maxStoredAlerts + 1))
      .exec();
  } catch (err) {
    process.stderr.write(JSON.stringify({
      level: 'error',
      msg:   'Failed to persist anomaly alert to Redis',
      error: err.message,
    }) + '\n');
  }

  return alert;
}

// ─── Rule evaluation ──────────────────────────────────────────────────────────

/**
 * Evaluate a single rule.
 *
 * @param {string}   ruleId
 * @param {boolean}  breached      true when the metric is outside safe range
 * @param {string}   severity
 * @param {string}   summary
 * @param {object}   details
 */
async function evalRule(ruleId, breached, severity, summary, details) {
  const now = Date.now();

  if (!breached) {
    // Rule is healthy — clear any recorded breach start
    _firstBreach.delete(ruleId);
    return;
  }

  if (!_firstBreach.has(ruleId)) {
    // First time we see this breach — record the timestamp but don't fire yet
    _firstBreach.set(ruleId, now);
    return;
  }

  const breachAge = now - _firstBreach.get(ruleId);

  if (breachAge >= CFG.sustainedMs) {
    // Sustained breach — fire.  Reset firstBreach so we don't spam every tick;
    // we'll re-arm after sustainedMs passes without recovery.
    _firstBreach.set(ruleId, now);
    await fireAlert(ruleId, severity, summary, { ...details, breachAgeMs: breachAge });
  }
}

// ─── Main evaluation loop ─────────────────────────────────────────────────────

async function evaluate() {
  let metrics;
  try {
    metrics = await getMetrics();
  } catch (err) {
    process.stderr.write(JSON.stringify({
      level: 'error',
      msg:   '[anomaly-detector] Failed to read metrics',
      error: err.message,
    }) + '\n');
    return;
  }

  const w5m  = metrics.windows?.['5m']  ?? {};
  const w1h  = metrics.windows?.['1h']  ?? {};
  const p95_5m = w5m.latency?.p95  ?? 0;
  const p95_1h = w1h.latency?.p95  ?? 0;

  const retryRate = metrics.total > 0
    ? metrics.retries / metrics.total
    : 0;

  // ── Rule 1: low 5m success rate (warning) ─────────────────────────────────
  await evalRule(
    'low_success_rate_5m',
    w5m.total > 0 && w5m.successRate < CFG.successWarn,
    'warning',
    `5-minute success rate is ${w5m.successRate?.toFixed(1)}% (threshold: ${CFG.successWarn}%)`,
    { successRate5m: w5m.successRate, threshold: CFG.successWarn }
  );

  // ── Rule 2: critical 5m success rate ──────────────────────────────────────
  await evalRule(
    'critical_success_rate_5m',
    w5m.total > 0 && w5m.successRate < CFG.successCrit,
    'critical',
    `5-minute success rate critically low: ${w5m.successRate?.toFixed(1)}% (threshold: ${CFG.successCrit}%)`,
    { successRate5m: w5m.successRate, threshold: CFG.successCrit }
  );

  // ── Rule 3: high p95 latency ──────────────────────────────────────────────
  await evalRule(
    'high_p95_latency_5m',
    p95_5m > CFG.p95WarnMs,
    'warning',
    `5-minute p95 latency is ${p95_5m}ms (threshold: ${CFG.p95WarnMs}ms)`,
    { p95Ms: p95_5m, threshold: CFG.p95WarnMs }
  );

  // ── Rule 4: latency spike vs 1h baseline ─────────────────────────────────
  const spikeRatio = p95_1h > 0 ? p95_5m / p95_1h : 0;
  await evalRule(
    'latency_spike_vs_baseline',
    p95_5m > 0 && p95_1h > 0 && spikeRatio > CFG.spikeRatio,
    'warning',
    `Latency spike: 5m p95 (${p95_5m}ms) is ${spikeRatio.toFixed(1)}× the 1h baseline (${p95_1h}ms)`,
    { p95_5m, p95_1h, spikeRatio: +spikeRatio.toFixed(2), threshold: CFG.spikeRatio }
  );

  // ── Rule 5: high retry rate ───────────────────────────────────────────────
  await evalRule(
    'high_retry_rate',
    metrics.total > 10 && retryRate > CFG.retryRateWarn,
    'warning',
    `Retry rate is ${(retryRate * 100).toFixed(1)}% (threshold: ${CFG.retryRateWarn * 100}%)`,
    { retryRate: +retryRate.toFixed(3), totalJobs: metrics.total, threshold: CFG.retryRateWarn }
  );
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let _timer = null;

/**
 * Start the anomaly detection loop.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startAnomalyDetector() {
  if (_timer !== null) return;

  // Run once immediately so the first evaluation isn't delayed by intervalMs
  evaluate().catch((err) => {
    process.stderr.write(JSON.stringify({
      level: 'error', msg: '[anomaly-detector] Initial evaluation error', error: err.message,
    }) + '\n');
  });

  _timer = setInterval(() => {
    evaluate().catch((err) => {
      process.stderr.write(JSON.stringify({
        level: 'error', msg: '[anomaly-detector] Evaluation error', error: err.message,
      }) + '\n');
    });
  }, CFG.intervalMs);

  // Don't hold the process open just for the detector
  if (_timer.unref) _timer.unref();

  process.stderr.write(JSON.stringify({
    level: 'info',
    msg:   `[anomaly-detector] Started — interval=${CFG.intervalMs}ms sustained=${CFG.sustainedMs}ms`,
    config: CFG,
  }) + '\n');
}

/**
 * Stop the anomaly detection loop (e.g. during graceful shutdown).
 */
export function stopAnomalyDetector() {
  if (_timer !== null) {
    clearInterval(_timer);
    _timer = null;
  }
}

// ─── GET /anomalies handler (import and mount in server.js) ──────────────────

/**
 * Return the most recent anomaly alerts stored in Redis, newest first.
 *
 * Mount in server.js:
 *   import { anomalyHandler } from './engine/anomaly-detector.js';
 *   app.get('/anomalies', requireApiKey, anomalyHandler);
 *
 * Response shape:
 *   {
 *     anomalies: [
 *       { ruleId, severity, summary, details, firedAt, firedAtIso, source },
 *       ...
 *     ],
 *     count: number
 *   }
 */
export async function anomalyHandler(req, res) {
  const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200);

  try {
    const keys = await redis.zrevrange(ALERT_INDEX, 0, limit - 1);

    if (!keys.length) {
      return res.json({ anomalies: [], count: 0 });
    }

    const pipeline = redis.pipeline();
    for (const k of keys) pipeline.get(k);
    const results = await pipeline.exec();

    const anomalies = results
      .map(([err, raw]) => (err || !raw ? null : JSON.parse(raw)))
      .filter(Boolean);

    res.json({ anomalies, count: anomalies.length });
  } catch (err) {
    console.error('[GET /anomalies]', err);
    res.status(500).json({ error: err.message });
  }
}
