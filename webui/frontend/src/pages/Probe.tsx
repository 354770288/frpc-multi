import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowDown, ArrowRight, ArrowUp, ArrowUpDown, Download, FolderCog, Gauge, ListPlus,
  Network, Pencil, Play, Plus, Radar, RefreshCw, Rocket, Route, Settings2, Square, Tag,
  Trash2, Upload, X, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { probeApi } from '../lib/api';
import { formatLastSeen } from '../lib/format';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { Progress } from '../components/ui/progress';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from '../components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { ConnBadge, ProbeStatCards, RecentList, SpeedText } from './probe/ProbeParts';
import { useDiscovery } from './probe/useDiscovery';
import { useServers } from './probe/useServers';
import { ConfirmOverlay, Overlay } from '../components/Overlay';
import { cn } from '../lib/utils';
import type {
  DiscoverStatus, GroupColor, GroupInfo, LabelCount, ServerConn,
  ProbeConnectivityHistory, ProbeConnectivitySummary, ProbeDashboard, ProbeServer,
  ProbeSpeedHistory, ProbeTestConfig, ProbeTestStatus, RouteNodeInfo,
} from '../lib/types';

/** 路由测试系统保留标签 → Badge variant（灰/红/绿三态）。 */
function labelVariant(label: string): 'destructive' | 'success' | 'muted' {
  switch (label) {
    case '非CN2': return 'destructive';
    case 'CN2': return 'success';
    case '未路由测试': return 'muted';
    default: return 'muted';
  }
}

function isRouteLabel(label: string): boolean {
  return label === 'CN2' || label === '非CN2' || label === '未路由测试';
}

type TestScope = 'all' | 'selected' | string; // 'all' | 'selected' | 分组名

type GroupBadgeVariant = 'destructive' | 'warning' | 'info' | 'success' | 'muted';

/** 分组颜色 → Badge variant（红=危险/黄=警告/蓝=信息/绿=成功，无色=灰）。 */
function groupVariant(color: GroupColor | undefined): GroupBadgeVariant {
  switch (color) {
    case 'red': return 'destructive';
    case 'yellow': return 'warning';
    case 'blue': return 'info';
    case 'green': return 'success';
    default: return 'muted';
  }
}

/** 颜色圆点（筛选下拉等小空间用）。 */
function GroupDot({ color, className }: { color: GroupColor | undefined; className?: string }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', GroupDotClass(color), className)} aria-hidden="true" />;
}

const COLOR_LABELS: Record<string, string> = { red: '红', yellow: '黄', blue: '蓝', green: '绿' };

/** 颜色圆点的背景类（选择器色块复用）。 */
function GroupDotClass(color: GroupColor | undefined): string {
  const dot: Record<string, string> = {
    red: 'bg-destructive',
    yellow: 'bg-warning',
    blue: 'bg-blue-500',
    green: 'bg-primary',
  };
  return color ? dot[color] : 'bg-muted-foreground/40';
}

export function Probe() {
  const navigate = useNavigate();
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [stats, setStats] = useState<ProbeDashboard | null>(null);
  const [status, setStatus] = useState<ProbeTestStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // 页面主 Tab（受控：勾选快速测试后自动切到「穿透测试」）；网段发现为第一子页
  const [tab, setTab] = useState('discover');
  const discovery = useDiscovery(tab === 'discover');
  // 服务器库同样走服务端分页（数据/轮询/跨页勾选由 hook 统一持有）
  const servers = useServers(tab === 'servers');
  const serverRows = servers.page.items;
  // 服务器表搜索框：本地受控 + 300ms 防抖
  const [serverSearch, setServerSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => servers.setSearch(serverSearch), 300);
    return () => clearTimeout(timer);
  }, [serverSearch, servers.setSearch]);
  const discoverRows = discovery.page.items;
  const dSelected = discovery.selected;
  const scanStatus = discovery.scanStatus;
  const routeStatus = discovery.routeStatus;

  // 发现表搜索框：本地受控 + 300ms 防抖后下沉到服务端查询
  const [discoverySearch, setDiscoverySearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => discovery.setSearch(discoverySearch), 300);
    return () => clearTimeout(timer);
  }, [discoverySearch, discovery.setSearch]);

  // 弹窗
  const [editing, setEditing] = useState<ProbeServer | 'new' | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleting, setDeleting] = useState<ProbeServer | null>(null);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [clearing, setClearing] = useState<'connectivity' | 'speed' | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [config, setConfig] = useState<ProbeTestConfig | null>(null);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [batchEdit, setBatchEdit] = useState<'group' | 'label' | null>(null);

  // 网段发现（分页数据、跨页勾选与轮询由 useDiscovery 统一持有）
  const [serverLabelFilter, setServerLabelFilter] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [dBatchEdit, setDBatchEdit] = useState<'group' | 'label' | null>(null);
  const [dDeleting, setDDeleting] = useState(false);
  const [importSelOpen, setImportSelOpen] = useState(false);
  const [routeNodesOpen, setRouteNodesOpen] = useState(false);

  // 测试
  const [scope, setScope] = useState<TestScope>('all');
  const [starting, setStarting] = useState(false);

  // 历史
  const [connHistory, setConnHistory] = useState<ProbeConnectivityHistory[]>([]);
  const [speedHistory, setSpeedHistory] = useState<ProbeSpeedHistory[]>([]);
  const [historyIp, setHistoryIp] = useState('');

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await probeApi.getConfig());
    } catch {
      /* 配置加载失败不阻塞页面，弹窗打开时会重试 */
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // 仪表盘（轻量，所有 Tab 头部都在用）：首屏 + 仅页面可见时 10s 一拍
  const loadDashboard = useCallback(async () => {
    try {
      setStats(await probeApi.dashboard());
    } catch {
      /* 仪表盘加载失败不阻塞页面 */
    } finally {
      setLoading(false);
    }
  }, []);
  const loadGroups = useCallback(async () => {
    try {
      setGroups(await probeApi.groups());
    } catch {
      /* 分组加载失败不阻塞页面 */
    }
  }, []);

  useEffect(() => {
    loadDashboard();
    loadGroups();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void loadDashboard();
    }, 10000);
    return () => clearInterval(timer);
  }, [loadDashboard, loadGroups]);

  const startRouteTest = async () => {
    const ids = [...discovery.selected];
    if (!ids.length) return;
    try {
      const result = await probeApi.routeStart(ids);
      toast.success(`已入队 ${result.enqueued} 台，等待路由节点领取测试`);
      discovery.setRouteStatus(await probeApi.routeStatus());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '入队失败');
    }
  };

  const loadHistory = useCallback(async (ip: string) => {
    try {
      const [conn, speed] = await Promise.all([
        probeApi.connectivityHistory(ip || undefined),
        probeApi.speedHistory(ip || undefined),
      ]);
      setConnHistory(conn);
      setSpeedHistory(speed);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '历史记录加载失败');
    }
  }, []);

  // 状态轮询：运行中 1.2s，空闲 6s；任务结束的瞬间刷新数据
  const wasRunning = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await probeApi.testStatus();
        if (cancelled) return;
        setStatus(next);
        if (wasRunning.current && !next.running) {
          loadDashboard();
          servers.refreshAll().catch(() => {});
          loadHistory(historyIp);
        }
        wasRunning.current = next.running;
      } catch {
        /* 轮询失败静默，下轮重试 */
      }
    };
    void tick();
    const timer = setInterval(tick, status?.running ? 1200 : 6000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [status?.running, loadDashboard, servers.refreshAll, loadHistory, historyIp]);

  useEffect(() => { loadHistory(historyIp); }, [loadHistory, historyIp]);

  /** 分组 → 组内服务器数：分组管理弹窗里标出空分组（提示先入组再绑域名）。 */
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { group, count } of servers.facets.groups) {
      counts.set(group, count);
    }
    return counts;
  }, [servers.facets.groups]);

  /** 分组名 → 颜色（徽章着色）。 */
  const groupColorMap = useMemo(() => {
    const map = new Map<string, GroupColor>();
    for (const group of groups) map.set(group.name, group.color);
    return map;
  }, [groups]);

  const discoverGroups = useMemo(() => (
    Array.from(new Set([
      ...groups.map((group) => group.name),
      ...discovery.facets.groups.map((group) => group.group),
    ])).filter(Boolean).sort()
  ), [groups, discovery.facets.groups]);

  // 发现表空态文案区分「完全没有数据」和「筛选无匹配」
  const discoveryHasFilter = Boolean(
    discovery.query.q?.trim()
    || discovery.query.group !== undefined
    || discovery.query.label !== undefined
    || discovery.query.library !== 'all'
  );

  const deleteDiscoverSelected = async () => {
    const ids = [...discovery.selected];
    if (!ids.length) return;
    try {
      const result = await probeApi.discoverDelete(ids);
      toast.success(`已删除 ${result.deleted} 条发现记录`);
      discovery.removeSelected(ids);
      setDDeleting(false);
      await discovery.refreshAll({ recoverOutOfRange: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    }
  };

  const selectedIps = useMemo(
    () => Array.from(servers.selected.values()).filter((ip): ip is string => typeof ip === 'string'),
    [servers.selected],
  );

  async function startTest(mode: 'connectivity' | 'speed' | 'full', ipsOverride?: string[]): Promise<boolean> {
    setStarting(true);
    try {
      const payload: { mode: typeof mode; ips?: string[]; group?: string } = { mode };
      if (ipsOverride?.length) payload.ips = ipsOverride;
      else if (scope === 'selected') payload.ips = selectedIps;
      else if (scope !== 'all') payload.group = scope;
      const result = await probeApi.startTest(payload);
      toast.success(`已开始${MODE_LABEL[mode]}测试（${result.count} 台）`);
      const next = await probeApi.testStatus();
      setStatus(next);
      wasRunning.current = next.running;
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '测试启动失败');
      return false;
    } finally {
      setStarting(false);
    }
  }

  /** 服务器库勾选后的一键测试：立即启动并切到「测试执行」页跟踪进度。 */
  async function quickTest(mode: 'connectivity' | 'speed' | 'full') {
    if (!selectedIps.length) return;
    const started = await startTest(mode, selectedIps);
    if (started) setTab('test');
  }

  async function skipCurrent() {
    try {
      const result = await probeApi.skipCurrent();
      if (!result.ok) toast.info('当前没有运行中的测试');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  }

  async function stopTest() {
    try {
      const result = await probeApi.stopTest();
      toast.success(result.ok ? '停止指令已下发，正在收尾' : '当前没有运行中的测试');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  }

  async function deleteServer() {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    try {
      await probeApi.deleteServer(target.id);
      toast.success(`${target.ip} 已删除`);
      servers.removeSelected([target.id]);
      servers.refreshAll({ recoverOutOfRange: true }).catch(() => {});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    }
  }

  /** 删除勾选的服务器（逐台调用，最后统一刷新）。 */
  async function deleteSelected() {
    const targets = [...servers.selected.entries()];
    setDeletingSelected(false);
    let failed = 0;
    for (const [id] of targets) {
      try {
        await probeApi.deleteServer(id);
      } catch {
        failed += 1;
      }
    }
    servers.removeSelected(targets.map(([id]) => id));
    if (failed) toast.warning(`已删除 ${targets.length - failed} 台，${failed} 台失败`);
    else toast.success(`已删除 ${targets.length} 台`);
    servers.refreshAll({ recoverOutOfRange: true }).catch(() => {});
  }

  async function clearHistory() {
    if (!clearing) return;
    const kind = clearing;
    setClearing(null);
    try {
      const result = await probeApi.clearHistory(kind);
      toast.success(`已清空 ${kind === 'connectivity' ? '连通性' : '速率'}历史（${result.deleted} 条）`);
      loadHistory(historyIp);
      servers.refreshAll().catch(() => {});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '清空失败');
    }
  }

  const running = status?.running ?? false;
  const percent = status && status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;

  return (
    <div className="mx-auto max-w-[1600px] px-6 py-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">服务器库</h2>
        <Badge tone="muted">frps 验收</Badge>
        <div className="ml-auto flex items-center gap-3">
          <ProbeStatCards stats={stats} />
          <Button size="sm" variant="outline"
            onClick={() => { loadDashboard(); servers.refreshAll().catch(() => {}); }} disabled={loading}>
            <RefreshCw size={13} />刷新
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="discover">网段发现</TabsTrigger>
          <TabsTrigger value="servers">服务器库</TabsTrigger>
          <TabsTrigger value="test">穿透测试</TabsTrigger>
          <TabsTrigger value="history">历史结果</TabsTrigger>
        </TabsList>

        {/* ---- 网段发现（第一子页） ---- */}
        {tab === 'discover' && <TabsContent value="discover" className="mt-4">
          <Card>
            <CardHeader className="flex-row flex-wrap items-center gap-2">
              <CardTitle className="text-sm">网段内开放 frps 端口的设备</CardTitle>
              <Badge tone="muted">{discovery.page.total} 条</Badge>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {scanStatus?.running ? (
                  <>
                    <Button size="sm" variant="destructive" onClick={() => probeApi.discoverStop().catch(() => {})}>
                      <Square size={13} />停止扫描
                    </Button>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {scanStatus.scanned} / {scanStatus.total} · 命中 {scanStatus.foundCount}
                    </span>
                  </>
                ) : (
                  <Button size="sm" onClick={() => setScanOpen(true)}>
                    <Radar size={13} />{discovery.page.total ? '再次扫描' : '开始扫描'}
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => discovery.refreshPage().catch(() => {})}>
                  <RefreshCw size={13} />刷新
                </Button>
                <Button size="sm" variant="outline" onClick={() => setRouteNodesOpen(true)}>
                  <Network size={13} />路由节点
                </Button>
              </div>
            </CardHeader>
            {(routeStatus?.active || (routeStatus && routeStatus.done + routeStatus.failed > 0)) && (
              <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2">
                <Badge tone="muted">路由追踪</Badge>
                <span className="text-xs tabular-nums text-muted-foreground">
                  待测 {routeStatus!.pending} · 进行 {routeStatus!.running} · 完成 {routeStatus!.done}
                  {routeStatus!.failed > 0 && ` · 失败 ${routeStatus!.failed}`}
                </span>
                {routeStatus!.runningTasks.slice(0, 2).map((task) => (
                  <span key={task.taskId} className="font-mono text-[11px] text-muted-foreground">
                    {task.ip}@{task.node}
                  </span>
                ))}
                {routeStatus!.active && (
                  <Button size="sm" variant="outline" className="ml-auto h-6 px-2 text-[11px]"
                    onClick={() => probeApi.routeStop().then(() => probeApi.routeStatus().then(discovery.setRouteStatus)).catch(() => {})}>
                    停止（清空队列）
                  </Button>
                )}
              </div>
            )}
            {scanStatus?.running && (
              <div className="px-4 pb-3">
                <Progress value={scanStatus.total > 0 ? Math.round((scanStatus.scanned / scanStatus.total) * 100) : 0} className="h-1.5" />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 border-y bg-muted/40 px-4 py-2">
              <div className="w-40">
                <Select value={discovery.query.group ?? 'all'} onValueChange={discovery.setGroup}>
                  <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="all">全部分组</SelectItem>
                      {discoverGroups.map((group) => (
                        <SelectItem key={group} value={group}>
                          <span className="flex items-center gap-1.5"><GroupDot color={groupColorMap.get(group)} />{group}</span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="w-32">
                <Select value={discovery.query.library} onValueChange={(value) => discovery.setLibrary(value as 'all' | 'new' | 'imported')}>
                  <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="all">全部状态</SelectItem>
                      <SelectItem value="new">未入库</SelectItem>
                      <SelectItem value="imported">已入库</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <Input
                className="h-8 w-44" value={discoverySearch} onChange={(e) => setDiscoverySearch(e.target.value)}
                placeholder="搜索 IP / 标签 / 分组"
              />
            </div>
            <LabelCloud labels={discovery.facets.labels} active={discovery.query.label ?? null} onToggle={discovery.setLabel} />
            {dSelected.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-4 py-2">
                <Badge tone="muted">已选 {dSelected.size} 条</Badge>
                <Button size="sm" onClick={() => setImportSelOpen(true)}>
                  <Download size={13} />导入服务器库
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDBatchEdit('group')}>
                  <FolderCog size={13} />改分组
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDBatchEdit('label')}>
                  <Tag size={13} />改标签
                </Button>
                <Button size="sm" onClick={startRouteTest}>
                  <Route size={13} />路由测试
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setDDeleting(true)}>
                  <Trash2 size={13} />删除
                </Button>
              </div>
            )}
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px]">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <Th><input type="checkbox" className="size-3.5 accent-[var(--primary)]"
                        disabled={!discoverRows.some((row) => !row.inLibrary)}
                        checked={discoverRows.some((row) => !row.inLibrary) && discoverRows.filter((row) => !row.inLibrary).every((row) => dSelected.has(row.id))}
                        onChange={(e) => discovery.toggleCurrentPage(e.target.checked)} /></Th>
                      <ThSort label="IP" sortKey="ip" activeKey={discovery.query.sort} asc={discovery.query.order === 'asc'} onSort={() => discovery.setSort('ip', discovery.query.sort === 'ip' && discovery.query.order === 'asc' ? 'desc' : 'asc')} />
                      <Th>端口</Th>
                      <ThSort label="延迟" sortKey="latency" activeKey={discovery.query.sort} asc={discovery.query.order === 'asc'} onSort={() => discovery.setSort('latency', discovery.query.sort === 'latency' && discovery.query.order === 'asc' ? 'desc' : 'asc')} />
                      <Th>分组</Th>
                      <Th>标签</Th>
                      <Th>状态</Th>
                      <ThSort label="发现时间" sortKey="discoveredAt" activeKey={discovery.query.sort} asc={discovery.query.order === 'asc'} onSort={() => discovery.setSort('discoveredAt', discovery.query.sort === 'discoveredAt' && discovery.query.order === 'desc' ? 'asc' : 'desc')} />
                      <Th align="right">操作</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {discoverRows.map((row) => (
                      <tr key={row.id} className="border-b last:border-b-0 transition-colors hover:bg-muted/50">
                        <Td>
                          <input type="checkbox" className="size-3.5 accent-[var(--primary)]"
                            checked={!row.inLibrary && dSelected.has(row.id)}
                            disabled={row.inLibrary}
                            onChange={() => discovery.toggleSelected(row.id)} />
                        </Td>
                        <Td><span className="font-mono text-[12px] font-medium">{row.ip}</span></Td>
                        <Td><span className="font-mono text-xs text-muted-foreground">{row.port}</span></Td>
                        <Td><span className="font-mono text-xs tabular-nums text-muted-foreground">{row.latencyMs} ms</span></Td>
                        <Td>{row.group ? <Badge variant={groupVariant(groupColorMap.get(row.group))} dot>{row.group}</Badge> : <span className="text-xs text-muted-foreground">—</span>}</Td>
                        <Td>
                          {row.labels.length ? (
                            <span className="flex flex-wrap items-center gap-1">
                              {row.labels.map((label) => (
                                <Badge key={label} variant={labelVariant(label)} dot={isRouteLabel(label)}>{label}</Badge>
                              ))}
                            </span>
                          ) : <span className="text-xs text-muted-foreground">—</span>}
                        </Td>
                        <Td>{row.inLibrary ? <Badge tone="muted">已入库</Badge> : <Badge tone="success">未入库</Badge>}</Td>
                        <Td><span className="whitespace-nowrap text-[11px] text-muted-foreground">{formatLastSeen(row.discoveredAt)}</span></Td>
                        <Td align="right">
                          {row.inLibrary ? (
                            <span className="text-[11px] text-muted-foreground">—</span>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => { discovery.setSelected(new Set([row.id])); setImportSelOpen(true); }}>
                              <Download size={13} />导入
                            </Button>
                          )}
                        </Td>
                      </tr>
                    ))}
                    {!discoverRows.length && (
                      <tr><td colSpan={9} className="px-4 py-10 text-center text-xs text-muted-foreground">
                        {discoveryHasFilter ? '当前筛选条件下没有匹配的记录' : '还没有发现记录，点「开始扫描」扫一段自有网段'}
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
                <span className="text-xs text-muted-foreground">
                  第 {discovery.page.page} / {Math.max(1, Math.ceil(discovery.page.total / discovery.page.pageSize))} 页
                </span>
                <div className="flex items-center gap-2">
                  <Select value={String(discovery.query.pageSize)} onValueChange={(value) => discovery.setPageSize(Number(value))}>
                    <SelectTrigger size="sm" className="w-24"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="25">25 / 页</SelectItem>
                      <SelectItem value="50">50 / 页</SelectItem>
                      <SelectItem value="100">100 / 页</SelectItem>
                      <SelectItem value="200">200 / 页</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button size="sm" variant="outline" disabled={discovery.page.page <= 1}
                    onClick={() => discovery.setPageNumber(discovery.page.page - 1)}>上一页</Button>
                  <Button size="sm" variant="outline"
                    disabled={discovery.page.page >= Math.max(1, Math.ceil(discovery.page.total / discovery.page.pageSize))}
                    onClick={() => discovery.setPageNumber(discovery.page.page + 1)}>下一页</Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>}

        {/* ---- 服务器库 ---- */}
        {tab === 'servers' && <TabsContent value="servers" className="mt-4">
          <Card>
            <CardHeader className="flex-row flex-wrap items-center gap-2">
              <CardTitle className="text-sm">候选 frps 服务器</CardTitle>
              <Badge tone="muted">{servers.page.total} 台</Badge>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <div className="w-40">
                  <Select value={servers.query.group ?? 'all'} onValueChange={servers.setGroup}>
                    <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="all">全部分组</SelectItem>
                        {groups.map((group) => (
                          <SelectItem key={group.name} value={group.name}>
                            <span className="flex items-center gap-1.5"><GroupDot color={group.color} />{group.name}</span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-36">
                  <Select value={servers.query.conn} onValueChange={(value) => servers.setConn(value as ServerConn)}>
                    <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="all">全部状态</SelectItem>
                        <SelectItem value="pass">连通性通过</SelectItem>
                        <SelectItem value="partial">部分通过</SelectItem>
                        <SelectItem value="fail">未通过</SelectItem>
                        <SelectItem value="untested">未测试</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <Input
                  className="h-8 w-44" value={serverSearch} onChange={(e) => setServerSearch(e.target.value)}
                  placeholder="搜索 IP / 标签 / 分组"
                />
                <Button size="sm" variant="outline" onClick={() => setGroupsOpen(true)}>
                  <FolderCog size={13} />分组管理
                </Button>
                <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
                  <ListPlus size={13} />批量导入
                </Button>
                <Button size="sm" onClick={() => setEditing('new')}><Plus size={13} />添加</Button>
              </div>
            </CardHeader>
            <LabelCloud labels={servers.facets.labels} active={servers.query.label ?? null} onToggle={servers.setLabel} />
            {selectedIps.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-4 py-2">
                <Badge tone="muted">已选 {selectedIps.length} 台（跨页保持）</Badge>
                <Button size="sm" variant="outline" onClick={() => quickTest('connectivity')} disabled={running || starting}>
                  <Play size={13} />测连通
                </Button>
                <Button size="sm" variant="outline" onClick={() => quickTest('speed')} disabled={running || starting}>
                  <Gauge size={13} />测速率
                </Button>
                <Button size="sm" onClick={() => quickTest('full')} disabled={running || starting}>
                  <Zap size={13} />完整测试
                </Button>
                <Button size="sm" variant="outline" onClick={() => setBatchEdit('group')}>
                  <FolderCog size={13} />改分组
                </Button>
                <Button size="sm" variant="outline" onClick={() => setBatchEdit('label')}>
                  <Tag size={13} />改标签
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setDeletingSelected(true)}>
                  <Trash2 size={13} />删除
                </Button>
                <Button size="sm" variant="ghost" onClick={() => servers.setSelected(new Map())}>
                  <X size={13} />清除勾选
                </Button>
                <span className="ml-auto text-[11px] text-muted-foreground">启动后自动跳转测试进度</span>
              </div>
            )}
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[960px]">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <Th>
                        <input
                          type="checkbox" aria-label="全选"
                          className="size-3.5 accent-[var(--primary)]"
                          checked={serverRows.length > 0 && serverRows.every((item) => servers.selected.has(item.id))}
                          onChange={(e) => servers.toggleCurrentPage(e.target.checked)}
                        />
                      </Th>
                      <ThSort label="服务器" sortKey="ip" activeKey={servers.query.sort} asc={servers.query.order === 'asc'}
                        onSort={() => servers.setSort('ip', servers.query.sort === 'ip' && servers.query.order === 'asc' ? 'desc' : 'asc')} />
                      <ThSort label="分组" sortKey="group" activeKey={servers.query.sort} asc={servers.query.order === 'asc'}
                        onSort={() => servers.setSort('group', servers.query.sort === 'group' && servers.query.order === 'asc' ? 'desc' : 'asc')} />
                      <ThSort label="连通性" sortKey="conn" activeKey={servers.query.sort} asc={servers.query.order === 'asc'}
                        onSort={() => servers.setSort('conn', servers.query.sort === 'conn' && servers.query.order === 'asc' ? 'desc' : 'asc')} />
                      <ThSort label="速率" sortKey="speed" activeKey={servers.query.sort} asc={servers.query.order === 'asc'}
                        onSort={() => servers.setSort('speed', servers.query.sort === 'speed' && servers.query.order === 'desc' ? 'asc' : 'desc')} />
                      <ThSort label="测速时间" sortKey="time" activeKey={servers.query.sort} asc={servers.query.order === 'asc'}
                        onSort={() => servers.setSort('time', servers.query.sort === 'time' && servers.query.order === 'desc' ? 'asc' : 'desc')} />
                      <Th align="right">操作</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {serverRows.map((item) => (
                      <tr key={item.id} className="border-b last:border-b-0 hover:bg-muted/50 transition-colors">
                        <Td>
                          <input
                            type="checkbox" aria-label={`选择 ${item.ip}`}
                            className="size-3.5 accent-[var(--primary)]"
                            checked={servers.selected.has(item.id)}
                            onChange={() => servers.toggleSelected(item.id, item.ip)}
                          />
                        </Td>
                        <Td>
                          <div className="font-mono text-[12px] font-medium">{item.ip}</div>
                          {item.labels.length > 0 && <div className="truncate text-[11px] text-muted-foreground">{item.labels.join(' · ')}</div>}
                        </Td>
                        <Td>{item.group ? <Badge variant={groupVariant(groupColorMap.get(item.group))} dot>{item.group}</Badge> : <span className="text-xs text-muted-foreground">—</span>}</Td>
                        <Td><ConnBadge latest={item.latestConnectivity} /></Td>
                        <Td><SpeedText latest={item.latestSpeed} /></Td>
                        <Td>
                          <span className="whitespace-nowrap text-xs text-muted-foreground">
                            {item.latestSpeed ? formatLastSeen(item.latestSpeed.testTime) : '—'}
                          </span>
                        </Td>
                        <Td align="right">
                          <div className="flex items-center justify-end gap-1">
                            <Button size="sm" variant="outline" onClick={() => navigate(`/create?server=${encodeURIComponent(item.ip)}`)} title="用此服务器创建 frpc 实例">
                              <Rocket size={13} />创建实例
                            </Button>
                            <Button size="icon-sm" variant="secondary" onClick={() => setEditing(item)} aria-label="编辑"><Pencil size={13} /></Button>
                            <Button size="icon-sm" variant="destructive" onClick={() => setDeleting(item)} aria-label="删除"><Trash2 size={13} /></Button>
                          </div>
                        </Td>
                      </tr>
                    ))}
                    {!serverRows.length && (
                      <tr><td colSpan={7} className="px-4 py-10 text-center text-xs text-muted-foreground">
                        {servers.page.total ? '当前筛选条件下没有匹配的记录' : '暂无服务器，点击「添加」或「批量导入」开始'}
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
                <span className="text-xs text-muted-foreground">
                  第 {servers.page.page} / {Math.max(1, Math.ceil(servers.page.total / servers.page.pageSize))} 页 · 共 {servers.page.total} 台
                </span>
                <div className="flex items-center gap-2">
                  <Select value={String(servers.query.pageSize)} onValueChange={(value) => servers.setPageSize(Number(value))}>
                    <SelectTrigger size="sm" className="w-24"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="25">25 / 页</SelectItem>
                      <SelectItem value="50">50 / 页</SelectItem>
                      <SelectItem value="100">100 / 页</SelectItem>
                      <SelectItem value="200">200 / 页</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button size="sm" variant="outline" disabled={servers.page.page <= 1}
                    onClick={() => servers.setPageNumber(servers.page.page - 1)}>上一页</Button>
                  <Button size="sm" variant="outline"
                    disabled={servers.page.page >= Math.max(1, Math.ceil(servers.page.total / servers.page.pageSize))}
                    onClick={() => servers.setPageNumber(servers.page.page + 1)}>下一页</Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>}

        {/* ---- 测试执行 ---- */}
        {tab === 'test' && <TabsContent value="test" className="mt-4">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
            <Card>
              <CardHeader><CardTitle className="text-sm">测试进度</CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-4">
                {running ? (
                  <>
                    <div className="flex items-center gap-3">
                      <Badge tone="success">{status?.phase === 'speed' ? '速率测试' : '连通性测试'}</Badge>
                      <span className="text-[11px] text-muted-foreground">
                        {status?.workers.length ?? 0} 台并行进行中
                      </span>
                      <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
                        {status?.done ?? 0}/{status?.total ?? 0}
                      </span>
                    </div>
                    <Progress value={percent} />
                    <div className="flex flex-col gap-1.5">
                      {(status?.workers ?? []).map((worker) => (
                        <div key={worker.ip} className="min-w-0 rounded-md bg-muted px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold">{worker.ip || '—'}</span>
                          </div>
                          <div className="mt-0.5 truncate text-xs text-foreground" title={worker.step}>{worker.step || '准备中…'}</div>
                          {worker.text && (
                            <div className="mt-0.5 truncate font-mono text-[11px] tabular-nums text-muted-foreground" title={worker.text}>
                              {worker.text}
                            </div>
                          )}
                        </div>
                      ))}
                      {!status?.workers.length && (
                        <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">准备中…</div>
                      )}
                    </div>
                    <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
                      <Button size="sm" variant="outline" onClick={skipCurrent}><ArrowRight size={13} />跳过进行中</Button>
                      <Button size="sm" variant="destructive" onClick={stopTest}><Square size={13} />停止测试</Button>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-input p-4">
                    <span className="text-sm font-medium">{status?.stopped ? '测试已停止' : status?.finishedAt ? '上轮测试已结束' : '空闲'}</span>
                    <span className="text-xs text-muted-foreground">
                      {status?.finishedAt
                        ? `完成于 ${formatLastSeen(status.finishedAt)} · ${status.done}/${status.total} 台`
                        : '从右侧选择范围并启动测试；测试在服务端执行，页面关闭不影响任务'}
                    </span>
                  </div>
                )}
                <div className="border-t border-border pt-3">
                  <div className="mb-2 text-[11px] font-medium text-muted-foreground">最近完成</div>
                  <RecentList recent={[...(status?.recent ?? [])].reverse()} />
                </div>
              </CardContent>
            </Card>

            <aside className="flex flex-col gap-4">
              <Card>
                <CardHeader className="flex-row items-center gap-2">
                  <CardTitle className="text-sm">启动测试</CardTitle>
                  <Button size="sm" variant="outline" className="ml-auto"
                    onClick={() => { loadConfig(); setConfigOpen(true); }}>
                    <Settings2 size={13} />测试设置
                  </Button>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs">测试范围</Label>
                    <Select value={scope} onValueChange={setScope} disabled={running}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="all">全部服务器（{stats?.servers ?? 0}）</SelectItem>
                          <SelectItem value="selected" disabled={!selectedIps.length}>
                            勾选的服务器（{selectedIps.length}）
                          </SelectItem>
                          {groups.map((group) => (
                            <SelectItem key={group.name} value={group.name}>
                              <span className="flex items-center gap-1.5"><GroupDot color={group.color} />分组：{group.name}</span>
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Button onClick={() => startTest('full')} disabled={running || starting || !(stats?.servers) || (scope === 'selected' && !selectedIps.length)}>
                      <Zap size={13} />一键完整测试
                    </Button>
                    <p className="text-[11px] leading-4 text-muted-foreground">连通性全过（可达 + 隧道 + 端口放行）的服务器自动续接速率测试</p>
                    <div className="grid grid-cols-2 gap-2">
                      <Button variant="outline" onClick={() => startTest('connectivity')} disabled={running || starting || !(stats?.servers) || (scope === 'selected' && !selectedIps.length)}>
                        <Play size={13} />连通性
                      </Button>
                      <Button variant="outline" onClick={() => startTest('speed')} disabled={running || starting || !(stats?.servers) || (scope === 'selected' && !selectedIps.length)}>
                        <Gauge size={13} />速率
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle className="text-sm">测试说明</CardTitle></CardHeader>
                <CardContent className="flex flex-col gap-2 text-[11px] leading-5 text-muted-foreground">
                  <p className="flex gap-2"><Download size={13} className="mt-0.5 shrink-0" />连通性：tcping frps 端口 → 建隧道 → 验证映射端口放行，单台约 15 秒。</p>
                  <p className="flex gap-2"><Upload size={13} className="mt-0.5 shrink-0" />速率：经双隧道实测上下行吞吐，单台最长约 70 秒。</p>
                  <p>测试流量绕 frps 一圈（本服务 ↔ frps），反映真实穿透链路质量；要求 frps 放行测试端口段。</p>
                </CardContent>
              </Card>
            </aside>
          </div>
        </TabsContent>}

        {/* ---- 历史结果 ---- */}
        {tab === 'history' && <TabsContent value="history" className="mt-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input
              className="h-8 w-56" value={historyIp} onChange={(e) => setHistoryIp(e.target.value)}
              placeholder="按 IP 筛选（如 1.2.3.4）"
            />
            <Badge tone="muted">连通性 {connHistory.length} 条</Badge>
            <Badge tone="muted">速率 {speedHistory.length} 条</Badge>
          </div>
          <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
            <Card>
              <CardHeader className="flex-row items-center">
                <CardTitle className="text-sm">连通性历史</CardTitle>
                <Button size="sm" variant="outline" className="ml-auto" onClick={() => setClearing('connectivity')} disabled={!connHistory.length}>
                  <Trash2 size={13} />清空
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px]">
                    <thead><tr className="border-b bg-muted/50"><Th>服务器</Th><Th>frps 可达</Th><Th>隧道</Th><Th>端口放行</Th><Th>备注</Th><Th>时间</Th></tr></thead>
                    <tbody>
                      {connHistory.map((row) => (
                        <tr key={row.id} className="border-b last:border-b-0 hover:bg-muted/50 transition-colors">
                          <Td><span className="font-mono text-[12px]">{row.serverIp}</span></Td>
                          <Td><Mark ok={row.frpsReachable} /></Td>
                          <Td><Mark ok={row.tunnelEstablished} /></Td>
                          <Td><Mark ok={row.firewallOpen} /></Td>
                          <Td><span className="max-w-56 truncate text-xs text-muted-foreground" title={row.detail}>{row.detail || '—'}</span></Td>
                          <Td><span className="whitespace-nowrap text-xs text-muted-foreground">{formatLastSeen(row.testTime)}</span></Td>
                        </tr>
                      ))}
                      {!connHistory.length && <tr><td colSpan={6} className="px-4 py-8 text-center text-xs text-muted-foreground">暂无记录</td></tr>}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex-row items-center">
                <CardTitle className="text-sm">速率历史</CardTitle>
                <Button size="sm" variant="outline" className="ml-auto" onClick={() => setClearing('speed')} disabled={!speedHistory.length}>
                  <Trash2 size={13} />清空
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px]">
                    <thead><tr className="border-b bg-muted/50"><Th>服务器</Th><Th>下载 Mbps</Th><Th>上传 Mbps</Th><Th>数据量 ↓/↑</Th><Th>备注</Th><Th>时间</Th></tr></thead>
                    <tbody>
                      {speedHistory.map((row) => (
                        <tr key={row.id} className="border-b last:border-b-0 hover:bg-muted/50 transition-colors">
                          <Td><span className="font-mono text-[12px]">{row.serverIp}</span></Td>
                          <Td>{row.downloadOk ? <span className="font-mono text-[11px] tabular-nums">{row.downloadMbps.toFixed(2)}</span> : <Mark ok={false} />}</Td>
                          <Td>{row.uploadOk ? <span className="font-mono text-[11px] tabular-nums">{row.uploadMbps.toFixed(2)}</span> : <Mark ok={false} />}</Td>
                          <Td>
                            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                              {(row.downloadBytes / 1048576).toFixed(1)}MB / {(row.uploadBytes / 1048576).toFixed(1)}MB
                            </span>
                          </Td>
                          <Td><span className="max-w-52 truncate text-xs text-muted-foreground" title={row.detail}>{row.detail || '—'}</span></Td>
                          <Td><span className="whitespace-nowrap text-xs text-muted-foreground">{formatLastSeen(row.testTime)}</span></Td>
                        </tr>
                      ))}
                      {!speedHistory.length && <tr><td colSpan={6} className="px-4 py-8 text-center text-xs text-muted-foreground">暂无记录</td></tr>}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>}
      </Tabs>

      {editing && (
        <ServerDialog
          server={editing === 'new' ? null : editing}
          groups={groups.map((group) => group.name)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            loadDashboard();
            servers.refreshAll().catch(() => {});
            loadGroups();
          }}
        />
      )}
      {importOpen && (
        <ImportDialog
          groups={groups.map((group) => group.name)}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            setImportOpen(false);
            loadDashboard();
            servers.refreshAll().catch(() => {});
            loadGroups();
          }}
        />
      )}
      {deleting && (
        <ConfirmOverlay
          title={`删除服务器 ${deleting.ip}`}
          description="只移除清单记录，历史测试结果保留。"
          confirmLabel="删除" variant="destructive"
          onCancel={() => setDeleting(null)} onConfirm={deleteServer}
        />
      )}
      {groupsOpen && (
        <GroupDialog
          groups={groups}
          groupCounts={groupCounts}
          onClose={() => setGroupsOpen(false)}
          onChanged={() => {
            loadGroups();
            discovery.refreshAll().catch(() => {});
            servers.refreshAll().catch(() => {});
          }}
        />
      )}
      {batchEdit && (
        <BatchEditDialog
          kind={batchEdit}
          ids={[...servers.selected.keys()]}
          count={servers.selected.size}
          groups={groups.map((group) => group.name)}
          cloudLabels={servers.facets.labels}
          onClose={() => setBatchEdit(null)}
          onSaved={() => {
            setBatchEdit(null);
            servers.refreshAll({ recoverOutOfRange: true }).catch(() => {});
            loadGroups();
          }}
        />
      )}
      {dBatchEdit && (
        <BatchEditDialog
          kind={dBatchEdit}
          ids={[...dSelected]}
          count={dSelected.size}
          groups={discoverGroups}
          cloudLabels={discovery.facets.labels}
          applyDiscover
          onClose={() => setDBatchEdit(null)}
          onSaved={() => { setDBatchEdit(null); discovery.refreshAll({ recoverOutOfRange: true }).catch(() => {}); }}
        />
      )}
      {scanOpen && (
        <ScanDialog
          defaultPort={config?.frpsPort ?? 7000}
          running={!!scanStatus?.running}
          onClose={() => setScanOpen(false)}
          onStarted={(next) => { setScanOpen(false); discovery.setScanStatus(next); setTab('discover'); }}
        />
      )}
      {importSelOpen && (
        <ImportSelectedDialog
          ids={[...dSelected]}
          count={dSelected.size}
          groups={discoverGroups}
          defaultGroup={discoverRows.find((row) => dSelected.has(row.id))?.group ?? ''}
          onClose={() => setImportSelOpen(false)}
          onDone={() => {
            const importedIds = [...dSelected];
            setImportSelOpen(false);
            discovery.removeSelected(importedIds);
            discovery.refreshAll({ recoverOutOfRange: true }).catch(() => {});
            loadDashboard();
          }}
        />
      )}
      {routeNodesOpen && (
        <RouteNodesDialog onClose={() => setRouteNodesOpen(false)} />
      )}
      {dDeleting && (
        <ConfirmOverlay
          title={`删除勾选的 ${dSelected.size} 条发现记录`}
          description="只删除网段发现结果，已入库的服务器不受影响。"
          confirmLabel="删除" variant="destructive"
          onCancel={() => setDDeleting(false)} onConfirm={deleteDiscoverSelected}
        />
      )}
      {configOpen && (
        <ConfigDialog
          config={config}
          running={running}
          onClose={() => setConfigOpen(false)}
          onSaved={(next) => { setConfig(next); setConfigOpen(false); }}
        />
      )}
      {deletingSelected && (
        <ConfirmOverlay
          title={`删除勾选的 ${selectedIps.length} 台服务器`}
          description="只移除清单记录，历史测试结果保留。"
          confirmLabel="删除" variant="destructive"
          onCancel={() => setDeletingSelected(false)} onConfirm={deleteSelected}
        />
      )}
      {clearing && (
        <ConfirmOverlay
          title={clearing === 'connectivity' ? '清空连通性历史' : '清空速率历史'}
          description="清空后不可恢复，服务器清单不受影响。"
          confirmLabel="清空" variant="destructive"
          onCancel={() => setClearing(null)} onConfirm={clearHistory}
        />
      )}
    </div>
  );
}

const MODE_LABEL: Record<'connectivity' | 'speed' | 'full', string> = {
  connectivity: '连通性', speed: '速率', full: '完整',
};

function Mark({ ok }: { ok: boolean }) {
  return ok
    ? <span className="text-[11px] font-medium text-primary">是</span>
    : <span className="text-[11px] text-muted-foreground">否</span>;
}

/** 添加 / 编辑服务器弹窗（项目惯用手写 overlay，见 NodeParts.ConfirmNodeAction）。 */
function ServerDialog({ server, groups, onClose, onSaved }: {
  server: ProbeServer | null;
  groups: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [ip, setIp] = useState(server?.ip ?? '');
  const [labels, setLabels] = useState((server?.labels ?? []).join(','));
  const [group, setGroup] = useState(server?.group ?? '');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!ip.trim()) { toast.error('请填写服务器地址'); return; }
    if (!group.trim()) { toast.error('请选择或输入分组'); return; }
    setSaving(true);
    try {
      const payload = {
        ip: ip.trim(),
        labels: labels.split(',').map((v) => v.trim()).filter(Boolean),
        group: group.trim(),
      };
      if (server) await probeApi.updateServer(server.id, payload);
      else await probeApi.createServer(payload);
      toast.success(server ? '服务器已更新' : '服务器已添加');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay title={server ? '编辑服务器' : '添加服务器'} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">服务器地址（IP 或域名）</Label>
          <Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="1.2.3.4 或 frps.example.com" autoFocus />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">标签（可选，多个用逗号分隔）</Label>
          <Input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="CN2,家宽" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">分组（必选，可输入新分组）</Label>
          <Input
            value={group} onChange={(e) => setGroup(e.target.value)}
            placeholder="选择建议或输入新分组" list="probe-group-options"
          />
          <datalist id="probe-group-options">
            {groups.map((name) => <option key={name} value={name} />)}
          </datalist>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button onClick={submit} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
      </div>
    </Overlay>
  );
}

/** 批量导入弹窗：粘贴 IP 行（每行「IP」或「IP 标签」）或 JSON 数组；分组必选。 */
function ImportDialog({ groups, onClose, onImported }: {
  groups: string[];
  onClose: () => void;
  onImported: () => void;
}) {
  const [text, setText] = useState('');
  const [group, setGroup] = useState('');
  const [importing, setImporting] = useState(false);

  const submit = async () => {
    if (!text.trim()) { toast.error('请粘贴要导入的内容'); return; }
    if (!group) { toast.error('请选择导入分组'); return; }
    setImporting(true);
    try {
      const result = await probeApi.importServers({ text, group });
      toast.success(`导入完成：新增 ${result.inserted} 台，跳过已存在 ${result.skipped} 台`);
      onImported();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Overlay title="批量导入服务器" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">导入分组（必选）</Label>
          <Select value={group} onValueChange={setGroup}>
            <SelectTrigger><SelectValue placeholder="选择分组（可在「分组管理」中提前创建）" /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {groups.length
                  ? groups.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)
                  : <div className="px-3 py-2 text-xs text-muted-foreground">还没有分组，请先在「分组管理」创建</div>}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">导入内容</Label>
          <Textarea
            rows={10} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={'每行一台：IP 或「IP 标签」\n1.2.3.4\n5.6.7.8 香港VPS\n\n也支持 JSON：[{"ip":"1.2.3.4","label":"A","group":"g"}]'}
            className="max-h-56 min-h-36 overflow-y-auto font-mono text-xs"
          />
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">已存在的 IP 自动跳过；JSON 行自带分组时以行内分组优先；原「FRPC穿透测试」项目导出的 JSON 可直接粘贴。</p>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button onClick={submit} disabled={importing}>{importing ? '导入中…' : '导入'}</Button>
      </div>
    </Overlay>
  );
}

/** 分组管理弹窗：创建/重命名/删除 + 颜色标记（红黄蓝绿，区分不同情况的服务器分组）。 */
function GroupDialog({ groups, groupCounts, onClose, onChanged }: {
  groups: GroupInfo[];
  groupCounts: Map<string, number>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const create = async () => {
    if (!name.trim()) { toast.error('请填写分组名'); return; }
    setBusy(true);
    try {
      await probeApi.createGroup(name.trim());
      setName('');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target: string) => {
    setBusy(true);
    try {
      await probeApi.deleteGroup(target);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  const startRename = (target: string) => {
    setRenaming(target);
    setRenameValue(target);
  };

  const confirmRename = async () => {
    if (!renaming) return;
    const next = renameValue.trim();
    if (!next) { toast.error('新分组名不能为空'); return; }
    if (next === renaming) { setRenaming(null); return; }
    setBusy(true);
    try {
      await probeApi.renameGroup(renaming, next);
      toast.success(`分组已重命名：${renaming} → ${next}（服务器/发现记录/负载均衡绑定已同步）`);
      setRenaming(null);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重命名失败');
    } finally {
      setBusy(false);
    }
  };

  const setColor = async (groupName: string, color: GroupColor) => {
    setBusy(true);
    try {
      await probeApi.setGroupColor(groupName, color);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '设置颜色失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay title="分组管理" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="flex items-end gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label className="text-xs">新建分组</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：阿里云ECS深圳" onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
          </div>
          <Button onClick={create} disabled={busy || !name.trim()}><Plus size={13} />创建</Button>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="text-[11px] font-medium text-muted-foreground">已有分组（含服务器正在使用的分组）· 点色点设置颜色</div>
          {groups.length ? (
            <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {groups.map(({ name: item, color }) => {
                const count = groupCounts.get(item) ?? 0;
                const isRenaming = renaming === item;
                const swatches: GroupColor[] = ['red', 'yellow', 'blue', 'green'];
                return (
                  <div key={item} className="flex flex-wrap items-center gap-2 rounded-md bg-muted/60 px-2.5 py-1.5">
                    {isRenaming ? (
                      <>
                        <Input
                          className="h-7 min-w-0 flex-1 text-[12px]" value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') confirmRename(); if (e.key === 'Escape') setRenaming(null); }}
                          autoFocus aria-label={`重命名分组 ${item}`} />
                        <Button size="sm" onClick={confirmRename} disabled={busy || !renameValue.trim()}>确定</Button>
                        <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>取消</Button>
                      </>
                    ) : (
                      <>
                        <Badge variant={groupVariant(color)} dot className="max-w-36">{item}</Badge>
                        <div className="flex items-center gap-1" role="group" aria-label={`分组 ${item} 颜色`}>
                          <button type="button" onClick={() => setColor(item, '')} disabled={busy}
                            className={cn('grid size-4 place-items-center rounded-full border border-border text-[9px] text-muted-foreground hover:border-foreground/40', color === '' && 'ring-2 ring-ring/50')}
                            title="无色" aria-label="无色">✕</button>
                          {swatches.map((swatch) => (
                            <button key={swatch} type="button" onClick={() => setColor(item, swatch)} disabled={busy}
                              className={cn('size-4 rounded-full border border-black/10 dark:border-white/10', GroupDotClass(swatch), color === swatch && 'ring-2 ring-ring/50 ring-offset-1 ring-offset-card')}
                              title={COLOR_LABELS[swatch]} aria-label={`${COLOR_LABELS[swatch]}色`} />
                          ))}
                        </div>
                        <span className="ml-auto whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
                          {count > 0 ? `${count} 台` : <span title="测通服务器后勾选批量改入该分组（即入池），再到负载均衡绑定域名">空 · 待入组</span>}
                        </span>
                        <Button size="icon-sm" variant="ghost" onClick={() => startRename(item)} disabled={busy}
                          aria-label={`重命名分组 ${item}`} title="重命名分组（服务器/发现记录/负载均衡绑定同步更新）">
                          <Pencil size={13} />
                        </Button>
                        <Button size="icon-sm" variant="ghost" onClick={() => remove(item)} disabled={busy} aria-label={`删除分组 ${item}`} title="删除预创建记录（不影响已归入该分组的服务器）">
                          <Trash2 size={13} />
                        </Button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-input p-4 text-center text-xs text-muted-foreground">还没有分组</div>
          )}
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">颜色用于在服务器库 / 网段发现 / 负载均衡中快速区分不同情况的分组；重命名会同步更新服务器、发现结果与负载均衡绑定；删除只移除预创建记录。</p>
      </div>
    </Overlay>
  );
}

/** 勾选批量修改弹窗：改分组（必选）或改标签（可空=清除）；服务器表改组成功后引导去负载均衡绑域名。
 * applyDiscover=true 时作用于网段发现结果表。 */
function BatchEditDialog({ kind, ids, count, groups, cloudLabels, applyDiscover, onClose, onSaved }: {
  kind: 'group' | 'label';
  ids: number[];
  count: number;
  groups: string[];
  /** 标签云（facets 全局标签，供快选） */
  cloudLabels: LabelCount[];
  applyDiscover?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const navigate = useNavigate();
  const [group, setGroup] = useState('');
  const [addLabels, setAddLabels] = useState<string[]>([]);
  const [removeLabels, setRemoveLabels] = useState<string[]>([]);
  const [attached, setAttached] = useState<LabelCount[]>([]);
  const [custom, setCustom] = useState('');
  const [saving, setSaving] = useState(false);

  // 所选行已贴标签聚合（跨页由服务端预览接口聚合）；ids 序列化做依赖，避免父组件渲染重复请求
  const idsKey = ids.join(',');
  useEffect(() => {
    if (kind !== 'label' || !idsKey) return;
    let cancelled = false;
    const idList = idsKey.split(',').map(Number).filter(Number.isFinite);
    const preview = applyDiscover ? probeApi.discoverLabelsPreview(idList) : probeApi.serversLabelsPreview(idList);
    preview.then((res) => { if (!cancelled) setAttached(res.labels); }).catch(() => { if (!cancelled) setAttached([]); });
    return () => { cancelled = true; };
  }, [kind, idsKey, applyDiscover]);

  const toggleAdd = (label: string) => {
    setAddLabels((current) => current.includes(label)
      ? current.filter((v) => v !== label)
      : [...current, label]);
    setRemoveLabels((current) => current.filter((v) => v !== label));
  };
  const toggleRemove = (label: string) => {
    setRemoveLabels((current) => current.includes(label)
      ? current.filter((v) => v !== label)
      : [...current, label]);
    setAddLabels((current) => current.filter((v) => v !== label));
  };
  const addCustom = () => {
    const parts = custom.split(',').map((v) => v.trim()).filter(Boolean);
    if (!parts.length) return;
    setAddLabels((current) => [...current, ...parts.filter((v) => !current.includes(v))]);
    setCustom('');
  };

  const submit = async () => {
    if (!ids.length) return;
    if (kind === 'group' && !group) { toast.error('请选择分组'); return; }
    if (kind === 'label' && !addLabels.length && !removeLabels.length) {
      toast.error('请至少选择要添加或移除的标签');
      return;
    }
    setSaving(true);
    try {
      if (applyDiscover) {
        const result = await probeApi.discoverUpdateBatch(ids, {
          group: kind === 'group' ? group : undefined,
          addLabels: kind === 'label' ? addLabels : undefined,
          removeLabels: kind === 'label' ? removeLabels : undefined,
        });
        toast.success(`已更新 ${result.updated} 条`);
      } else {
        const changes = kind === 'group'
          ? { group }
          : { addLabels, removeLabels };
        const result = await probeApi.batchUpdateServers(ids, changes);
        if (kind === 'group') {
          toast.success(`已更新 ${result.updated} 台（入组 ${group}）`, {
            duration: 6000,
            action: { label: '去负载均衡绑域名', onClick: () => navigate('/lb') },
          });
        } else {
          toast.success(`已更新 ${result.updated} 台`);
        }
      }
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败');
    } finally {
      setSaving(false);
    }
  };

  const chipCls = (active: boolean, danger = false) => cn(
    'rounded-full px-2.5 py-0.5 text-[11px] transition-colors',
    active
      ? (danger ? 'bg-destructive text-destructive-foreground' : 'bg-primary text-primary-foreground')
      : 'bg-muted text-muted-foreground hover:text-foreground',
  );

  return (
    <Overlay title={kind === 'group'
      ? `更改分组（${count} ${applyDiscover ? '条' : '台'}）`
      : `批量标签（${count} ${applyDiscover ? '条' : '台'}）`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {kind === 'group' ? (
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">目标分组</Label>
            <Select value={group} onValueChange={setGroup}>
              <SelectTrigger><SelectValue placeholder="选择分组" /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {groups.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">已贴标签（点击 = 从所选行移除）</Label>
              {attached.length ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {attached.map(({ label, count: n }) => (
                    <button key={label} type="button" className={chipCls(removeLabels.includes(label), true)}
                      onClick={() => toggleRemove(label)}>
                      {label}<span className="ml-1 opacity-70">×{n}</span>
                    </button>
                  ))}
                </div>
              ) : <span className="text-[11px] text-muted-foreground">所选行还没有标签</span>}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">标签云（点击 = 添加到所选行）</Label>
              {cloudLabels.length ? (
                <div className="flex max-h-28 flex-wrap items-center gap-1.5 overflow-y-auto">
                  {cloudLabels.map(({ label }) => (
                    <button key={label} type="button" className={chipCls(addLabels.includes(label))}
                      onClick={() => toggleAdd(label)}>{label}</button>
                  ))}
                </div>
              ) : <span className="text-[11px] text-muted-foreground">还没有任何标签</span>}
            </div>
            <div className="flex items-center gap-2">
              <Input value={custom} onChange={(e) => setCustom(e.target.value)}
                placeholder="手动添加新标签" autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }} />
              <Button variant="outline" size="sm" onClick={addCustom}><Plus size={13} />添加</Button>
            </div>
            {(addLabels.length > 0 || removeLabels.length > 0) && (
              <div className="text-[11px] text-muted-foreground">
                将添加：{addLabels.join('、') || '（无）'}；将移除：{removeLabels.join('、') || '（无）'}
              </div>
            )}
          </>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button onClick={submit} disabled={saving}>{saving ? '更新中…' : '更新'}</Button>
      </div>
    </Overlay>
  );
}

/** 测试配置字段定义（key 与后端 _CAMEL_KEYS 对齐）。 */
const CONFIG_FIELDS: { key: keyof Omit<ProbeTestConfig, 'hasOverride' | 'running'>; label: string; hint: string; step?: string }[] = [
  { key: 'frpsPort', label: 'frps 服务端口', hint: '候选服务器上 frps 的监听端口' },
  { key: 'basePort', label: '测试端口组起始', hint: '连通性=x，下载=x+1，上传=x+2；frps 侧需放行这三个端口' },
  { key: 'tcpingTimeout', label: 'tcping 超时（秒）', hint: '单次探测超时', step: '0.5' },
  { key: 'tcpingRetries', label: 'tcping 重试次数', hint: '仅超时重试，连接被拒绝直接失败' },
  { key: 'tunnelWait', label: '等待隧道（秒）', hint: 'frpc 建立隧道的上限，日志确认后会提前返回' },
  { key: 'speedDuration', label: '测速时长（秒）', hint: '上下行各测一次的时限' },
  { key: 'connConcurrency', label: '连通性并行数', hint: '无带宽占用，可较高' },
  { key: 'speedConcurrency', label: '速率并行数', hint: '并发会分摊带宽，追求精确设 1' },
];

/** 测试配置弹窗：面板内临时调整端口/超时/并发，保存后下一次测试生效。 */
function ConfigDialog({ config, running, onClose, onSaved }: {
  config: ProbeTestConfig | null;
  running: boolean;
  onClose: () => void;
  onSaved: (next: ProbeTestConfig) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    if (config) {
      for (const field of CONFIG_FIELDS) initial[field.key] = String(config[field.key]);
    }
    return initial;
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!config) return;
    setValues((prev) => {
      const next = { ...prev };
      for (const field of CONFIG_FIELDS) {
        if (next[field.key] === undefined) next[field.key] = String(config[field.key]);
      }
      return next;
    });
  }, [config]);

  const submit = async () => {
    setSaving(true);
    try {
      const next = await probeApi.updateConfig(values);
      toast.success('测试配置已保存，下次测试生效');
      onSaved(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay title="测试设置" onClose={onClose} wide>
      <div className="flex flex-col gap-3.5">
        {config?.hasOverride && (
          <div className="rounded-md bg-primary/10 px-3 py-2 text-[11px] text-foreground">
            当前部分配置为面板覆盖值（未改回默认时持续生效）。
          </div>
        )}
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          {CONFIG_FIELDS.map((field) => (
            <div key={field.key} className="flex flex-col gap-1.5">
              <Label className="text-xs">{field.label}</Label>
              <Input
                value={values[field.key] ?? ''}
                type={field.step ? 'number' : 'text'}
                inputMode="numeric"
                step={field.step}
                disabled={running}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              />
              <span className="text-[10px] leading-4 text-muted-foreground">{field.hint}</span>
            </div>
          ))}
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">
          保存后持久化在 Console 数据库并立即对后续测试生效；容器部署时也无需改环境变量重启。
        </p>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button onClick={submit} disabled={saving || running}>{running ? '测试进行中…' : '保存'}</Button>
      </div>
    </Overlay>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <th className={`whitespace-nowrap px-4 py-2.5 text-[11px] font-medium text-muted-foreground ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</th>;
}

function ThSort({ label, sortKey, activeKey, asc, onSort }: {
  label: string;
  sortKey: string;
  activeKey: string;
  asc: boolean;
  onSort: (key: string) => void;
}) {
  const active = activeKey === sortKey;
  const Icon = !active ? ArrowUpDown : asc ? ArrowUp : ArrowDown;
  return (
    <th className="whitespace-nowrap px-4 py-2.5 text-[11px] font-medium text-muted-foreground">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 rounded transition-colors hover:text-foreground ${active ? 'text-foreground' : ''}`}
      >
        {label}
        <Icon size={11} className={active ? '' : 'opacity-40'} />
      </button>
    </th>
  );
}
function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <td className={`px-4 py-3 align-middle ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</td>;
}

/** 标签云：两个表格共用的标签筛选（点击切换，带计数）。 */
function LabelCloud({ labels, active, onToggle }: {
  labels: LabelCount[];
  active: string | null;
  onToggle: (label: string | null) => void;
}) {
  if (!labels.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2">
      {labels.map(({ label, count }) => (
        <button
          key={label}
          type="button"
          onClick={() => onToggle(active === label ? null : label)}
          className={cn(
            'rounded-full px-2.5 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            active === label
              ? 'bg-primary text-primary-foreground'
              : isRouteLabel(label)
                ? (label === 'CN2'
                    ? 'bg-primary/15 text-primary'
                    : label === '非CN2' ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground')
                : 'bg-muted text-muted-foreground hover:text-foreground',
          )}
          aria-pressed={active === label}
        >
          {label}<span className="ml-1 opacity-70">{count}</span>
        </button>
      ))}
      {active && (
        <button type="button" onClick={() => onToggle(null)}
          className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground">
          清除标签筛选
        </button>
      )}
    </div>
  );
}

/** 扫描参数弹窗：目标/排除/端口/并发/超时 → 开始扫描（命中自动落入网段发现表格）。 */
function ScanDialog({ defaultPort, running, onClose, onStarted }: {
  defaultPort: number;
  running: boolean;
  onClose: () => void;
  onStarted: (status: DiscoverStatus) => void;
}) {
  const [targets, setTargets] = useState('');
  const [exclude, setExclude] = useState('');
  const [sourceUrl, setSourceUrl] = useState(() => localStorage.getItem('discover_source_url') || '');
  const [port, setPort] = useState(String(defaultPort));
  const [concurrency, setConcurrency] = useState('500');
  const [probeTimeout, setProbeTimeout] = useState('1.5');
  const [autoRoute, setAutoRoute] = useState(() => localStorage.getItem('discover_auto_route') === '1');
  const [starting, setStarting] = useState(false);

  const start = async () => {
    const url = sourceUrl.trim();
    if (!targets.trim() && !url) { toast.error('请填写目标网段或订阅链接'); return; }
    if (url && !/^https?:\/\//i.test(url)) { toast.error('订阅链接必须是 http/https 地址'); return; }
    setStarting(true);
    localStorage.setItem('discover_auto_route', autoRoute ? '1' : '0');
    localStorage.setItem('discover_source_url', url);
    try {
      const status = await probeApi.discoverStart({
        targets,
        exclude: exclude.trim() || undefined,
        sourceUrl: url || undefined,
        port: port.trim() ? Number(port) : undefined,
        concurrency: concurrency.trim() ? Number(concurrency) : undefined,
        timeout: probeTimeout.trim() ? Number(probeTimeout) : undefined,
        autoRoute,
      });
      toast.success(`扫描已启动（目标 ${status.total} 个 IP）`);
      onStarted(status);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '启动扫描失败');
    } finally {
      setStarting(false);
    }
  };

  return (
    <Overlay title="开始扫描（自有网段）" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <p className="text-[11px] leading-4 text-muted-foreground">
          扫描自己有权管理的网段（内网 / 自有 VPS 段），找出开放 frps 端口的设备；命中自动进入网段发现列表，勾选即可导入服务器库。
          仅做资产发现，请勿扫描未授权网络。
        </p>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">目标网段（CIDR / IP 段 / 单 IP，逗号或换行分隔）</Label>
          <Textarea
            value={targets} onChange={(e) => setTargets(e.target.value)}
            placeholder={'10.0.0.0/24\n192.168.1.1-192.168.1.254\n172.16.0.1-254'}
            className="max-h-32 font-mono text-xs" disabled={running || starting}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">订阅链接（可选，txt 一行一个网段，下载后与上方目标合并）</Label>
          <Input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://example.com/subnets.txt" disabled={running || starting} />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">排除</Label>
            <Input value={exclude} onChange={(e) => setExclude(e.target.value)}
              placeholder="10.0.0.1,10.0.9.0/24" disabled={running || starting} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">frps 端口</Label>
            <Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" disabled={running || starting} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">并发</Label>
            <Input value={concurrency} onChange={(e) => setConcurrency(e.target.value)} inputMode="numeric" disabled={running || starting} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">超时（秒）</Label>
            <Input value={probeTimeout} onChange={(e) => setProbeTimeout(e.target.value)} inputMode="decimal" disabled={running || starting} />
          </div>
        </div>
        <label className="flex items-center gap-2 rounded-md bg-muted px-3 py-2">
          <input
            type="checkbox" checked={autoRoute}
            onChange={(e) => setAutoRoute(e.target.checked)}
            disabled={running || starting}
            className="size-3.5 accent-[var(--primary)]"
          />
          <span className="text-xs">扫描后自动路由追踪（新发现的设备立即入队测 CN2，需已部署路由节点）</span>
        </label>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button onClick={start} disabled={starting || running}>
          <Radar size={13} />{starting ? '启动中…' : '开始扫描'}
        </Button>
      </div>
    </Overlay>
  );
}

/** 勾选导入服务器库弹窗：选目标分组（默认取所选记录自身分组），标签随行带入。 */
function ImportSelectedDialog({ ids, count, groups, defaultGroup, onClose, onDone }: {
  ids: number[];
  count: number;
  groups: string[];
  defaultGroup: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const [group, setGroup] = useState(defaultGroup);
  const [importing, setImporting] = useState(false);

  const submit = async () => {
    if (!ids.length) return;
    setImporting(true);
    try {
      const result = await probeApi.discoverImport(ids, group || undefined);
      toast.success(`导入完成：新增 ${result.inserted} 台，跳过已在库 ${result.skipped} 台`, {
        duration: 6000,
        action: { label: '去跑穿透测试', onClick: () => navigate('/probe') },
      });
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Overlay title={`导入服务器库（${count} 条）`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">目标分组{defaultGroup ? '（默认取记录自身分组）' : ''}</Label>
          <Select value={group} onValueChange={setGroup}>
            <SelectTrigger><SelectValue placeholder="选择分组" /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {groups.length
                  ? groups.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)
                  : <div className="px-3 py-2 text-xs text-muted-foreground">还没有分组，先到「分组管理」创建</div>}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">
          只导入未入库的记录；记录上的标签会一并带入。导入后可到「穿透测试」子页直接开测。
        </p>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button onClick={submit} disabled={importing}>{importing ? '导入中…' : '导入'}</Button>
      </div>
    </Overlay>
  );
}

/** 路由节点管理弹窗：多节点部署（各自 Token）、在线状态、删除吊销。 */
function RouteNodesDialog({ onClose }: { onClose: () => void }) {
  const [nodes, setNodes] = useState<RouteNodeInfo[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);

  const load = useCallback(() => {
    probeApi.routeNodes().then(setNodes).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const create = async () => {
    if (!name.trim()) { toast.error('请填写节点名称'); return; }
    setBusy(true);
    try {
      const node = await probeApi.routeNodeCreate(name.trim());
      setCreated(node);
      setName('');
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target: string) => {
    setBusy(true);
    try {
      await probeApi.routeNodeDelete(target);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay title="路由节点（国内服务器 · CN2 测试）" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <p className="text-[11px] leading-4 text-muted-foreground">
          节点无需公网 IP：部署 scripts/route_node 的脚本后，它主动轮询主控领任务，用本机 mtr 测去程路由并判定 CN2（任一跳 59.43.*）。
          多节点自动负载均衡；某节点掉线，其任务 2 分钟内自动转派其他节点。
        </p>

        <div className="flex items-end gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label className="text-xs">新增节点（如：杭州节点）</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="节点名称" onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
          </div>
          <Button onClick={create} disabled={busy || !name.trim()}><Plus size={13} />生成 Token</Button>
        </div>

        {created && (
          <div className="flex flex-col gap-1.5 rounded-md border border-primary/40 bg-primary/5 px-3 py-2">
            <div className="text-xs font-medium">节点「{created.name}」的 Token（只显示这一次，请立即复制）：</div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[12px]">{created.token}</code>
              <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(created.token).then(() => toast.success('已复制'))}>复制</Button>
            </div>
            <div className="text-[11px] text-muted-foreground">
              节点机环境变量：CONSOLE_URL=主控地址、ROUTE_TOKEN=上面的 Token（部署见 scripts/route_node/README.md）
            </div>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="text-[11px] font-medium text-muted-foreground">已部署节点</div>
          {nodes.length ? (
            <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
              {nodes.map((node) => (
                <div key={node.name} className="flex items-center gap-2 rounded-md bg-muted/60 px-2.5 py-1.5">
                  <Badge tone={node.online ? 'success' : 'muted'} dot>{node.online ? '在线' : '离线'}</Badge>
                  <span className="min-w-0 flex-1 truncate text-[12px]">{node.name}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{node.tokenMasked}</span>
                  <Button size="icon-sm" variant="ghost" onClick={() => remove(node.name)} disabled={busy}
                    aria-label={`删除节点 ${node.name}`} title="删除节点（Token 即时吊销）">
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-input p-4 text-center text-xs text-muted-foreground">
              还没有节点——生成 Token 后按 README 部署到国内服务器
            </div>
          )}
        </div>
      </div>
    </Overlay>
  );
}
