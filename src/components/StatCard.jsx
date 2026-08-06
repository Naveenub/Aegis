export default function StatCard({ label, value, sub, accent }) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '16px 18px',
        minWidth: 140,
        flex: 1,
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 26,
          fontWeight: 600,
          marginTop: 6,
          color: accent ? 'var(--accent)' : 'var(--text)',
        }}
      >
        {value}
      </div>
      {sub && <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
