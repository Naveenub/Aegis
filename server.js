/**
 * dashboard-routes.js
 *
 * Drop-in route additions for server.js.
 *
 * HOW TO INTEGRATE
 * ────────────────
 * 1. Add this import near the top of server.js alongside the other engine imports:
 *
 *      import { readFileSync } from 'fs';
 *      import { fileURLToPath } from 'url';
 *      import { dirname, join } from 'path';
 *      import { getMetrics } from './engine/metrics.js';
 *
 * 2. Copy the three route blocks below into server.js, after the Express app
 *    is created and middleware is applied.
 *
 * That's it — no new dependencies, no build step.
 */

// ─── Resolve dashboard HTML path at module load time ──────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const DASHBOARD_HTML = join(__dirname, 'engine', 'dashboard.html');

/**
 * GET /api/metrics
 *
 * Internal JSON endpoint consumed by the dashboard. Returns the full
 * structured metrics object from getMetrics() — all-time counters,
 * windowed rollups, latency percentiles, per-agent stats, and recent steps.
 *
 * Not intended for Prometheus scraping (use GET /metrics for that).
 * Auth: requireApiKey (same as all non-health endpoints).
 */
app.get('/api/metrics', requireApiKey, async (req, res) => {
  try {
    const data = await getMetrics();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /dashboard
 *
 * Full observability UI served as a single self-contained HTML page.
 * The page fetches live data from:
 *   GET /api/metrics        — structured metrics JSON (all-time + windowed)
 *   GET /metrics/json       — OTEL fallback when /api/metrics is unavailable
 *   GET /traces             — workflow trace list
 *   GET /jobs               — job log
 *   GET /review-queue       — pending human-review items
 *
 * Auth: requireApiKey — operators should use a read-only key for browser access.
 * The HTML file is read from disk at startup (not per-request) so disk I/O
 * only happens once; edits to dashboard.html require a server restart.
 */
const dashboardHtml = (() => {
  try {
    return readFileSync(DASHBOARD_HTML, 'utf-8');
  } catch (err) {
    console.warn('[dashboard] Could not read engine/dashboard.html:', err.message);
    return `<!DOCTYPE html><html><body><pre>Dashboard HTML not found at ${DASHBOARD_HTML}.\nRun the server from the project root.</pre></body></html>`;
  }
})();

app.get('/dashboard', requireApiKey, (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  // No-cache so a forced browser refresh always gets the latest HTML
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(dashboardHtml);
});
