import http from 'http';
import express from 'express';
import fs from 'fs';
import { WebSocketServer } from 'ws';
import { requireApiKey, optionalApiKey } from './middleware/auth.js';
import { getMetrics } from './engine/metrics.js';
import { getTrace, listTraces } from './engine/tracer.js';
import { listJobs } from './engine/job-store.js';
import {
  getWorkflow,
  getRunnableSteps,
  pauseWorkflow,
  resumeWorkflow,
  cancelWorkflow,
  getWorkflowStatus,
  getReviewQueue,
  resolveReview,
  resetStepForRetry
} from './engine/workflow-store.js';
import { initVectorIndex } from './engine/vector-memory.js';
import { runSystem } from './engine/orchestrator.js';
import { addStep, Priority } from './engine/queue.js';
import { slotStatus, getLimit } from './engine/concurrency.js';
import { finaliseWorkflow } from './engine/git.js';
import { listTenants, getTenant, registerTenant, seedTenantsFromEnv } from './engine/tenant-registry.js';
import { getWorker } from './workers/agent-worker.js';
import { getDlqWorker } from './workers/dlq-worker.js';

const app = express();
app.use(express.json());

// ─── WebSocket server (share the HTTP server so same port) ───────────────────

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

/**
 * Collect the full dashboard payload in one shot.
 * Mirrors what the old polling dashboard fetched via 3 HTTP calls.
 */
async function buildDashboardPayload() {
  const [metrics, traces, reviewData] = await Promise.all([
    Promise.resolve(getMetrics()),
    Promise.resolve(listTraces(30)),
    getReviewQueue({ limit: 50, status: 'pending' }),
  ]);
  return { metrics, traces, reviewQueue: reviewData };
}

/** Broadcast a fresh payload to every connected dashboard client. */
async function broadcastDashboard() {
  if (wss.clients.size === 0) return;
  try {
    const payload = JSON.stringify(await buildDashboardPayload());
    for (const client of wss.clients) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(payload);
      }
    }
  } catch (err) {
    console.error('[ws] broadcast error:', err.message);
  }
}

// Send a fresh snapshot to each client the moment it connects.
wss.on('connection', async (ws) => {
  try {
    ws.send(JSON.stringify(await buildDashboardPayload()));
  } catch (err) {
    console.error('[ws] initial send error:', err.message);
  }
  // Clients don't send anything; ignore inbound messages.
});

// ─── File watchers: push whenever metrics or traces change on disk ───────────
//
// Both files are written by engine workers after every step, so watching them
// is the cheapest way to know "something happened" without polling.
// fs.watch uses inotify/kqueue — effectively zero CPU when idle.

const METRICS_PATH = '.claude/context/metrics.json';
const TRACES_PATH  = '.claude/context/traces.json';

// Debounce: coalesce rapid successive writes into a single broadcast.
let broadcastTimer = null;
function scheduleBroadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(broadcastDashboard, 120);
}

function watchFile(filePath) {
  // Ensure the file exists so fs.watch doesn't throw.
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(new URL('.', new URL(filePath, import.meta.url)).pathname, { recursive: true });
    fs.writeFileSync(filePath, filePath.endsWith('traces.json') ? '{}' : '{}');
  }
  fs.watch(filePath, { persistent: false }, scheduleBroadcast);
}

watchFile(METRICS_PATH);
watchFile(TRACES_PATH);

// ─── Health ──────────────────────────────────────────────────────────────────

/**
 * ❤️ Health Check — intentionally public, no key required.
 */
app.get('/health', optionalApiKey, (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

/**
 * 🔒 All routes below this line require a valid AEGIS_API_KEY.
 *    Send:  Authorization: Bearer <key>
 *      or:  x-api-key: <key>
 */
app.use(requireApiKey);

/**
 * 🚀 Trigger task execution
 * Body: { task, priority?, timeoutMs? }
 * priority: "critical" | "high" | "normal" | "low"  (default: normal)
 */
app.post('/task', async (req, res) => {
  try {
    const { task, priority = 'normal', timeoutMs, tenantId } = req.body;

    const p = Priority[priority.toUpperCase()] ?? Priority.NORMAL;
    const workflowId = await runSystem(task, { priority: p, timeoutMs, tenantId });

    res.json({ status: 'submitted', workflowId, priority, tenantId: tenantId ?? null, timeoutMs: timeoutMs ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ▶️ Resume a paused workflow
 */
app.post('/resume/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const ok = await resumeWorkflow(id);
    if (!ok) {
      return res.status(409).json({ error: 'Workflow not found or not paused' });
    }

    const wf = await getWorkflow(id);
    const priority = wf?.priority ?? Priority.NORMAL;
    const tenantId = wf?.tenantId ?? undefined;

    const steps = await getRunnableSteps(id);
    for (const step of steps) {
      await addStep(id, step, priority, tenantId);
    }

    res.json({ status: 'resumed', workflowId: id, stepsScheduled: steps.length, priority });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ⏸ Pause a running workflow
 */
app.post('/pause/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const ok = await pauseWorkflow(id);
    if (!ok) {
      return res.status(409).json({ error: 'Workflow not found or not running' });
    }

    res.json({ status: 'paused', workflowId: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🛑 Cancel a workflow
 * Body: { reason? }
 */
app.post('/cancel/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = 'user request' } = req.body ?? {};

    const ok = await cancelWorkflow(id, reason);
    if (!ok) {
      return res.status(409).json({ error: 'Workflow not found, already cancelled, or completed' });
    }

    res.json({ status: 'cancelled', workflowId: id, reason });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🔍 Get workflow status + steps
 */
app.get('/workflow/:id', async (req, res) => {
  try {
    const wf = await getWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    res.json(wf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📊 Metrics
 */
app.get('/metrics', (req, res) => {
  try {
    res.json(getMetrics());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📁 Job State Viewer
 * Query: ?tenantId=default&limit=200
 */
app.get('/jobs', async (req, res) => {
  try {
    const tenantId = req.query.tenantId ?? 'default';
    const limit    = parseInt(req.query.limit ?? '200', 10);
    const jobs     = await listJobs(tenantId, { limit });
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 👁 Human review queue — steps that exhausted all retries
 * Query params: ?status=pending|resolved|skipped|retrying  (default: pending)
 *               ?limit=50
 */
app.get('/review-queue', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit ?? '50', 10);
    const status = req.query.status ?? 'pending';
    const items = await getReviewQueue({ limit, status });
    res.json({ count: items.length, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ✅ Resolve a review item
 * Body: { resolution: 'resolved' | 'skipped' | 'retrying', note?: string }
 *
 * 'retrying'  → re-queue the step (you must also POST /resume/:workflowId
 *               or the step will re-enter a paused/cancelled workflow)
 * 'skipped'   → mark the step as skipped, allow DAG to continue if possible
 * 'resolved'  → human fixed it externally, close the item
 */
app.post('/review/:workflowId/:stepId/resolve', async (req, res) => {
  try {
    const { workflowId, stepId } = req.params;
    const { resolution, note = '' } = req.body ?? {};

    const validResolutions = ['resolved', 'skipped', 'retrying'];
    if (!validResolutions.includes(resolution)) {
      return res.status(400).json({
        error: `Invalid resolution. Must be one of: ${validResolutions.join(', ')}`
      });
    }

    const record = await resolveReview(workflowId, stepId, resolution, note);
    if (!record) {
      return res.status(404).json({ error: 'Review item not found' });
    }

    const wf = await getWorkflow(workflowId);
    const tenantId = wf?.tenantId ?? undefined;

    // If retrying: reset step to pending + zero the attempt counter, then re-queue.
    // resetStepForRetry() writes status='pending' and attempt=0 atomically and
    // returns the updated step, so addStep() always receives a clean payload.
    // Using the returned step (rather than wf.steps.find) avoids passing a
    // stale object that still carries status='needs-review' and the old attempt
    // value — which would cause agentForAttempt() to route to escalationAgent
    // or fallbackAgent instead of the step's own agent on the very first retry.
    if (resolution === 'retrying') {
      if (wf) {
        const freshStep = await resetStepForRetry(workflowId, stepId);
        if (freshStep) {
          await addStep(workflowId, freshStep, wf.priority ?? Priority.NORMAL, tenantId);
        }
      }
    }

    // FIX: 'resolved' means a human fixed the step externally.
    // Mark it completed and check whether the workflow is now fully done —
    // if so, merge and clean up the workflow branch.
    if (resolution === 'resolved') {
      await updateStep(workflowId, stepId, 'completed');

      // Check if any steps are still pending or running
      const remaining = (wf?.steps ?? []).filter(
        s => s.id !== stepId && (s.status === 'pending' || s.status === 'running')
      );

      if (remaining.length === 0 && tenantId) {
        // All steps done — finalise the git branch
        try {
          await finaliseWorkflow(workflowId, tenantId);
        } catch (err) {
          // Non-fatal: log but don't fail the HTTP response
          console.error(`[review/resolve] finaliseWorkflow failed for ${workflowId}:`, err.message);
        }
      }
    }

    // Push updated review queue to all dashboard clients immediately.
    scheduleBroadcast();

    res.json({ status: 'ok', record });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🔗 Get full trace for a workflow (step → agent → patch → test result)
 */
app.get('/trace/:id', (req, res) => {
  try {
    const trace = getTrace(req.params.id);
    if (!trace) return res.status(404).json({ error: 'Trace not found' });
    res.json(trace);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🔗 List recent traces
 * Query: ?limit=50
 */
app.get('/traces', (req, res) => {
  try {
    const limit = parseInt(req.query.limit ?? '50', 10);
    res.json(listTraces(limit));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📊 Observability Dashboard (HTML) — WebSocket-push edition
 *
 * The browser opens a single WebSocket to /ws.  The server pushes
 * { metrics, traces, reviewQueue } whenever metrics.json or traces.json
 * changes on disk (via fs.watch + 120 ms debounce).  No HTTP polling.
 */
app.get('/dashboard', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Aegis Dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0f1117;color:#e2e8f0;padding:24px}
  h1{font-size:1.5rem;font-weight:700;margin-bottom:4px;color:#a78bfa}
  .topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:8px}
  .ws-controls{display:flex;align-items:center;gap:10px;font-size:.8rem;color:#94a3b8}
  .ws-indicator{display:inline-block;width:8px;height:8px;border-radius:50%;background:#f87171;margin-right:4px;transition:background .3s}
  .ws-indicator.open{background:#34d399}
  .ws-indicator.connecting{background:#fb923c}
  .last-updated{font-size:.75rem;color:#64748b}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:28px}
  .card{background:#1e2130;border-radius:10px;padding:18px;border:1px solid #2d3148}
  .card .label{font-size:.75rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em}
  .card .value{font-size:2rem;font-weight:700;margin-top:6px}
  .card .value.green{color:#34d399} .card .value.red{color:#f87171} .card .value.blue{color:#60a5fa}
  table{width:100%;border-collapse:collapse;background:#1e2130;border-radius:10px;overflow:hidden;margin-bottom:28px}
  th{background:#252840;padding:10px 14px;text-align:left;font-size:.75rem;text-transform:uppercase;color:#94a3b8;letter-spacing:.06em}
  td{padding:10px 14px;border-top:1px solid #2d3148;font-size:.85rem;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.7rem;font-weight:600}
  .badge.success{background:#064e3b;color:#34d399} .badge.failure{background:#450a0a;color:#f87171} .badge.running{background:#1e3a5f;color:#60a5fa}
  h2{font-size:1rem;font-weight:600;color:#a78bfa;margin-bottom:12px}
  .section{margin-bottom:28px}
  button{background:#a78bfa;color:#0f1117;border:none;border-radius:6px;padding:8px 16px;font-weight:600;cursor:pointer;font-size:.85rem}
  button:hover{background:#c4b5fd}
  button.secondary{background:#1e2130;color:#a78bfa;border:1px solid #a78bfa}
  button.secondary:hover{background:#252840}
  .err{color:#f87171;font-size:.85rem;margin-top:8px}
  .review-count{background:#fb923c;color:#0f1117;border-radius:999px;padding:1px 7px;font-size:.75rem;font-weight:700;margin-left:6px}
  .resolve-btn{padding:3px 10px;font-size:.75rem;border-radius:5px;cursor:pointer;border:none;font-weight:600}
  .resolve-btn.resolved{background:#064e3b;color:#34d399}
  .resolve-btn.skipped{background:#1e3a5f;color:#60a5fa}
  .resolve-btn.retrying{background:#3b1f6e;color:#a78bfa}
  .resolve-btn:hover{filter:brightness(1.2)}
</style>
</head>
<body>
<div class="topbar">
  <div>
    <h1>⚡ Aegis Observability</h1>
    <span class="last-updated" id="lastUpdated">Connecting…</span>
  </div>
  <div class="ws-controls">
    <span><span class="ws-indicator connecting" id="wsDot"></span><span id="wsStatus">Connecting</span></span>
    <button class="secondary" id="reconnectBtn" onclick="connect()" style="display:none">↻ Reconnect</button>
  </div>
</div>
<div id="app"><p style="color:#94a3b8">Waiting for server push…</p></div>

<script>
let ws = null;

function fmt(d) {
  return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

function setStatus(state) {
  const dot = document.getElementById('wsDot');
  const lbl = document.getElementById('wsStatus');
  const btn = document.getElementById('reconnectBtn');
  dot.className = 'ws-indicator ' + state;
  lbl.textContent = state === 'open' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Disconnected';
  btn.style.display = state === 'closed' ? '' : 'none';
}

function connect() {
  if (ws && ws.readyState < 2) ws.close();
  setStatus('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/ws');

  ws.onopen  = () => setStatus('open');
  ws.onclose = () => { setStatus('closed'); setTimeout(connect, 3000); /* auto-reconnect */ };
  ws.onerror = () => ws.close();

  ws.onmessage = (evt) => {
    try {
      const { metrics, traces, reviewQueue } = JSON.parse(evt.data);
      render(metrics, traces, reviewQueue?.items ?? []);
      document.getElementById('lastUpdated').textContent = 'Updated ' + fmt(new Date());
    } catch(e) {
      console.error('ws parse error', e);
    }
  };
}

async function resolve(workflowId, stepId, resolution) {
  const row = document.getElementById(\`rq-\${workflowId}-\${stepId}\`);
  if (row) row.style.opacity = '0.4';
  try {
    const resp = await fetch(\`/review/\${workflowId}/\${stepId}/resolve\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'Unknown error' }));
      alert(\`Resolve failed: \${err.error}\`);
      if (row) row.style.opacity = '1';
    }
    // No need to manually update the UI — the server will push a fresh
    // payload via WebSocket as soon as the review file changes.
  } catch(e) {
    alert('Network error: ' + e.message);
    if (row) row.style.opacity = '1';
  }
}

function render(metrics, traces, reviewItems) {
  const byAgent     = metrics.byAgent     ?? {};
  const recentSteps = metrics.recentSteps ?? [];

  document.getElementById('app').innerHTML = \`
    <div class="grid">
      <div class="card"><div class="label">Total Jobs</div><div class="value blue">\${metrics.total ?? 0}</div></div>
      <div class="card"><div class="label">Success</div><div class="value green">\${metrics.success ?? 0}</div></div>
      <div class="card"><div class="label">Failed</div><div class="value red">\${metrics.failed ?? 0}</div></div>
      <div class="card"><div class="label">Retries</div><div class="value">\${metrics.retries ?? 0}</div></div>
      <div class="card"><div class="label">Success Rate</div><div class="value green">\${metrics.successRate ?? 0}%</div></div>
      <div class="card"><div class="label">Avg Latency</div><div class="value blue">\${metrics.avgLatency ?? 0}ms</div></div>
      <div class="card"><div class="label">Needs Review</div><div class="value" style="color:#fb923c">\${reviewItems.length}</div></div>
    </div>

    <div class="section">
      <h2>Per-Agent Latency</h2>
      \${Object.keys(byAgent).length === 0 ? '<p style="color:#94a3b8;font-size:.85rem">No agent data yet.</p>' : \`
      <table>
        <thead><tr><th>Agent</th><th>Calls</th><th>Avg ms</th></tr></thead>
        <tbody>
          \${Object.entries(byAgent).map(([a,v])=>\`<tr><td>\${a}</td><td>\${v.count}</td><td>\${v.avgMs}</td></tr>\`).join('')}
        </tbody>
      </table>\`}
    </div>

    <div class="section">
      <h2>Recent Step Spans</h2>
      \${recentSteps.length === 0 ? '<p style="color:#94a3b8;font-size:.85rem">No completed steps yet.</p>' : \`
      <table>
        <thead><tr><th>Step</th><th>Agent</th><th>Duration ms</th><th>Status</th></tr></thead>
        <tbody>
          \${recentSteps.slice().reverse().map(s=>\`
            <tr>
              <td title="\${s.stepId}">\${s.stepId}</td>
              <td>\${s.agent ?? '—'}</td>
              <td>\${s.durationMs ?? '—'}</td>
              <td><span class="badge \${s.status}">\${s.status}</span></td>
            </tr>\`).join('')}
        </tbody>
      </table>\`}
    </div>

    <div class="section">
      <h2>Traces (step → agent → patch → test)</h2>
      \${traces.length === 0 ? '<p style="color:#94a3b8;font-size:.85rem">No traces yet.</p>' : \`
      <table>
        <thead><tr><th>Workflow</th><th>Spans</th><th>Status</th><th>Link</th></tr></thead>
        <tbody>
          \${traces.map(t => {
            const spans = Object.values(t.spans ?? {});
            const anyRunning = spans.some(s=>s.status==='running');
            const anyFailed  = spans.some(s=>s.status==='failure');
            const overall = anyRunning ? 'running' : anyFailed ? 'failure' : 'success';
            return \`<tr>
              <td title="\${t.traceId}">\${t.traceId.slice(0,12)}…</td>
              <td>\${spans.length}</td>
              <td><span class="badge \${overall}">\${overall}</span></td>
              <td><a href="/trace/\${t.traceId}" style="color:#a78bfa">view</a></td>
            </tr>\`;
          }).join('')}
        </tbody>
      </table>\`}
    </div>

    <div class="section">
      <h2>👁 Review Queue <span class="review-count">\${reviewItems.length}</span></h2>
      \${reviewItems.length === 0
        ? '<p style="color:#94a3b8;font-size:.85rem">No items pending human review. ✅</p>'
        : \`<table>
        <thead><tr><th>Workflow</th><th>Step</th><th>Agent</th><th>Error</th><th>Flagged</th><th>Actions</th></tr></thead>
        <tbody>
          \${reviewItems.map(item => \`
            <tr id="rq-\${item.workflowId}-\${item.stepId}">
              <td title="\${item.workflowId}">\${item.workflowId.slice(0,10)}…</td>
              <td title="\${item.stepId}">\${item.stepId.slice(0,14)}…</td>
              <td>\${item.agent ?? '—'}</td>
              <td title="\${item.error ?? ''}" style="color:#fca5a5;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${item.error ? item.error.slice(0,60) + (item.error.length > 60 ? '…' : '') : '—'}</td>
              <td style="color:#94a3b8;white-space:nowrap">\${new Date(item.flaggedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</td>
              <td style="display:flex;gap:6px;flex-wrap:wrap">
                <button class="resolve-btn resolved" onclick="resolve('\${item.workflowId}','\${item.stepId}','resolved')">✓ Resolved</button>
                <button class="resolve-btn skipped"  onclick="resolve('\${item.workflowId}','\${item.stepId}','skipped')">⏭ Skip</button>
                <button class="resolve-btn retrying" onclick="resolve('\${item.workflowId}','\${item.stepId}','retrying')">↻ Retry</button>
              </td>
            </tr>\`).join('')}
        </tbody>
      </table>\`}
    </div>
  \`;
}

connect();
</script>
</body>
</html>`);
});

/**
 * 📋 List all registered tenants
 */
app.get('/tenants', async (_req, res) => {
  try {
    const ids = await listTenants();
    res.json({ count: ids.length, tenants: ids });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ➕ Register a new tenant at runtime
 * Body: { tenantId, label? }
 *
 * Idempotent — re-registering an existing tenant returns 200 with created=false.
 * Immediately boots a BullMQ worker for the tenant in this process so jobs
 * submitted to aegis-tasks:{tenantId} are picked up without a restart.
 */
app.post('/tenants', async (req, res) => {
  try {
    const { tenantId, label } = req.body ?? {};

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const { created } = await registerTenant(tenantId, { label });

    // Boot (or no-op if already running) workers for this tenant.
    // getDlqWorker must be called here so the per-tenant DLQ queue
    // "aegis-dead-letter:{tenantId}" is consumed immediately after registration,
    // rather than waiting for the next server restart.
    getWorker(tenantId);
    getDlqWorker(tenantId);

    // Ensure the vector index exists for the new tenant
    await initVectorIndex(tenantId);

    const record = await getTenant(tenantId);
    res.status(created ? 201 : 200).json({ created, tenant: record });
  } catch (err) {
    // assertTenantId throws a plain Error for invalid ids
    if (err.message?.startsWith('Invalid tenantId')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🔢 Concurrency status for a workflow
 * Shows active slot count, configured limit, and current slot holders.
 * Query: ?priority=0  (default 5 = NORMAL; use the BullMQ numeric value)
 */
app.get('/concurrency/:id', async (req, res) => {
  try {
    const priority = parseInt(req.query.priority ?? '5', 10);
    const status   = await slotStatus(req.params.id, priority);
    res.json({
      workflowId: req.params.id,
      priority,
      limit:  status.limit,
      active: status.active,
      available: Math.max(0, status.limit - status.active),
      holders: status.holders
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

await seedTenantsFromEnv();
await initVectorIndex();

// Use httpServer (not app.listen) so Express and WebSocket share port 3000.
httpServer.listen(3000, () => {
  console.log('🚀 Aegis server running on http://localhost:3000');
  console.log('  POST /task                          – submit task');
  console.log('  POST /pause/:id                     – pause workflow');
  console.log('  POST /resume/:id                    – resume workflow');
  console.log('  POST /cancel/:id                    – cancel workflow');
  console.log('  GET  /workflow/:id                  – workflow state + steps');
  console.log('  GET  /review-queue                  – items pending human review');
  console.log('  POST /review/:wfId/:stepId/resolve  – resolve a review item');
  console.log('  GET  /metrics                       – system metrics (per-agent, per-step)');
  console.log('  GET  /traces                        – list recent traces');
  console.log('  GET  /trace/:id                     – full trace for a workflow');
  console.log('  GET  /dashboard                     – observability dashboard (WebSocket-push)');
  console.log('  GET  /jobs                          – job list');
  console.log('  GET  /concurrency/:id               – slot usage for a workflow');
  console.log('  GET  /tenants                       – list registered tenants');
  console.log('  POST /tenants                       – register a tenant at runtime');
  console.log('  WS   /ws                            – dashboard push channel');
});
