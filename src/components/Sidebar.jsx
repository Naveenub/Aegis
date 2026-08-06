import { NavLink } from 'react-router-dom';

const LINKS = [
  { to: '/', label: 'Overview', end: true },
  { to: '/workflows', label: 'Workflows' },
  { to: '/review-queue', label: 'Review queue' },
  { to: '/dlq', label: 'Dead letters' },
  { to: '/traces', label: 'Traces' },
  { to: '/anomalies', label: 'Anomalies' },
  { to: '/tenants', label: 'Tenants & keys' },
];

export default function Sidebar() {
  return (
    <div
      style={{
        width: 200,
        flexShrink: 0,
        borderRight: '1px solid var(--border)',
        background: 'var(--surface)',
        padding: '18px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 15,
          fontWeight: 600,
          color: 'var(--accent)',
          padding: '0 10px 18px',
          letterSpacing: '0.02em',
        }}
      >
        AEGIS
      </div>
      {LINKS.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          end={link.end}
          style={({ isActive }) => ({
            padding: '8px 10px',
            borderRadius: 'var(--radius)',
            color: isActive ? 'var(--text)' : 'var(--text-dim)',
            background: isActive ? 'var(--surface-2)' : 'transparent',
            fontSize: 13,
            fontWeight: isActive ? 600 : 400,
          })}
        >
          {link.label}
        </NavLink>
      ))}
    </div>
  );
}
