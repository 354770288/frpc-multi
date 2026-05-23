import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { ToastStack } from './components/ToastStack';
import { Overview } from './pages/Overview';
import { Detail } from './pages/Detail';
import { ConfigEditor } from './pages/ConfigEditor';
import { CreateInstance } from './pages/CreateInstance';
import { SystemPage } from './pages/SystemPage';
import { api } from './lib/api';
import { actionLabel } from './lib/format';
import type {
  AuthState,
  Instance,
  Page,
  StatsMap,
  StatsResponse,
  SystemInfo,
  Toast,
  ToastKind
} from './lib/types';

export function Console({
  auth,
  onLogout,
  onAuthRefresh
}: {
  auth: AuthState;
  onLogout: () => void;
  onAuthRefresh: (state: AuthState) => void;
}) {
  const [page, setPage] = useState<Page>('overview');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [stats, setStats] = useState<StatsMap>({});
  const [dockerAvailable, setDockerAvailable] = useState(false);
  const [dockerError, setDockerError] = useState('');
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [selected, setSelected] = useState('');
  const [pendingAction, setPendingAction] = useState<Record<string, string>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);

  const closeToast = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((kind: ToastKind, text: string) => {
    const id = ++toastIdRef.current;
    setToasts((list) => [...list, { id, kind, text }]);
    window.setTimeout(
      () => {
        setToasts((list) => list.filter((t) => t.id !== id));
      },
      kind === 'error' ? 6000 : 3500
    );
  }, []);

  async function loadInstances() {
    const data = await api<Instance[]>('/api/instances').catch(() => []);
    setInstances(data);
    if (!selected && data[0]) setSelected(data[0].name);
  }

  async function loadStats() {
    try {
      const data = await api<StatsResponse>('/api/stats');
      setStats(data.containers || {});
      setDockerAvailable(!!data.available);
      setDockerError(data.error || '');
    } catch {
      setStats({});
      setDockerAvailable(false);
      setDockerError('无法访问 /api/stats');
    }
  }

  async function loadSystem() {
    const data = await api<SystemInfo>('/api/system').catch(() => null);
    setSystem(data);
  }

  async function refreshAll() {
    await Promise.all([loadInstances(), loadStats(), loadSystem()]);
  }

  useEffect(() => {
    refreshAll();
    const timer = window.setInterval(loadStats, 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const action = useCallback(
    async (name: string, verb: string) => {
      setPendingAction((prev) => ({ ...prev, [name]: verb }));
      try {
        await api(`/api/instances/${name}/${verb}`, { method: 'POST' });
        toast('success', `${name} ${actionLabel(verb)}成功`);
        await Promise.all([loadInstances(), loadStats()]);
      } catch (err) {
        toast(
          'error',
          `${name} ${actionLabel(verb)}失败：${err instanceof Error ? err.message : '未知错误'}`
        );
      } finally {
        setPendingAction((prev) => {
          const next = { ...prev };
          delete next[name];
          return next;
        });
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [toast]
  );

  const deleteInstance = useCallback(
    async (name: string) => {
      if (!window.confirm(`确认删除实例 ${name}？该操作会停止容器、删除 instances/${name} 整个目录，且不可撤销。`))
        return;
      setPendingAction((prev) => ({ ...prev, [name]: 'delete' }));
      try {
        await api(`/api/instances/${name}`, { method: 'DELETE' });
        toast('success', `${name} 已删除`);
        if (selected === name) setSelected('');
        await refreshAll();
      } catch (err) {
        toast('error', `${name} 删除失败：${err instanceof Error ? err.message : '未知错误'}`);
      } finally {
        setPendingAction((prev) => {
          const next = { ...prev };
          delete next[name];
          return next;
        });
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [toast, selected]
  );

  const body = useMemo(() => {
    if (page === 'overview')
      return (
        <Overview
          instances={instances}
          stats={stats}
          dockerAvailable={dockerAvailable}
          dockerError={dockerError}
          system={system}
          pendingAction={pendingAction}
          onSelect={setSelected}
          onPage={setPage}
          onAction={action}
          onDelete={deleteInstance}
        />
      );
    if (page === 'detail')
      return (
        <Detail
          name={selected}
          stats={stats}
          pendingAction={pendingAction}
          onPage={setPage}
          onAction={action}
        />
      );
    if (page === 'config') return <ConfigEditor name={selected} toast={toast} />;
    if (page === 'create')
      return (
        <CreateInstance
          toast={toast}
          onCreated={(name) => {
            setSelected(name);
            setPage('overview');
            refreshAll();
          }}
          onCancel={() => setPage('overview')}
        />
      );
    return <SystemPage system={system} toast={toast} onPasswordChanged={onAuthRefresh} />;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, instances, stats, dockerAvailable, dockerError, system, selected, pendingAction]);

  const pageTitle =
    page === 'overview'
      ? '总览'
      : page === 'create'
        ? '创建实例'
        : page === 'config'
          ? '配置'
          : page === 'detail'
            ? '实例详情'
            : '系统';

  return (
    <div className="flex min-h-screen">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-3 focus:py-1.5 focus:rounded-md focus:bg-[var(--color-accent)] focus:text-white focus:text-[12px] focus:font-medium focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-white"
      >
        跳到主内容
      </a>
      <Sidebar
        page={page}
        onPage={setPage}
        system={system}
        collapsed={sidebarCollapsed}
      />
      <div className="flex-1 min-w-0 flex flex-col">
        <Topbar
          pageTitle={pageTitle}
          username={auth.username}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
          onRefresh={refreshAll}
          onLogout={onLogout}
          onOpenSystem={() => setPage('system')}
        />
        <div id="main-content" tabIndex={-1} className="flex-1 min-w-0 outline-none">
          {body}
        </div>
      </div>
      <ToastStack toasts={toasts} onClose={closeToast} />
    </div>
  );
}
