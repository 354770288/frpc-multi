import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Login } from './components/Login';
import { ConsoleLayout } from './ConsoleLayout';
import { clearAuth, loadAuth, saveAuth, setAuthToken, setOnUnauthorized } from './lib/auth';
import type { AuthState } from './lib/types';
import { Toaster } from './components/ui/sonner';
const Overview=lazy(()=>import('./pages/Overview').then((module)=>({default:module.Overview})));
const Detail=lazy(()=>import('./pages/Detail').then((module)=>({default:module.Detail})));
const CreateInstance=lazy(()=>import('./pages/CreateInstance').then((module)=>({default:module.CreateInstance})));
const NodesPage=lazy(()=>import('./pages/NodesPage').then((module)=>({default:module.NodesPage})));
const Probe=lazy(()=>import('./pages/Probe').then((module)=>({default:module.Probe})));
const LbPage=lazy(()=>import('./pages/LbPage').then((module)=>({default:module.LbPage})));
const LbSettingsPage=lazy(()=>import('./pages/LbPage').then((module)=>({default:module.LbSettingsPage})));
const AuditLogsPage=lazy(()=>import('./pages/AuditLogsPage').then((module)=>({default:module.AuditLogsPage})));
const SystemPage=lazy(()=>import('./pages/SystemPage').then((module)=>({default:module.SystemPage})));
const ResourceOverview=lazy(()=>import('./pages/ResourceOverview').then((module)=>({default:module.ResourceOverview})));
const TestCreatePage=lazy(()=>import('./pages/TestCreatePage').then((module)=>({default:module.TestCreatePage})));
const TestNodesPage=lazy(()=>import('./pages/TestNodesPage').then((module)=>({default:module.TestNodesPage})));
const NotFoundPage=lazy(()=>import('./pages/NotFoundPage').then((module)=>({default:module.NotFoundPage})));
const ResultsPage=lazy(()=>import('./pages/ResultsPage').then((module)=>({default:module.ResultsPage})));

function LegacyProbeRedirect() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const tab = params.get('tab');
  params.delete('tab');
  const target = tab === 'test' ? (params.has('group') ? '/tests/new' : '/tests') :
    tab === 'servers' ? '/servers' : tab === 'history' ? '/results' : '/discovery';
  return <Navigate to={`${target}${params.size ? `?${params.toString()}` : ''}`} replace />;
}
function LegacyCreateRedirect() {
  const {search}=useLocation();
  return <Navigate to={`/instances/new${search}`} replace />;
}

function LoginRoute() {
  const [auth, setAuth] = useState<AuthState | null>(() => {
    const cached = loadAuth();
    if (cached) setAuthToken(cached.token);
    return cached;
  });
  const navigate = useNavigate();
  const location = useLocation();
  const next = new URLSearchParams(location.search).get('next');
  const destination = next?.startsWith('/') && !next.startsWith('//') && !next.startsWith('/logout') && !next.startsWith('/login') ? next : '/workspace';

  function handleLogin(state: AuthState) {
    saveAuth(state);
    setAuthToken(state.token);
    setAuth(state);
    navigate(destination, { replace: true });
  }

  if (auth) {
    return <Navigate to={destination} replace />;
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

  const location = useLocation();
  if (!auth) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;

  return (
    <ConsoleLayout auth={auth} onAuthRefresh={(state) => {
      saveAuth(state);
      setAuthToken(state.token);
      setAuth(state);
    }}>
      <Suspense fallback={<div role="status" className="p-6 text-sm text-muted-foreground">页面加载中…</div>}><Routes>
        <Route index element={<Navigate to="/workspace" replace />} />
        <Route path="workspace" element={<ResourceOverview />} />
        <Route path="instances" element={<Overview />} />
        <Route path="instances/new" element={<CreateInstance />} />
        <Route path="nodes" element={<NodesPage />} />
        <Route path="test-nodes" element={<TestNodesPage />} />
        <Route path="discovery" element={<Probe section="discover" />} />
        <Route path="servers" element={<Probe section="servers" />} />
        <Route path="tests/new" element={<TestCreatePage />} />
        <Route path="tests" element={<Probe section="test" />} />
        <Route path="tests/:jobId" element={<Probe section="test" />} />
        <Route path="results" element={<ResultsPage />} />
        <Route path="probe" element={<LegacyProbeRedirect />} />
        <Route path="lb" element={<LbPage />} />
        <Route path="lb/settings" element={<LbSettingsPage />} />
        <Route path="lb/:domainId" element={<LbPage />} />
        <Route path="create" element={<LegacyCreateRedirect />} />
        <Route path="instances/:nodeId/:name" element={<Detail />} />
        <Route path="audit" element={<AuditLogsPage />} />
        <Route path="system" element={<SystemPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes></Suspense>
    </ConsoleLayout>
  );
}

export function App() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // 任何 API 401：清除本地凭据并回登录页。注册在顶层，登录页/工作台/子页面都覆盖。
    setOnUnauthorized(() => {
      clearAuth();
      setAuthToken(null);
      navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
    });
    return () => { setOnUnauthorized(() => {}); };
  }, [navigate, location.pathname, location.search]);

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
