import { useSSE } from '../context/SSEContext';

const BARS = 40;

export default function PulseStrip() {
  const { history, connected } = useSSE();

  const maxTotal = Math.max(1, ...history.map((h) => h.total));
  const padded = Array.from({ length: BARS }, (_, i) => {
    const idx = history.length - (BARS - i);
    return idx >= 0 ? history[idx] : null;
  });

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 2,
        height: 28,
        padding: '0 4px',
      }}
      title={connected ? 'Live — 1m step throughput' : 'Disconnected'}
    >
      {padded.map((sample, i) => {
        const h = sample ? Math.max(2, (sample.total / maxTotal) * 24) : 2;
        const hasFailure = sample?.failed > 0;
        return (
          <div
            key={i}
            style={{
              width: 3,
              height: h,
              borderRadius: 1,
              background: !sample
                ? 'var(--border)'
                : hasFailure
                ? 'var(--danger)'
                : 'var(--accent)',
              opacity: sample ? 0.55 + 0.45 * (i / BARS) : 0.3,
              transition: 'height 300ms ease',
            }}
          />
        );
      })}
    </div>
  );
}
