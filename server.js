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
  h1{font-size:1.5rem;font-weight:700;margin-bottom:20px;color:#a78bfa}
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
  .err{color:#f87171;font-size:.85rem;margin-top:8px}
</style>
</head>
<body>
<h1>⚡ Aegis Observability</h1>
<div id="app"><p style="color:#94a3b8">Loading…</p></div>
<script>
async function load() {
  const [metrics, traces] = await Promise.all([
    fetch('/metrics').then(r=>r.json()),
    fetch('/traces?limit=30').then(r=>r.json()),
  ]);

  const byAgent = metrics.byAgent ?? {};
  const recentSteps = metrics.recentSteps ?? [];

  document.getElementById('app').innerHTML = \`
    <div class="grid">
      <div class="card"><div class="label">Total Jobs</div><div class="value blue">\${metrics.total}</div></div>
      <div class="card"><div class="label">Success</div><div class="value green">\${metrics.success}</div></div>
      <div class="card"><div class="label">Failed</div><div class="value red">\${metrics.failed}</div></div>
      <div class="card"><div class="label">Retries</div><div class="value">\${metrics.retries}</div></div>
      <div class="card"><div class="label">Success Rate</div><div class="value green">\${metrics.successRate}%</div></div>
      <div class="card"><div class="label">Avg Latency</div><div class="value blue">\${metrics.avgLatency}ms</div></div>
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

    <button onclick="load()">↻ Refresh</button>
  \`;
}
load().catch(e => { document.getElementById('app').innerHTML = '<p class="err">'+e.message+'</p>'; });
</script>
</body>
</html>`);
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
  console.log('  GET  /health                        – health check');
});