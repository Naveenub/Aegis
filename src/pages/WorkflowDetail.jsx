import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import DataTable from '../components/DataTable';
import Badge from '../components/Badge';

export default function WorkflowDetail() {
  const { workflowId } = useParams();
  const { apiKey } = useAuth();
  const navigate = useNavigate();
  const [wf, setWf] = useState(null);
  const [error, setError] = useState(null);
  const [actionMsg, setActionMsg] = useState(null);

  const load = useCallback(() => {
    api.getWorkflow(apiKey, workflowId).then(setWf).catch((e) => setError(e.message));
  }, [apiKey, workflowId]);

  useEffect(() => { load(); }, [load]);

  const act = async (fn, label) => {
    setActionMsg(null);
    try {
      await fn();
      setActionMsg({ ok: true, text: `${label} — done` });
      load();
    } catch (err) {
      setActionMsg({ ok: false, text: err.message });
    }
  };

  if (error) return <div style={{ color: 'var(--danger)' }}>{error}</div>;
  if (!wf) return <div style={{ color: 'var(--text-dim)' }}>Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', width: 'fit-content', padding: 0 }}>
        ← Back
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{wf.id}</span>
        <Badge status={wf.status} />
      </div>

      <div style={{ display: 'flex', gap: 24, fontSize: 13, color: 'var(--text-dim)' }}>
        <span>Tenant: <span className="mono" style={{ color: 'var(--text)' }}>{wf.tenantId || '—'}</span></span>
        <span>Priority: <span className="mono" style={{ color: 'var(--text)' }}>{wf.priority}</span></span>
        <span>Started: <span className="mono" style={{ color: 'var(--text)' }}>{new Date(wf.startedAt).toLocaleString()}</span></span>
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <ActionButton onClick={() => act(() => api.resumeWorkflow(apiKey, { workflowId, tenantId: wf.tenantId }), 'Resume')}>
          Resume
        </ActionButton>
        <ActionButton danger onClick={() => act(() => api.cancelWorkflow(apiKey, { workflowId, tenantId: wf.tenantId, reason: 'cancelled via dashboard' }), 'Cancel')}>
          Cancel
        </ActionButton>
      </div>
      {actionMsg && (
        <div style={{ color: actionMsg.ok ? 'var(--accent)' : 'var(--danger)', fontSize: 13 }}>{actionMsg.text}</div>
      )}

      <div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Steps
        </div>
        <DataTable
          rows={wf.steps ?? []}
          keyField="id"
          emptyLabel="No steps recorded."
          columns={[
            { key: 'id', header: 'Step', mono: true },
            { key: 'agent', header: 'Agent', mono: true },
            { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
            {
              key: 'action',
              header: '',
              render: (r) =>
                r.status === 'completed' ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      act(() => api.rewindStep(apiKey, workflowId, r.id, { tenantId: wf.tenantId, reason: 'rewound via dashboard' }), `Rewind ${r.id}`);
                    }}
                    style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-dim)', fontSize: 11, padding: '3px 8px', cursor: 'pointer' }}
                  >
                    Rewind
                  </button>
                ) : null,
            },
          ]}
        />
      </div>
    </div>
  );
}

function ActionButton({ children, onClick, danger }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '7px 14px',
        borderRadius: 'var(--radius)',
        border: `1px solid ${danger ? 'var(--danger)' : 'var(--border)'}`,
        background: 'transparent',
        color: danger ? 'var(--danger)' : 'var(--text)',
        cursor: 'pointer',
        fontSize: 13,
      }}
    >
      {children}
    </button>
  );
}
