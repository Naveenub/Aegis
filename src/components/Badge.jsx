const COLORS = {
  running: 'var(--info)',
  submitted: 'var(--info)',
  pending: 'var(--text-dim)',
  waiting: 'var(--text-dim)',
  paused: 'var(--warn)',
  'needs-review': 'var(--warn)',
  delayed: 'var(--warn)',
  completed: 'var(--accent)',
  success: 'var(--accent)',
  approved: 'var(--accent)',
  retrying: 'var(--warn)',
  failed: 'var(--danger)',
  cancelled: 'var(--text-faint)',
  skip: 'var(--text-faint)',
  escalate: 'var(--danger)',
};

export default function Badge({ status }) {
  const color = COLORS[status] || 'var(--text-dim)';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        color,
        textTransform: 'uppercase',
        letterSpacing: '0.03em',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {status}
    </span>
  );
}
