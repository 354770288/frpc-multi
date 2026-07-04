import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Login } from './components/Login';
import { ConsoleLayout } from './ConsoleLayout';
import { clearAuth, loadAuth, saveAuth, setAuthToken, setOnUnauthorized } from './lib/auth';
import type { AuthState } from './lib/types';
import { Overview } from './pages/Overview';
import { Detail } from './pages/Detail';
import { CreateInstance } from './pages/CreateInstance';
import { NodesPage } from './pages/NodesPage';
import { AuditLogsPage } from './pages/AuditLogsPage';
import { SystemPage } from './pages/SystemPage';
import { Toaster } from './components/ui/sonner';

function LoginRoute() {
  const [auth, setAuth] = useState<AuthState | null>(() => {
    const cached = loadAuth();
    if (cached) setAuthToken(cached.token);
    return cached;
  });
  const navigate = useNavigate();

  useEffect(() => {
    setOnUnauthorized(() => {
      clearAuth();
      setAuthToken(null);
      setAuth(null);
    });
    return () => { setOnUnauthorized(() => {}); };
  }, []);

  function handleLogin(state: AuthState) {
    saveAuth(state);
    setAuthToken(state.token);
    setAuth(state);
    navigate('/workspace');
  }

  if (auth) {
    return <Navigate to="/workspace" replace />;
  }

  return <Login onSuccess={handleLogin} />;
}

function LogoutRoute() {
  useEffect(() => {
    clearAuth();
    setAuthToken(null);
  }, []);
  return <Navigate to="/login" replace />;
}

function ConsoleRoutes() {
  const [auth, setAuth] = useState<AuthState | null>(() => {
    const cached = loadAuth();
    if (cached) setAuthToken(cached.token);
    return cached;
  });

  if (!auth) return <Navigate to="/login" replace />;

  return (
    <ConsoleLayout auth={auth} onAuthRefresh={(state) => {
      saveAuth(state);
      setAuthToken(state.token);
      setAuth(state);
    }}>
      <Routes>
        <Route index element={<Navigate to="/workspace" replace />} />
        <Route path="workspace" element={<Overview />} />
        <Route path="nodes" element={<NodesPage />} />
        <Route path="create" element={<CreateInstance />} />
        <Route path="instances/:nodeId/:name" element={<Detail />} />
        <Route path="audit" element={<AuditLogsPage />} />
        <Route path="system" element={<SystemPage />} />
      </Routes>
    </ConsoleLayout>
  );
}

export function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginRoute />} />
        <Route path="/logout" element={<LogoutRoute />} />
        <Route path="/*" element={<ConsoleRoutes />} />
      </Routes>
      <Toaster position="top-right" richColors closeButton duration={3500} />
    </>
  );
}
