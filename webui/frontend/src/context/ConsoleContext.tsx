import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { toast as sonnerToast } from 'sonner';
import { api, auditLogsApi, nodesApi } from '../lib/api';
import { actionLabel, instanceStateBadge } from '../lib/format';
import type {
  AuditLog,
  AuthState,
  ConsoleInfo,
  InstanceRef,
  InstanceStats,
  Node,
  NodeInstanceHealth,
  StatsMap,
  SummaryResponse,
  SystemInfo,
} from '../lib/types';

// ── types ──────────────────────────────────────────────────────────────────

type SummaryCounts = { total: number; running: number; stopped: number; error: number };
const EMPTY_COUNTS: SummaryCounts = { total: 0, running: 0, stopped: 0, error: 0 };
type NodeSystemSnapshot = Record<number, { info: SystemInfo | null; error: string | null }>;

export function instanceKey(nodeId: number, name: string) {
  return `${nodeId}:${name}`;
}

// ── context shape ──────────────────────────────────────────────────────────

interface ConsoleContextValue {
  auth: AuthState;
  onAuthRefresh: (state: AuthState) => void;
  // data
  nodes: Node[];
  instances: InstanceRef[];
  summaryLoading: boolean;
  summaryLoaded: boolean;
  summaryError: string;
  stats: StatsMap;
  counts: SummaryCounts;
  dockerAvailable: boolean;
  dockerError: string;
  system: ConsoleInfo | null;
  pendingAction: Record<string, string>;
  auditLogs: AuditLog[];
  setAuditLogs: (logs: AuditLog[]) => void;
  nodeSystems: NodeSystemSnapshot;
  nodeHealthById: Record<number, NodeInstanceHealth>;
  // workspace filters
  workspaceNodeId: number | 'all';
  setWorkspaceNodeId: (val: number | 'all') => void;
  workspaceSearch: string;
  setWorkspaceSearch: (val: string) => void;
  // actions
  action: (item: InstanceRef, verb: string) => Promise<void>;
  patchInstance: (item: InstanceRef, patch: { displayName?: string; description?: string; enabled?: boolean; applyImmediately?: boolean }) => Promise<void>;
  deleteInstance: (item: InstanceRef) => Promise<void>;
  refreshAll: () => Promise<void>;
  loadSummary: () => Promise<void>;
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

export function useConsole() {
  const ctx = useContext(ConsoleContext);
  if (!ctx) throw new Error('useConsole must be used within ConsoleProvider');
  return ctx;
}

// ── provider ───────────────────────────────────────────────────────────────

export function ConsoleProvider({ auth, onAuthRefresh, children }: { auth: AuthState; onAuthRefresh: (state: AuthState) => void; children: ReactNode }) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [instances, setInstances] = useState<InstanceRef[]>([]);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryLoaded, setSummaryLoaded] = useState(false);
  const [summaryError, setSummaryError] = useState('');
  const [stats, setStats] = useState<StatsMap>({});
  const [counts, setCounts] = useState<SummaryCounts>(EMPTY_COUNTS);
  const [dockerAvailable, setDockerAvailable] = useState(false);
  const [dockerError, setDockerError] = useState('');
  const [system, setSystem] = useState<ConsoleInfo | null>(null);
  const [pendingAction, setPendingAction] = useState<Record<string, string>>({});
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [nodeSystems, setNodeSystems] = useState<NodeSystemSnapshot>({});
  const [workspaceNodeId, setWorkspaceNodeId] = useState<number | 'all'>('all');
  const [workspaceSearch, setWorkspaceSearch] = useState('');

  async function loadSummary() {
    setSummaryLoading(true);
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
            ? { ...node, status: summary.status, online: summary.status === 'online', lastSeenAt: summary.lastSeenAt }
            : node;
        })
      );
      const list: InstanceRef[] = [];
      const statMap: StatsMap = {};
      for (const item of data.instances) {
        const { runtime, nodeId, nodeName, ...rest } = item;
        const id = typeof nodeId === 'number' ? nodeId : 0;
        list.push({ ...rest, nodeId: id, nodeName: nodeName || '本机' });
        if (runtime && Object.keys(runtime).length) statMap[instanceKey(id, item.name)] = runtime as InstanceStats;
      }
      setInstances(list);
      setStats(statMap);
      setCounts({ total: data.total, running: data.running, stopped: data.stopped, error: data.error });
      setDockerAvailable(!!data.dockerAvailable);
      setDockerError(data.dockerError || '');
      setSummaryError('');
    } catch {
      setInstances([]);
      setStats({});
      setCounts(EMPTY_COUNTS);
      setDockerAvailable(false);
      setDockerError('无法访问 /api/summary');
      setSummaryError('无法访问 /api/summary');
    } finally {
      setSummaryLoaded(true);
      setSummaryLoading(false);
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
    if (!nodes.length) { setNodeSystems({}); return; }
    let cancelled = false;
    async function loadNodeSystems() {
      const entries = await Promise.all(
        nodes.map(async (node) => {
          if (!(node.online || node.status === 'online')) return [node.id, { info: null, error: '节点未在线' }] as const;
          try {
            return [node.id, { info: await nodesApi.system(node.id), error: null }] as const;
          } catch (err) {
            return [node.id, { info: null, error: err instanceof Error ? err.message : '节点系统信息不可达' }] as const;
          }
        })
      );
      if (!cancelled) setNodeSystems(Object.fromEntries(entries));
    }
    loadNodeSystems();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeSystemKey]);

  const action = useCallback(async (item: InstanceRef, verb: string) => {
    const key = instanceKey(item.nodeId, item.name);
    setPendingAction((prev) => ({ ...prev, [key]: verb }));
    try {
      if (item.nodeId > 0) await nodesApi.instances.action(item.nodeId, item.name, verb);
      else await api(`/api/instances/${item.name}/${verb}`, { method: 'POST' });
      sonnerToast.success(`${item.name} ${actionLabel(verb)}成功`);
      await loadSummary();
    } catch (err) {
      sonnerToast.error(`${item.name} ${actionLabel(verb)}失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setPendingAction((prev) => { const next = { ...prev }; delete next[key]; return next; });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchInstance = useCallback(async (
    item: InstanceRef,
    patch: { displayName?: string; description?: string; enabled?: boolean; applyImmediately?: boolean }
  ) => {
    const key = patch.enabled !== undefined ? 'toggle' : 'patch';
    const pendingKey = instanceKey(item.nodeId, item.name);
    setPendingAction((prev) => ({ ...prev, [pendingKey]: key }));
    try {
      if (item.nodeId > 0) await nodesApi.instances.patch(item.nodeId, item.name, patch);
      else await api(`/api/instances/${item.name}`, { method: 'PATCH', body: JSON.stringify(patch) });
      sonnerToast.success(patch.enabled !== undefined ? `${item.name} 已${patch.enabled ? '启用' : '停用'}` : `${item.name} 已更新`);
      await loadSummary();
    } catch (err) {
      sonnerToast.error(`${item.name} 更新失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setPendingAction((prev) => { const next = { ...prev }; delete next[pendingKey]; return next; });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const deleteInstance = useCallback(async (item: InstanceRef) => {
    const key = instanceKey(item.nodeId, item.name);
    setPendingAction((prev) => ({ ...prev, [key]: 'delete' }));
    try {
      if (item.nodeId > 0) await nodesApi.instances.delete(item.nodeId, item.name);
      else await api(`/api/instances/${item.name}`, { method: 'DELETE' });
      sonnerToast.success(`${item.name} 已删除`);
      await refreshAll();
    } catch (err) {
      sonnerToast.error(`${item.name} 删除失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setPendingAction((prev) => { const next = { ...prev }; delete next[key]; return next; });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nodeHealthById = useMemo<Record<number, NodeInstanceHealth>>(() => {
    const byNode: Record<number, NodeInstanceHealth> = {};
    for (const item of instances) {
      if (!byNode[item.nodeId]) byNode[item.nodeId] = { total: 0, running: 0, stopped: 0, error: 0, disabled: 0 };
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

  const value: ConsoleContextValue = {
    auth, onAuthRefresh,
    nodes, instances, summaryLoading, summaryLoaded, summaryError, stats, counts, dockerAvailable, dockerError, system, pendingAction, auditLogs, setAuditLogs, nodeSystems, nodeHealthById,
    workspaceNodeId, setWorkspaceNodeId, workspaceSearch, setWorkspaceSearch,
    action, patchInstance, deleteInstance, refreshAll, loadSummary,
  };

  return (
    <ConsoleContext.Provider value={value}>
      {children}
    </ConsoleContext.Provider>
  );
}
