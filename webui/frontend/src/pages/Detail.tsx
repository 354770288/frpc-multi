import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
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
import { instanceStateBadge, parsePercent } from '../lib/format';
import { parseProxies, splitTomlAtProxies, type ProxyDraft } from '../lib/proxyToml';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/EmptyState';
import { Meter } from '../components/ui/meter';
import { Sparkline } from '../components/Sparkline';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '../components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Panel } from '../components/ui/Panel';
import { ConfigEditorPanel } from './ConfigEditor';
import { useConsole } from '../context/ConsoleContext';
import type { AuditLog, InstanceDetail, InstanceRef } from '../lib/types';

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

// ponytail: 只 strip 不着色；docker logs 常丢 ESC 字节只剩 "[1;31m" 字面量，两种形态都匹配
const ANSI_RE = /\x1b\[[0-9;]*m|\[[0-9;]{1,8}m/g;
function stripAnsi(line: string): string {
  return line.replace(ANSI_RE, '');
}

function parseDetailTab(value: string | null): DetailTab {
  return value === 'config' || value === 'proxies' || value === 'audit' ? value : 'logs';
}

export function Detail() {
  const {
    instances,
    summaryLoaded,
    summaryError,
    stats,
    statsHistory,
    pendingAction,
    action,
    loadSummary
  } = useConsole();
  const navigate = useNavigate();
  const params = useParams<{ nodeId: string; name: string }>();
  const [searchParams] = useSearchParams();
  const routeNodeId = Number(params.nodeId);
  const routeName = params.name ? decodeURIComponent(params.name) : '';
  const instance = useMemo(
    () =>
      instances.find((item) => item.nodeId === routeNodeId && item.name === routeName) || null,
    [instances, routeName, routeNodeId]
  );
  const initialTab = parseDetailTab(searchParams.get('tab'));
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
      toast.error(err instanceof Error ? err.message : '实例详情加载失败');
    } finally {
      setDetailLoading(false);
    }
  }, [instance?.name, instance?.nodeId]);

  const loadAuditLogs = useCallback(async () => {
    if (!instance) return;
    setAuditLoading(true);
    try {
      setAuditLogs(await auditLogsApi.list(200));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作记录加载失败');
    } finally {
      setAuditLoading(false);
    }
  }, [instance?.name, instance?.nodeId]);

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
      const lines = data.lines.map(stripAnsi);
      setLogs(lines);
      setViewLogs(lines);
    } catch (err) {
      setLogs([]);
      // 7s 轮询失败会反复进入，固定 id 让 sonner 复用同一条 toast 避免刷屏
      toast.error(err instanceof Error ? err.message : '日志加载失败', { id: 'detail-logs-error' });
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

  if (!instance) {
    const invalidRoute = !Number.isFinite(routeNodeId) || !routeName;
    const isInitialLoading = !summaryLoaded && !summaryError;
    const title = summaryError
      ? '实例列表不可用'
      : invalidRoute
        ? '实例路由无效'
        : isInitialLoading
          ? '实例详情'
          : '实例不存在';
    const message = summaryError
      ? summaryError
      : invalidRoute
        ? '请从节点工作台重新打开实例'
        : isInitialLoading
          ? '正在加载实例列表…'
          : '实例可能已被删除或移动到其他节点';

    return (
      <main className="px-6 py-6">
        <Panel
          title={title}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {summaryError && (
                <Button onClick={loadSummary}>
                  <RefreshCw size={13} />
                  重试
                </Button>
              )}
              <Button variant="ghost" onClick={() => navigate('/workspace')}>
                <ArrowLeft size={13} />
                返回工作台
              </Button>
            </div>
          }
        >
          <p className="text-[12px] text-muted-foreground">{message}</p>
        </Panel>
      </main>
    );
  }

  const stat = stats[key];
  const history = statsHistory[key] || [];
  const enabled = detail?.enabled ?? instance.enabled;
  const badge = instanceStateBadge(stat, enabled);
  const pending = pendingAction[key];
  const displayName = detail?.displayName || instance.displayName || name;

  function applyKeyword() {
    setAppliedKeyword(keywordInput.trim());
  }

  return (
    <main className="px-4 sm:px-6 py-5 sm:py-6 max-w-[1720px] mx-auto">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate('/workspace')}
        className="mb-4 -ml-3 text-muted-foreground"
      >
        <ArrowLeft data-icon="inline-start" />
        返回节点工作台
      </Button>

      <section className="mb-4 overflow-hidden rounded-lg border border-border bg-card">
        <div className="grid gap-4 border-b border-border bg-muted/50 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge tone={badge.tone} dot>{badge.label}</Badge>
              {!enabled && <Badge tone="muted">已停用</Badge>}
              {detailLoading && <Badge tone="muted">加载中</Badge>}
            </div>
            <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
              {displayName}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
              <span>节点：{instance.nodeName}</span>
              <span className="font-mono">实例：{name}</span>
              {detail?.description && <span>{detail.description}</span>}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <ActionGroup title="运行操作">
              <Button
                size="sm"
                variant="outline"
                disabled={!!pending || !enabled}
                onClick={() => action(instance, 'start')}
                title={!enabled ? '实例已停用，请先在节点工作台启用' : undefined}
              >
                <Play size={13} />
                {pending === 'start' ? '启动中…' : '启动'}
              </Button>
              <Button size="sm" variant="outline" disabled={!!pending} onClick={() => action(instance, 'stop')}>
                <Square size={13} />
                {pending === 'stop' ? '停止中…' : '停止'}
              </Button>
              <Button size="sm" variant="outline" disabled={!!pending || !enabled} onClick={() => action(instance, 'restart')}>
                <RefreshCw size={13} />
                {pending === 'restart' ? '重启中…' : '重启'}
              </Button>
            </ActionGroup>
            <ActionGroup title="高风险操作">
              <Button
                size="sm"
                variant="destructive"
                disabled={!!pending || !enabled}
                onClick={() => action(instance, 'recreate')}
              >
                <RotateCcw size={13} />
                {pending === 'recreate' ? '重建中…' : '重新创建容器'}
              </Button>
            </ActionGroup>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 p-3 md:grid-cols-4">
          <StatTile
            label="CPU 占用"
            value={stat?.cpuPercent || '--'}
            meter={stat ? parsePercent(stat.cpuPercent) : null}
            trend={history.map((point) => point.cpu)}
          />
          <StatTile
            label="内存占用"
            value={stat?.memUsage || '--'}
            meter={stat ? parsePercent(stat.memPercent) : null}
            trend={history.map((point) => point.mem)}
          />
          <StatTile label="网络 I/O" value={stat?.netIO || '--'} mono truncate />
          <StatTile label="进程数" value={stat?.pids || '--'} />
          <StatTile label="重启次数" value={stat ? String(stat.restartCount) : '--'} />
          <StatTile label="容器" value={stat?.containerName || stat?.service || '--'} mono truncate />
          <StatTile label="服务端" value={detail?.summary.serverAddr || '--'} mono truncate />
          <StatTile label="配置路径" value={detail?.configPath || instance.configPath || '--'} mono truncate />
        </div>
      </section>

      <Tabs value={tab} onValueChange={(value) => setTab(value as DetailTab)} className="mb-4">
        <TabsList>
          <TabsTrigger value="logs">
            <TerminalSquare />
            日志
          </TabsTrigger>
          <TabsTrigger value="config">
            <FileCode2 />
            配置
          </TabsTrigger>
          <TabsTrigger value="proxies">
            <RefreshCw />
            代理
          </TabsTrigger>
          <TabsTrigger value="audit">
            <History />
            操作记录
          </TabsTrigger>
        </TabsList>
      </Tabs>

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
        <ConfigEditorPanel instance={instance} embedded onSaved={loadDetail} />
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
          {loading && (
            <span className="text-[11px] font-normal text-muted-foreground">加载中…</span>
          )}
        </span>
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading || paused}>
            <RefreshCw size={13} />
            刷新
          </Button>
          <Button size="sm" variant="outline" onClick={() => onPausedChange(!paused)}>
            {paused ? <Play size={13} /> : <Square size={13} />}
            {paused ? '继续' : '暂停'}
          </Button>
          <Button
            size="sm"
            variant={follow ? 'secondary' : 'ghost'}
            onClick={() => onFollowChange(!follow)}
            title={follow ? '关闭新日志定位' : '自动定位到最新日志'}
          >
            {follow ? '跟随中' : '跟随'}
          </Button>
          <Select value={logOrder} onValueChange={(value) => onLogOrderChange(value as 'newest' | 'oldest')}>
            <SelectTrigger size="sm" aria-label="日志排序">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="newest">最新在上</SelectItem>
                <SelectItem value="oldest">最新在下</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button size="sm" variant="ghost" onClick={onClearView}>
            清空视图
          </Button>
          <Select value={String(tail)} onValueChange={(value) => onTailChange(Number(value) as TailOption)}>
            <SelectTrigger size="sm" aria-label="日志行数">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {TAIL_OPTIONS.map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    最近 {value} 行
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onApplyKeyword();
            }}
            className="min-w-0 flex-1 basis-[160px] max-w-[240px]"
          >
            <InputGroup>
              <InputGroupAddon>
                <Search aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                value={keywordInput}
                onChange={(event) => onKeywordInputChange(event.target.value)}
                onBlur={onApplyKeyword}
                placeholder="按 Enter 搜索"
                aria-label="按关键字过滤日志"
              />
              {appliedKeyword && (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton onClick={onClearKeyword} aria-label="清除过滤">
                    清除
                  </InputGroupButton>
                </InputGroupAddon>
              )}
            </InputGroup>
          </form>
        </div>
      }
      bodyClassName="p-0"
    >
      {/* ponytail: 日志终端区按终端惯例固定深色，不随主题切换 */}
      <pre
        tabIndex={0}
        role="log"
        aria-label="实例日志"
        className="m-0 h-[560px] overflow-auto bg-zinc-950 px-4 py-3 font-mono text-[12px] leading-[1.65] text-slate-200 whitespace-pre-wrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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
        <p className="text-[12px] text-muted-foreground">加载中…</p>
      </Panel>
    );
  }

  if (!detail) {
    return (
      <Panel title="代理">
        <p className="text-[12px] text-muted-foreground">详情不可用</p>
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

        <div className="mt-5 grid gap-3 2xl:hidden">
          {proxies.map((proxy, index) => (
            <div key={`${proxy.name || 'proxy'}:${index}`} className="min-w-0 rounded-lg border border-border bg-muted/40 p-3">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="truncate font-mono text-[12px] text-foreground">
                  {proxy.name.trim() || '未命名'}
                </span>
                <Badge tone="muted">{proxy.type || '--'}</Badge>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <MobileFact label="本地目标" value={formatProxyLocalTarget(proxy)} mono />
                <MobileFact label="远端" value={formatProxyRemoteTarget(proxy)} mono />
              </div>
            </div>
          ))}
          {!proxies.length && (
            <EmptyState title={detail.summary.proxyCount > 0 ? '未能解析代理表格' : '暂无代理'} />
          )}
        </div>

        <div className="mt-5 hidden rounded-lg border border-border 2xl:block">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="border-b border-border bg-muted">
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
                  className="border-b border-border last:border-b-0 hover:bg-muted"
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
                    className="px-4 py-8 text-center text-[12px] text-muted-foreground"
                  >
                    {detail.summary.proxyCount > 0 ? '未能解析代理表格' : '暂无代理'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={13} />
          刷新
        </Button>
      }
      bodyClassName="p-0"
    >
      <div>
        <div className="grid gap-3 p-3 2xl:hidden">
          {logs.map((log) => (
            <div key={log.id} className="min-w-0 rounded-lg border border-border bg-card p-3">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {formatTime(log.createdAt)}
                </span>
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
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <MobileFact label="操作人" value={log.username || '--'} />
                <MobileFact label="动作" value={ACTION_LABEL[log.action] || log.action} />
                <MobileFact label="消息" value={log.message || '--'} />
              </div>
            </div>
          ))}
          {!logs.length && (
            <EmptyState title={loading ? '加载中…' : '该实例暂无操作记录'} />
          )}
        </div>
        <div className="hidden 2xl:block">
        <table className="w-full min-w-[780px]">
          <thead>
            <tr className="border-b border-border bg-muted">
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
                className="border-b border-border transition-colors last:border-b-0 hover:bg-muted"
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
                  <span className="text-[12px] text-muted-foreground">
                    {log.message || '--'}
                  </span>
                </Td>
              </tr>
            ))}
            {!logs.length && (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-10 text-center text-[12px] text-muted-foreground"
                >
                  {loading ? '加载中…' : '该实例暂无操作记录'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
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

function MobileFact({
  label,
  value,
  mono = false
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-md bg-muted px-2.5 py-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div
        className={`mt-0.5 truncate text-[12px] text-foreground ${
          mono ? 'font-mono tabular-nums text-muted-foreground' : ''
        }`}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function ActionGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-2.5">
      <div className="mb-2 text-[11px] font-semibold text-muted-foreground">{title}</div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
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
      <div className="mb-1.5 text-[12px] text-muted-foreground">{label}</div>
      {entries.length === 0 ? (
        <span className="text-[12px] text-muted-foreground/70">不可用</span>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {entries.map((entry) => (
            <span
              key={entry.key}
              className={`inline-flex h-6 max-w-full items-center overflow-hidden rounded-md border border-border bg-muted px-2 text-[11px] text-foreground whitespace-nowrap ${
                mono ? 'font-mono tabular-nums' : ''
              }`}
            >
              <span className="min-w-0 truncate">{entry.label}</span>
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
  truncate = false,
  meter,
  trend
}: {
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
  /** 0–100 占比；null 表示暂无数据（渲染空轨道） */
  meter?: number | null;
  trend?: number[];
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-muted/60 p-3">
      <div className="mb-1 text-[11px] text-muted-foreground">{label}</div>
      <div className="flex items-center justify-between gap-2">
        <div
          className={`min-w-0 text-[13px] font-semibold text-foreground tabular-nums ${
            mono ? 'font-mono text-[11px] font-normal text-muted-foreground' : ''
          } ${truncate ? 'truncate' : ''}`}
          title={truncate ? value : undefined}
        >
          {value}
        </div>
        {trend && <Sparkline points={trend} />}
      </div>
      {meter !== undefined && <Meter value={meter} className="mt-2 h-1" aria-label={`${label}占比`} />}
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
      <dt className="mb-1 text-muted-foreground">{label}</dt>
      <dd className={`font-medium text-foreground ${mono ? 'font-mono tabular-nums' : ''}`}>
        {value ?? '不可用'}
      </dd>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground">
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
      className={`px-4 py-2.5 text-[13px] text-foreground ${mono ? 'font-mono text-[12px] tabular-nums text-muted-foreground' : ''}`}
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
