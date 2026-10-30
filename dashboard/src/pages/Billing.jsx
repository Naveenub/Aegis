import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useTenant } from '../context/TenantContext';
import StatCard from '../components/StatCard';
import DataTable from '../components/DataTable';

const EVENT_LABELS = {
  workflow_run: 'Workflow runs',
  agent_step: 'Agent steps',
  tokens_in: 'Input tokens',
  tokens_out: 'Output tokens',
  sandbox_minutes: 'Sandbox minutes',
};

const fmt = (n) => (n === null || n === undefined ? '∞' : Number(n).toLocaleString());

export default function Billing() {
  const { apiKey, can } = useAuth();
  const { tenants, tenantId, setTenantId } = useTenant();
  const [billing, setBilling] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [portalError, setPortalError] = useState(null);

  // The billing endpoint needs an explicit tenant; fall back to the default tenant.
  const activeTenant = tenantId || 'default';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBilling(await api.getBilling(apiKey, activeTenant));
    } catch (err) {
      setBilling(null);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [apiKey, activeTenant]);

  useEffect(() => { load(); }, [load]);

  const openPortal = async () => {
    setOpening(true);
    setPortalError(null);
    try {
      // The portal is scoped to the tenant the API key belongs to, not the
      // tenant selected above.
      const { url } = await api.createPortalSession(apiKey);
      window.location.assign(url);
    } catch (err) {
      setPortalError(err.message);
      setOpening(false);
    }
  };

  const rows = (billing?.usage ?? []).map((u) => ({ ...u, id: u.eventType }));
  const totalOverage = rows.reduce((sum, u) => sum + (u.overage || 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
          style={{ padding: '8px 10px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text)' }}
        >
          <option value="">default</option>
          {tenants.map((t) => {
            const id = t.id ?? t.tenantId;
            return <option key={id} value={id}>{id}</option>;
          })}
        </select>
        <div style={{ flex: 1 }} />
        {can('tenant.admin') && (
          <button
            onClick={openPortal}
            disabled={opening}
            style={{ padding: '8px 14px', background: 'var(--accent)', color: '#06110D', border: 'none', borderRadius: 'var(--radius)', fontWeight: 600, cursor: opening ? 'default' : 'pointer', opacity: opening ? 0.6 : 1 }}
          >
            {opening ? 'Opening…' : 'Manage billing'}
          </button>
        )}
      </div>

      {portalError && (
        <div style={{ border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: 'var(--radius)', padding: 10, fontSize: 13 }}>
          {portalError}
        </div>
      )}

      {error && (
        <div style={{ border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: 'var(--radius)', padding: 10, fontSize: 13 }}>
          {error}
        </div>
      )}

      {billing && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <StatCard label="Tier" value={billing.tier} accent />
            <StatCard
              label="Overage this period"
              value={fmt(totalOverage)}
              sub="units above included allowance"
            />
          </div>

          <DataTable
            rows={rows}
            keyField="id"
            emptyLabel={loading ? 'Loading…' : 'No usage recorded.'}
            columns={[
              { key: 'eventType', header: 'Metric', render: (r) => EVENT_LABELS[r.eventType] ?? r.eventType },
              { key: 'used', header: 'Used', mono: true, render: (r) => fmt(r.used) },
              { key: 'included', header: 'Included', mono: true, render: (r) => fmt(r.included) },
              {
                key: 'overage',
                header: 'Overage',
                mono: true,
                render: (r) => (
                  <span style={{ color: r.overage > 0 ? 'var(--warn)' : 'var(--text-dim)' }}>{fmt(r.overage)}</span>
                ),
              },
            ]}
          />
        </>
      )}
    </div>
  );
}
