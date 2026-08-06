import { createContext, useContext, useState, useCallback } from 'react';
import { api, ApiError } from '../api/client';

const STORAGE_KEY = 'aegis.apiKey';
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(STORAGE_KEY) || '');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState(null);

  const login = useCallback(async (key) => {
    setVerifying(true);
    setError(null);
    try {
      // /tenants requires a valid key and touches no tenant-scoped data,
      // so it doubles as a cheap credential check.
      await api.listTenants(key);
      localStorage.setItem(STORAGE_KEY, key);
      setApiKey(key);
      return true;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not reach the Aegis API.';
      setError(msg);
      return false;
    } finally {
      setVerifying(false);
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setApiKey('');
  }, []);

  return (
    <AuthContext.Provider value={{ apiKey, isAuthenticated: !!apiKey, login, logout, verifying, error }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
