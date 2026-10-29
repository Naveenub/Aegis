import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import DataTable from '../components/DataTable';

const field = { padding: '7px 10px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 12 };

function Actor({ e }) {
  if (e.actorType === 'user') {
    return (
      <span>
        <span className="mono">{e.actorEmail || e.actorId}</span>
        {e.actorRole && <span style={{ color: 'var(--text-faint)' }}> · {e.actorRole}</span>}
      </span>
    );
  }
  return (
    <span className="mono" style={{ color: 'var(--text-dim)' }}>
      {e.actorType === 'api-key' ? 'key ' : ''}{e.actorId}
      {e.actorRole && <span style={{ color: 'var(--text-faint)' }}> · {e.actorRole}</span>}
    </span>
  );
}

export default function AuditLog() {
  const { apiKey, user } = useAuth();
  const tenantId = user.tenantId;
  const [events, setEvents] = useState([]);
  const [chainValid, setChainValid] = useState(null);
  const [action, setAction] = useState('');
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.getAuditLog(apiKey, tenantId, { action: action.trim() || undefined, limit: 200 });
      setEvents(res.events ?? []);
      setChainValid(res.chainValid);
    } catch (err) {
      setError(err.message);
    }
  }, [apiKey, tenantId, action]);

  useEffect(() => { load(); }, [load]);

  const exportCsv = async () => {
    try {
      const blob = await api.downloadAuditLog(apiKey, tenantId, 'csv');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `audit-${tenantId}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input value={action} onChange={(e) => setAction(e.target.value)} placeholder="Filter by action, e.g. key.created" style={{ ...field, width: 260 }} />
        <button onClick={load} style={{ ...field, color: 'var(--text-dim)', cursor: 'pointer' }}>Refresh</button>
        <button onClick={exportCsv} style={{ ...field, color: 'var(--text-dim)', cursor: 'pointer' }}>Export CSV</button>
        {chainValid !== null && (
          <span style={{ marginLeft: 'auto', fontSize: 12, color: chainValid ? 'var(--accent)' : 'var(--danger)' }}>
            {chainValid ? '✓ Hash chain verified' : '✗ Hash chain broken — events were altered or removed'}
          </span>
        )}
      </div>

      {error && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}

      <DataTable
        rows={events}
        keyField="id"
        emptyLabel="No audit events match."
        columns={[
          { key: 'ts', header: 'Time', mono: true, render: (e) => new Date(Number(e.ts)).toLocaleString() },
          { key: 'actor', header: 'Actor', render: (e) => <Actor e={e} /> },
          { key: 'action', header: 'Action', mono: true },
          { key: 'resource', header: 'Resource', mono: true, render: (e) => `${e.resourceType}/${e.resourceId}` },
          { key: 'ip', header: 'IP', mono: true, render: (e) => e.ip || '—' },
        ]}
      />
    </div>
  );
}
