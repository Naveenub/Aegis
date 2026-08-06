import EmptyState from './EmptyState';

/**
 * columns: [{ key, header, render?: (row) => node, mono?: bool }]
 */
export default function DataTable({ columns, rows, keyField = 'id', onRowClick, emptyLabel = 'Nothing here yet.' }) {
  if (!rows || rows.length === 0) {
    return <EmptyState label={emptyLabel} />;
  }

  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'var(--surface-2)' }}>
            {columns.map((col) => (
              <th
                key={col.key}
                style={{
                  textAlign: 'left',
                  padding: '10px 14px',
                  color: 'var(--text-dim)',
                  fontWeight: 500,
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row[keyField]}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              style={{
                borderBottom: '1px solid var(--border)',
                cursor: onRowClick ? 'pointer' : 'default',
                transition: 'background 120ms',
              }}
              onMouseEnter={(e) => { if (onRowClick) e.currentTarget.style.background = 'var(--surface-2)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  style={{
                    padding: '10px 14px',
                    color: 'var(--text)',
                    fontFamily: col.mono ? 'var(--font-mono)' : 'inherit',
                    whiteSpace: col.wrap ? 'normal' : 'nowrap',
                  }}
                >
                  {col.render ? col.render(row) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
