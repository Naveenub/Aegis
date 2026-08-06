import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import DataTable from '../components/DataTable';
import EmptyState from '../components/EmptyState';

export default function Traces() {
  const { apiKey } = useAuth();
  const [traces, setTraces] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    api.listTraces(apiKey, 100).then((r) => setTraces(r.traces ?? [])).catch(() => setTraces([]));
  }, [apiKey]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    api.getTrace(apiKey, selected).then(setDetail).catch(() => setDetail(null));
  }, [apiKey, selected]);

  return (
    <div style={{ display: 'flex', gap: 20 }}>
      <div style={{ flex: 1 }}>
        <DataTable
          rows={traces}
          keyField="traceId"
          onRowClick={(r) => setSelected(r.traceId)}
          emptyLabel="No traces recorded yet."
          columns={[
            { key: 'traceId', header: 'Trace', mono: true },
            { key: 'spans', header: 'Spans', render: (r) => Object.keys(r.spans ?? {}).length },
          ]}
        />
      </div>
      <div style={{ width: 380, flexShrink: 0 }}>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Spans
        </div>
        {!detail ? (
          <EmptyState label="Select a trace to inspect its spans." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {Object.values(detail.spans ?? {}).map((span) => (
              <div key={span.spanId} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '8px 10px', fontSize: 12 }}>
                <div className="mono" style={{ color: 'var(--text)' }}>{span.step}</div>
                <div style={{ color: 'var(--text-faint)', marginTop: 2 }}>
                  {span.agent} · {span.status || 'running'} · {span.endMs ? `${span.endMs - span.startMs}ms` : 'in progress'}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
