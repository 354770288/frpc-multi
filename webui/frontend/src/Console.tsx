import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { ToastStack } from './components/ToastStack';
import { Overview } from './pages/Overview';
import { Detail } from './pages/Detail';
import { ConfigEditor } from './pages/ConfigEditor';
import { CreateInstance } from './pages/CreateInstance';
import { NodesPage } from './pages/NodesPage';
import { AuditLogsPage } from './pages/AuditLogsPage';
import { SystemPage } from './pages/SystemPage';
import { api, nodesApi } from './lib/api';
import { actionLabel } from './lib/format';
import type {
  AuthState,
  InstanceRef,
  InstanceStats,
  Node,
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
  const [nodes, setNodes] = useState<Node[]>([]);
  const [instances, setInstances] = useState<InstanceRef[]>([]);
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

  function instanceKey(nodeId: number, name: string) {
    return `${nodeId}:${name}`;
  }

  function selectedInstance() {
    return instances.find((item) => instanceKey(item.nodeId, item.name) === selected) || null;
  }

  async function loadSummary() {
    try {
      const [nodeList, data] = await Promise.all([
        nodesApi.list(),
        api<SummaryResponse>('/api/summary')
      ]);
      const summaryByNodeId = new Map((data.nodes || []).map((node) => [node.id, node]));
      setNodes(
        nodeList.map((node) => {
          const summary = summaryByNodeId.get(node.id);
          return summary
            ? { ...node, status: summary.status, lastSeenAt: summary.lastSeenAt }
            : node;
        })
      );

      const list: InstanceRef[] = [];
      const statMap: StatsMap = {};
      for (const item of data.instances) {
        const { runtime, nodeId, nodeName, ...rest } = item;
        const resolvedNodeId = typeof nodeId === 'number' ? nodeId : 0;
        list.push({ ...rest, nodeId: resolvedNodeId, nodeName: nodeName || '本机' });
        if (runtime && Object.keys(runtime).length) {
          statMap[instanceKey(resolvedNodeId, item.name)] = runtime as InstanceStats;
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
      const currentStillExists = list.some(
        (item) => instanceKey(item.nodeId, item.name) === selectedRef.current
      );
      if (!currentStillExists) setSelected(list[0] ? instanceKey(list[0].nodeId, list[0].name) : '');
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
    async (item: InstanceRef, verb: string) => {
      const key = instanceKey(item.nodeId, item.name);
      setPendingAction((prev) => ({ ...prev, [key]: verb }));
      try {
        if (item.nodeId > 0) await nodesApi.instances.action(item.nodeId, item.name, verb);
        else await api(`/api/instances/${item.name}/${verb}`, { method: 'POST' });
        toast('success', `${item.name} ${actionLabel(verb)}成功`);
        await loadSummary();
      } catch (err) {
        toast(
          'error',
          `${item.name} ${actionLabel(verb)}失败：${err instanceof Error ? err.message : '未知错误'}`
        );
      } finally {
        setPendingAction((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [toast]
  );

  const patchInstance = useCallback(
    async (
      item: InstanceRef,
      patch: { displayName?: string; description?: string; enabled?: boolean; applyImmediately?: boolean }
    ) => {
      const key = patch.enabled !== undefined ? 'toggle' : 'patch';
      const pendingKey = instanceKey(item.nodeId, item.name);
      setPendingAction((prev) => ({ ...prev, [pendingKey]: key }));
      try {
        if (item.nodeId > 0) await nodesApi.instances.patch(item.nodeId, item.name, patch);
        else {
          await api(`/api/instances/${item.name}`, {
            method: 'PATCH',
            body: JSON.stringify(patch)
          });
        }
        if (patch.enabled !== undefined) {
          toast('success', `${item.name} 已${patch.enabled ? '启用' : '停用'}`);
        } else {
          toast('success', `${item.name} 已更新`);
        }
        await loadSummary();
      } catch (err) {
        toast(
          'error',
          `${item.name} 更新失败：${err instanceof Error ? err.message : '未知错误'}`
        );
      } finally {
        setPendingAction((prev) => {
          const next = { ...prev };
          delete next[pendingKey];
          return next;
        });
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [toast]
  );

  const deleteInstance = useCallback(
    async (item: InstanceRef) => {
      const key = instanceKey(item.nodeId, item.name);
      if (!window.confirm(`确认删除实例 ${item.name}？该操作会停止容器、删除实例目录，且不可撤销。`))
        return;
      setPendingAction((prev) => ({ ...prev, [key]: 'delete' }));
      try {
        if (item.nodeId > 0) await nodesApi.instances.delete(item.nodeId, item.name);
        else await api(`/api/instances/${item.name}`, { method: 'DELETE' });
        toast('success', `${item.name} 已删除`);
        if (selected === key) setSelected('');
        await refreshAll();
      } catch (err) {
        toast('error', `${item.name} 删除失败：${err instanceof Error ? err.message : '未知错误'}`);
      } finally {
        setPendingAction((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [toast, selected]
  );

  const body = useMemo(() => {
    const current = selectedInstance();
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
          onSelect={(item) => setSelected(instanceKey(item.nodeId, item.name))}
          onPage={setPage}
          onAction={action}
          onPatch={patchInstance}
          onDelete={deleteInstance}
        />
      );
    if (page === 'nodes') return <NodesPage toast={toast} onChanged={refreshAll} />;
    if (page === 'audit') return <AuditLogsPage nodes={nodes} toast={toast} />;
    if (page === 'detail')
      return (
        <Detail
          instance={current}
          stats={stats}
          pendingAction={pendingAction}
          onPage={setPage}
          onAction={action}
        />
      );
    if (page === 'config') return <ConfigEditor instance={current} toast={toast} />;
    if (page === 'create')
      return (
        <CreateInstance
          toast={toast}
          instances={instances}
          nodes={nodes}
          onCreated={(name, nodeId) => {
            setSelected(instanceKey(nodeId, name));
            setPage('overview');
            refreshAll();
          }}
          onCancel={() => setPage('overview')}
        />
      );
    return <SystemPage auth={auth} system={system} toast={toast} onPasswordChanged={onAuthRefresh} />;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, instances, nodes, stats, counts, dockerAvailable, dockerError, system, selected, pendingAction]);

  const pageTitle =
    page === 'overview'
      ? '总览'
      : page === 'nodes'
        ? '节点'
        : page === 'audit'
          ? '审计日志'
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
