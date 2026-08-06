import { useState } from 'react';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { login, verifying, error } = useAuth();
  const [key, setKey] = useState('');

  const submit = (e) => {
    e.preventDefault();
    if (key.trim()) login(key.trim());
  };

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: 340,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: 28,
        }}
      >
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 600, color: 'var(--accent)', marginBottom: 4 }}>
          AEGIS
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 20 }}>
          Enter a tenant API key to connect to the orchestrator.
        </div>

        <label style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          API key
        </label>
        <input
          autoFocus
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="x-api-key"
          style={{
            width: '100%',
            marginTop: 6,
            marginBottom: 14,
            padding: '9px 10px',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            fontFamily: 'var(--font-mono)',
          }}
        />

        {error && (
          <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 14 }}>{error}</div>
        )}

        <button
          type="submit"
          disabled={verifying || !key.trim()}
          style={{
            width: '100%',
            padding: '10px 0',
            background: 'var(--accent)',
            color: '#06110D',
            border: 'none',
            borderRadius: 'var(--radius)',
            fontWeight: 600,
            cursor: verifying ? 'default' : 'pointer',
            opacity: verifying ? 0.7 : 1,
          }}
        >
          {verifying ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    </div>
  );
}
