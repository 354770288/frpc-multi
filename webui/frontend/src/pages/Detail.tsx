import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  FileCode2,
  History,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
  TerminalSquare,
  XCircle
} from 'lucide-react';
import { api, auditLogsApi, nodesApi } from '../lib/api';
import { instanceStateBadge } from '../lib/format';
import { parseProxies, splitTomlAtProxies, type ProxyDraft } from '../lib/proxyToml';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Panel } from '../components/ui/Panel';
import { ConfigEditorPanel } from './ConfigEditor';
import type { AuditLog, InstanceDetail, InstanceRef, Page, StatsMap, ToastKind } from '../lib/types';

const TAIL_OPTIONS = [100, 300, 1000] as const;
type TailOption = (typeof TAIL_OPTIONS)[number];
export type DetailTab = 'logs' | 'config' | 'proxies' | 'audit';

const LOG_REFRESH_MS = 7000;

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

export function Detail({
  instance,
  stats,
  pendingAction,
  toast,
  initialTab = 'logs',
  onPage,
  onAction
}: {
  instance: InstanceRef | null;
  stats: StatsMap;
  pendingAction: Record<string, string>;
  toast: (kind: ToastKind, text: string) => void;
  initialTab?: DetailTab;
  onPage: (page: Page) => void;
  onAction: (instance: InstanceRef, action: string) => void;
}) {
  const [detail, setDetail] = useState<InstanceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tab, setTab] = useState<DetailTab>('logs');
  const [logs, setLogs] = useState<string[]>([]);
  const [keywordInput, setKeywordInput] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [tail, setTail] = useState<TailOption>(300);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsPaused, setLogsPaused] = useState(false);
  const [viewLogs, setViewLogs] = useState<string[]>([]);
  const [followLogs, setFollowLogs] = useState(false);
  const [logOrder, setLogOrder] = useState<'newest' | 'oldest'>('newest');
  const [proxyDrafts, setProxyDrafts] = useState<ProxyDraft[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  const name = instance?.name || '';
  const key = instance ? `${instance.nodeId}:${instance.name}` : '';

  const loadDetail = useCallback(async () => {
    if (!instance) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    try {
      const data =
        instance.nodeId > 0
          ? await nodesApi.instances.get(instance.nodeId, instance.name)
          : await api<InstanceDetail>(`/api/instances/${instance.name}`);
      setDetail(data);
    } catch (err) {
      setDetail(null);
      toast('error', err instanceof Error ? err.message : '实例详情加载失败');
    } finally {
      setDetailLoading(false);
    }
  }, [instance?.name, instance?.nodeId, toast]);

  const loadAuditLogs = useCallback(async () => {
    if (!instance) return;
    setAuditLoading(true);
    try {
      setAuditLogs(await auditLogsApi.list(200));
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '操作记录加载失败');
    } finally {
      setAuditLoading(false);
    }
  }, [instance?.name, instance?.nodeId, toast]);

  const loadLogs = useCallback(async () => {
    if (!instance || logsPaused) return;
    setLogsLoading(true);
    const params = new URLSearchParams({ tail: String(tail) });
    if (appliedKeyword) params.set('keyword', appliedKeyword);
    try {
      const data =
        instance.nodeId > 0
          ? await nodesApi.instances.logs(instance.nodeId, instance.name, params)
          : await api<{ lines: string[] }>(`/api/instances/${instance.name}/logs?${params.toString()}`);
      setLogs(data.lines);
      setViewLogs(data.lines);
    } catch {
      setLogs([]);
    } finally {
      setLogsLoading(false);
    }
  }, [appliedKeyword, instance, logsPaused, tail]);

  useEffect(() => {
    setTab(initialTab);
    setLogs([]);
    setViewLogs([]);
    setKeywordInput('');
    setAppliedKeyword('');
    setAuditLogs([]);
    setLogsPaused(false);
    setFollowLogs(false);
    setLogOrder('newest');
    setProxyDrafts([]);
  }, [initialTab, key]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    if (tab !== 'audit') return;
    loadAuditLogs();
  }, [loadAuditLogs, tab]);

  useEffect(() => {
    if (tab !== 'logs') return;
    loadLogs();
    if (logsPaused) return;
    const timer = window.setInterval(loadLogs, LOG_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [loadLogs, logsPaused, tab]);

  useEffect(() => {
    if (!instance || tab !== 'proxies') return;
    const current = instance;
    let cancelled = false;
    async function loadProxyDrafts() {
      try {
        const data =
          current.nodeId > 0
            ? await nodesApi.instances.getConfig(current.nodeId, current.name)
            : await api<{ configText: string }>(`/api/instances/${current.name}/config`);
        const { proxiesBody } = splitTomlAtProxies(data.configText);
        if (!cancelled) setProxyDrafts(parseProxies(proxiesBody));
      } catch {
        if (!cancelled) setProxyDrafts([]);
      }
    }
    loadProxyDrafts();
    return () => {
      cancelled = true;
    };
  }, [instance, tab]);

  const filteredAuditLogs = useMemo(() => {
    if (!instance) return [];
    return auditLogs.filter((log) => auditMatchesInstance(log, instance));
  }, [auditLogs, instance]);

  if (!instance)
    return (
      <main className="px-6 py-6">
        <Panel title="实例详情">
          <p className="text-[12px] text-[var(--color-fg-muted)]">请选择实例</p>
        </Panel>
      </main>
    );

  const stat = stats[key];
  const enabled = detail?.enabled ?? instance.enabled;
  const badge = instanceStateBadge(stat, enabled);
  const pending = pendingAction[key];
  const displayName = detail?.displayName || instance.displayName || name;

  function applyKeyword() {
    setAppliedKeyword(keywordInput.trim());
  }

  return (
    <main className="px-4 sm:px-6 py-5 sm:py-6 max-w-[1720px] mx-auto">
      <button
        onClick={() => onPage('overview')}
        className="inline-flex items-center gap-1.5 mb-4 text-[12px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] rounded-sm"
      >
        <ArrowLeft size={13} />
        返回节点工作台
      </button>

      <section className="mb-4 overflow-hidden rounded-lg border border-[var(--color-border)] bg-white">
        <div className="grid gap-4 border-b border-[var(--color-border)] bg-[var(--color-accent-soft)] p-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge tone={badge.tone} dot>{badge.label}</Badge>
              {!enabled && <Badge tone="muted">已停用</Badge>}
              {detailLoading && <Badge tone="muted">加载中</Badge>}
            </div>
            <h1 className="truncate text-[22px] font-semibold tracking-tight text-[var(--color-fg)]">
              {displayName}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[var(--color-fg-muted)]">
              <span>节点：{instance.nodeName}</span>
              <span className="font-mono">实例：{name}</span>
              {detail?.description && <span>{detail.description}</span>}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <ActionGroup title="运行操作">
              <Button
                variant="default"
                disabled={!!pending || !enabled}
                onClick={() => onAction(instance, 'start')}
                title={!enabled ? '实例已停用，请先在节点工作台启用' : undefined}
              >
                <Play size={13} />
                {pending === 'start' ? '启动中...' : '启动'}
              </Button>
              <Button disabled={!!pending} onClick={() => onAction(instance, 'stop')}>
                <Square size={13} />
                {pending === 'stop' ? '停止中...' : '停止'}
              </Button>
              <Button disabled={!!pending || !enabled} onClick={() => onAction(instance, 'restart')}>
                <RefreshCw size={13} />
                {pending === 'restart' ? '重启中...' : '重启'}
              </Button>
            </ActionGroup>
            <ActionGroup title="高风险操作">
              <Button
                variant="destructive"
                disabled={!!pending || !enabled}
                onClick={() => onAction(instance, 'recreate')}
              >
                <RotateCcw size={13} />
                {pending === 'recreate' ? '重建中...' : '重新创建容器'}
              </Button>
            </ActionGroup>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 p-3 md:grid-cols-4 xl:grid-cols-6">
          <StatTile label="CPU 占用" value={stat?.cpuPercent || '--'} />
          <StatTile label="内存占用" value={stat?.memUsage || '--'} />
          <StatTile label="重启次数" value={stat ? String(stat.restartCount) : '--'} />
          <StatTile label="容器" value={stat?.containerName || stat?.service || '--'} mono truncate />
          <StatTile label="服务端" value={detail?.summary.serverAddr || '--'} mono truncate />
          <StatTile label="配置路径" value={detail?.configPath || instance.configPath || '--'} mono truncate />
        </div>
      </section>

      <div className="mb-4 flex gap-1.5 overflow-x-auto border-b border-[var(--color-border)]">
        <TabButton active={tab === 'logs'} onClick={() => setTab('logs')} icon={<TerminalSquare size={13} />}>
          日志
        </TabButton>
        <TabButton active={tab === 'config'} onClick={() => setTab('config')} icon={<FileCode2 size={13} />}>
          配置
        </TabButton>
        <TabButton active={tab === 'proxies'} onClick={() => setTab('proxies')} icon={<RefreshCw size={13} />}>
          代理
        </TabButton>
        <TabButton active={tab === 'audit'} onClick={() => setTab('audit')} icon={<History size={13} />}>
          操作记录
        </TabButton>
      </div>

      {tab === 'logs' && (
        <LogsPanel
          logs={viewLogs}
          loading={logsLoading}
          tail={tail}
          keywordInput={keywordInput}
          appliedKeyword={appliedKeyword}
          onTailChange={setTail}
          onKeywordInputChange={setKeywordInput}
          onApplyKeyword={applyKeyword}
          onRefresh={loadLogs}
          paused={logsPaused}
          follow={followLogs}
          logOrder={logOrder}
          onPausedChange={setLogsPaused}
          onFollowChange={(next) => {
            setFollowLogs(next);
            setLogOrder(next ? 'oldest' : 'newest');
          }}
          onLogOrderChange={setLogOrder}
          onClearView={() => setViewLogs([])}
          onClearKeyword={() => {
            setKeywordInput('');
            setAppliedKeyword('');
          }}
        />
      )}

      {tab === 'config' && (
        <ConfigEditorPanel instance={instance} toast={toast} embedded onSaved={loadDetail} />
      )}

      {tab === 'proxies' && <ProxySummaryPanel detail={detail} loading={detailLoading} proxies={proxyDrafts} />}

      {tab === 'audit' && (
        <AuditPanel
          logs={filteredAuditLogs}
          loading={auditLoading}
          onRefresh={loadAuditLogs}
        />
      )}
    </main>
  );
}

function LogsPanel({
  logs,
  loading,
  paused,
  follow,
  logOrder,
  tail,
  keywordInput,
  appliedKeyword,
  onTailChange,
  onKeywordInputChange,
  onApplyKeyword,
  onRefresh,
  onPausedChange,
  onFollowChange,
  onLogOrderChange,
  onClearView,
  onClearKeyword
}: {
  logs: string[];
  loading: boolean;
  paused: boolean;
  follow: boolean;
  logOrder: 'newest' | 'oldest';
  tail: TailOption;
  keywordInput: string;
  appliedKeyword: string;
  onTailChange: (value: TailOption) => void;
  onKeywordInputChange: (value: string) => void;
  onApplyKeyword: () => void;
  onRefresh: () => void;
  onPausedChange: (paused: boolean) => void;
  onFollowChange: (follow: boolean) => void;
  onLogOrderChange: (order: 'newest' | 'oldest') => void;
  onClearView: () => void;
  onClearKeyword: () => void;
}) {
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          日志
          <span className="text-[11px] font-normal text-[var(--color-fg-muted)]">
            {paused ? '自动刷新已暂停' : `每 ${LOG_REFRESH_MS / 1000} 秒自动刷新`}
          </span>
          {loading && (
            <span className="text-[11px] font-normal text-[var(--color-fg-muted)]">加载中...</span>
          )}
        </span>
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onRefresh} disabled={loading || paused}>
            <RefreshCw size={13} />
            刷新
          </Button>
          <Button onClick={() => onPausedChange(!paused)}>
            {paused ? <Play size={13} /> : <Square size={13} />}
            {paused ? '继续' : '暂停'}
          </Button>
          <Button
            variant={follow ? 'default' : 'ghost'}
            onClick={() => onFollowChange(!follow)}
            title={follow ? '关闭新日志定位' : '自动定位到最新日志'}
          >
            {follow ? '跟随中' : '跟随'}
          </Button>
          <select
            value={logOrder}
            onChange={(event) => onLogOrderChange(event.target.value as 'newest' | 'oldest')}
            aria-label="日志排序"
            className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/15"
          >
            <option value="newest">最新在上</option>
            <option value="oldest">最新在下</option>
          </select>
          <Button variant="ghost" onClick={onClearView}>
            清空视图
          </Button>
          <select
            value={tail}
            onChange={(event) => onTailChange(Number(event.target.value) as TailOption)}
            aria-label="日志行数"
            className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/15"
          >
            {TAIL_OPTIONS.map((value) => (
              <option key={value} value={value}>
                最近 {value} 行
              </option>
            ))}
          </select>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onApplyKeyword();
            }}
            className="flex h-8 w-[240px] items-center gap-2 rounded-md border border-[var(--color-border)] px-2.5 focus-within:border-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--color-accent)]/15"
          >
            <Search size={12} className="text-[var(--color-fg-subtle)]" aria-hidden="true" />
            <input
              value={keywordInput}
              onChange={(event) => onKeywordInputChange(event.target.value)}
              onBlur={onApplyKeyword}
              placeholder="按 Enter 搜索"
              aria-label="按关键字过滤日志"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg-subtle)]"
            />
            {appliedKeyword && (
              <button
                type="button"
                onClick={onClearKeyword}
                className="text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                aria-label="清除过滤"
              >
                清除
              </button>
            )}
          </form>
        </div>
      }
      bodyClassName="p-0"
    >
      <pre
        className="m-0 h-[560px] overflow-auto bg-zinc-950 px-4 py-3 font-mono text-[12px] leading-[1.65] text-slate-200 whitespace-pre-wrap"
      >
        {logs.length
          ? (logOrder === 'oldest' ? logs : logs.slice().reverse()).join('\n')
          : appliedKeyword
            ? `没有匹配「${appliedKeyword}」的日志`
            : '暂无日志或 Docker 未连接'}
      </pre>
    </Panel>
  );
}

function ProxySummaryPanel({
  detail,
  loading,
  proxies
}: {
  detail: InstanceDetail | null;
  loading: boolean;
  proxies: ProxyDraft[];
}) {
  if (loading) {
    return (
      <Panel title="代理">
        <p className="text-[12px] text-[var(--color-fg-muted)]">加载中...</p>
      </Panel>
    );
  }

  if (!detail) {
    return (
      <Panel title="代理">
        <p className="text-[12px] text-[var(--color-fg-muted)]">详情不可用，无法展示代理摘要。</p>
      </Panel>
    );
  }

  const proxyTypes = proxyTypeEntries(detail.summary.proxyTypes);
  const remotePorts = portEntries(detail.summary.remotePorts);

  return (
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Panel title="代理摘要">
        <dl className="grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-2 lg:grid-cols-4">
          <SummaryItem label="服务端地址" value={detail.summary.serverAddr} mono />
          <SummaryItem label="服务端端口" value={detail.summary.serverPort} mono />
          <SummaryItem label="认证方式" value={detail.summary.authMethod} />
          <SummaryItem label="代理数量" value={detail.summary.proxyCount} mono />
        </dl>

        <div className="mt-5 overflow-x-auto rounded-lg border border-[var(--color-border)]">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]">
                <Th>代理名</Th>
                <Th>类型</Th>
                <Th>本地目标</Th>
                <Th>远端</Th>
              </tr>
            </thead>
            <tbody>
              {proxies.map((proxy, index) => (
                <tr
                  key={`${proxy.name || 'proxy'}:${index}`}
                  className="border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--color-surface-muted)]"
                >
                  <Td mono>{proxy.name.trim() || '未命名'}</Td>
                  <Td>
                    <Badge tone="muted">{proxy.type || '--'}</Badge>
                  </Td>
                  <Td mono>{formatProxyLocalTarget(proxy)}</Td>
                  <Td mono>{formatProxyRemoteTarget(proxy)}</Td>
                </tr>
              ))}
              {!proxies.length && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-8 text-center text-[12px] text-[var(--color-fg-muted)]"
                  >
                    {detail.summary.proxyCount > 0
                      ? '当前配置摘要显示有代理，但常用字段未能解析成表格；可在配置 tab 查看原始 TOML。'
                      : '当前配置没有代理条目。'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {proxies.length > 0 && (
          <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-[11px] leading-5 text-[var(--color-fg-muted)]">
            代理表只展示常用字段；高级字段仍以原始 TOML 为准。
          </div>
        )}
      </Panel>

      <aside className="flex flex-col gap-4">
        <Panel title="代理类型">
          <ChipGroup label="类型分布" entries={proxyTypes} />
        </Panel>
        <Panel title="远端端口">
          <ChipGroup label="端口" entries={remotePorts} mono />
        </Panel>
      </aside>
    </section>
  );
}

function AuditPanel({
  logs,
  loading,
  onRefresh
}: {
  logs: AuditLog[];
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <Panel
      title="操作记录"
      actions={
        <Button onClick={onRefresh} disabled={loading}>
          <RefreshCw size={13} />
          刷新
        </Button>
      }
      bodyClassName="p-0"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[780px]">
          <thead>
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]">
              <Th>时间</Th>
              <Th>操作人</Th>
              <Th>动作</Th>
              <Th>结果</Th>
              <Th>消息</Th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr
                key={log.id}
                className="border-b border-[var(--color-border)] transition-colors last:border-b-0 hover:bg-[var(--color-surface-muted)]"
              >
                <Td mono>{formatTime(log.createdAt)}</Td>
                <Td>{log.username || '--'}</Td>
                <Td>{ACTION_LABEL[log.action] || log.action}</Td>
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
                  <span className="text-[12px] text-[var(--color-fg-muted)]">
                    {log.message || '--'}
                  </span>
                </Td>
              </tr>
            ))}
            {!logs.length && (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-10 text-center text-[12px] text-[var(--color-fg-muted)]"
                >
                  {loading ? '加载中...' : '该实例暂无操作记录'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function auditMatchesInstance(log: AuditLog, instance: InstanceRef): boolean {
  if (log.instanceName !== instance.name) return false;
  if (instance.nodeId > 0) return log.nodeId === instance.nodeId;
  return log.nodeId === null || log.nodeId === 0;
}

function proxyTypeEntries(types: Record<string, number> | undefined): { key: string; label: string }[] {
  if (!types) return [];
  return Object.entries(types)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ key: type, label: `${type} · ${count}` }));
}

function portEntries(ports: number[] | undefined): { key: string; label: string }[] {
  if (!ports || ports.length === 0) return [];
  const counts = new Map<number, number>();
  for (const port of ports) {
    counts.set(port, (counts.get(port) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([port, count]) => ({
      key: String(port),
      label: count > 1 ? `${port} x${count}` : String(port)
    }));
}

function formatProxyLocalTarget(proxy: ProxyDraft): string {
  const ip = proxy.localIP.trim();
  const port = proxy.localPort.trim();
  if (ip && port) return `${ip}:${port}`;
  if (port) return `:${port}`;
  return ip || '不可用';
}

function formatProxyRemoteTarget(proxy: ProxyDraft): string {
  const parts: string[] = [];
  if (proxy.remotePort.trim()) parts.push(`端口 ${proxy.remotePort.trim()}`);
  if (proxy.subdomain.trim()) parts.push(`子域名 ${proxy.subdomain.trim()}`);
  const domains = proxy.customDomains
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (domains.length) parts.push(domains.join(', '));
  return parts.length ? parts.join(' · ') : '不可用';
}

function ActionGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-white p-2.5">
      <div className="mb-2 text-[11px] font-semibold text-[var(--color-fg-muted)]">{title}</div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-t-lg border border-b-0 px-3 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
        active
          ? 'border-[var(--color-border)] bg-white font-semibold text-[var(--color-accent)]'
          : 'border-transparent text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function ChipGroup({
  label,
  entries,
  mono = false
}: {
  label: string;
  entries: { key: string; label: string }[];
  mono?: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[12px] text-[var(--color-fg-muted)]">{label}</div>
      {entries.length === 0 ? (
        <span className="text-[12px] text-[var(--color-fg-subtle)]">不可用</span>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {entries.map((entry) => (
            <span
              key={entry.key}
              className={`inline-flex h-6 items-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 text-[11px] text-[var(--color-fg)] ${
                mono ? 'font-mono tabular-nums' : ''
              }`}
            >
              {entry.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  mono = false,
  truncate = false
}: {
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
      <div className="mb-1 text-[11px] text-[var(--color-fg-muted)]">{label}</div>
      <div
        className={`text-[13px] font-semibold text-[var(--color-fg)] tabular-nums ${
          mono ? 'font-mono text-[11px] font-normal text-[var(--color-fg-muted)]' : ''
        } ${truncate ? 'truncate' : ''}`}
        title={truncate ? value : undefined}
      >
        {value}
      </div>
    </div>
  );
}

function SummaryItem({
  label,
  value,
  mono = false
}: {
  label: string;
  value?: string | number | null;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="mb-1 text-[var(--color-fg-muted)]">{label}</dt>
      <dd className={`font-medium text-[var(--color-fg)] ${mono ? 'font-mono tabular-nums' : ''}`}>
        {value ?? '不可用'}
      </dd>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-2.5 text-left text-[11px] font-medium text-[var(--color-fg-muted)]">
      {children}
    </th>
  );
}

function Td({
  children,
  mono = false
}: {
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <td
      className={`px-4 py-2.5 text-[13px] text-[var(--color-fg)] ${mono ? 'font-mono text-[12px] tabular-nums text-[var(--color-fg-muted)]' : ''}`}
    >
      {children}
    </td>
  );
}

function formatTime(value: string): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
