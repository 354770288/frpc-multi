import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, FolderCog, Network, Radar, RefreshCw, Route, Tag, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { probeApi } from '../../lib/api';
import { formatLastSeen } from '../../lib/format';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import { ConfirmOverlay } from '../../components/Overlay';
import type {
  GroupColor, GroupInfo, ProbeDashboard, ProbeJobDetail, TestNode, TestNodeExecutionPolicy,
} from '../../lib/types';
import { GeoInfo } from './GeoInfo';
import { BatchEditDialog, ImportSelectedDialog } from './ProbeDialogs';
import { ProbeStatCards } from './ProbeParts';
import {
  GroupDot, groupVariant, IndeterminateCheckbox, isRouteLabel,
  LabelCloud, labelVariant, Td, Th, ThSort,
} from './ProbeTableShared';
import { ScanDialog } from './ScanDialog';
import { TestNodesDialog } from './TestNodesDialog';
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
  const [routeNodesOpen, setRouteNodesOpen] = useState(false);

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

  const loadGroups = useCallback(async () => {
    try { setGroups(await probeApi.groups()); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void loadNodes();
    void loadDashboard();
    void loadGroups();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadNodes();
        void loadDashboard();
      }
    }, 10000);
    return () => {
      clearInterval(timer);
      nodeRequestRef.current++;
    };
  }, [loadDashboard, loadGroups, loadNodes]);

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

  return (
    <div className="mx-auto max-w-[1600px] px-6 py-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">网段发现</h2>
        <Badge tone="muted">frps 验收</Badge>
        <div className="ml-auto flex items-center gap-3">
          <Button size="sm" variant="outline" onClick={() => navigate('/test-nodes')}>测试节点</Button>
          <ProbeStatCards stats={stats} />
          <Button size="sm" variant="outline" onClick={() => { void loadDashboard(); void discovery.refreshAll().catch(() => {}); }} disabled={loading}>
            <RefreshCw size={13} />刷新
          </Button>
        </div>
      </div>

      {nodeError && <p role="alert" className="mb-3 text-xs text-destructive">{nodeError}</p>}
      {dashboardError && <p role="alert" className="mb-3 text-sm text-destructive">{dashboardError}；统计不可用，请重试。</p>}

      <div className="mt-4">
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
                    <tr key={row.id} className="border-b last:border-b-0 transition-colors hover:bg-muted/50">
                      <Td>
                        <input
                          type="checkbox"
                          className="size-3.5 accent-[var(--primary)]"
                          checked={!row.inLibrary && dSelected.has(row.id)}
                          disabled={row.inLibrary}
                          onChange={() => discovery.toggleSelected(row.id)}
                        />
                      </Td>
                      <Td><div className="flex flex-col gap-1"><span className="font-mono text-[12px] font-medium">{row.ip}</span><GeoInfo geo={row.geo} labels={row.labels} /><span className="text-[11px] text-muted-foreground">{row.nodeName} · {row.latestRoute ? row.latestRoute.ok ? row.latestRoute.isCn2 ? 'CN2' : '非 CN2' : '路由失败' : '未测路由'}</span></div></Td>
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
      </div>

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
      {routeNodesOpen && (
        <TestNodesDialog nodes={nodes} onChanged={loadNodes} onClose={() => setRouteNodesOpen(false)} />
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
    </div>
  );
}
