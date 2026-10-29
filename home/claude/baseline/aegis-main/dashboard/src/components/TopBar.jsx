import { useAuth } from '../context/AuthContext';
import { useSSE } from '../context/SSEContext';
import { useTenant } from '../context/TenantContext';
import PulseStrip from './PulseStrip';

export default function TopBar() {
  const { logout } = useAuth();
  const { connected } = useSSE();
  const { tenantId, setTenantId, tenants } = useTenant();

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 20,
        padding: '10px 20px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: connected ? 'var(--accent)' : 'var(--text-faint)',
            boxShadow: connected ? '0 0 6px var(--accent)' : 'none',
          }}
        />
        <span style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
          {connected ? 'LIVE' : 'DISCONNECTED'}
        </span>
      </div>

      <PulseStrip />

      <div style={{ flex: 1 }} />

      <select
        value={tenantId}
        onChange={(e) => setTenantId(e.target.value)}
        style={{
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: '6px 10px',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
        }}
      >
        <option value="">All tenants</option>
        {tenants.map((t) => (
          <option key={t.id ?? t.tenantId} value={t.id ?? t.tenantId}>
            {t.label || t.id || t.tenantId}
          </option>
        ))}
      </select>

      <button
        onClick={logout}
        style={{
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: '6px 12px',
          color: 'var(--text-dim)',
          cursor: 'pointer',
        }}
      >
        Sign out
      </button>
    </div>
  );
}
