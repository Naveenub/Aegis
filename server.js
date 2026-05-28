import express from 'express';
import fs from 'fs';
import { getMetrics } from './engine/metrics.js';
import { getTrace, listTraces } from './engine/tracer.js';
import {
  getWorkflow,
  getRunnableSteps,
  pauseWorkflow,
  resumeWorkflow,
  cancelWorkflow,
  getWorkflowStatus,
  getReviewQueue,
  resolveReview
} from './engine/workflow-store.js';
import { initVectorIndex } from './engine/vector-memory.js';
import { runSystem } from './engine/orchestrator.js';
import { addStep, Priority } from './engine/queue.js';
import { slotStatus, getLimit } from './engine/concurrency.js';

const app = express();
app.use(express.json());

/**
 * 🚀 Trigger task execution
 * Body: { task, priority?, timeoutMs? }
 * priority: "critical" | "high" | "normal" | "low"  (default: normal)
 */
app.post('/task', async (req, res) => {
  try {
    const { task, priority = 'normal', timeoutMs } = req.body;

    const p = Priority[priority.toUpperCase()] ?? Priority.NORMAL;
    const workflowId = await runSystem(task, { priority: p, timeoutMs });

    res.json({ status: 'submitted', workflowId, priority, timeoutMs: timeoutMs ?? null });
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

    const steps = await getRunnableSteps(id);
    for (const step of steps) {
      await addStep(id, step);
    }

    res.json({ status: 'resumed', workflowId: id, stepsScheduled: steps.length });
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
 */
app.get('/jobs', (req, res) => {
  try {
    const path = '.claude/context/jobs.json';
    if (!fs.existsSync(path)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(path)));
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

    // If retrying: re-queue the step so it gets another run
    if (resolution === 'retrying') {
      const wf = await getWorkflow(workflowId);
      if (wf) {
        const step = wf.steps.find(s => s.id === stepId);
        if (step) {
          // Reset step to pending so the worker processes it
          const { updateStep } = await import('./engine/workflow-store.js');
          await updateStep(workflowId, stepId, 'pending');
          await addStep(workflowId, step);
        }
      }
    }

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
 * 📊 Observability Dashboard (HTML)
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
  .poll-controls{display:flex;align-items:center;gap:10px;font-size:.8rem;color:#94a3b8}
  .poll-controls select{background:#1e2130;color:#e2e8f0;border:1px solid #2d3148;border-radius:5px;padding:3px 8px;font-size:.8rem}
  .poll-indicator{display:inline-block;width:8px;height:8px;border-radius:50%;background:#34d399;margin-right:4px}
  .poll-indicator.paused{background:#f87171}
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
  .btn-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  button{background:#a78bfa;color:#0f1117;border:none;border-radius:6px;padding:8px 16px;font-weight:600;cursor:pointer;font-size:.85rem}
  button:hover{background:#c4b5fd}
  button.secondary{background:#1e2130;color:#a78bfa;border:1px solid #a78bfa}
  button.secondary:hover{background:#252840}
  .err{color:#f87171;font-size:.85rem;margin-top:8px}
  .progress-bar{height:3px;background:#2d3148;border-radius:2px;overflow:hidden;margin-bottom:20px}
  .progress-fill{height:100%;background:#a78bfa;transition:width linear}
</style>
</head>
<body>
<div class="topbar">
  <div>
    <h1>⚡ Aegis Observability</h1>
    <span class="last-updated" id="lastUpdated">Never updated</span>
  </div>
  <div class="poll-controls">
    <span><span class="poll-indicator" id="pollDot"></span><span id="pollStatus">Live</span></span>
    <label for="intervalSelect">every</label>
    <select id="intervalSelect">
      <option value="3000">3 s</option>
      <option value="5000" selected>5 s</option>
      <option value="10000">10 s</option>
      <option value="30000">30 s</option>
      <option value="60000">60 s</option>
    </select>
    <button class="secondary" id="toggleBtn" onclick="togglePoll()">⏸ Pause</button>
    <button onclick="load()">↻ Now</button>
  </div>
</div>
<div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:0%"></div></div>
<div id="app"><p style="color:#94a3b8">Loading…</p></div>

<script>
let pollTimer = null;
let progressTimer = null;
let paused = false;
let intervalMs = 5000;

function fmt(d){
  return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

function startProgress() {
  clearInterval(progressTimer);
  const fill = document.getElementById('progressFill');
  const start = Date.now();
  fill.style.transition = 'none';
  fill.style.width = '0%';
  progressTimer = setInterval(() => {
    const pct = Math.min(100, ((Date.now() - start) / intervalMs) * 100);
    fill.style.width = pct + '%';
    if (pct >= 100) clearInterval(progressTimer);
  }, 100);
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (!paused) {
    startProgress();
    pollTimer = setTimeout(() => { load(); }, intervalMs);
  }
}

function togglePoll() {
  paused = !paused;
  const dot = document.getElementById('pollDot');
  const status = document.getElementById('pollStatus');
  const btn = document.getElementById('toggleBtn');
  const fill = document.getElementById('progressFill');
  if (paused) {
    clearTimeout(pollTimer);
    clearInterval(progressTimer);
    fill.style.width = '0%';
    dot.classList.add('paused');
    status.textContent = 'Paused';
    btn.textContent = '▶ Resume';
  } else {
    dot.classList.remove('paused');
    status.textContent = 'Live';
    btn.textContent = '⏸ Pause';
    load();
  }
}

document.getElementById('intervalSelect').addEventListener('change', function() {
  intervalMs = parseInt(this.value, 10);
  if (!paused) { clearTimeout(pollTimer); load(); }
});

async function load() {
  try {
    const [metrics, traces] = await Promise.all([
      fetch('/metrics').then(r=>r.json()),
      fetch('/traces?limit=30').then(r=>r.json()),
    ]);

    const byAgent = metrics.byAgent ?? {};
    const recentSteps = metrics.recentSteps ?? [];

    document.getElementById('app').innerHTML = \`
      <div class="grid">
        <div class="card"><div class="label">Total Jobs</div><div class="value blue">\${metrics.total ?? 0}</div></div>
        <div class="card"><div class="label">Success</div><div class="value green">\${metrics.success ?? 0}</div></div>
        <div class="card"><div class="label">Failed</div><div class="value red">\${metrics.failed ?? 0}</div></div>
        <div class="card"><div class="label">Retries</div><div class="value">\${metrics.retries ?? 0}</div></div>
        <div class="card"><div class="label">Success Rate</div><div class="value green">\${metrics.successRate ?? 0}%</div></div>
        <div class="card"><div class="label">Avg Latency</div><div class="value blue">\${metrics.avgLatency ?? 0}ms</div></div>
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
    \`;

    document.getElementById('lastUpdated').textContent = 'Updated ' + fmt(new Date());
    schedulePoll();
  } catch(e) {
    document.getElementById('app').innerHTML = '<p class="err">Fetch error: ' + e.message + '</p>';
    schedulePoll(); // keep trying even on error
  }
}

load();
</script>
</body>
</html>`);
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

/**
 * ❤️ Health Check
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

await initVectorIndex();

app.listen(3000, () => {
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
  console.log('  GET  /dashboard                     – observability dashboard (HTML)');
  console.log('  GET  /jobs                          – job list');
  console.log('  GET  /concurrency/:id               – slot usage for a workflow');
});