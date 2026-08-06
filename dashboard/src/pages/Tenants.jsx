import { useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useTenant } from '../context/TenantContext';
import DataTable from '../components/DataTable';

export default function Tenants() {
  const { apiKey } = useAuth();
  const { tenants, refresh } = useTenant();
  const [newTenantId, setNewTenantId] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [keys, setKeys] = useState([]);
  const [newRawKey, setNewRawKey] = useState(null);

  const createTenant = async (e) => {
    e.preventDefault();
    if (!newTenantId.trim()) return;
    await api.createTenant(apiKey, { tenantId: newTenantId.trim() });
    setNewTenantId('');
    refresh();
  };

  const openTenant = async (row) => {
    const id = row.id ?? row.tenantId;
    setExpanded(id);
    setNewRawKey(null);
    const { keys } = await api.listKeys(apiKey, id);
    setKeys(keys ?? []);
  };

  const createKey = async () => {
    const res = await api.createKey(apiKey, expanded, { label: 'dashboard-generated' });
    setNewRawKey(res.rawKey);
    const { keys } = await api.listKeys(apiKey, expanded);
    setKeys(keys ?? []);
  };

  const revoke = async (keyId) => {
    await api.revokeKey(apiKey, expanded, keyId);
    const { keys } = await api.listKeys(apiKey, expanded);
    setKeys(keys ?? []);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <form onSubmit={createTenant} style={{ display: 'flex', gap: 8 }}>
        <input
          value={newTenantId}
          onChange={(e) => setNewTenantId(e.target.value)}
          placeholder="New tenant id"
          style={{ flex: 1, maxWidth: 280, padding: '8px 10px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}
        />
        <button type="submit" style={{ padding: '8px 14px', background: 'var(--accent)', color: '#06110D', border: 'none', borderRadius: 'var(--radius)', fontWeight: 600, cursor: 'pointer' }}>
          Register tenant
        </button>
      </form>

      <DataTable
        rows={tenants}
        keyField="id"
        onRowClick={openTenant}
        emptyLabel="No tenants registered."
        columns={[
          { key: 'id', header: 'Tenant', mono: true, render: (r) => r.id ?? r.tenantId },
          { key: 'label', header: 'Label' },
        ]}
      />

      {expanded && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span className="mono" style={{ fontWeight: 600 }}>{expanded} — API keys</span>
            <button onClick={createKey} style={{ padding: '6px 12px', background: 'var(--accent)', color: '#06110D', border: 'none', borderRadius: 'var(--radius)', fontWeight: 600, cursor: 'pointer', fontSize: 12 }}>
              New key
            </button>
          </div>

          {newRawKey && (
            <div style={{ background: 'var(--surface-2)', border: '1px solid var(--accent)', borderRadius: 'var(--radius)', padding: 10, marginBottom: 12, fontSize: 12 }}>
              <div style={{ color: 'var(--warn)', marginBottom: 4 }}>Save this now — it will not be shown again:</div>
              <div className="mono" style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>{newRawKey}</div>
            </div>
          )}

          <DataTable
            rows={keys}
            keyField="keyId"
            emptyLabel="No keys issued for this tenant."
            columns={[
              { key: 'keyId', header: 'Key ID', mono: true },
              { key: 'label', header: 'Label' },
              { key: 'createdAt', header: 'Created', mono: true, render: (r) => new Date(r.createdAt).toLocaleDateString() },
              {
                key: 'revoke',
                header: '',
                render: (r) => (
                  <button
                    onClick={(e) => { e.stopPropagation(); revoke(r.keyId); }}
                    style={{ background: 'none', border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: 'var(--radius)', fontSize: 11, padding: '3px 8px', cursor: 'pointer' }}
                  >
                    Revoke
                  </button>
                ),
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}
