import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import DataTable from '../components/DataTable';
import Badge from '../components/Badge';

export default function Anomalies() {
  const { apiKey } = useAuth();
  const [anomalies, setAnomalies] = useState([]);

  useEffect(() => {
    api.getAnomalies(apiKey, 100).then((r) => setAnomalies(r.anomalies ?? [])).catch(() => setAnomalies([]));
  }, [apiKey]);

  return (
    <DataTable
      rows={anomalies}
      keyField="firedAt"
      emptyLabel="No anomalies detected."
      columns={[
        { key: 'severity', header: 'Severity', render: (r) => <Badge status={r.severity} /> },
        { key: 'ruleId', header: 'Rule', mono: true },
        { key: 'summary', header: 'Summary', wrap: true },
        { key: 'source', header: 'Source', mono: true },
        { key: 'firedAtIso', header: 'Fired', mono: true, render: (r) => new Date(r.firedAtIso ?? r.firedAt).toLocaleString() },
      ]}
    />
  );
}
