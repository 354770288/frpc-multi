import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowDown, ArrowRight, ArrowUp, ArrowUpDown, Download, FolderCog, Gauge, ListPlus,
  Pencil, Play, Plus, Radar, RefreshCw, Rocket, Settings2, Square, Tag, Trash2, Upload, X, Zap,
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
import { ConfirmOverlay, Overlay } from '../components/Overlay';
import type {
  DiscoverStatus, ProbeConnectivityHistory, ProbeConnectivitySummary, ProbeDashboard,
  ProbeServer, ProbeSpeedHistory, ProbeTestConfig, ProbeTestStatus,
} from '../lib/types';

type TestScope = 'all' | 'selected' | string; // 'all' | 'selected' | 分组名
type SortKey = 'none' | 'ip' | 'group' | 'conn' | 'speed' | 'time';

/** IPv4 按段数值比较（10.0.0.2 < 10.0.0.10），其他按字典序。 */
function compareIp(a: string, b: string): number {
  const seg = (ip: string) => ip.split('.');
  if (seg(a).length === 4 && seg(b).length === 4 && [...a, ...b].every((s) => /^\d+$/.test(s))) {
    const left = seg(a).map(Number);
    const right = seg(b).map(Number);
    for (let i = 0; i < 4; i += 1) {
      if (left[i] !== right[i]) return left[i] - right[i];
    }
    return 0;
  }
  return a.localeCompare(b);
}

/** 连通性状态分级：未测 < 不可达 < 可达 < 隧道 < 全通过。 */
function connScore(latest: ProbeConnectivitySummary | null): number {
  if (!latest) return 0;
  if (latest.frpsReachable && latest.tunnelEstablished && latest.firewallOpen) return 4;
  if (latest.frpsReachable && latest.tunnelEstablished) return 3;
  if (latest.frpsReachable) return 2;
  return 1;
}

export function Probe() {
  const navigate = useNavigate();
  const [servers, setServers] = useState<ProbeServer[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [stats, setStats] = useState<ProbeDashboard | null>(null);
  const [status, setStatus] = useState<ProbeTestStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // 服务器表：筛选 + 勾选 + 排序
  const [groupFilter, setGroupFilter] = useState('all');
  const [connFilter, setConnFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>('none');
  const [sortAsc, setSortAsc] = useState(true);

  // 页面主 Tab（受控：勾选快速测试后自动切到「测试执行」）
  const [tab, setTab] = useState('servers');

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
  const [discoverOpen, setDiscoverOpen] = useState(false);

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

  const loadServers = useCallback(async () => {
    try {
      const [list, dash, groupList] = await Promise.all([
        probeApi.servers(), probeApi.dashboard(), probeApi.groups(),
      ]);
      setServers(list);
      setStats(dash);
      setGroups(groupList);
      setSelectedIds((prev) => {
        const alive = new Set(list.map((item) => item.id));
        const next = new Set([...prev].filter((id) => alive.has(id)));
        return next.size === prev.size ? prev : next;
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '服务器列表加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

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

  useEffect(() => {
    loadServers();
    const timer = setInterval(loadServers, 10000);
    return () => clearInterval(timer);
  }, [loadServers]);

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
          loadServers();
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
  }, [status?.running, loadServers, loadHistory, historyIp]);

  useEffect(() => { loadHistory(historyIp); }, [loadHistory, historyIp]);

  /** 分组 → 组内服务器数：分组管理弹窗里标出空分组（提示先入组再绑域名）。 */
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const server of servers) {
      if (server.group) counts.set(server.group, (counts.get(server.group) ?? 0) + 1);
    }
    return counts;
  }, [servers]);

  const filtered = useMemo(() => servers.filter((item) => {    if (groupFilter !== 'all' && item.group !== groupFilter) return false;
    const score = connScore(item.latestConnectivity);
    if (connFilter === 'pass' && score !== 4) return false;
    if (connFilter === 'partial' && (score <= 1 || score === 4)) return false;
    if (connFilter === 'fail' && (score === 0 || score === 4)) return false;
    if (connFilter === 'untested' && score !== 0) return false;
    const keyword = search.trim().toLowerCase();
    if (!keyword) return true;
    return item.ip.toLowerCase().includes(keyword)
      || item.label.toLowerCase().includes(keyword)
      || item.group.toLowerCase().includes(keyword);
  }), [servers, groupFilter, connFilter, search]);

  const displayList = useMemo(() => {
    if (sortKey === 'none') return filtered;
    const dir = sortAsc ? 1 : -1;
    const timeOf = (item: ProbeServer) => item.latestSpeed?.testTime || item.latestConnectivity?.testTime || '';
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case 'ip': return compareIp(a.ip, b.ip) * dir;
        case 'group': return (a.group || '\uffff').localeCompare(b.group || '\uffff') * dir;
        case 'conn': return (connScore(a.latestConnectivity) - connScore(b.latestConnectivity)) * dir;
        case 'speed': return ((a.latestSpeed?.downloadMbps ?? -1) - (b.latestSpeed?.downloadMbps ?? -1)) * dir;
        case 'time': return timeOf(a).localeCompare(timeOf(b)) * dir;
        default: return 0;
      }
    });
  }, [filtered, sortKey, sortAsc]);

  function toggleSort(key: Exclude<SortKey, 'none'>) {
    if (sortKey === key) {
      setSortAsc((prev) => !prev);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  const selectedIps = useMemo(
    () => servers.filter((item) => selectedIds.has(item.id)).map((item) => item.ip),
    [servers, selectedIds],
  );

  function toggleAll(checked: boolean) {
    setSelectedIds(checked ? new Set(filtered.map((item) => item.id)) : new Set());
  }

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
      loadServers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    }
  }

  /** 删除勾选的服务器（逐台调用，最后统一刷新）。 */
  async function deleteSelected() {
    const targets = servers.filter((item) => selectedIds.has(item.id));
    setDeletingSelected(false);
    let failed = 0;
    for (const item of targets) {
      try {
        await probeApi.deleteServer(item.id);
      } catch {
        failed += 1;
      }
    }
    setSelectedIds(new Set());
    if (failed) toast.warning(`已删除 ${targets.length - failed} 台，${failed} 台失败`);
    else toast.success(`已删除 ${targets.length} 台`);
    loadServers();
  }

  async function clearHistory() {
    if (!clearing) return;
    const kind = clearing;
    setClearing(null);
    try {
      const result = await probeApi.clearHistory(kind);
      toast.success(`已清空 ${kind === 'connectivity' ? '连通性' : '速率'}历史（${result.deleted} 条）`);
      loadHistory(historyIp);
      loadServers();
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
          <Button size="sm" variant="outline" onClick={() => { loadConfig(); setConfigOpen(true); }}>
            <Settings2 size={13} />测试设置
          </Button>
          <Button size="sm" variant="outline" onClick={loadServers} disabled={loading}>
            <RefreshCw size={13} />刷新
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="servers">服务器库</TabsTrigger>
          <TabsTrigger value="test">测试执行</TabsTrigger>
          <TabsTrigger value="history">历史结果</TabsTrigger>
        </TabsList>

        {/* ---- 服务器库 ---- */}
        <TabsContent value="servers" className="mt-4">
          <Card>
            <CardHeader className="flex-row flex-wrap items-center gap-2">
              <CardTitle className="text-sm">候选 frps 服务器</CardTitle>
              <Badge tone="muted">{servers.length} 台</Badge>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <div className="w-40">
                  <Select value={groupFilter} onValueChange={setGroupFilter}>
                    <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="all">全部分组</SelectItem>
                        {groups.map((group) => (
                          <SelectItem key={group} value={group}>{group}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-36">
                  <Select value={connFilter} onValueChange={setConnFilter}>
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
                  className="h-8 w-44" value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索 IP / 标签 / 分组"
                />
                <Button size="sm" variant="outline" onClick={() => setGroupsOpen(true)}>
                  <FolderCog size={13} />分组管理
                </Button>
                <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
                  <ListPlus size={13} />批量导入
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDiscoverOpen(true)} title="扫描自有网段，发现开放 frps 端口的设备">
                  <Radar size={13} />网段发现
                </Button>
                <Button size="sm" onClick={() => setEditing('new')}><Plus size={13} />添加</Button>
              </div>
            </CardHeader>
            {selectedIps.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-4 py-2">
                <Badge tone="muted">已选 {selectedIps.length} 台</Badge>
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
                <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
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
                          checked={displayList.length > 0 && displayList.every((item) => selectedIds.has(item.id))}
                          onChange={(e) => toggleAll(e.target.checked)}
                        />
                      </Th>
                      <ThSort label="服务器" sortKey="ip" activeKey={sortKey} asc={sortAsc} onSort={toggleSort} />
                      <ThSort label="分组" sortKey="group" activeKey={sortKey} asc={sortAsc} onSort={toggleSort} />
                      <ThSort label="连通性" sortKey="conn" activeKey={sortKey} asc={sortAsc} onSort={toggleSort} />
                      <ThSort label="速率" sortKey="speed" activeKey={sortKey} asc={sortAsc} onSort={toggleSort} />
                      <ThSort label="测速时间" sortKey="time" activeKey={sortKey} asc={sortAsc} onSort={toggleSort} />
                      <Th align="right">操作</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayList.map((item) => (
                      <tr key={item.id} className="border-b last:border-b-0 hover:bg-muted/50 transition-colors">
                        <Td>
                          <input
                            type="checkbox" aria-label={`选择 ${item.ip}`}
                            className="size-3.5 accent-[var(--primary)]"
                            checked={selectedIds.has(item.id)}
                            onChange={(e) => {
                              const next = new Set(selectedIds);
                              if (e.target.checked) next.add(item.id); else next.delete(item.id);
                              setSelectedIds(next);
                            }}
                          />
                        </Td>
                        <Td>
                          <div className="font-mono text-[12px] font-medium">{item.ip}</div>
                          {item.label && <div className="text-[11px] text-muted-foreground">{item.label}</div>}
                        </Td>
                        <Td>{item.group ? <Badge tone="muted">{item.group}</Badge> : <span className="text-xs text-muted-foreground">—</span>}</Td>
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
                    {!displayList.length && (
                      <tr><td colSpan={7} className="px-4 py-10 text-center text-xs text-muted-foreground">
                        {loading ? '加载中…' : '暂无服务器，点击「添加」或「批量导入」开始'}
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- 测试执行 ---- */}
        <TabsContent value="test" className="mt-4">
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
                <CardHeader><CardTitle className="text-sm">启动测试</CardTitle></CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs">测试范围</Label>
                    <Select value={scope} onValueChange={setScope} disabled={running}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="all">全部服务器（{servers.length}）</SelectItem>
                          <SelectItem value="selected" disabled={!selectedIps.length}>
                            勾选的服务器（{selectedIps.length}）
                          </SelectItem>
                          {groups.map((group) => (
                            <SelectItem key={group} value={group}>分组：{group}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Button onClick={() => startTest('full')} disabled={running || starting || !servers.length || (scope === 'selected' && !selectedIps.length)}>
                      <Zap size={13} />一键完整测试
                    </Button>
                    <p className="text-[11px] leading-4 text-muted-foreground">连通性全过（可达 + 隧道 + 端口放行）的服务器自动续接速率测试</p>
                    <div className="grid grid-cols-2 gap-2">
                      <Button variant="outline" onClick={() => startTest('connectivity')} disabled={running || starting || !servers.length || (scope === 'selected' && !selectedIps.length)}>
                        <Play size={13} />连通性
                      </Button>
                      <Button variant="outline" onClick={() => startTest('speed')} disabled={running || starting || !servers.length || (scope === 'selected' && !selectedIps.length)}>
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
        </TabsContent>

        {/* ---- 历史结果 ---- */}
        <TabsContent value="history" className="mt-4">
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
        </TabsContent>
      </Tabs>

      {editing && (
        <ServerDialog
          server={editing === 'new' ? null : editing}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); loadServers(); }}
        />
      )}
      {importOpen && (
        <ImportDialog
          groups={groups}
          onClose={() => setImportOpen(false)}
          onImported={() => { setImportOpen(false); loadServers(); }}
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
          onChanged={loadServers}
        />
      )}
      {batchEdit && (
        <BatchEditDialog
          kind={batchEdit}
          ids={[...selectedIds]}
          count={selectedIps.length}
          groups={groups}
          onClose={() => setBatchEdit(null)}
          onSaved={() => { setBatchEdit(null); loadServers(); }}
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
      {discoverOpen && (
        <DiscoverDialog
          groups={groups}
          existingIps={new Set(servers.map((item) => item.ip))}
          defaultPort={config?.frpsPort ?? 7000}
          onClose={() => setDiscoverOpen(false)}
          onImported={loadServers}
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
  const [label, setLabel] = useState(server?.label ?? '');
  const [group, setGroup] = useState(server?.group ?? '');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!ip.trim()) { toast.error('请填写服务器地址'); return; }
    if (!group.trim()) { toast.error('请选择或输入分组'); return; }
    setSaving(true);
    try {
      const payload = { ip: ip.trim(), label: label.trim(), group: group.trim() };
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
          <Label className="text-xs">分组（必选，可输入新分组）</Label>
          <Input
            value={group} onChange={(e) => setGroup(e.target.value)}
            placeholder="选择建议或输入新分组" list="probe-group-options"
          />
          <datalist id="probe-group-options">
            {groups.map((name) => <option key={name} value={name} />)}
          </datalist>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">标签（可选）</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="香港 VPS-01" />
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

/** 分组管理弹窗：提前创建分组（导入时必选），删除预创建记录；空分组提示入组步骤。 */
function GroupDialog({ groups, groupCounts, onClose, onChanged }: {
  groups: string[];
  groupCounts: Map<string, number>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

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
          <div className="text-[11px] font-medium text-muted-foreground">已有分组（含服务器正在使用的分组）</div>
          {groups.length ? (
            <div className="flex max-h-60 flex-col gap-1 overflow-y-auto">
              {groups.map((item) => {
                const count = groupCounts.get(item) ?? 0;
                return (
                  <div key={item} className="flex items-center gap-2 rounded-md bg-muted/60 px-2.5 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-[12px]">{item}</span>
                    {count > 0
                      ? <span className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">{count} 台</span>
                      : <span className="whitespace-nowrap text-[11px] text-muted-foreground" title="测通服务器后勾选批量改入该分组（即入池），再到负载均衡绑定域名">空 · 待入组</span>}
                    <Button size="icon-sm" variant="ghost" onClick={() => remove(item)} disabled={busy} aria-label={`删除分组 ${item}`} title="删除预创建记录（不影响已归入该分组的服务器）">
                      <Trash2 size={13} />
                  </Button>
                </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-input p-4 text-center text-xs text-muted-foreground">还没有分组</div>
          )}
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">删除分组只移除预创建记录；已归入该分组的服务器保持不变。</p>
      </div>
    </Overlay>
  );
}

/** 勾选批量修改弹窗：改分组（必选）或改标签（可空=清除）；改组成功后引导去负载均衡绑域名。 */
function BatchEditDialog({ kind, ids, count, groups, onClose, onSaved }: {
  kind: 'group' | 'label';
  ids: number[];
  count: number;
  groups: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const navigate = useNavigate();
  const [group, setGroup] = useState('');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!ids.length) return;
    if (kind === 'group' && !group) { toast.error('请选择分组'); return; }
    setSaving(true);
    try {
      const changes = kind === 'group' ? { group } : { label: label.trim() };
      const result = await probeApi.batchUpdateServers(ids, changes);
      if (kind === 'group') {
        toast.success(`已更新 ${result.updated} 台（入组 ${group}）`, {
          duration: 6000,
          action: { label: '去负载均衡绑域名', onClick: () => navigate('/lb') },
        });
      } else {
        toast.success(`已更新 ${result.updated} 台`);
      }
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay title={kind === 'group' ? `更改分组（${count} 台）` : `更改标签（${count} 台）`} onClose={onClose}>
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
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">目标标签（留空表示清除标签）</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="如：香港 VPS-01" autoFocus />
          </div>
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
  sortKey: 'ip' | 'group' | 'conn' | 'speed' | 'time';
  activeKey: SortKey;
  asc: boolean;
  onSort: (key: 'ip' | 'group' | 'conn' | 'speed' | 'time') => void;
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

/**
 * 网段发现弹窗（整合自 portpilot）：扫描自有网段内开放 frps 端口的设备，
 * 勾选导入服务器库 → 走既有穿透测试入池链路。仅供扫描自己有权管理的网段。
 */
function DiscoverDialog({ groups, existingIps, defaultPort, onClose, onImported }: {
  groups: string[];
  existingIps: Set<string>;
  defaultPort: number;
  onClose: () => void;
  onImported: () => void;
}) {
  const [targets, setTargets] = useState('');
  const [exclude, setExclude] = useState('');
  const [port, setPort] = useState(String(defaultPort));
  const [concurrency, setConcurrency] = useState('500');
  const [probeTimeout, setProbeTimeout] = useState('1.5');
  const [status, setStatus] = useState<DiscoverStatus | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [group, setGroup] = useState('');
  const [starting, setStarting] = useState(false);
  const [importing, setImporting] = useState(false);

  const running = !!status?.running;

  useEffect(() => {
    probeApi.discoverStatus().then((current) => {
      setStatus(current);
      // 已有结果时默认全选「不在库」的命中项
      const ips = current.found.filter((hit) => !existingIps.has(hit.ip)).map((hit) => hit.ip);
      setSelected(new Set(ips));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      probeApi.discoverStatus().then(setStatus).catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [running]);

  const toggle = (ip: string, inLibrary: boolean) => {
    if (inLibrary) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ip)) next.delete(ip);
      else next.add(ip);
      return next;
    });
  };

  const start = async () => {
    if (!targets.trim()) { toast.error('请填写目标网段'); return; }
    setStarting(true);
    try {
      setStatus(await probeApi.discoverStart({
        targets,
        exclude: exclude.trim() || undefined,
        port: port.trim() ? Number(port) : undefined,
        concurrency: concurrency.trim() ? Number(concurrency) : undefined,
        timeout: probeTimeout.trim() ? Number(probeTimeout) : undefined,
      }));
      setSelected(new Set());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '启动扫描失败');
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    try { await probeApi.discoverStop(); } catch { /* 状态轮询会跟上 */ }
  };

  const importSelected = async () => {
    if (!group) { toast.error('请选择导入分组'); return; }
    const ips = [...selected];
    if (!ips.length) { toast.error('请勾选要导入的 IP'); return; }
    setImporting(true);
    try {
      const result = await probeApi.discoverImport(ips, group);
      toast.success(`导入完成：新增 ${result.inserted} 台，跳过已在库 ${result.skipped} 台`, {
        duration: 6000,
        action: { label: '去跑穿透测试', onClick: () => { onImported(); onClose(); } },
      });
      onImported();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败');
    } finally {
      setImporting(false);
    }
  };

  const found = status?.found ?? [];
  const progress = status && status.total > 0 ? Math.round((status.scanned / status.total) * 100) : 0;

  return (
    <Overlay title="网段发现（扫描自有网段）" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <p className="text-[11px] leading-4 text-muted-foreground">
          扫描自己有权管理的网段（内网 / 自有 VPS 段），找出开放 frps 端口的设备，勾选导入服务器库后跑穿透测试。
          仅做资产发现，请勿扫描未授权网络。
        </p>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">目标网段（CIDR / IP 段 / 单 IP，逗号或换行分隔）</Label>
          <Textarea
            value={targets} onChange={(e) => setTargets(e.target.value)}
            placeholder={'10.0.0.0/24\n192.168.1.1-192.168.1.254\n172.16.0.1-254'}
            className="max-h-32 font-mono text-xs" disabled={running}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">排除</Label>
            <Input value={exclude} onChange={(e) => setExclude(e.target.value)}
              placeholder="10.0.0.1,10.0.9.0/24" disabled={running} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">frps 端口</Label>
            <Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" disabled={running} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">并发</Label>
            <Input value={concurrency} onChange={(e) => setConcurrency(e.target.value)} inputMode="numeric" disabled={running} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">超时（秒）</Label>
            <Input value={probeTimeout} onChange={(e) => setProbeTimeout(e.target.value)} inputMode="decimal" disabled={running} />
          </div>
        </div>

        <div className="flex items-center gap-2">
          {running ? (
            <>
              <Button size="sm" variant="destructive" onClick={stop}><Square size={13} />停止扫描</Button>
              <span className="text-xs tabular-nums text-muted-foreground">
                {status!.scanned} / {status!.total}（{progress}%）· 命中 {found.length} 台
              </span>
            </>
          ) : (
            <Button size="sm" onClick={start} disabled={starting}>
              <Play size={13} />{starting ? '启动中…' : found.length ? '重新扫描' : '开始扫描'}
            </Button>
          )}
        </div>
        {running && (
          <Progress value={progress} className="h-1.5" />
        )}
        {status?.error && <div className="text-xs text-destructive">{status.error}</div>}

        {found.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium text-muted-foreground">
                命中 {found.length} 台（勾选 {selected.size} 台）
              </span>
              <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[11px]"
                onClick={() => setSelected(new Set(found.filter((hit) => !existingIps.has(hit.ip)).map((hit) => hit.ip)))}>
                全选（不在库）
              </Button>
            </div>
            <div className="max-h-56 overflow-y-auto rounded-md border border-border">
              <table className="w-full">
                <thead className="sticky top-0 bg-muted">
                  <tr className="text-[11px] text-muted-foreground">
                    <th className="w-8 px-2 py-1.5" />
                    <th className="px-2 py-1.5 text-left">IP</th>
                    <th className="px-2 py-1.5 text-left">端口</th>
                    <th className="px-2 py-1.5 text-left">延迟</th>
                    <th className="px-2 py-1.5 text-left">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {found.map((hit) => {
                    const inLibrary = existingIps.has(hit.ip);
                    return (
                      <tr key={hit.ip} className="border-t border-border text-xs">
                        <td className="px-2 py-1.5">
                          <input
                            type="checkbox"
                            className="size-3.5 accent-[var(--primary)]"
                            checked={inLibrary || selected.has(hit.ip)}
                            disabled={inLibrary}
                            onChange={() => toggle(hit.ip, inLibrary)}
                          />
                        </td>
                        <td className="px-2 py-1.5 font-mono">{hit.ip}</td>
                        <td className="px-2 py-1.5 font-mono text-muted-foreground">{hit.port}</td>
                        <td className="px-2 py-1.5 font-mono tabular-nums text-muted-foreground">{hit.latencyMs} ms</td>
                        <td className="px-2 py-1.5">
                          {inLibrary ? <Badge tone="muted">已在库</Badge> : <Badge tone="success">可导入</Badge>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-end gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Label className="text-xs">导入分组</Label>
                <Select value={group} onValueChange={setGroup}>
                  <SelectTrigger><SelectValue placeholder="选择分组" /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {groups.length
                        ? groups.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)
                        : <div className="px-3 py-2 text-xs text-muted-foreground">还没有分组，先到「分组管理」创建</div>}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={importSelected} disabled={importing || !selected.size}>
                {importing ? '导入中…' : `导入所选（${selected.size}）`}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Overlay>
  );
}
