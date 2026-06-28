import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ShieldAlert, Trash2 } from 'lucide-react';
import { Topbar } from './components/Topbar';
import { ToastStack } from './components/ToastStack';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Overview } from './pages/Overview';
import { Detail, type DetailTab } from './pages/Detail';
import { ConfigEditor } from './pages/ConfigEditor';
import { CreateInstance } from './pages/CreateInstance';
import { NodesPage } from './pages/NodesPage';
import { AuditLogsPage } from './pages/AuditLogsPage';
import { SystemPage } from './pages/SystemPage';
import { api, auditLogsApi, nodesApi } from './lib/api';
import { actionLabel, instanceStateBadge } from './lib/format';
import type {
  AuditLog,
  AuthState,
  ConsoleInfo,
  InstanceRef,
  InstanceStats,
  Node,
  NodeInstanceHealth,
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

type NodeSystemSnapshot = Record<number, { info: SystemInfo | null; error: string | null }>;

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
  const [nodes, setNodes] = useState<Node[]>([]);
  const [instances, setInstances] = useState<InstanceRef[]>([]);
  const [stats, setStats] = useState<StatsMap>({});
  const [counts, setCounts] = useState<SummaryCounts>(EMPTY_COUNTS);
  const [dockerAvailable, setDockerAvailable] = useState(false);
  const [dockerError, setDockerError] = useState('');
  const [system, setSystem] = useState<ConsoleInfo | null>(null);
  const [selected, setSelected] = useState('');
  const [detailInitialTab, setDetailInitialTab] = useState<DetailTab>('logs');
  const [workspaceNodeId, setWorkspaceNodeId] = useState<number | 'all'>('all');
  const [workspaceSearch, setWorkspaceSearch] = useState('');
  const [deleteCandidate, setDeleteCandidate] = useState<InstanceRef | null>(null);
  const [pendingAction, setPendingAction] = useState<Record<string, string>>({});
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [nodeSystems, setNodeSystems] = useState<NodeSystemSnapshot>({});
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

  function openPage(next: Page) {
    if (next === 'detail') setDetailInitialTab('logs');
    if (next === 'config') {
      setDetailInitialTab('config');
      setPage('detail');
      return;
    }
    setPage(next);
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
            ? {
                ...node,
                status: summary.status,
                online: summary.status === 'online',
                lastSeenAt: summary.lastSeenAt
              }
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
    const data = await api<ConsoleInfo>('/api/console-info').catch(() => null);
    setSystem(data);
  }

  async function loadAuditLogs() {
    const data = await auditLogsApi.list(200).catch(() => []);
    setAuditLogs(data);
  }

  async function refreshAll() {
    await Promise.all([loadSummary(), loadSystem(), loadAuditLogs()]);
  }

  useEffect(() => {
    refreshAll();
    const timer = window.setInterval(loadSummary, 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nodeSystemKey = useMemo(
    () => nodes.map((node) => `${node.id}:${node.online || node.status === 'online'}`).join('|'),
    [nodes]
  );

  useEffect(() => {
    if (!nodes.length) {
      setNodeSystems({});
      return;
    }
    let cancelled = false;
    async function loadNodeSystems() {
      const entries = await Promise.all(
        nodes.map(async (node) => {
          if (!(node.online || node.status === 'online')) {
            return [node.id, { info: null, error: '节点未在线' }] as const;
          }
          try {
            return [node.id, { info: await nodesApi.system(node.id), error: null }] as const;
          } catch (err) {
            return [
              node.id,
              { info: null, error: err instanceof Error ? err.message : '节点系统信息不可达' }
            ] as const;
          }
        })
      );
      if (!cancelled) setNodeSystems(Object.fromEntries(entries));
    }
    loadNodeSystems();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeSystemKey]);

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
      setPendingAction((prev) => ({ ...prev, [key]: 'delete' }));
      try {
        if (item.nodeId > 0) await nodesApi.instances.delete(item.nodeId, item.name);
        else await api(`/api/instances/${item.name}`, { method: 'DELETE' });
        toast('success', `${item.name} 已删除`);
        if (selected === key) setSelected('');
        setDeleteCandidate(null);
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

  const nodeHealthById = useMemo<Record<number, NodeInstanceHealth>>(() => {
    const byNode: Record<number, NodeInstanceHealth> = {};
    for (const item of instances) {
      if (!byNode[item.nodeId]) {
        byNode[item.nodeId] = { total: 0, running: 0, stopped: 0, error: 0, disabled: 0 };
      }
      const health = byNode[item.nodeId];
      const badge = instanceStateBadge(stats[instanceKey(item.nodeId, item.name)], item.enabled);
      health.total += 1;
      if (!item.enabled) health.disabled += 1;
      if (badge.tone === 'success') health.running += 1;
      else if (badge.tone === 'danger') health.error += 1;
      else health.stopped += 1;
    }
    return byNode;
  }, [instances, stats]);

  const body = useMemo(() => {
    const current = selectedInstance();
    if (page === 'overview')
      return (
        <Overview
          nodes={nodes}
          selectedNodeId={workspaceNodeId}
          instanceKeyword={workspaceSearch}
          instances={instances}
          stats={stats}
          counts={counts}
          dockerAvailable={dockerAvailable}
          dockerError={dockerError}
          system={system}
          pendingAction={pendingAction}
          onSelect={(item) => setSelected(instanceKey(item.nodeId, item.name))}
          onSelectedNodeChange={setWorkspaceNodeId}
          onInstanceKeywordChange={setWorkspaceSearch}
          onPage={openPage}
          onAction={action}
          onPatch={patchInstance}
          onDelete={setDeleteCandidate}
        />
      );
    if (page === 'nodes')
      return (
        <NodesPage
          toast={toast}
          onChanged={refreshAll}
          nodeHealthById={nodeHealthById}
          nodeSystems={nodeSystems}
        />
      );
    if (page === 'audit')
      return (
        <AuditLogsPage
          nodes={nodes}
          toast={toast}
          initialLogs={auditLogs}
          onLogsLoaded={setAuditLogs}
          onOpenInstance={(nodeId, name) => {
            setSelected(instanceKey(nodeId, name));
            setPage('detail');
          }}
          onOpenNode={(nodeId) => {
            setWorkspaceNodeId(nodeId);
            setPage('nodes');
          }}
        />
      );
    if (page === 'detail')
      return (
        <Detail
          instance={current}
          stats={stats}
          pendingAction={pendingAction}
          toast={toast}
          initialTab={detailInitialTab}
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
          initialNodeId={workspaceNodeId === 'all' ? undefined : workspaceNodeId}
          onCreated={(name, nodeId) => {
            setSelected(instanceKey(nodeId, name));
            if (nodeId > 0) setWorkspaceNodeId(nodeId);
            setPage('overview');
            refreshAll();
          }}
          onManageNodes={() => setPage('nodes')}
          onCancel={() => setPage('overview')}
        />
      );
    return <SystemPage auth={auth} system={system} nodes={nodes} toast={toast} onPasswordChanged={onAuthRefresh} />;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, instances, nodes, stats, counts, dockerAvailable, dockerError, system, selected, pendingAction, workspaceNodeId, workspaceSearch, nodeHealthById, detailInitialTab, auditLogs, nodeSystems]);

  return (
    <div className="min-h-screen flex">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-3 focus:py-1.5 focus:rounded-md focus:bg-[var(--color-accent)] focus:text-white focus:text-[12px] focus:font-medium focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-white"
      >
        跳到主内容
      </a>
      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <Topbar
          username={auth.username}
          onCreateInstance={() => setPage('create')}
          workspaceSearch={workspaceSearch}
          onWorkspaceSearchChange={(value) => {
            setWorkspaceSearch(value);
            if (value.trim()) setWorkspaceNodeId('all');
            setPage('overview');
          }}
          onOpenWorkspace={() => setPage('overview')}
          onOpenAudit={() => setPage('audit')}
          onLogout={onLogout}
          onOpenSystem={() => setPage('system')}
        />
        <div id="main-content" tabIndex={-1} className="flex-1 min-w-0 outline-none">
          {body}
        </div>
      </div>
      {deleteCandidate && (
        <ConfirmInstanceDelete
          instance={deleteCandidate}
          pending={pendingAction[instanceKey(deleteCandidate.nodeId, deleteCandidate.name)] === 'delete'}
          onCancel={() => setDeleteCandidate(null)}
          onConfirm={() => deleteInstance(deleteCandidate)}
        />
      )}
      <ToastStack toasts={toasts} onClose={closeToast} />
    </div>
  );
}

function ConfirmInstanceDelete({
  instance,
  pending,
  onCancel,
  onConfirm
}: {
  instance: InstanceRef;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typedName, setTypedName] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const canConfirm = typedName === instance.name && !pending;

  useEffect(() => {
    setTypedName('');
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [instance.nodeId, instance.name]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !pending) onCancel();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 px-4 py-6"
      role="presentation"
      onKeyDown={handleKeyDown}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="instance-delete-title"
        className="w-full max-w-[520px] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl"
      >
        <header className="flex items-start gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--color-danger-soft)] text-[var(--color-danger)]">
            <ShieldAlert size={16} />
          </span>
          <div className="min-w-0">
            <h2 id="instance-delete-title" className="text-[14px] font-semibold text-[var(--color-fg)]">
              删除实例
            </h2>
            <p className="mt-1 text-[12px] leading-5 text-[var(--color-fg-muted)]">
              目标实例：<span className="font-semibold text-[var(--color-fg)]">{instance.name}</span>
              <span className="mx-1">/</span>
              节点：<span className="font-semibold text-[var(--color-fg)]">{instance.nodeName}</span>
            </p>
          </div>
        </header>
        <div className="space-y-4 p-4">
          <p className="text-[12px] leading-5 text-[var(--color-fg-muted)]">
            该操作会停止容器、删除实例目录，并从主控实例列表中移除记录。删除后不可撤销。
          </p>
          <div className="rounded-md border border-[var(--color-danger)]/25 bg-[var(--color-danger-soft)] p-3">
            <label className="text-[12px] font-medium text-[var(--color-danger)]">
              输入实例名确认删除
            </label>
            <Input
              ref={inputRef}
              value={typedName}
              onChange={(event) => setTypedName(event.target.value)}
              placeholder={instance.name}
              className="mt-2 bg-white"
              disabled={pending}
            />
            <p className="mt-2 text-[11px] leading-4 text-[var(--color-danger)]">
              只有完全匹配实例名后才能继续。
            </p>
          </div>
        </div>
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-3">
          <Button onClick={onCancel} disabled={pending}>取消</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={!canConfirm}>
            <Trash2 size={13} />
            {pending ? '删除中...' : '删除实例'}
          </Button>
        </footer>
      </section>
    </div>
  );
}
