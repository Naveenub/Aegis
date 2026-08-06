import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import DataTable from '../components/DataTable';

const RESOLUTIONS = ['retrying', 'skip', 'escalate'];

export default function ReviewQueue() {
  const { apiKey } = useAuth();
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('pending');
  const [busyKey, setBusyKey] = useState(null);

  const load = useCallback(() => {
    api.getReviewQueue(apiKey, { status, limit: 100 }).then((r) => setItems(r.items ?? [])).catch(() => setItems([]));
  }, [apiKey, status]);

  useEffect(() => { load(); }, [load]);

  const resolve = async (item, resolution) => {
    const key = `${item.workflowId}:${item.stepId}`;
    setBusyKey(key);
    try {
      await api.resolveReview(apiKey, {
        workflowId: item.workflowId,
        stepId: item.stepId,
        resolution,
        tenantId: item.tenantId,
      });
      load();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {['pending', 'approved', 'rejected'].map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            style={{
              padding: '6px 12px',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--border)',
              background: status === s ? 'var(--surface-2)' : 'transparent',
              color: status === s ? 'var(--text)' : 'var(--text-dim)',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {s}
          </button>
        ))}
      </div>

      <DataTable
        rows={items}
        keyField="stepId"
        emptyLabel="No items awaiting human review."
        columns={[
          { key: 'workflowId', header: 'Workflow', mono: true },
          { key: 'stepId', header: 'Step', mono: true },
          { key: 'agent', header: 'Agent', mono: true },
          { key: 'error', header: 'Error', wrap: true, render: (r) => <span style={{ color: 'var(--danger)' }}>{r.error}</span> },
          {
            key: 'resolve',
            header: 'Resolve',
            render: (r) => {
              const busy = busyKey === `${r.workflowId}:${r.stepId}`;
              return (
                <div style={{ display: 'flex', gap: 6 }}>
                  {RESOLUTIONS.map((res) => (
                    <button
                      key={res}
                      disabled={busy}
                      onClick={() => resolve(r, res)}
                      style={{
                        background: 'none',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius)',
                        color: res === 'escalate' ? 'var(--danger)' : 'var(--text-dim)',
                        fontSize: 11,
                        padding: '3px 8px',
                        cursor: busy ? 'default' : 'pointer',
                        opacity: busy ? 0.5 : 1,
                      }}
                    >
                      {res}
                    </button>
                  ))}
                </div>
              );
            },
          },
        ]}
      />
    </div>
  );
}
