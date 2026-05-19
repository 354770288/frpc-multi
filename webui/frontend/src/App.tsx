import { useEffect, useState } from 'react';
import { Login } from './components/Login';
import { Console } from './Console';
import { clearAuth, loadAuth, saveAuth, setAuthToken, setOnUnauthorized } from './lib/auth';
import type { AuthState } from './lib/types';

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(() => {
    const cached = loadAuth();
    if (cached) setAuthToken(cached.token);
    return cached;
  });

  useEffect(() => {
    setOnUnauthorized(() => {
      clearAuth();
      setAuthToken(null);
      setAuth(null);
    });
    return () => {
      setOnUnauthorized(() => {});
    };
  }, []);

  function handleLogin(state: AuthState) {
    saveAuth(state);
    setAuthToken(state.token);
    setAuth(state);
  }

  function handleLogout() {
    clearAuth();
    setAuthToken(null);
    setAuth(null);
  }

  if (!auth) {
    return <Login onSuccess={handleLogin} />;
  }
  return <Console auth={auth} onLogout={handleLogout} onAuthRefresh={handleLogin} />;
}
