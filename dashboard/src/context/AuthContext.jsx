import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { api, ApiError } from '../api/client';

// Holds either an API key or an SSO session token — the API accepts both in
// the same header, so the rest of the app doesn't care which it is.
const STORAGE_KEY = 'aegis.apiKey';
const AuthContext = createContext(null);

const SSO_ERRORS = {
  denied: 'Your account is not allowed to sign in to this tenant.',
  state_mismatch: 'Sign-in could not be verified. Please try again.',
  state_expired: 'Sign-in expired. Please try again.',
  idp_error: 'Sign-in was cancelled or refused by your identity provider.',
};

export function AuthProvider({ children }) {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(STORAGE_KEY) || '');
  const [user, setUser] = useState(null); // { type, id, email?, role, permissions }
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState(null);

  const establish = useCallback(async (credential) => {
    // /auth/me validates the credential and tells us who we are and what we may do.
    const me = await api.me(credential);
    localStorage.setItem(STORAGE_KEY, credential);
    setApiKey(credential);
    setUser(me);
  }, []);

  const login = useCallback(async (key) => {
    setVerifying(true);
    setError(null);
    try {
      await establish(key);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the Aegis API.');
      return false;
    } finally {
      setVerifying(false);
    }
  }, [establish]);

  const logout = useCallback(() => {
    if (apiKey) api.logout(apiKey).catch(() => {}); // ends an SSO session; no-op for API keys
    localStorage.removeItem(STORAGE_KEY);
    setApiKey('');
    setUser(null);
  }, [apiKey]);

  // On load: finish an SSO redirect (#sso_code / #sso_error), else restore who we are.
  useEffect(() => {
    const frag = new URLSearchParams(window.location.hash.slice(1));
    const code = frag.get('sso_code');
    const ssoError = frag.get('sso_error');
    if (code || ssoError) history.replaceState(null, '', window.location.pathname + window.location.search);

    (async () => {
      if (ssoError) { setError(SSO_ERRORS[ssoError] || 'Single sign-on failed.'); return; }
      setVerifying(true);
      try {
        if (code) {
          const { token } = await api.exchangeSsoCode(code);
          await establish(token);
        } else if (apiKey) {
          await establish(apiKey);
        }
      } catch (err) {
        // Expired/revoked credential: drop it and show the login screen.
        localStorage.removeItem(STORAGE_KEY);
        setApiKey('');
        setError(err instanceof ApiError && err.status !== 401 && err.status !== 403 ? err.message : null);
      } finally {
        setVerifying(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const can = useCallback((permission) => !!user?.permissions?.includes(permission), [user]);

  return (
    <AuthContext.Provider value={{ apiKey, user, can, isAuthenticated: !!apiKey && !!user, login, logout, verifying, error }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
