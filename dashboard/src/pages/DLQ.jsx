import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useTenant } from '../context/TenantContext';
import DataTable from '../components/DataTable';
import Badge from '../components/Badge';

export default function DLQ() {
  const { apiKey } = useAuth();
  const { tenantId } = useTenant();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api.listDlq(apiKey, { tenantId: tenantId || 'default', limit: 100 })
      .then((r) => setItems(r.items ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [apiKey, tenantId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
        Raw BullMQ dead-letter entries{tenantId ? ` for tenant ${tenantId}` : ' for the default tenant'} — most
        are re-queued or escalated to the review queue within seconds by the DLQ worker; this is an audit trail,
        not a live worklist.
      </div>
      <DataTable
        rows={loading ? [] : items}
        emptyLabel={loading ? 'Loading…' : 'No dead-letter entries.'}
        columns={[
          { key: 'id', header: 'Job', mono: true },
          { key: 'state', header: 'State', render: (r) => <Badge status={r.state} /> },
          { key: 'workflowId', header: 'Workflow', mono: true, render: (r) => r.data?.workflowId ?? '—' },
          { key: 'stepId', header: 'Step', mono: true, render: (r) => r.data?.step?.id ?? '—' },
          { key: 'error', header: 'Error', wrap: true, render: (r) => r.data?.error ?? r.failedReason ?? '—' },
          { key: 'addedAt', header: 'Added', mono: true, render: (r) => new Date(r.addedAt).toLocaleString() },
        ]}
      />
    </div>
  );
}
