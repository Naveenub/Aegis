export default function EmptyState({ label }) {
  return (
    <div
      style={{
        border: '1px dashed var(--border)',
        borderRadius: 'var(--radius)',
        padding: '32px 16px',
        textAlign: 'center',
        color: 'var(--text-faint)',
        fontSize: 13,
      }}
    >
      {label}
    </div>
  );
}
