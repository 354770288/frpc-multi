import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, FolderCog, Radar, RefreshCw, Route, Search, Square, Tag, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { probeApi } from '../../lib/api';
import { formatLastSeen } from '../../lib/format';
import { CopyableText } from '../../components/CopyableText';
import { PageHeader, PageShell } from '../../components/PageHeader';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader } from '../../components/ui/card';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../../components/ui/input-group';
import { Progress } from '../../components/ui/progress';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import { ConfirmOverlay } from '../../components/Overlay';
import type {
  DiscoverStatus,
  GroupColor,
  GroupInfo,
  ProbeDashboard,
  ProbeJobDetail,
  RouteStatusView,
  TestNode,
  TestNodeExecutionPolicy,
} from '../../lib/types';
import { GeoInfo } from './GeoInfo';
import { BatchEditDialog, ImportSelectedDialog } from './ProbeDialogs';
import { ProbeStatCards } from './ProbeParts';
import {
  GroupDot, groupVariant, IndeterminateCheckbox, isRouteLabel,
  LabelCloud, labelVariant, Td, Th, ThSort,
} from './ProbeTableShared';
import { ScanDialog } from './ScanDialog';
import { useDiscovery } from './useDiscovery';

export function DiscoveryPage() {
  const navigate = useNavigate();
  const nodeRequestRef = useRef(0);
  const [nodes, setNodes] = useState<TestNode[]>([]);
  const [nodeError, setNodeError] = useState('');
  const [executionPolicyLoading, setExecutionPolicyLoading] = useState(true);
  const [executionPolicy, setExecutionPolicy] = useState<TestNodeExecutionPolicy | null>(null);
  const [executionPolicyError, setExecutionPolicyError] = useState('');
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [stats, setStats] = useState<ProbeDashboard | null>(null);
  const [dashboardError, setDashboardError] = useState('');
  const [loading, setLoading] = useState(true);

  const [scanStatus, setScanStatus] = useState<DiscoverStatus | null>(null);
  const [routeStatus, setRouteStatus] = useState<RouteStatusView | null>(null);
  const [stoppingScan, setStoppingScan] = useState(false);

  const discovery = useDiscovery(true);
  const discoverRows = discovery.page.items;
  const dSelected = discovery.selected;

  const [discoverySearch, setDiscoverySearch] = useState(discovery.query.q ?? '');
  useEffect(() => {
    const timer = setTimeout(() => discovery.setSearch(discoverySearch), 300);
    return () => clearTimeout(timer);
  }, [discoverySearch, discovery.setSearch]);

  const [scanOpen, setScanOpen] = useState(false);
  const [dBatchEdit, setDBatchEdit] = useState<'group' | 'label' | null>(null);
  const [dDeleting, setDDeleting] = useState(false);
  const [importSelOpen, setImportSelOpen] = useState(false);

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

  const loadDashboard = useCallback(async () => {
    try {
      setStats(await probeApi.dashboard('console'));
      setDashboardError('');
    } catch (err) {
      setDashboardError(err instanceof Error ? err.message : '统计加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLiveStatus = useCallback(async () => {
    const [dRes, rRes] = await Promise.allSettled([
      probeApi.discoverStatus(),
      probeApi.routeStatus(),
    ]);
    if (dRes.status === 'fulfilled' && dRes.value && typeof dRes.value.running === 'boolean') {
      setScanStatus(dRes.value);
    }
    if (rRes.status === 'fulfilled' && rRes.value && typeof rRes.value.active === 'boolean') {
      setRouteStatus(rRes.value);
    }
  }, []);

  const loadGroups = useCallback(async () => {
    try { setGroups(await probeApi.groups()); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void loadNodes();
    void loadDashboard();
    void loadGroups();
    void loadLiveStatus();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadNodes();
        void loadDashboard();
        void loadLiveStatus();
      }
    }, 6000);
    return () => {
      clearInterval(timer);
      nodeRequestRef.current++;
    };
  }, [loadDashboard, loadGroups, loadLiveStatus, loadNodes]);

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

  const discoveryHasFilter = Boolean(
    discovery.query.q?.trim()
    || discovery.query.group !== undefined
    || discovery.query.label !== undefined
    || discovery.query.library !== 'all',
  );

  const selectableRows = useMemo(() => discoverRows.filter((row) => !row.inLibrary), [discoverRows]);
  const allPageSelected = selectableRows.length > 0 && selectableRows.every((row) => dSelected.has(row.id));
  const somePageSelected = !allPageSelected && selectableRows.some((row) => dSelected.has(row.id));

  const startRouteTest = () => {
    if (!dSelected.size) return;
    const targets = [...discovery.selectedTargets.entries()].filter(([id]) => dSelected.has(id)).map(([, endpoint]) => endpoint);
    if (!targets.length) { toast.error('没有勾选目标'); return; }
    sessionStorage.setItem('probe_selected_endpoints', JSON.stringify(targets));
    navigate('/tests/new?selected=1&mode=route');
  };

  const handleStopScan = async () => {
    setStoppingScan(true);
    try {
      await probeApi.discoverStop();
      toast.success('已发送停止扫描指令');
      await loadLiveStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '停止扫描失败');
    } finally {
      setStoppingScan(false);
    }
  };

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

  const jobStarted = (job: ProbeJobDetail) => {
    navigate(`/tests/${job.id}`);
  };

  const scanPercent = scanStatus?.running && scanStatus.total > 0
    ? Math.min(100, Math.round((scanStatus.scanned / scanStatus.total) * 100))
    : 0;

  return (
    <PageShell maxWidth="full" className="max-w-[1600px]">
      <PageHeader
        title="网段发现"
        badge={<Badge tone="muted">{discovery.page.total} 条记录</Badge>}
        description="按全局主备测试节点扫描自有网段开放 7000 端口的设备，筛选后一键导入服务器库"
        actions={
          <>
            <ProbeStatCards stats={stats} />
            <Button
              size="sm"
              variant="outline"
              onClick={() => { void loadDashboard(); void loadLiveStatus(); void discovery.refreshAll().catch(() => {}); }}
              disabled={loading}
            >
              <RefreshCw className="size-3.5" data-icon="inline-start" />刷新
            </Button>
            <Button size="sm" onClick={() => setScanOpen(true)}>
              <Radar className="size-3.5" data-icon="inline-start" />开始扫描
            </Button>
          </>
        }
      />

      {nodeError && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">{nodeError}</p>}
      {dashboardError && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{dashboardError}；统计不可用，请重试。</p>}

      <Card>
        {scanStatus?.running && (
          <div className="space-y-2 border-b bg-primary/5 px-4 py-3 text-xs" role="status" aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge tone="info">网段扫描进行中</Badge>
                <span className="tabular-nums text-foreground">
                  已扫 {scanStatus.scanned} / {scanStatus.total} · 命中 {scanStatus.foundCount} 台（{scanPercent}%）
                </span>
              </div>
              <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" disabled={stoppingScan} onClick={() => void handleStopScan()}>
                <Square className="size-3" data-icon="inline-start" />停止扫描
              </Button>
            </div>
            <Progress value={scanPercent} className="h-1.5" />
          </div>
        )}

        {routeStatus?.active && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-sky-500/5 px-4 py-2.5 text-xs" role="status">
            <div className="flex items-center gap-2">
              <Badge tone="info">路由追踪队列运行中</Badge>
              <span>已完成 {routeStatus.done} · 运行中 {routeStatus.running} · 待处理 {routeStatus.pending}</span>
            </div>
          </div>
        )}

        <CardHeader className="flex-row flex-wrap items-center gap-2 border-b pb-3.5">
          <InputGroup className="h-8 w-full sm:w-52">
            <InputGroupAddon><Search className="size-3.5" /></InputGroupAddon>
            <InputGroupInput
              value={discoverySearch}
              onChange={(e) => setDiscoverySearch(e.target.value)}
              placeholder="搜索 IP / 标签 / 分组"
            />
          </InputGroup>

          <div className="w-40">
            <Select value={discovery.query.group ?? 'all'} onValueChange={discovery.setGroup}>
              <SelectTrigger size="sm" aria-label="发现分组筛选"><SelectValue /></SelectTrigger>
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
              <SelectTrigger size="sm" aria-label="入库状态筛选"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">全部状态</SelectItem>
                  <SelectItem value="new">未入库</SelectItem>
                  <SelectItem value="imported">已入库</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <span className="ml-auto text-xs text-muted-foreground">
            探测目标固定端口 <code className="font-mono">7000</code>
          </span>
        </CardHeader>

        <LabelCloud labels={discovery.facets.labels} active={discovery.query.label ?? null} onToggle={discovery.setLabel} />

        {dSelected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-4 py-2">
            <Badge tone="info">已选 {dSelected.size} 条</Badge>
            <Button size="sm" onClick={() => setImportSelOpen(true)}>
              <Download className="size-3.5" />导入服务器库
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDBatchEdit('group')}>
              <FolderCog className="size-3.5" />改分组
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDBatchEdit('label')}>
              <Tag className="size-3.5" />改标签
            </Button>
            <Button size="sm" onClick={startRouteTest}>
              <Route className="size-3.5" />路由测试
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setDDeleting(true)}>
              <Trash2 className="size-3.5" />删除
            </Button>
          </div>
        )}

        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[780px]">
              <thead>
                <tr className="border-b bg-muted/40">
                  <Th>
                    <IndeterminateCheckbox
                      aria-label="全选当前页发现记录"
                      className="size-3.5 accent-[var(--primary)]"
                      disabled={!selectableRows.length}
                      checked={allPageSelected}
                      indeterminate={somePageSelected}
                      onChange={(e) => discovery.toggleCurrentPage(e.target.checked)}
                    />
                  </Th>
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
                  <tr key={row.id} className="border-b transition-colors last:border-b-0 hover:bg-muted/40">
                    <Td>
                      <input
                        type="checkbox"
                        className="size-3.5 accent-[var(--primary)]"
                        checked={!row.inLibrary && dSelected.has(row.id)}
                        disabled={row.inLibrary}
                        onChange={() => discovery.toggleSelected(row.id)}
                      />
                    </Td>
                    <Td>
                      <div className="flex flex-col gap-1">
                        <CopyableText value={row.ip} label={row.ip} textClassName="text-[12.5px] font-medium" />
                        <GeoInfo geo={row.geo} labels={row.labels} />
                        <span className="text-[11px] text-muted-foreground">
                          {row.nodeName} · {row.latestRoute ? (row.latestRoute.ok ? (row.latestRoute.isCn2 ? 'CN2' : '非 CN2') : '路由失败') : '未测路由'}
                        </span>
                      </div>
                    </Td>
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
                          <Download className="size-3.5" />导入
                        </Button>
                      )}
                    </Td>
                  </tr>
                ))}
                {!discoverRows.length && (
                  <tr>
                    <td colSpan={9} className="px-4 py-12 text-center text-xs text-muted-foreground">
                      {discoveryHasFilter ? '当前筛选条件下没有匹配的记录' : '还没有发现记录，点「开始扫描」扫一段自有网段'}
                    </td>
                  </tr>
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
              <Button
                size="sm"
                variant="outline"
                disabled={discovery.page.page <= 1}
                onClick={() => discovery.setPageNumber(discovery.page.page - 1)}
              >
                上一页
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={discovery.page.page >= Math.max(1, Math.ceil(discovery.page.total / discovery.page.pageSize))}
                onClick={() => discovery.setPageNumber(discovery.page.page + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

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
          nodes={nodes}
          policy={executionPolicy}
          policyError={executionPolicyError}
          nodesError={nodeError}
          loading={executionPolicyLoading}
          onRetry={() => void loadNodes()}
          onClose={() => setScanOpen(false)}
          onStarted={(job) => { setScanOpen(false); jobStarted(job); }}
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
            void loadDashboard();
          }}
        />
      )}
      {dDeleting && (
        <ConfirmOverlay
          title={`删除勾选的 ${dSelected.size} 条发现记录`}
          description="只删除网段发现结果，已入库的服务器不受影响。"
          confirmLabel="删除"
          variant="destructive"
          onCancel={() => setDDeleting(false)}
          onConfirm={deleteDiscoverSelected}
        />
      )}
    </PageShell>
  );
}
