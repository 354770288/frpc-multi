import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowDown, ArrowUp, ArrowUpDown, Download, FolderCog, Gauge, ListPlus,
  Network, Pencil, Play, Plus, Radar, RefreshCw, Rocket, Route, Tag,
  Trash2, X, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { probeApi } from '../lib/api';
import { formatLastSeen } from '../lib/format';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from '../components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { ConnBadge, ProbeStatCards, SpeedText } from './probe/ProbeParts';
import { useDiscovery } from './probe/useDiscovery';
import { useServers } from './probe/useServers';
import { useServerBulk } from './probe/useServerBulk';
import { useServerImport } from './probe/useServerImport';
import { batchTagDialogTitle, canFreezeServerSelection, canRemoveLegacyLabels, canSubmitServerBatch, legacyServerBatchPayload } from './probe/serverBulkUi';
import { TestNodesDialog } from './probe/TestNodesDialog';
import { ProbeJobsPanel } from './probe/ProbeJobsPanel';
import { ScanDialog } from './probe/ScanDialog';
import { ProbeRouteHistory } from './probe/ProbeRouteHistory';
import { SourceSelect } from './probe/NodeControls';
import { BatchTagDialog, TagManagementDialog } from './probe/TagDialogs';
import { ConfirmOverlay, Overlay } from '../components/Overlay';
import { cn } from '../lib/utils';
import { probeEndpointHost } from '../lib/probeEndpoint';
import type {
  TestNode, TestNodeExecutionPolicy, ProbeJobDetail, GroupColor, GroupInfo, LabelCount, ServerConn,
  ProbeConnectivityHistory, ProbeDashboard, ProbeServer,
  ProbeSpeedHistory, ProbeTestConfig,
  ServerFacets, ServerQuery, ServerTagFacet, ServerView, ServerViewColumn,
} from '../lib/types';
import { queryFromSavedView, savedViewPayload, serverViewDraftSignature, SERVER_VIEW_COLUMNS } from './probe/serverViews';

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

function latestServerObservationTime(item: ProbeServer): string | null {
  const times=[item.latestRoute?.test_time,item.latestConnectivity?.testTime,item.latestSpeed?.testTime]
    .filter((value):value is string=>!!value);
  return times.sort((a,b)=>Date.parse(b)-Date.parse(a))[0] || null;
}

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

export function Probe({ section = 'discover' }: { section?: 'discover' | 'servers' | 'test' | 'history' }) {
  const navigate = useNavigate();
  const { jobId: routeJobId } = useParams<{ jobId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [nodeId, setNodeId] = useState(searchParams.get('nodeId') || 'console');
  useEffect(() => { setNodeId(searchParams.get('nodeId') || 'console'); }, [searchParams]);
  const changeNodeId = (id: string) => { setNodeId(id); setSearchParams((current) => { const next=new URLSearchParams(current); next.set('nodeId',id); return next; }); };
  const sourceRef = useRef(nodeId); sourceRef.current = nodeId;
  const historyRequestRef = useRef(0);
  const nodeRequestRef = useRef(0);
  const [nodes, setNodes] = useState<TestNode[]>([]);
  const [nodeError, setNodeError] = useState('');
  const [executionPolicyLoading, setExecutionPolicyLoading] = useState(true);
  const [executionPolicy, setExecutionPolicy] = useState<TestNodeExecutionPolicy | null>(null);
  const [executionPolicyError, setExecutionPolicyError] = useState('');
  const [focusJobId, setFocusJobId] = useState('');
  const [jobRevision, setJobRevision] = useState(0);
  const loadNodes = useCallback(async () => {
    const request = ++nodeRequestRef.current;
    setExecutionPolicyLoading(true);
    const [nodeResult, policyResult] = await Promise.allSettled([probeApi.testNodes(), probeApi.executionPolicy()]);
    if (request !== nodeRequestRef.current) return;
    if (nodeResult.status === 'fulfilled') { setNodes(nodeResult.value.items); setNodeError(''); }
    else setNodeError(nodeResult.reason instanceof Error ? nodeResult.reason.message : '节点加载失败');
    if (policyResult.status === 'fulfilled') { setExecutionPolicy(policyResult.value); setExecutionPolicyError(''); }
    else { setExecutionPolicy(null); setExecutionPolicyError(policyResult.reason instanceof Error ? policyResult.reason.message : '执行节点策略加载失败'); }
    setExecutionPolicyLoading(false);
  }, []);
  useEffect(() => {
    void loadNodes();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void loadNodes(); }, 10000);
    return () => { clearInterval(timer); nodeRequestRef.current++; };
  }, [loadNodes]);
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [stats, setStats] = useState<ProbeDashboard | null>(null);
  const [dashboardError,setDashboardError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(()=>{setStats(null);setLoading(true);setDashboardError('');},[nodeId]);

  // 页面主 Tab（受控：勾选快速测试后自动切到「穿透测试」）；网段发现为第一子页
  const [tab, setTabState] = useState(section);
  useEffect(() => { setTabState(section); }, [section]);
  const setTab = (value: string) => {
    setTabState(value as typeof section);
    const path: Record<string,string> = { discover:'/discovery',servers:'/servers',test:'/tests',history:'/results' };
    navigate(`${path[value] || '/discovery'}?nodeId=${encodeURIComponent(nodeId)}`);
  };
  const discovery = useDiscovery(tab === 'discover', nodeId);
  // 服务器库同样走服务端分页（数据/轮询/跨页勾选由 hook 统一持有）
  const servers = useServers(tab === 'servers');
  const [serverSearch, setServerSearch] = useState(servers.query.q ?? '');
  useEffect(() => { setServerSearch(servers.query.q ?? ''); }, [servers.query.q]);
  useEffect(() => {
    const timer = setTimeout(() => servers.setSearch(serverSearch), 300);
    return () => clearTimeout(timer);
  }, [serverSearch, servers.setSearch]);
  const serverQueryRef = useRef(servers.query); serverQueryRef.current = servers.query;
  const serverSearchRef = useRef(serverSearch); serverSearchRef.current = serverSearch;
  const [savedViews, setSavedViews] = useState<ServerView[]>([]);
  const [savedViewId, setSavedViewId] = useState('');
  const [savedViewName, setSavedViewName] = useState('');
  const [renameViewName, setRenameViewName] = useState('');
  const [renamingView, setRenamingView] = useState(false);
  const [deletingView, setDeletingView] = useState<ServerView | null>(null);
  const [viewsLoading, setViewsLoading] = useState(false);
  const [creatingView, setCreatingView] = useState(false);
  const [savingViewName, setSavingViewName] = useState(false);
  const [deletingViewBusy, setDeletingViewBusy] = useState(false);
  const viewsRequestGeneration = useRef(0);
  const viewsMutationGeneration = useRef(0);
  const viewsMutationLocks = useRef({ create: false, rename: false, delete: false });
  const [visibleServerColumns, setVisibleServerColumns] = useState<ServerViewColumn[]>(SERVER_VIEW_COLUMNS.map((column) => column.id));
  const visibleServerColumnsRef = useRef(visibleServerColumns); visibleServerColumnsRef.current = visibleServerColumns;
  const activeSavedView = savedViews.find((view) => view.id === savedViewId) ?? null;
  const beginViewsMutation = () => {
    viewsMutationGeneration.current++;
    viewsRequestGeneration.current++;
    setViewsLoading(false);
  };
  const finishViewsMutation = () => {
    viewsMutationGeneration.current++;
    viewsRequestGeneration.current++;
  };
  const loadSavedViews = useCallback(async () => {
    const requestGeneration = ++viewsRequestGeneration.current;
    const mutationGeneration = viewsMutationGeneration.current;
    setViewsLoading(true);
    try {
      const result = await probeApi.serverViews();
      if (requestGeneration === viewsRequestGeneration.current && mutationGeneration === viewsMutationGeneration.current) setSavedViews(result.items);
    }
    catch (error) {
      if (requestGeneration === viewsRequestGeneration.current && mutationGeneration === viewsMutationGeneration.current) toast.error(error instanceof Error ? error.message : '保存视图加载失败');
    }
    finally { if (requestGeneration === viewsRequestGeneration.current) setViewsLoading(false); }
  }, []);
  useEffect(() => { if (tab === 'servers') void loadSavedViews(); }, [tab, loadSavedViews]);
  const applyServerView = (view: ServerView) => {
    setSavedViewId(view.id);
    setVisibleServerColumns(view.visibleColumns);
    setServerSearch(view.filters.q ?? '');
    servers.applySavedView(queryFromSavedView(view));
  };
  const createServerView = async () => {
    const name = savedViewName.trim();
    if (!name) { toast.error('请输入视图名称'); return; }
    if (viewsMutationLocks.current.create) return;
    const searchAtSubmit = serverSearchRef.current;
    const queryAtSubmit = { ...serverQueryRef.current, q: searchAtSubmit };
    const columnsAtSubmit = [...visibleServerColumnsRef.current];
    const submittedSignature = serverViewDraftSignature(queryAtSubmit, searchAtSubmit, columnsAtSubmit);
    viewsMutationLocks.current.create = true;
    setCreatingView(true);
    beginViewsMutation();
    servers.setSearch(searchAtSubmit);
    try {
      const created = await probeApi.createServerView({ name, ...savedViewPayload(queryAtSubmit, columnsAtSubmit) });
      setSavedViews((current) => [...current.filter((view) => view.id !== created.id), created].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')));
      setSavedViewName('');
      const currentSignature = serverViewDraftSignature(serverQueryRef.current, serverSearchRef.current, visibleServerColumnsRef.current);
      if (currentSignature === submittedSignature) {
        setSavedViewId(created.id);
        setVisibleServerColumns(created.visibleColumns);
        setServerSearch(created.filters.q ?? '');
        servers.applySavedView(queryFromSavedView(created));
      } else {
        setSavedViewId('');
      }
      toast.success(`已保存视图「${created.name}」`);
    } catch (error) { toast.error(error instanceof Error ? error.message : '保存视图失败'); }
    finally {
      viewsMutationLocks.current.create = false;
      setCreatingView(false);
      finishViewsMutation();
    }
  };
  const renameServerView = async () => {
    if (!activeSavedView || !renameViewName.trim()) return;
    if (viewsMutationLocks.current.rename) return;
    viewsMutationLocks.current.rename = true;
    setSavingViewName(true);
    beginViewsMutation();
    try {
      const updated = await probeApi.updateServerView(activeSavedView.id, { name: renameViewName.trim() });
      setSavedViews((current) => current.map((view) => view.id === updated.id ? updated : view).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')));
      setRenamingView(false); toast.success('视图名称已更新');
    } catch (error) { toast.error(error instanceof Error ? error.message : '重命名视图失败'); }
    finally {
      viewsMutationLocks.current.rename = false;
      setSavingViewName(false);
      finishViewsMutation();
    }
  };
  const deleteServerView = async () => {
    if (!deletingView) return;
    if (viewsMutationLocks.current.delete) return;
    viewsMutationLocks.current.delete = true;
    setDeletingViewBusy(true);
    beginViewsMutation();
    try {
      await probeApi.deleteServerView(deletingView.id);
      setSavedViews((current) => current.filter((view) => view.id !== deletingView.id));
      if (savedViewId === deletingView.id) setSavedViewId('');
      setDeletingView(null); toast.success('视图已删除');
    } catch (error) { toast.error(error instanceof Error ? error.message : '删除视图失败'); }
    finally {
      viewsMutationLocks.current.delete = false;
      setDeletingViewBusy(false);
      finishViewsMutation();
    }
  };
  const serverBulk = useServerBulk(tab === 'servers');
  const refreshedBulkJob = useRef<string | null>(null);
  const serverRows = servers.page.items;
  const discoverRows = discovery.page.items;
  const dSelected = discovery.selected;

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
  const [tagsOpen, setTagsOpen] = useState(false);
  const [batchTagsOpen, setBatchTagsOpen] = useState(false);
  const [serverAdvancedOpen, setServerAdvancedOpen] = useState(false);
  const [batchEdit, setBatchEdit] = useState<'group' | 'label' | null>(null);
  const [batchEditSnapshot, setBatchEditSnapshot] = useState<'group' | 'label' | null>(null);
  const [batchTagsSnapshotOpen, setBatchTagsSnapshotOpen] = useState(false);
  const [deletingSnapshot, setDeletingSnapshot] = useState(false);
  const [freezingSelection, setFreezingSelection] = useState(false);

  // 网段发现（分页数据、跨页勾选与轮询由 useDiscovery 统一持有）
  const [scanOpen, setScanOpen] = useState(false);
  const [dBatchEdit, setDBatchEdit] = useState<'group' | 'label' | null>(null);
  const [dDeleting, setDDeleting] = useState(false);
  const [importSelOpen, setImportSelOpen] = useState(false);
  const [routeNodesOpen, setRouteNodesOpen] = useState(false);

  // 测试
  const starting = false;

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
    if(section==='discover' || section==='test')void loadConfig();
  }, [loadConfig,section]);

  // 仪表盘（轻量，所有 Tab 头部都在用）：首屏 + 仅页面可见时 10s 一拍
  const loadDashboard = useCallback(async () => {
    try {
      const value = await probeApi.dashboard(nodeId);
      if (sourceRef.current === nodeId) {setStats(value);setDashboardError('');}
    } catch (err) {
      if (sourceRef.current === nodeId) setDashboardError(err instanceof Error ? err.message : '统计加载失败');
    } finally {
      if (sourceRef.current === nodeId)setLoading(false);
    }
  }, [nodeId]);
  const loadGroups = useCallback(async () => {
    try {
      setGroups(await probeApi.groups());
    } catch {
      /* 分组加载失败不阻塞页面 */
    }
  }, []);
  useEffect(() => {
    if (!serverBulk.job || !['done', 'partial', 'failed'].includes(serverBulk.job.state) || refreshedBulkJob.current === serverBulk.job.jobId) return;
    refreshedBulkJob.current = serverBulk.job.jobId;
    void servers.refreshAll({ recoverOutOfRange: true }).catch(() => {});
    void loadGroups();
  }, [serverBulk.job?.jobId, serverBulk.job?.state]);
  const serverImport = useServerImport(() => {
    void servers.refreshAll({ recoverOutOfRange: true }).catch(() => {});
    void loadGroups();
    void loadDashboard();
  });

  useEffect(() => {
    if(section==='test')return;
    void loadDashboard();
    void loadGroups();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void loadDashboard();
    }, 10000);
    return () => clearInterval(timer);
  }, [loadDashboard, loadGroups,section]);

  const jobStarted = (job: ProbeJobDetail) => {
    setFocusJobId(job.id); setJobRevision((value) => value + 1); navigate(`/tests/${job.id}`);
  };
  const startRouteTest = () => {
    if (!dSelected.size) return;
    const targets=[...discovery.selectedTargets.entries()].filter(([id])=>dSelected.has(id)).map(([,endpoint])=>endpoint);
    if (!targets.length) { toast.error('没有勾选目标'); return; }
    sessionStorage.setItem('probe_selected_endpoints',JSON.stringify(targets));
    navigate('/tests/new?selected=1&mode=route');
  };

  const loadHistory = useCallback(async (ip: string) => {
    const request = ++historyRequestRef.current;
    try {
      const [conn, speed] = await Promise.all([
        probeApi.connectivityHistory(ip || undefined, 200, nodeId),
        probeApi.speedHistory(ip || undefined, 200, nodeId),
      ]);
      if (sourceRef.current !== nodeId || request !== historyRequestRef.current) return;
      setConnHistory(conn);
      setSpeedHistory(speed);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '历史记录加载失败');
    }
  }, [nodeId]);

  useEffect(() => { setStats(null); setConnHistory([]); setSpeedHistory([]); }, [nodeId]);

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
  const bulkActionBusy = !!serverBulk.pending || !!serverBulk.job && ['queued', 'running'].includes(serverBulk.job.state);
  const manualBulkDisabled = bulkActionBusy || servers.selected.size > 5000;
  const freezeReady = canFreezeServerSelection(serverSearch, servers.query.q, servers.totalCount, servers.countLoading, servers.countError, servers.pageLoading, servers.pageError);

  function quickTest(mode: 'connectivity' | 'speed' | 'full') {
    if (!selectedIps.length) return;
    sessionStorage.setItem('probe_selected_endpoints',JSON.stringify(selectedIps));
    navigate(`/tests/new?selected=1&mode=${mode}`);
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
    try {
      const next = await serverBulk.submit('delete', {}, targets.map(([id]) => id));
      toast.success(`删除任务已提交（${next.total} 台）`);
    } catch (err) { toast.error(err instanceof Error ? err.message : '删除任务提交失败'); }
  }

  async function freezeMatchingServers() {
    setFreezingSelection(true);
    try {
      const next = await serverBulk.freezeAllMatching(servers.query);
      toast.success(next.state === 'ready' ? `已冻结 ${next.count} 台匹配服务器` : '正在生成服务器选择快照');
    } catch (err) { toast.error(err instanceof Error ? err.message : '创建选择快照失败'); }
    finally { setFreezingSelection(false); }
  }

  async function submitSnapshotUpdate(payload: Record<string, unknown>) {
    return serverBulk.submit('update', payload);
  }

  async function submitSnapshotDelete() {
    setDeletingSnapshot(false);
    try {
      const next = await serverBulk.submit('delete', {});
      toast.success(`批量删除任务已提交（${next.total} 台）`);
    } catch (err) { toast.error(err instanceof Error ? err.message : '批量删除提交失败'); }
  }

  async function clearHistory() {
    if (!clearing) return;
    const kind = clearing;
    setClearing(null);
    try {
      const result = await probeApi.clearHistory(kind, nodeId);
      toast.success(`已清空 ${kind === 'connectivity' ? '连通性' : '速率'}历史（${result.deleted} 条）`);
      loadHistory(historyIp);
      servers.refreshAll().catch(() => {});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '清空失败');
    }
  }

  const refreshObservations = () => { void loadDashboard(); void loadHistory(historyIp); void servers.refreshAll().catch(() => {}); void discovery.refreshAll().catch(() => {}); };

  return (
    <div className="mx-auto max-w-[1600px] px-6 py-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{{discover:'网段发现',servers:'服务器库',test:'测试任务',history:'测试结果'}[section]}</h2>
        <Badge tone="muted">frps 验收</Badge>
        <div className="ml-auto flex items-center gap-3">
          {section !== 'test' && section !== 'servers' && <SourceSelect nodes={nodes} value={nodeId} onChange={changeNodeId} />}
          <Button size="sm" variant="outline" onClick={() => navigate('/test-nodes')}>测试节点</Button>
          {section !== 'test' && <ProbeStatCards stats={stats} />}
          {section !== 'test' && <Button size="sm" variant="outline"
            onClick={() => { loadDashboard(); servers.refreshAll().catch(() => {}); }} disabled={loading}>
            <RefreshCw size={13} />刷新
          </Button>}
        </div>
      </div>

      {nodeError && <p role="alert" className="mb-3 text-xs text-destructive">{nodeError}</p>}
      {dashboardError && <p role="alert" className="mb-3 text-sm text-destructive">{dashboardError}；统计不可用，请重试。</p>}
      {section === 'servers' && <p className="mb-3 text-sm text-muted-foreground">当前结果反映最近一次被接受的主用或备用测量；执行来源与任务进度请查看测试任务和历史记录。</p>}
      {section !== 'test' && section !== 'servers' && <p className="mb-3 text-sm text-muted-foreground">结果来源：{nodes.find((node) => node.id === nodeId)?.name || nodeId}。切换来源只改变显示；新任务使用测试节点设置中的主节点策略。</p>}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="sr-only">
          <TabsTrigger value="discover">网段发现</TabsTrigger>
          <TabsTrigger value="servers">服务器库</TabsTrigger>
          <TabsTrigger value="test">测试执行</TabsTrigger>
          <TabsTrigger value="history">历史结果</TabsTrigger>
        </TabsList>

        {/* ---- 网段发现（第一子页） ---- */}
        {tab === 'discover' && <TabsContent value="discover" className="mt-4">
          <Card>
            <CardHeader className="flex-row flex-wrap items-center gap-2">
              <CardTitle className="text-sm">网段内开放 frps 端口的设备</CardTitle>
              <Badge tone="muted">{discovery.page.total} 条</Badge>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => setScanOpen(true)}><Radar data-icon="inline-start" />开始扫描</Button>
                <Button size="sm" variant="outline" onClick={() => discovery.refreshPage().catch(() => {})}>
                  <RefreshCw size={13} />刷新
                </Button>
                <Button size="sm" variant="outline" onClick={() => setRouteNodesOpen(true)}>
                  <Network size={13} />测试节点
                </Button>
              </div>
            </CardHeader>
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
                <Button size="sm" onClick={startRouteTest} disabled={starting}>
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
                        <Td><div className="flex flex-col gap-1"><span className="font-mono text-[12px] font-medium">{row.ip}</span><span className="text-[11px] text-muted-foreground">{row.nodeName} · {row.latestRoute ? row.latestRoute.ok ? row.latestRoute.isCn2 ? 'CN2' : '非 CN2' : '路由失败' : '未测路由'}</span></div></Td>
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
              <Badge tone="muted">{servers.totalCount === null ? (servers.countError ? '总数暂不可用' : '总数加载中…') : `${servers.totalCount} 台`}</Badge>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <div className="w-40">
                  <Select value={servers.query.group ?? 'all'} onValueChange={servers.setGroup}>
                    <SelectTrigger size="sm" aria-label="单一分组筛选"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="all">全部分组</SelectItem>
                        {groups.map((group) => (
                          <SelectItem key={group.id ?? group.name} value={group.name}>
                            <span className="flex items-center gap-1.5"><GroupDot color={group.color} />{group.name}{servers.facetsCurrent ? ` (${servers.facets.groups.find((facet) => facet.group === group.name)?.count ?? 0})` : ''}</span>
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
                <Button size="sm" variant="outline" onClick={() => setTagsOpen(true)}>
                  <Tag size={13} />标签管理
                </Button>
                <Button size="sm" variant="outline" onClick={() => setImportOpen(true)} disabled={!serverImport.canStartNew && !serverImport.hasPendingSubmission}>
                  <ListPlus size={13} />{serverImport.hasPendingSubmission ? '恢复待提交导入' : serverImport.hasPendingRetry ? '先恢复失败项重试' : '批量导入'}
                </Button>
                <Button size="sm" onClick={() => setEditing('new')}><Plus size={13} />添加</Button>
              </div>
            </CardHeader>
            <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2" aria-label="保存的服务器视图">
              <span className="text-xs font-medium">保存视图</span>
              <div className="w-48">
                <Select value={savedViewId || 'none'} disabled={viewsLoading || creatingView || savingViewName || deletingViewBusy} onValueChange={(value) => {
                  if (value === 'none') { setSavedViewId(''); return; }
                  const view = savedViews.find((item) => item.id === value);
                  if (view) applyServerView(view);
                }}>
                  <SelectTrigger size="sm" aria-label="加载保存视图"><SelectValue placeholder="选择视图" /></SelectTrigger>
                  <SelectContent><SelectGroup>
                    <SelectItem value="none">当前筛选</SelectItem>
                    {savedViews.map((view) => <SelectItem key={view.id} value={view.id}>{view.name}</SelectItem>)}
                  </SelectGroup></SelectContent>
                </Select>
              </div>
              {viewsLoading && <span role="status" className="text-xs text-muted-foreground">正在加载…</span>}
              <Input aria-label="新视图名称" className="h-8 w-36" placeholder="新视图名称" value={savedViewName} disabled={creatingView} onChange={(event) => setSavedViewName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createServerView(); }} />
              <Button size="sm" variant="outline" disabled={!savedViewName.trim() || creatingView} onClick={() => void createServerView()}>{creatingView ? '保存中…' : '保存当前视图'}</Button>
              {activeSavedView && (renamingView ? <>
                <Input aria-label="视图新名称" className="h-8 w-36" value={renameViewName} disabled={savingViewName} onChange={(event) => setRenameViewName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void renameServerView(); }} />
                <Button size="sm" variant="outline" disabled={savingViewName || !renameViewName.trim()} onClick={() => void renameServerView()}>{savingViewName ? '重命名中…' : '确认重命名'}</Button>
                <Button size="sm" variant="ghost" disabled={savingViewName} onClick={() => setRenamingView(false)}>取消</Button>
              </> : <>
                <Button size="sm" variant="ghost" disabled={savingViewName || deletingViewBusy} onClick={() => { setRenameViewName(activeSavedView.name); setRenamingView(true); }}>重命名</Button>
                <Button size="sm" variant="ghost" className="text-destructive" disabled={deletingViewBusy || savingViewName} onClick={() => setDeletingView(activeSavedView)}>删除视图</Button>
              </>)}
              <fieldset className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <legend className="sr-only">服务器表格显示列</legend>
                <span className="text-muted-foreground">显示列</span>
                {SERVER_VIEW_COLUMNS.map((column) => <label key={column.id} className="flex items-center gap-1.5">
                  <input type="checkbox" aria-label={`显示列 ${column.label}`} checked={visibleServerColumns.includes(column.id)} disabled={visibleServerColumns.length === 1 && visibleServerColumns.includes(column.id)} onChange={() => setVisibleServerColumns((current) => current.includes(column.id) ? current.filter((id) => id !== column.id) : [...current, column.id])} />
                  {column.label}
                </label>)}
              </fieldset>
            </div>
            <ServerAdvancedFilters
              query={servers.query}
              groups={groups}
              facets={servers.facets}
              facetsCurrent={servers.facetsCurrent}
              facetsLoading={servers.facetsLoading}
              facetsError={servers.facetsError}
              tagSearch={servers.tagSearch}
              tagPage={servers.tagPage}
              tagPageSize={servers.tagPageSize}
              tagTotal={servers.tagTotal}
              tagCandidatesCurrent={servers.tagCandidatesCurrent}
              onTagSearch={servers.setTagCandidateSearch}
              onTagPage={servers.setTagCandidatePage}
              open={serverAdvancedOpen}
              onOpenChange={setServerAdvancedOpen}
              onGroupIds={servers.setGroupIds}
              onIncludeTagIds={servers.setIncludeTagIds}
              onExcludeTagIds={servers.setExcludeTagIds}
              onTagMode={servers.setTagMode}
              onSingleGroup={servers.setGroup}
              onQuickTag={servers.setTagId}
              onRetryFacets={() => servers.refreshFacets().catch(() => {})}
            />
            <ServerTagCloud tags={servers.facets.tagItems} active={servers.query.tagId ?? null} candidatesCurrent={servers.tagCandidatesCurrent} candidateLoading={servers.facetsLoading} candidateError={servers.facetsError} tagSearch={servers.tagSearch} tagPage={servers.tagPage} tagPageSize={servers.tagPageSize} tagTotal={servers.tagTotal} onToggle={servers.setTagId} onManage={() => setTagsOpen(true)} onOpenAdvanced={() => setServerAdvancedOpen(true)} />
            {(servers.pageError || servers.countError) && <div className="flex flex-wrap items-center gap-3 border-b bg-destructive/5 px-4 py-2 text-xs" role="alert">
              {servers.pageError && <span>服务器列表读取失败：{servers.pageError}</span>}
              {servers.pageError && <Button size="sm" variant="outline" onClick={() => servers.refreshPage().catch(() => {})}>重试列表</Button>}
              {servers.countError && <span>服务器总数读取失败：{servers.countError}</span>}
              {servers.countError && <Button size="sm" variant="outline" onClick={() => servers.refreshCount().catch(() => {})}>重试总数</Button>}
            </div>}
            {servers.totalCount !== null && servers.totalCount > 0 && <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
              <Button size="sm" variant="outline" disabled={freezingSelection || !!serverBulk.pending || !freezeReady} onClick={() => void freezeMatchingServers()}>
                {freezingSelection ? '正在冻结…' : `冻结全部匹配 (${servers.totalCount})`}
              </Button>
              <span className="text-[11px] text-muted-foreground">固定当前筛选结果；之后更改筛选条件不会改变快照。</span>
            </div>}
            {serverBulk.selection && <div className="border-b bg-primary/5 px-4 py-3 text-xs" aria-label="服务器选择快照">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={serverBulk.selection.state === 'ready' ? 'muted' : serverBulk.selection.state === 'failed' || serverBulk.selection.state === 'expired' ? 'muted' : 'warning'}>
                  {serverBulk.selection.state === 'ready' ? `冻结快照 ${serverBulk.selection.count} 台` : serverBulk.selection.state === 'failed' ? '快照生成失败' : serverBulk.selection.state === 'expired' ? '快照已过期' : `快照生成中 ${serverBulk.selection.processed}/${serverBulk.selection.count || '…'}`}
                </Badge>
                {serverBulk.selection.error && <span role="alert" className="text-destructive">{serverBulk.selection.error}</span>}
                {serverBulk.selection.state === 'ready' && <>
                  <Button size="sm" onClick={() => navigate(`/tests/new?${new URLSearchParams({ selectionId: serverBulk.selection!.selectionId })}`)}>创建测试任务</Button>
                  <Button size="sm" variant="outline" disabled={bulkActionBusy} onClick={() => setBatchEditSnapshot('group')}>改分组</Button>
                  <Button size="sm" variant="outline" disabled={bulkActionBusy} onClick={() => setBatchEditSnapshot('label')}>改旧标签</Button>
                  <Button size="sm" variant="outline" disabled={bulkActionBusy} onClick={() => setBatchTagsSnapshotOpen(true)}>分类标签</Button>
                  <Button size="sm" variant="destructive" disabled={bulkActionBusy} onClick={() => setDeletingSnapshot(true)}>删除</Button>
                </>}
                {(serverBulk.selection.state === 'failed' || serverBulk.selection.state === 'expired') && <Button size="sm" variant="outline" onClick={() => serverBulk.clearSelection()}>清除快照</Button>}
              </div>
              {serverBulk.selection.state === 'ready' && <p className="mt-1 text-[11px] text-muted-foreground">快照固定于 {new Date(serverBulk.selection.createdAt).toLocaleString()}，有效期至 {new Date(serverBulk.selection.expiresAt).toLocaleString()}。</p>}
            </div>}
            {serverBulk.pending && <div className="flex flex-wrap items-center gap-2 border-b bg-destructive/5 px-4 py-2 text-xs">
              <span role="alert">批量任务提交结果尚未确认。重试会沿用原幂等键。</span>
              <Button size="sm" variant="outline" onClick={() => void serverBulk.retryPending().catch((err) => toast.error(err instanceof Error ? err.message : '重试提交失败'))}>重试提交</Button>
            </div>}
            {serverBulk.job && <div className="border-b bg-muted/30 px-4 py-3 text-xs" aria-label="批量任务进度" aria-live="polite">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={serverBulk.job.state === 'done' ? 'success' : serverBulk.job.state === 'partial' || serverBulk.job.state === 'failed' ? 'warning' : 'muted'}>
                  {serverBulk.job.operation === 'delete' ? '删除' : '更新'}任务：{serverBulk.job.state === 'done' ? '完成' : serverBulk.job.state === 'partial' ? '部分失败' : serverBulk.job.state === 'failed' ? '失败' : `${serverBulk.job.processed}/${serverBulk.job.total}`}
                </Badge>
                <span>成功 {serverBulk.job.succeeded} · 失败 {serverBulk.job.failed} · 共 {serverBulk.job.total}</span>
                {serverBulk.job.error && <span role="alert" className="text-destructive">{serverBulk.job.error}</span>}
                {['partial', 'failed'].includes(serverBulk.job.state) && serverBulk.job.failed > 0 && <Button size="sm" variant="outline" onClick={() => void serverBulk.retryFailed().catch((err) => toast.error(err instanceof Error ? err.message : '重试失败项失败'))}>仅重试失败项</Button>}
                {serverBulk.failureCursor !== null && <Button size="sm" variant="ghost" onClick={() => void serverBulk.loadMoreFailures().catch((err) => toast.error(err instanceof Error ? err.message : '失败明细读取失败'))}>加载更多失败项</Button>}
              </div>
              {serverBulk.failures.length > 0 && <ul className="mt-2 max-h-24 overflow-y-auto text-[11px] text-destructive">
                {serverBulk.failures.map((failure) => <li key={`${failure.serverId}-${failure.ip}`}>{failure.ip}: {failure.error}</li>)}
              </ul>}
              {serverBulk.error && <p role="alert" className="mt-1 text-destructive">{serverBulk.error}</p>}
            </div>}
            {selectedIps.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-4 py-2">
                <Badge tone="muted">已选 {selectedIps.length} 台（跨页保持）</Badge>
                <Button size="sm" variant="outline" onClick={() => quickTest('connectivity')} disabled={starting}>
                  <Play size={13} />测连通
                </Button>
                <Button size="sm" variant="outline" onClick={() => quickTest('speed')} disabled={starting}>
                  <Gauge size={13} />测速率
                </Button>
                <Button size="sm" onClick={() => quickTest('full')} disabled={starting}>
                  <Zap size={13} />完整测试
                </Button>
                <Button size="sm" variant="outline" disabled={manualBulkDisabled} onClick={() => setBatchEdit('group')}>
                  <FolderCog size={13} />改分组
                </Button>
                <Button size="sm" variant="outline" disabled={manualBulkDisabled} onClick={() => setBatchEdit('label')}>
                  <Tag size={13} />改旧标签
                </Button>
                <Button size="sm" variant="outline" disabled={manualBulkDisabled} onClick={() => setBatchTagsOpen(true)}>
                  <Tag size={13} />分类标签
                </Button>
                <Button size="sm" variant="destructive" disabled={manualBulkDisabled} onClick={() => setDeletingSelected(true)}>
                  <Trash2 size={13} />删除
                </Button>
                <Button size="sm" variant="ghost" onClick={() => servers.setSelected(new Map())}>
                  <X size={13} />清除勾选
                </Button>
                {servers.selected.size > 5000 && <span className="text-[11px] text-muted-foreground">显式勾选最多支持 5000 台；请使用上方“冻结全部匹配”。</span>}
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
                      {visibleServerColumns.includes('ip') && <ThSort label="服务器" sortKey="ip" activeKey={servers.query.sort} asc={servers.query.order === 'asc'} onSort={() => servers.setSort('ip', servers.query.sort === 'ip' && servers.query.order === 'asc' ? 'desc' : 'asc')} />}
                      {visibleServerColumns.includes('group') && <ThSort label="分组" sortKey="group" activeKey={servers.query.sort} asc={servers.query.order === 'asc'} onSort={() => servers.setSort('group', servers.query.sort === 'group' && servers.query.order === 'asc' ? 'desc' : 'asc')} />}
                      {visibleServerColumns.includes('tags') && <Th>标签</Th>}
                      {visibleServerColumns.includes('route') && <Th>路由</Th>}
                      {visibleServerColumns.includes('connectivity') && <ThSort label="连通性" sortKey="conn" activeKey={servers.query.sort} asc={servers.query.order === 'asc'} onSort={() => servers.setSort('conn', servers.query.sort === 'conn' && servers.query.order === 'asc' ? 'desc' : 'asc')} />}
                      {visibleServerColumns.includes('speed') && <ThSort label="速率" sortKey="speed" activeKey={servers.query.sort} asc={servers.query.order === 'asc'} onSort={() => servers.setSort('speed', servers.query.sort === 'speed' && servers.query.order === 'desc' ? 'asc' : 'desc')} />}
                      {visibleServerColumns.includes('lastTestTime') && <ThSort label="测速时间" sortKey="time" activeKey={servers.query.sort} asc={servers.query.order === 'asc'} onSort={() => servers.setSort('time', servers.query.sort === 'time' && servers.query.order === 'desc' ? 'asc' : 'desc')} />}
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
                        {visibleServerColumns.includes('ip') && <Td><div className="font-mono text-[12px] font-medium">{item.ip}</div></Td>}
                        {visibleServerColumns.includes('group') && <Td>{item.group ? <Badge variant={groupVariant(groupColorMap.get(item.group))} dot>{item.group}</Badge> : <span className="text-xs text-muted-foreground">—</span>}</Td>}
                        {visibleServerColumns.includes('tags') && <Td>{item.labels.length ? <div className="flex flex-wrap gap-1">{item.labels.map((label) => <Badge key={label} tone="muted">{label}</Badge>)}</div> : <span className="text-xs text-muted-foreground">—</span>}</Td>}
                        {visibleServerColumns.includes('route') && <Td>{item.latestRoute ? <Badge tone={item.latestRoute.ok ? item.latestRoute.isCn2 ? 'success' : 'warning' : 'muted'}>{item.latestRoute.ok ? item.latestRoute.isCn2 ? 'CN2' : '非 CN2' : '路由失败'}</Badge> : <span className="text-xs text-muted-foreground">未测试</span>}</Td>}
                        {visibleServerColumns.includes('connectivity') && <Td><ConnBadge latest={item.latestConnectivity} /></Td>}
                        {visibleServerColumns.includes('speed') && <Td><SpeedText latest={item.latestSpeed} /></Td>}
                        {visibleServerColumns.includes('lastTestTime') && <Td>
                          <span className="whitespace-nowrap text-xs text-muted-foreground">
                            {latestServerObservationTime(item) ? formatLastSeen(latestServerObservationTime(item)!) : '—'}
                          </span>
                        </Td>}
                        <Td align="right">
                          <div className="flex items-center justify-end gap-1">
                            <Button size="sm" variant="outline" onClick={() => navigate(`/instances/new?${new URLSearchParams({server:probeEndpointHost(item.ip),port:String(item.port)})}`)} title="用此服务器创建 frpc 实例">
                              <Rocket size={13} />创建实例
                            </Button>
                            <Button size="icon-sm" variant="secondary" onClick={() => setEditing(item)} aria-label="编辑"><Pencil size={13} /></Button>
                            <Button size="icon-sm" variant="destructive" onClick={() => setDeleting(item)} aria-label="删除"><Trash2 size={13} /></Button>
                          </div>
                        </Td>
                      </tr>
                    ))}
                    {!serverRows.length && (
                      <tr><td colSpan={visibleServerColumns.length + 2} className="px-4 py-10 text-center text-xs text-muted-foreground">
                        {servers.pageLoading ? '服务器列表加载中…' : servers.pageError ? '服务器列表读取失败' : servers.totalCount === null ? (servers.countLoading ? '服务器总数加载中…' : '服务器总数暂不可用') : servers.totalCount ? '当前筛选条件下没有匹配的记录' : '暂无服务器，点击「添加」或「批量导入」开始'}
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
                <span className="text-xs text-muted-foreground">
                  第 {servers.page.page} 页{servers.cursorMode ? '' : ` / ${Math.max(1, Math.ceil(servers.page.total / servers.page.pageSize))}`} · 共 {servers.totalCount === null ? (servers.countError ? '总数暂不可用' : '总数加载中…') : `${servers.totalCount} 台`}
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
                  <Button size="sm" variant="outline" disabled={servers.cursorMode ? !servers.cursorCanPrevious : servers.page.page <= 1}
                    onClick={() => servers.cursorMode ? servers.previousCursorPage() : servers.setPageNumber(servers.page.page - 1)}>上一页</Button>
                  <Button size="sm" variant="outline"
                    disabled={servers.cursorMode ? !servers.cursorHasMore : servers.page.page >= Math.max(1, Math.ceil(servers.page.total / servers.page.pageSize))}
                    onClick={() => servers.cursorMode ? servers.nextCursorPage() : servers.setPageNumber(servers.page.page + 1)}>下一页</Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>}

        {/* ---- 测试执行 ---- */}
        {tab === 'test' && <TabsContent value="test" className="mt-4">
          <div className="space-y-4">
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => {void loadConfig();setConfigOpen(true);}}>测试设置</Button><Button onClick={() => navigate('/tests/new')}>新建测试</Button></div>
            <ProbeJobsPanel nodes={nodes} focusJobId={routeJobId || focusJobId} revision={jobRevision} onChanged={refreshObservations} />
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
          <div className="mt-4"><ProbeRouteHistory nodeId={nodeId} ip={historyIp} /></div>
        </TabsContent>}
      </Tabs>

      {serverImport.job && (
        <ServerImportStatus task={serverImport} />
      )}

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
          task={serverImport}
          onSubmitted={() => setImportOpen(false)}
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
      {deletingView && <ConfirmOverlay
        title={`删除保存视图「${deletingView.name}」`}
        description="删除后无法恢复此视图。"
        confirmLabel={deletingViewBusy ? '删除中…' : '删除视图'} variant="destructive" confirmDisabled={deletingViewBusy} keepOpenOnConfirm
        onCancel={() => setDeletingView(null)} onConfirm={() => void deleteServerView()}
      />}
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
      <TagManagementDialog open={tagsOpen} onOpenChange={setTagsOpen} onChanged={() => servers.refreshAll().catch(() => {})} />
      <BatchTagDialog open={batchTagsOpen} onOpenChange={setBatchTagsOpen} ids={[...servers.selected.keys()]}
        onSubmitBulk={(payload) => serverBulk.submit('update', payload, [...servers.selected.keys()]).then(() => {})}
        onSaved={() => { setBatchTagsOpen(false); servers.refreshAll({ recoverOutOfRange: true }).catch(() => {}); }} />
      <BatchTagDialog open={batchTagsSnapshotOpen} onOpenChange={setBatchTagsSnapshotOpen} ids={[]}
        count={serverBulk.selection?.count ?? 0} snapshotMode
        onSubmitBulk={(payload) => serverBulk.submit('update', payload).then(() => {})}
        onSaved={() => { setBatchTagsSnapshotOpen(false); }} />
      {batchEdit && (
        <BatchEditDialog
          kind={batchEdit}
          ids={[...servers.selected.keys()]}
          count={servers.selected.size}
          groups={groups.map((group) => group.name)}
          cloudLabels={servers.facets.labels}
          onSubmitBulk={(payload) => serverBulk.submit('update', payload, [...servers.selected.keys()]).then(() => {})}
          onClose={() => setBatchEdit(null)}
          onSaved={() => {
            setBatchEdit(null);
            servers.refreshAll({ recoverOutOfRange: true }).catch(() => {});
            loadGroups();
          }}
        />
      )}
      {batchEditSnapshot && serverBulk.selection && (
        <BatchEditDialog
          kind={batchEditSnapshot}
          ids={[]}
          count={serverBulk.selection.count}
          groups={groups.map((group) => group.name)}
          cloudLabels={servers.facets.labels}
          snapshotMode
          onSubmitBulk={submitSnapshotUpdate}
          onClose={() => setBatchEditSnapshot(null)}
          onSaved={() => { setBatchEditSnapshot(null); servers.refreshAll({ recoverOutOfRange: true }).catch(() => {}); loadGroups(); }}
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
        <ScanDialog nodes={nodes} policy={executionPolicy} policyError={executionPolicyError} nodesError={nodeError} loading={executionPolicyLoading} onRetry={() => void loadNodes()} onClose={() => setScanOpen(false)} onStarted={(job) => { setScanOpen(false); jobStarted(job); }} />
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
        <TestNodesDialog nodes={nodes} onChanged={loadNodes} onClose={() => setRouteNodesOpen(false)} />
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
      {deletingSnapshot && serverBulk.selection && (
        <ConfirmOverlay
          title={`删除冻结快照中的 ${serverBulk.selection.count} 台服务器`}
          description="任务将按该快照固定的服务器列表执行，并显示进度及失败明细。"
          confirmLabel="提交删除任务" variant="destructive"
          onCancel={() => setDeletingSnapshot(false)} onConfirm={submitSnapshotDelete}
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

type ServerImportTask = ReturnType<typeof useServerImport>;

function ServerImportStatus({ task }: { task: ServerImportTask }) {
  const { job } = task;
  if (!job) return null;
  const terminal = ['done', 'partial', 'failed'].includes(job.state);
  const percent = job.total ? Math.min(100, Math.round(job.processed / job.total * 100)) : (terminal ? 100 : 0);
  const stateLabel: Record<typeof job.state, string> = {
    queued: '排队中', running: '导入中', done: '已完成', partial: '部分完成', failed: '失败',
  };
  return (
    <Card className="mt-4 border-primary/30" aria-label="服务器导入任务">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="font-medium text-sm">服务器导入 · {stateLabel[job.state]}</div>
          <span className="text-xs text-muted-foreground">{job.processed}/{job.total} 条（{percent}%）</span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" onClick={() => task.refreshJob()} disabled={task.submitting || task.retrying}>
              <RefreshCw size={13} />刷新状态
            </Button>
            {terminal && <Button size="sm" variant="ghost" onClick={task.clearJob} disabled={task.unresolvedRequest}>关闭</Button>}
          </div>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded bg-muted" role="progressbar" aria-label="导入进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>新增 {job.inserted}</span><span>跳过 {job.skipped}</span><span>失败 {job.failed}（可重试 {job.retryableFailed ?? 0}）</span>
          {job.error && <span className="text-destructive">{job.error}</span>}
          {task.error && <span role="alert" className="text-destructive">{task.error}</span>}
          {task.hasPendingSubmission && <span role="status" className="text-warning-foreground">有一项新导入等待确认，请先恢复待提交请求。</span>}
          {task.pendingRetry?.jobId === job.jobId && <span role="status">失败项重试等待确认；重试会复用原幂等键。</span>}
        </div>
        {terminal && !!job.failed && (
          <div className="mt-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium">失败明细（已载入 {task.failures.length} 条）</span>
              {Number(job.retryableFailed) > 0 && <Button size="sm" variant="outline" onClick={() => task.retryFailed()} disabled={task.retrying || task.hasPendingSubmission || (!!task.pendingRetry && task.pendingRetry.jobId !== job.jobId)}>
                {task.retrying ? '提交重试中…' : task.pendingRetry?.jobId === job.jobId ? '恢复失败项重试' : `重试失败项（${job.retryableFailed}）`}
              </Button>}
              {task.failureCursor !== null && <Button size="sm" variant="ghost" onClick={() => task.loadMoreFailures()} disabled={task.loadingFailures}>{task.loadingFailures ? '加载中…' : '加载更多'}</Button>}
              {task.failureLoadError && <><span role="alert" className="text-xs text-destructive">{task.failureLoadError}</span><Button size="sm" variant="outline" onClick={() => task.retryLoadFailures()} disabled={task.loadingFailures}>{task.loadingFailures ? '正在重试…' : '重试加载失败明细'}</Button></>}
            </div>
            <div className="max-h-52 overflow-auto rounded border">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-muted"><tr><th className="p-2">行</th><th className="p-2">输入</th><th className="p-2">原因</th><th className="p-2">处理</th></tr></thead>
                <tbody>{task.failures.map((failure, index) => <tr key={`${failure.line}-${index}`} className="border-t"><td className="p-2 font-mono">{failure.line}</td><td className="max-w-64 truncate p-2 font-mono" title={failure.input}>{failure.input}</td><td className="p-2">{failure.error}</td><td className="p-2">{failure.retryable ? '可重试' : '永久失败'}</td></tr>)}</tbody>
              </table>
              {!task.failures.length && <div className="p-3 text-xs text-muted-foreground">{task.loadingFailures ? '正在加载失败明细…' : '暂无失败明细'}</div>}
              {task.failures.length > 0 && !(Number(job.retryableFailed) > 0) && <div className="border-t p-3 text-xs text-muted-foreground">这些失败项均不可重试。</div>}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** 批量导入弹窗：粘贴 IP 行（每行「IP」或「IP 标签」）或 JSON 数组；分组必选。 */
function ImportDialog({ groups, onClose, onSubmitted, task }: {
  groups: string[];
  onClose: () => void;
  onSubmitted: () => void;
  task: ServerImportTask;
}) {
  const [text, setText] = useState(() => task.pendingRequest?.text ?? '');
  const [group, setGroup] = useState(() => task.pendingRequest?.group ?? '');
  const [sizeError, setSizeError] = useState('');

  const submit = async () => {
    if (!text.trim()) { toast.error('请粘贴要导入的内容'); return; }
    if (!group) { toast.error('请选择导入分组'); return; }
    if (new TextEncoder().encode(text).length > 16 * 1024 * 1024) {
      setSizeError('内容超过 16 MiB 上限，请拆分后导入');
      return;
    }
    setSizeError('');
    try {
      await task.submit(text, group);
      toast.success('导入任务已提交，可在任务进度中查看结果');
      onSubmitted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败');
    }
  };

  return (
    <Overlay title="批量导入服务器" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">导入分组（必选）</Label>
          <Select value={group} onValueChange={setGroup} disabled={task.hasPendingSubmission}>
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
            rows={10} value={text} onChange={(e) => setText(e.target.value)} readOnly={task.hasPendingSubmission}
            placeholder={'每行一台：IP 或「IP 标签」\n1.2.3.4\n5.6.7.8 香港VPS\n\n也支持 JSON：[{"ip":"1.2.3.4","label":"A","group":"g"}]'}
            className="max-h-56 min-h-36 overflow-y-auto font-mono text-xs"
          />
          {sizeError && <p role="alert" className="text-xs text-destructive">{sizeError}</p>}
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">已存在的 IP 自动跳过；JSON 行自带分组时以行内分组优先；支持最多 100,000 项、16 MiB。任务提交后可关闭弹窗，状态会在页面切换和刷新后恢复。</p>
        {task.hasPendingSubmission && <p className="text-xs text-muted-foreground">已恢复待确认的提交；原内容已锁定，重试会沿用原幂等键。</p>}
        {task.hasPendingRetry && <p className="text-xs text-destructive">有失败项重试请求等待确认，请先在任务卡恢复该请求。</p>}
        {task.error && <p role="alert" className="text-xs text-destructive">{task.error}</p>}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button onClick={task.hasPendingSubmission ? () => task.retrySubmit().then(() => { toast.success('导入任务已提交'); onSubmitted(); }).catch(() => {}) : submit} disabled={task.submitting || task.isActive || task.hasPendingRetry}>{task.submitting ? '提交中…' : task.hasPendingSubmission ? '重试提交' : '导入'}</Button>
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
function BatchEditDialog({ kind, ids, count, groups, cloudLabels, applyDiscover, snapshotMode, onSubmitBulk, onClose, onSaved }: {
  kind: 'group' | 'label';
  ids: number[];
  count: number;
  groups: string[];
  /** 标签云（facets 全局标签，供快选） */
  cloudLabels: LabelCount[];
  applyDiscover?: boolean;
  snapshotMode?: boolean;
  onSubmitBulk?: (payload: Record<string, unknown>) => Promise<unknown>;
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
    if (snapshotMode && kind === 'label') { setAttached([]); return; }
    if (kind !== 'label' || !idsKey) return;
    let cancelled = false;
    const idList = idsKey.split(',').map(Number).filter(Number.isFinite);
    const preview = applyDiscover ? probeApi.discoverLabelsPreview(idList) : probeApi.serversLabelsPreview(idList);
    preview.then((res) => { if (!cancelled) setAttached(res.labels); }).catch(() => { if (!cancelled) setAttached([]); });
    return () => { cancelled = true; };
  }, [kind, idsKey, applyDiscover, snapshotMode, cloudLabels]);

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
    if (!canSubmitServerBatch(ids.length, !!onSubmitBulk, !!applyDiscover)) return;
    if (kind === 'group' && !group) { toast.error('请选择分组'); return; }
    if (kind === 'label' && !addLabels.length && (snapshotMode || !removeLabels.length)) {
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
        const changes = legacyServerBatchPayload(kind, group, addLabels, removeLabels, !!snapshotMode);
        const result = onSubmitBulk ? await onSubmitBulk(changes) : await probeApi.batchUpdateServers(ids, changes);
        if (kind === 'group') {
          toast.success(onSubmitBulk ? `批量更新任务已提交（入组 ${group}）` : `已更新 ${(result as { updated: number }).updated} 台（入组 ${group}）`, {
            duration: 6000,
            action: { label: '去负载均衡绑域名', onClick: () => navigate('/lb') },
          });
        } else {
          toast.success(onSubmitBulk ? '批量标签更新任务已提交' : `已更新 ${(result as { updated: number }).updated} 台`);
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
            {canRemoveLegacyLabels(!!snapshotMode) && <div className="flex flex-col gap-1.5">
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
            </div>}
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
function ConfigDialog({ config, onClose, onSaved }: {
  config: ProbeTestConfig | null;
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
                disabled={saving}
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
        <Button onClick={submit} disabled={saving}>保存</Button>
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

function ServerAdvancedFilters({ query, groups, facets, facetsCurrent, facetsLoading, facetsError, tagSearch, tagPage, tagPageSize, tagTotal, tagCandidatesCurrent, onTagSearch, onTagPage, open, onOpenChange, onGroupIds, onIncludeTagIds, onExcludeTagIds, onTagMode, onSingleGroup, onQuickTag, onRetryFacets }: {
  query: ServerQuery;
  groups: GroupInfo[];
  facets: ServerFacets;
  facetsCurrent: boolean;
  facetsLoading: boolean;
  facetsError: string | null;
  tagSearch: string;
  tagPage: number;
  tagPageSize: number;
  tagTotal: number | null;
  tagCandidatesCurrent: boolean;
  onTagSearch: (value: string) => void;
  onTagPage: (page: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGroupIds: (ids: string[]) => void;
  onIncludeTagIds: (ids: string[]) => void;
  onExcludeTagIds: (ids: string[]) => void;
  onTagMode: (mode: 'any' | 'all') => void;
  onSingleGroup: (group: string) => void;
  onQuickTag: (tagId: string | null) => void;
  onRetryFacets: () => void;
}) {
  const selectedGroups = query.groupIds ?? [];
  const includedTags = query.includeTagIds ?? [];
  const excludedTags = query.excludeTagIds ?? [];
  const candidateTags = tagCandidatesCurrent ? facets.tagItems : [];
  const groupName = (id: string) => groups.find((group) => group.id === id)?.name ?? id;
  const tag = (id: string) => facets.tagItems.find((item) => item.tagId === id);
  const tagName = (id: string) => {
    const item = tag(id);
    return item ? `${item.category} / ${item.name}` : id;
  };
  const toggle = (values: string[], id: string) => values.includes(id) ? values.filter((value) => value !== id) : [...values, id];
  const countLabel = (count: number) => facetsCurrent ? `(${count})` : '(…)';
  const hasFilters = query.group !== undefined || selectedGroups.length > 0 || query.tagId !== undefined || includedTags.length > 0 || excludedTags.length > 0 || query.label !== undefined;

  return <div className="border-b px-4 py-2 text-xs">
    <details open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
      <summary className="cursor-pointer select-none font-medium">高级分组与标签筛选</summary>
      <div className="mt-3 grid gap-4 md:grid-cols-3">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[11px] font-medium text-muted-foreground">分组（多选为并集）</legend>
          {groups.filter((group): group is GroupInfo & { id: string } => typeof group.id === 'string' && group.id.length > 0).map((group) => {
            const count = facets.groups.find((facet) => facet.group === group.name)?.count ?? 0;
            return <label key={group.id} className="flex items-center gap-2">
              <input aria-label={`选择分组 ${group.name}`} type="checkbox" checked={selectedGroups.includes(group.id!)} onChange={() => onGroupIds(toggle(selectedGroups, group.id!))} />
              <GroupDot color={group.color} />{group.name} {countLabel(count)}
            </label>;
          })}
          {!groups.some((group) => group.id) && <span className="text-muted-foreground">暂无可用的稳定分组 ID</span>}
          {query.group !== undefined && <span className="text-muted-foreground">单一分组筛选与多选互斥；选择多项会清除单一分组。</span>}
        </fieldset>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[11px] font-medium text-muted-foreground">包含标签</legend>
          <Input aria-label="搜索标签候选" className="h-8" value={tagSearch} onChange={(event) => onTagSearch(event.target.value)} placeholder="搜索标签名称" />
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>{tagCandidatesCurrent && tagTotal !== null
              ? tagTotal === 0 ? '当前搜索没有标签候选（0）' : `显示 ${(tagPage - 1) * tagPageSize + 1}–${Math.min(tagPage * tagPageSize, tagTotal)} / ${tagTotal} 个标签`
              : tagCandidatesCurrent ? '标签总数暂不可用' : facetsError ? `标签候选读取失败：${facetsError}` : '正在加载标签候选…'}</span>
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="outline" className="h-6 px-2" disabled={!tagCandidatesCurrent || facetsLoading || tagPage <= 1} aria-label="上一页标签候选" onClick={() => onTagPage(tagPage - 1)}>上一页</Button>
              <Button size="sm" variant="outline" className="h-6 px-2" disabled={!tagCandidatesCurrent || facetsLoading || tagTotal === null || tagPage * tagPageSize >= tagTotal} aria-label="下一页标签候选" onClick={() => onTagPage(tagPage + 1)}>下一页</Button>
            </div>
          </div>
          <label className="mb-1 flex items-center gap-2">匹配方式
            <select aria-label="包含标签匹配" className="rounded border bg-background px-2 py-1" value={query.tagMode ?? 'any'} onChange={(event) => onTagMode(event.target.value as 'any' | 'all')}>
              <option value="any">任意一个</option><option value="all">全部</option>
            </select>
          </label>
          {candidateTags.map((item) => <label key={item.tagId} className="flex items-center gap-2">
            <input aria-label={`包含标签 ${item.category} / ${item.name}`} type="checkbox" checked={includedTags.includes(item.tagId)} onChange={() => {
              const next = toggle(includedTags, item.tagId);
              onIncludeTagIds(next);
              if (next.includes(item.tagId)) onExcludeTagIds(excludedTags.filter((id) => id !== item.tagId));
            }} />
            {item.category} / {item.name} {countLabel(item.count)}
          </label>)}
          {!candidateTags.length && tagCandidatesCurrent && <span className="text-muted-foreground">当前页没有标签候选</span>}
        </fieldset>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[11px] font-medium text-muted-foreground">排除标签</legend>
          {candidateTags.map((item) => <label key={item.tagId} className="flex items-center gap-2">
            <input aria-label={`排除标签 ${item.category} / ${item.name}`} type="checkbox" checked={excludedTags.includes(item.tagId)} onChange={() => {
              const next = toggle(excludedTags, item.tagId);
              onExcludeTagIds(next);
              if (next.includes(item.tagId)) onIncludeTagIds(includedTags.filter((id) => id !== item.tagId));
            }} />
            {item.category} / {item.name} {countLabel(item.count)}
          </label>)}
          {!candidateTags.length && tagCandidatesCurrent && <span className="text-muted-foreground">当前页没有标签候选</span>}
        </fieldset>
      </div>
      {facetsLoading && <p role="status" className="mt-2 text-[11px] text-muted-foreground">{facetsCurrent ? '正在加载当前标签候选页…' : '正在更新当前筛选条件下的分组和标签计数…'}</p>}
      {facetsError && <div role="alert" className="mt-2 flex items-center gap-2 text-[11px] text-destructive"><span>筛选计数读取失败：{facetsError}</span><Button size="sm" variant="outline" onClick={onRetryFacets}>重试计数</Button></div>}
    </details>
    {hasFilters && <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="当前筛选">
      <span className="text-[11px] text-muted-foreground">当前筛选：</span>
      {query.group !== undefined && <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onSingleGroup('all')} aria-label={`移除单一分组 ${query.group || '未分组'}`}>分组 {query.group || '未分组'} ×</Button>}
      {selectedGroups.map((id) => <Button key={id} size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onGroupIds(selectedGroups.filter((value) => value !== id))} aria-label={`移除分组 ${groupName(id)}`}>分组 {groupName(id)} ×</Button>)}
      {query.tagId && <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onQuickTag(null)} aria-label={`移除快捷标签 ${tagName(query.tagId)}`}>快捷标签 {tagName(query.tagId)} ×</Button>}
      {includedTags.map((id) => <Button key={`include-${id}`} size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onIncludeTagIds(includedTags.filter((value) => value !== id))} aria-label={`移除包含标签 ${tagName(id)}`}>包含 {tagName(id)} ×</Button>)}
      {excludedTags.map((id) => <Button key={`exclude-${id}`} size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onExcludeTagIds(excludedTags.filter((value) => value !== id))} aria-label={`移除排除标签 ${tagName(id)}`}>排除 {tagName(id)} ×</Button>)}
      {query.label !== undefined && <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onQuickTag(null)} aria-label="移除旧标签筛选">旧标签 {query.label || '未标记'} ×</Button>}
    </div>}
  </div>;
}

function ServerTagCloud({ tags, active, candidatesCurrent, candidateLoading, candidateError, tagSearch, tagPage, tagPageSize, tagTotal, onToggle, onManage, onOpenAdvanced }: {
  tags: ServerTagFacet[];
  active: string | null;
  candidatesCurrent: boolean;
  candidateLoading: boolean;
  candidateError: string | null;
  tagSearch: string;
  tagPage: number;
  tagPageSize: number;
  tagTotal: number | null;
  onToggle: (tagId: string | null) => void;
  onManage: () => void;
  onOpenAdvanced: () => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, ServerTagFacet[]>();
    if (candidatesCurrent) for (const tag of tags) map.set(tag.category, [...(map.get(tag.category) ?? []), tag]);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN'));
  }, [tags, candidatesCurrent]);
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2">
    {!candidatesCurrent && <span role={candidateError ? 'alert' : 'status'} className={cn('text-[11px]', candidateError ? 'text-destructive' : 'text-muted-foreground')}>
      {candidateError ? `标签候选读取失败：${candidateError}` : '正在加载标签候选…'}
    </span>}
    {candidatesCurrent && !groups.length && <span className="text-[11px] text-muted-foreground">当前标签搜索没有候选</span>}
    {groups.map(([category, items]) => <div key={category} className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">{category}</span>
      {items.map((item) => <Button key={item.tagId} size="sm" variant={active === item.tagId ? 'default' : 'outline'} className="h-6 rounded-full px-2 text-[11px]" aria-label={`${category} ${item.name} ${candidatesCurrent ? item.count : '…'}`} aria-pressed={active === item.tagId} onClick={() => onToggle(active === item.tagId ? null : item.tagId)}>
        {item.name}<span className="ml-1 opacity-70">{candidatesCurrent ? item.count : '…'}</span>
      </Button>)}
    </div>)}
    {candidatesCurrent && <span className="text-[11px] text-muted-foreground">{tagTotal === null ? '候选总数暂不可用' : `${tagSearch ? `搜索“${tagSearch}” · ` : ''}第 ${tagPage} / ${Math.max(1, Math.ceil(tagTotal / tagPageSize))} 页 · ${tagTotal} 个候选`}</span>}
    <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={onOpenAdvanced}>搜索/翻页标签候选</Button>
    {active && <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onToggle(null)}>清除标签筛选</Button>}
    <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={onManage}>管理分类标签</Button>
  </div>;
}

/** 扫描参数弹窗：目标/排除/端口/并发/超时 → 开始扫描（命中自动落入网段发现表格）。 */
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
        action: { label: '查看服务器库', onClick: () => navigate('/servers') },
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
          只导入未入库的记录；记录上的标签会一并带入。导入后可在服务器库勾选目标并新建测试。
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
