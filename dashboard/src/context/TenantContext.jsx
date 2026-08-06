import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from './AuthContext';

const TenantContext = createContext(null);

export function TenantProvider({ children }) {
  const { apiKey, isAuthenticated } = useAuth();
  const [tenants, setTenants] = useState([]);
  const [tenantId, setTenantId] = useState('');

  const refresh = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const { tenants } = await api.listTenants(apiKey);
      setTenants(tenants ?? []);
    } catch {
      setTenants([]);
    }
  }, [apiKey, isAuthenticated]);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <TenantContext.Provider value={{ tenants, tenantId, setTenantId, refresh }}>
      {children}
    </TenantContext.Provider>
  );
}

export function useTenant() {
  const ctx = useContext(TenantContext);
  if (!ctx) throw new Error('useTenant must be used within TenantProvider');
  return ctx;
}
