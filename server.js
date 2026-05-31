// ─── server.js — metrics endpoint additions ───────────────────────────────────
//
// Add these two imports alongside the other engine imports at the top of server.js:
//
//   import { renderPrometheus, renderOtel } from './engine/metrics.js';
//
// Then add these routes anywhere after the express app is created.
// Neither endpoint requires auth — standard practice for /metrics scrapers.
// If you want auth, wrap each handler in requireApiKey.
//

/**
 * GET /metrics
 *
 * Prometheus text-format exposition (format 0.0.4).
 * Scraped by Prometheus, Grafana Agent, VictoriaMetrics, Datadog Agent, etc.
 *
 * Exposes:
 *   aegis_jobs_total / success / failed / retries        — all-time counters
 *   aegis_success_rate / avg_latency_ms                  — all-time rates
 *   aegis_agent_jobs_total / avg_latency_ms{agent}       — per-agent gauges
 *   aegis_window_jobs_total / success_rate{window}       — 1m / 5m / 1h rollups
 *   aegis_latency_p50_ms / p95_ms / p99_ms{window}       — windowed percentiles
 *
 * Prometheus scrape config example:
 *   - job_name: aegis
 *     static_configs:
 *       - targets: ['localhost:3000']
 *     metrics_path: /metrics
 */
app.get('/metrics', async (req, res) => {
  try {
    const body = await renderPrometheus();
    // Content-Type required by Prometheus; charset must be UTF-8
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(body);
  } catch (err) {
    res.status(500).type('text/plain').send(`# ERROR: ${err.message}\n`);
  }
});

/**
 * GET /metrics/json
 *
 * OpenTelemetry-compatible JSON (OTLP/JSON ResourceMetrics shape).
 * Consumed by:
 *   - OTEL Collector HTTP receiver (forward to any OTEL backend)
 *   - Dashboards that prefer JSON over Prometheus scraping
 *   - Custom alerting / reporting tools
 *
 * Response shape:
 *   { resourceMetrics: [{ resource, scopeMetrics: [{ metrics: [...] }] }] }
 *
 * Each metric entry is a gauge dataPoint with attributes for window/agent,
 * allowing any OTEL-aware tool to slice by dimension without extra config.
 *
 * OTEL Collector pipeline example (otel-collector-config.yaml):
 *   receivers:
 *     otlphttp:
 *       endpoint: "http://aegis:3000/metrics/json"
 *   exporters:
 *     otlp:
 *       endpoint: "https://your-otel-backend"
 */
app.get('/metrics/json', async (req, res) => {
  try {
    const body = await renderOtel();
    res.json(body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
