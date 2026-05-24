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
  InstanceStats,
  Page,
  StatsMap,
  SummaryResponse,
  SystemInfo,
  Toast,
  ToastKind
} from './lib/types';

type SummaryCounts = {
  total: number;
  running: number;
  stopped: number;
  error: number;
};

const EMPTY_COUNTS: SummaryCounts = { total: 0, running: 0, stopped: 0, error: 0 };

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
  const [counts, setCounts] = useState<SummaryCounts>(EMPTY_COUNTS);
  const [dockerAvailable, setDockerAvailable] = useState(false);
  const [dockerError, setDockerError] = useState('');
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [selected, setSelected] = useState('');
  const [pendingAction, setPendingAction] = useState<Record<string, string>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  const selectedRef = useRef('');
  selectedRef.current = selected;

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

  async function loadSummary() {
    try {
      const data = await api<SummaryResponse>('/api/summary');
      const list: Instance[] = [];
      const statMap: StatsMap = {};
      for (const item of data.instances) {
        const { runtime, ...rest } = item;
        list.push(rest);
        if (runtime && Object.keys(runtime).length) {
          statMap[item.name] = runtime as InstanceStats;
        }
      }
      setInstances(list);
      setStats(statMap);
      setCounts({
        total: data.total,
        running: data.running,
        stopped: data.stopped,
        error: data.error
      });
      setDockerAvailable(!!data.dockerAvailable);
      setDockerError(data.dockerError || '');
      if (!selectedRef.current && list[0]) setSelected(list[0].name);
    } catch {
      setInstances([]);
      setStats({});
      setCounts(EMPTY_COUNTS);
      setDockerAvailable(false);
      setDockerError('无法访问 /api/summary');
    }
  }

  async function loadSystem() {
    const data = await api<SystemInfo>('/api/system').catch(() => null);
    setSystem(data);
  }

  async function refreshAll() {
    await Promise.all([loadSummary(), loadSystem()]);
  }

  useEffect(() => {
    refreshAll();
    const timer = window.setInterval(loadSummary, 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const action = useCallback(
    async (name: string, verb: string) => {
      setPendingAction((prev) => ({ ...prev, [name]: verb }));
      try {
        await api(`/api/instances/${name}/${verb}`, { method: 'POST' });
        toast('success', `${name} ${actionLabel(verb)}成功`);
        await loadSummary();
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

  const patchInstance = useCallback(
    async (
      name: string,
      patch: { displayName?: string; description?: string; enabled?: boolean; applyImmediately?: boolean }
    ) => {
      const key = patch.enabled !== undefined ? 'toggle' : 'patch';
      setPendingAction((prev) => ({ ...prev, [name]: key }));
      try {
        await api(`/api/instances/${name}`, {
          method: 'PATCH',
          body: JSON.stringify(patch)
        });
        if (patch.enabled !== undefined) {
          toast('success', `${name} 已${patch.enabled ? '启用' : '停用'}`);
        } else {
          toast('success', `${name} 已更新`);
        }
        await loadSummary();
      } catch (err) {
        toast(
          'error',
          `${name} 更新失败：${err instanceof Error ? err.message : '未知错误'}`
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
          counts={counts}
          dockerAvailable={dockerAvailable}
          dockerError={dockerError}
          system={system}
          pendingAction={pendingAction}
          onSelect={setSelected}
          onPage={setPage}
          onAction={action}
          onPatch={patchInstance}
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
          instances={instances}
          onCreated={(name) => {
            setSelected(name);
            setPage('overview');
            refreshAll();
          }}
          onCancel={() => setPage('overview')}
        />
      );
    return <SystemPage auth={auth} system={system} toast={toast} onPasswordChanged={onAuthRefresh} />;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, instances, stats, counts, dockerAvailable, dockerError, system, selected, pendingAction]);

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
