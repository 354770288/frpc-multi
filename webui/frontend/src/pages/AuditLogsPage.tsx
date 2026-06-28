import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Filter,
  RefreshCw,
  RotateCcw,
  XCircle
} from 'lucide-react';
import { auditLogsApi } from '../lib/api';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Panel } from '../components/ui/Panel';
import type { AuditLog, Node, ToastKind } from '../lib/types';

const ACTION_LABEL: Record<string, string> = {
  create_instance: '创建实例',
  patch_instance: '更新实例',
  update_config: '修改配置',
  delete_instance: '删除实例',
  start_instance: '启动',
  stop_instance: '停止',
  restart_instance: '重启',
  recreate_instance: '重建'
};

type TimeFilter = 'all' | 'today' | '7d' | '30d';

export function AuditLogsPage({
  nodes,
  toast,
  initialLogs,
  onLogsLoaded,
  onOpenInstance,
  onOpenNode
}: {
  nodes: Node[];
  toast: (kind: ToastKind, text: string) => void;
  initialLogs?: AuditLog[];
  onLogsLoaded?: (logs: AuditLog[]) => void;
  onOpenInstance: (nodeId: number, name: string) => void;
  onOpenNode: (nodeId: number) => void;
}) {
  const [logs, setLogs] = useState<AuditLog[]>(initialLogs || []);
  const [loading, setLoading] = useState(true);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');
  const [nodeFilter, setNodeFilter] = useState('all');
  const [actionFilter, setActionFilter] = useState('all');
  const [resultFilter, setResultFilter] = useState('all');
  const [instanceQuery, setInstanceQuery] = useState('');
  const [expandedMessages, setExpandedMessages] = useState<Record<number, boolean>>({});

  const nodeNameById = useMemo(() => new Map(nodes.map((node) => [node.id, node.name])), [nodes]);
  const actionOptions = useMemo(
    () => Array.from(new Set(logs.map((log) => log.action))).sort(),
    [logs]
  );
  const hasLocalLogs = useMemo(() => logs.some((log) => isLocalAuditNode(log.nodeId)), [logs]);
  const filteredLogs = useMemo(() => {
    const keyword = instanceQuery.trim().toLowerCase();
    return logs.filter((log) => {
      if (!matchesTimeRange(log.createdAt, timeFilter)) return false;
      if (nodeFilter !== 'all' && logNodeFilterValue(log.nodeId) !== nodeFilter) return false;
      if (actionFilter !== 'all' && log.action !== actionFilter) return false;
      if (resultFilter === 'success' && !log.success) return false;
      if (resultFilter === 'failed' && log.success) return false;
      if (keyword && !(log.instanceName || '').toLowerCase().includes(keyword)) return false;
      return true;
    });
  }, [actionFilter, instanceQuery, logs, nodeFilter, resultFilter, timeFilter]);
  const failedCount = useMemo(() => logs.filter((log) => !log.success).length, [logs]);

  async function loadLogs() {
    setLoading(true);
    try {
      const data = await auditLogsApi.list(200);
      setLogs(data);
      onLogsLoaded?.(data);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '审计日志加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetFilters() {
    setTimeFilter('all');
    setNodeFilter('all');
    setActionFilter('all');
    setResultFilter('all');
    setInstanceQuery('');
  }

  function toggleMessage(id: number) {
    setExpandedMessages((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <main className="px-6 py-6 max-w-[1600px]">
      <div className="mb-6 flex items-center gap-3">
        <h2 className="text-[18px] font-semibold tracking-tight text-[var(--color-fg)]">
          审计日志
        </h2>
        <Badge tone="muted">{logs.length} 条</Badge>
        {failedCount > 0 && <Badge tone="danger">{failedCount} 条失败</Badge>}
        <Button className="ml-auto" onClick={loadLogs} disabled={loading}>
          <RefreshCw size={13} />
          刷新
        </Button>
      </div>

      <Panel
        title={
          <span className="inline-flex items-center gap-2">
            <Filter size={14} />
            客户端筛选
          </span>
        }
        actions={
          <Button size="sm" variant="ghost" onClick={resetFilters}>
            <RotateCcw size={13} />
            重置
          </Button>
        }
        className="mb-4"
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-[var(--color-fg-muted)]">时间范围</span>
            <select
              value={timeFilter}
              onChange={(event) => setTimeFilter(event.target.value as TimeFilter)}
              className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/15"
            >
              <option value="all">全部时间</option>
              <option value="today">今天</option>
              <option value="7d">最近 7 天</option>
              <option value="30d">最近 30 天</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-[var(--color-fg-muted)]">节点</span>
            <select
              value={nodeFilter}
              onChange={(event) => setNodeFilter(event.target.value)}
              className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/15"
            >
              <option value="all">全部节点</option>
              {hasLocalLogs && <option value="local">本机</option>}
              {nodes.map((node) => (
                <option key={node.id} value={`node:${node.id}`}>
                  {node.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-[var(--color-fg-muted)]">动作</span>
            <select
              value={actionFilter}
              onChange={(event) => setActionFilter(event.target.value)}
              className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/15"
            >
              <option value="all">全部动作</option>
              {actionOptions.map((action) => (
                <option key={action} value={action}>
                  {ACTION_LABEL[action] || action}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-[var(--color-fg-muted)]">结果</span>
            <select
              value={resultFilter}
              onChange={(event) => setResultFilter(event.target.value)}
              className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/15"
            >
              <option value="all">全部结果</option>
              <option value="success">成功</option>
              <option value="failed">失败</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-[var(--color-fg-muted)]">实例</span>
            <Input
              value={instanceQuery}
              onChange={(event) => setInstanceQuery(event.target.value)}
              placeholder="按实例名筛选"
            />
          </label>
        </div>
      </Panel>

      <Panel
        title="最近操作"
        actions={
          <span className="text-[11px] text-[var(--color-fg-muted)]">
            显示 {filteredLogs.length} / {logs.length}
          </span>
        }
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px]">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]">
                <Th>时间</Th>
                <Th>操作人</Th>
                <Th>动作</Th>
                <Th>节点</Th>
                <Th>实例</Th>
                <Th>结果</Th>
                <Th>消息</Th>
                <Th align="right">定位</Th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.map((log) => (
                <tr
                  key={log.id}
                  className={`border-b border-[var(--color-border)] last:border-b-0 transition-colors hover:bg-[var(--color-surface-muted)] ${
                    log.success ? '' : 'bg-[var(--color-danger-soft)]/40'
                  }`}
                >
                  <Td mono>{formatTime(log.createdAt)}</Td>
                  <Td>{log.username || '—'}</Td>
                  <Td>{ACTION_LABEL[log.action] || log.action}</Td>
                  <Td>{nodeLabel(log.nodeId, nodeNameById)}</Td>
                  <Td mono>{log.instanceName || '—'}</Td>
                  <Td>
                    {log.success ? (
                      <Badge tone="success">
                        <CheckCircle2 size={12} />
                        成功
                      </Badge>
                    ) : (
                      <Badge tone="danger">
                        <XCircle size={12} />
                        失败
                      </Badge>
                    )}
                  </Td>
                  <Td>
                    <MessageCell
                      log={log}
                      expanded={!!expandedMessages[log.id]}
                      onToggle={() => toggleMessage(log.id)}
                    />
                  </Td>
                  <Td align="right">
                    <div className="flex justify-end gap-1">
                      {isRemoteAuditNode(log.nodeId) && (
                        <Button size="sm" variant="ghost" onClick={() => onOpenNode(log.nodeId as number)}>
                          <ExternalLink size={13} />
                          节点
                        </Button>
                      )}
                      {log.instanceName && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onOpenInstance(log.nodeId ?? 0, log.instanceName as string)}
                        >
                          <ExternalLink size={13} />
                          实例
                        </Button>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
              {!filteredLogs.length && (
                <tr>
                  <td
                    colSpan={8}
                    className="px-4 py-10 text-center text-[12px] text-[var(--color-fg-muted)]"
                  >
                    {loading ? '加载中…' : logs.length ? '没有匹配当前筛选的审计记录' : '暂无审计记录'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </main>
  );
}

function logNodeFilterValue(nodeId: number | null): string {
  return isLocalAuditNode(nodeId) ? 'local' : `node:${nodeId}`;
}

function matchesTimeRange(value: string, filter: TimeFilter): boolean {
  if (filter === 'all') return true;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return false;
  if (filter === 'today') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return time >= start.getTime();
  }
  const days = filter === '7d' ? 7 : 30;
  return time >= Date.now() - days * 24 * 60 * 60 * 1000;
}

function nodeLabel(nodeId: number | null, nodeNameById: Map<number, string>): string {
  if (nodeId === null || nodeId === 0) return '本机';
  return nodeNameById.get(nodeId) || `节点 #${nodeId}`;
}

function isLocalAuditNode(nodeId: number | null): boolean {
  return nodeId === null || nodeId === 0;
}

function isRemoteAuditNode(nodeId: number | null): boolean {
  return typeof nodeId === 'number' && nodeId > 0;
}

function formatTime(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function MessageCell({
  log,
  expanded,
  onToggle
}: {
  log: AuditLog;
  expanded: boolean;
  onToggle: () => void;
}) {
  const message = log.message || '—';
  const isLong = message.length > 96;
  const text = !isLong || expanded ? message : `${message.slice(0, 96)}...`;
  return (
    <div className="max-w-[420px]">
      <span
        className={`whitespace-pre-wrap break-words text-[12px] ${
          log.success ? 'text-[var(--color-fg-muted)]' : 'font-medium text-[var(--color-danger)]'
        }`}
      >
        {text}
      </span>
      {isLong && (
        <button
          type="button"
          onClick={onToggle}
          className="ml-2 inline-flex items-center gap-1 rounded-sm text-[11px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </div>
  );
}

function Th({
  children,
  align = 'left'
}: {
  children: ReactNode;
  align?: 'left' | 'right';
}) {
  const alignClass = align === 'right' ? 'text-right' : 'text-left';
  return (
    <th
      className={`px-4 py-2.5 ${alignClass} text-[11px] font-medium text-[var(--color-fg-muted)]`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  mono = false,
  align = 'left'
}: {
  children: ReactNode;
  mono?: boolean;
  align?: 'left' | 'right';
}) {
  const alignClass = align === 'right' ? 'text-right' : 'text-left';
  return (
    <td
      className={`px-4 py-2.5 ${alignClass} text-[13px] text-[var(--color-fg)] ${mono ? 'font-mono tabular-nums text-[12px] text-[var(--color-fg-muted)]' : ''}`}
    >
      {children}
    </td>
  );
}
