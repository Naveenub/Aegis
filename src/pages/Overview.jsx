import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useTenant } from '../context/TenantContext';
import { useSSE } from '../context/SSEContext';
import StatCard from '../components/StatCard';
import DataTable from '../components/DataTable';

export default function Overview() {
  const { apiKey } = useAuth();
  const { tenantId } = useTenant();
  const { metrics: liveMetrics } = useSSE();
  const [metrics, setMetrics] = useState(null);
  const [task, setTask] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState(null);

  useEffect(() => {
    api.getMetrics(apiKey).then(setMetrics).catch(() => {});
  }, [apiKey]);

  // Prefer the live SSE snapshot once it arrives — falls back to the initial fetch.
  const m = liveMetrics || metrics;

  const submitTask = async (e) => {
    e.preventDefault();
    if (!task.trim()) return;
    setSubmitting(true);
    setSubmitMsg(null);
    try {
      const res = await api.submitTask(apiKey, { task: task.trim(), tenantId: tenantId || undefined });
      setSubmitMsg({ ok: true, text: `Submitted — workflow ${res.workflowId}` });
      setTask('');
    } catch (err) {
      setSubmitMsg({ ok: false, text: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const agentRows = m?.byAgent
    ? Object.entries(m.byAgent).map(([agent, stats]) => ({ agent, ...stats }))
    : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <form onSubmit={submitTask} style={{ display: 'flex', gap: 10 }}>
        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="Describe a task to submit to the orchestrator…"
          style={{
            flex: 1,
            padding: '10px 12px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
          }}
        />
        <button
          type="submit"
          disabled={submitting || !task.trim()}
          style={{
            padding: '10px 18px',
            background: 'var(--accent)',
            color: '#06110D',
            border: 'none',
            borderRadius: 'var(--radius)',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {submitting ? 'Submitting…' : 'Submit task'}
        </button>
      </form>
      {submitMsg && (
        <div style={{ color: submitMsg.ok ? 'var(--accent)' : 'var(--danger)', fontSize: 13, marginTop: -14 }}>
          {submitMsg.text}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <StatCard label="Total steps" value={m?.total ?? '—'} />
        <StatCard label="Success rate" value={m ? `${m.successRate}%` : '—'} accent />
        <StatCard label="Failed" value={m?.failed ?? '—'} />
        <StatCard label="Retries" value={m?.retries ?? '—'} />
        <StatCard label="Avg latency" value={m ? `${m.avgLatency}ms` : '—'} />
        <StatCard label="LLM spend" value={m ? `$${m.cost?.totalUsd?.toFixed(2)}` : '—'} sub="all-time" />
      </div>

      <div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Per-agent throughput
        </div>
        <DataTable
          keyField="agent"
          rows={agentRows}
          emptyLabel="No agent activity recorded yet."
          columns={[
            { key: 'agent', header: 'Agent', mono: true },
            { key: 'count', header: 'Steps' },
            { key: 'avgMs', header: 'Avg ms', render: (r) => `${r.avgMs}ms` },
          ]}
        />
      </div>
    </div>
  );
}
