import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from './AuthContext';

const SSEContext = createContext(null);
const HISTORY_LEN = 40;

export function SSEProvider({ children }) {
  const { apiKey, isAuthenticated } = useAuth();
  const [metrics, setMetrics] = useState(null);
  const [workflows, setWorkflows] = useState([]);
  const [connected, setConnected] = useState(false);
  const [history, setHistory] = useState([]); // recent throughput samples for the pulse strip
  const sourceRef = useRef(null);

  useEffect(() => {
    if (!isAuthenticated) return;

    const es = new EventSource(api.eventsUrl(apiKey));
    sourceRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.addEventListener('metrics', (e) => {
      const data = JSON.parse(e.data);
      setMetrics(data);
      setHistory((prev) => {
        // windows['1m'].total is the closest thing to a live throughput
        // signal getMetrics() exposes — no dedicated "active count" field exists.
        const oneMin = data?.windows?.['1m']?.total ?? 0;
        const failed = data?.windows?.['1m']?.failed ?? 0;
        const next = [...prev, { t: Date.now(), total: oneMin, failed }];
        return next.length > HISTORY_LEN ? next.slice(next.length - HISTORY_LEN) : next;
      });
    });

    es.addEventListener('workflows', (e) => {
      setWorkflows(JSON.parse(e.data));
    });

    return () => {
      es.close();
      sourceRef.current = null;
      setConnected(false);
    };
  }, [isAuthenticated, apiKey]);

  return (
    <SSEContext.Provider value={{ metrics, workflows, connected, history }}>
      {children}
    </SSEContext.Provider>
  );
}

export function useSSE() {
  const ctx = useContext(SSEContext);
  if (!ctx) throw new Error('useSSE must be used within SSEProvider');
  return ctx;
}
