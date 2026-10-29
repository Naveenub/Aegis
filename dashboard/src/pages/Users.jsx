import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import DataTable from '../components/DataTable';

const ROLES = ['viewer', 'member', 'admin'];
const field = { padding: '8px 10px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' };
const smallBtn = { background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-dim)', fontSize: 11, padding: '3px 8px', cursor: 'pointer' };

export default function Users() {
  const { apiKey, user: me } = useAuth();
  const tenantId = me.tenantId;
  const [users, setUsers] = useState([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    try {
      const { users } = await api.listUsers(apiKey, tenantId);
      setUsers(users ?? []);
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    }
  }, [apiKey, tenantId]);

  useEffect(() => { load(); }, [load]);

  const run = async (fn, okText) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: okText });
      load();
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    }
  };

  const add = (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    run(async () => {
      await api.createUser(apiKey, tenantId, { email: email.trim(), role });
      setEmail('');
    }, 'User added — they can now sign in with SSO.');
  };

  const isSelf = (u) => me.type === 'user' && u.userId === me.id;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
        Users of <span className="mono" style={{ color: 'var(--text)' }}>{tenantId}</span>. Role and disabled changes apply to active sessions immediately.
      </div>

      <form onSubmit={add} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" style={{ ...field, flex: 1, minWidth: 220, maxWidth: 320 }} />
        <select value={role} onChange={(e) => setRole(e.target.value)} style={field}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <button type="submit" disabled={!email.trim()} style={{ padding: '8px 14px', background: 'var(--accent)', color: '#06110D', border: 'none', borderRadius: 'var(--radius)', fontWeight: 600, cursor: 'pointer' }}>
          Add user
        </button>
      </form>

      {msg && <div style={{ color: msg.ok ? 'var(--accent)' : 'var(--danger)', fontSize: 13 }}>{msg.text}</div>}

      <DataTable
        rows={users}
        keyField="userId"
        emptyLabel="No users yet. Add one above, or enable JIT provisioning in the tenant's SSO config."
        columns={[
          { key: 'email', header: 'Email', mono: true },
          { key: 'name', header: 'Name' },
          {
            key: 'role', header: 'Role',
            render: (u) => (
              <select
                value={u.role}
                disabled={isSelf(u)}
                title={isSelf(u) ? 'You cannot change your own role' : undefined}
                onChange={(e) => run(() => api.updateUser(apiKey, tenantId, u.userId, { role: e.target.value }), `${u.email} is now ${e.target.value}.`)}
                style={{ ...field, padding: '4px 6px', fontSize: 12 }}
              >
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            ),
          },
          { key: 'lastLoginAt', header: 'Last sign-in', mono: true, render: (u) => (u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never') },
          {
            key: 'status', header: 'Status',
            render: (u) => (u.disabledAt ? <span style={{ color: 'var(--danger)' }}>disabled</span> : 'active'),
          },
          {
            key: 'toggle', header: '',
            render: (u) => !isSelf(u) && (
              <button style={smallBtn} onClick={() => run(() => api.updateUser(apiKey, tenantId, u.userId, { disabled: !u.disabledAt }), `${u.email} ${u.disabledAt ? 'enabled' : 'disabled'}.`)}>
                {u.disabledAt ? 'Enable' : 'Disable'}
              </button>
            ),
          },
        ]}
      />
    </div>
  );
}
