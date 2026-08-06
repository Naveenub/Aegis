import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useTenant } from '../context/TenantContext';
import DataTable from '../components/DataTable';
import Badge from '../components/Badge';

const STATUSES = ['', 'running', 'paused', 'needs-review', 'completed', 'failed', 'cancelled'];

export default function Workflows() {
  const { apiKey } = useAuth();
  const { tenantId } = useTenant();
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listWorkflows(apiKey, { status: status || undefined, tenantId: tenantId || undefined, limit: 100 })
      .then((res) => setWorkflows(res.workflows ?? res.collected ?? []))
      .catch(() => setWorkflows([]))
      .finally(() => setLoading(false));
  }, [apiKey, status, tenantId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {STATUSES.map((s) => (
          <button
            key={s || 'all'}
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
            {s || 'all'}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={load} style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '6px 12px', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 12 }}>
          Refresh
        </button>
      </div>

      <DataTable
        rows={loading ? [] : workflows}
        emptyLabel={loading ? 'Loading…' : 'No workflows match this filter.'}
        onRowClick={(row) => navigate(`/workflows/${row.id}`)}
        columns={[
          { key: 'id', header: 'Workflow', mono: true },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
          { key: 'tenantId', header: 'Tenant', mono: true, render: (r) => r.tenantId || '—' },
          { key: 'priority', header: 'Priority' },
          { key: 'createdAt', header: 'Created', mono: true, render: (r) => new Date(r.createdAt).toLocaleString() },
        ]}
      />
    </div>
  );
}
