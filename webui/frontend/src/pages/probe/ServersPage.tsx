import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FolderCog, Gauge, ListPlus, Pencil, Play, Plus, RefreshCw, Rocket, Tag, Trash2, X, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { probeApi } from '../../lib/api';
import { formatLastSeen } from '../../lib/format';
import { probeEndpointHost } from '../../lib/probeEndpoint';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import { ConfirmOverlay } from '../../components/Overlay';
import type {
  GroupColor, GroupInfo, ProbeDashboard, ProbeServer, ServerConn, ServerView, ServerViewColumn,
} from '../../lib/types';
import { GeoInfo } from './GeoInfo';
import {
  BatchEditDialog, GroupDialog, ImportDialog, ServerDialog, ServerImportStatus,
} from './ProbeDialogs';
import { ConnBadge, ProbeStatCards, SpeedText } from './ProbeParts';
import {
  GroupDot, groupVariant, IndeterminateCheckbox, latestServerObservationTime, Td, Th, ThSort,
} from './ProbeTableShared';
import { canFreezeServerSelection } from './serverBulkUi';
import { ServerAdvancedFilters, ServerTagCloud } from './ServerFilterControls';
import {
  queryFromSavedView, savedViewPayload, SERVER_VIEW_COLUMNS, serverViewDraftSignature,
} from './serverViews';
import { BatchTagDialog, TagManagementDialog } from './TagDialogs';
import { useServerBulk } from './useServerBulk';
import { useServerImport } from './useServerImport';
import { useServers } from './useServers';

export function ServersPage() {
  const navigate = useNavigate();
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [stats, setStats] = useState<ProbeDashboard | null>(null);
  const [dashboardError, setDashboardError] = useState('');
  const [loading, setLoading] = useState(true);

  const servers = useServers(true);
  const serverBulk = useServerBulk(true);
  const refreshedBulkJob = useRef<string | null>(null);
  const serverRows = servers.page.items;

  const [serverSearch, setServerSearch] = useState(servers.query.q ?? '');
  useEffect(() => { setServerSearch(servers.query.q ?? ''); }, [servers.query.q]);
  useEffect(() => {
    const timer = setTimeout(() => servers.setSearch(serverSearch), 300);
    return () => clearTimeout(timer);
  }, [serverSearch, servers.setSearch]);
  const serverQueryRef = useRef(servers.query);
  serverQueryRef.current = servers.query;
  const serverSearchRef = useRef(serverSearch);
  serverSearchRef.current = serverSearch;

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
  const [visibleServerColumns, setVisibleServerColumns] = useState<ServerViewColumn[]>(
    SERVER_VIEW_COLUMNS.map((column) => column.id),
  );
  const visibleServerColumnsRef = useRef(visibleServerColumns);
  visibleServerColumnsRef.current = visibleServerColumns;
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
      if (requestGeneration === viewsRequestGeneration.current && mutationGeneration === viewsMutationGeneration.current) {
        setSavedViews(result.items);
      }
    } catch (error) {
      if (requestGeneration === viewsRequestGeneration.current && mutationGeneration === viewsMutationGeneration.current) {
        toast.error(error instanceof Error ? error.message : '保存视图加载失败');
      }
    } finally {
      if (requestGeneration === viewsRequestGeneration.current) setViewsLoading(false);
    }
  }, []);

  useEffect(() => { void loadSavedViews(); }, [loadSavedViews]);

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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存视图失败');
    } finally {
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
      setRenamingView(false);
      toast.success('视图名称已更新');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重命名视图失败');
    } finally {
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
      setDeletingView(null);
      toast.success('视图已删除');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除视图失败');
    } finally {
      viewsMutationLocks.current.delete = false;
      setDeletingViewBusy(false);
      finishViewsMutation();
    }
  };

  // 弹窗状态
  const [editing, setEditing] = useState<ProbeServer | 'new' | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleting, setDeleting] = useState<ProbeServer | null>(null);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [batchTagsOpen, setBatchTagsOpen] = useState(false);
  const [serverAdvancedOpen, setServerAdvancedOpen] = useState(false);
  const [batchEdit, setBatchEdit] = useState<'group' | 'label' | null>(null);
  const [batchEditSnapshot, setBatchEditSnapshot] = useState<'group' | 'label' | null>(null);
  const [batchTagsSnapshotOpen, setBatchTagsSnapshotOpen] = useState(false);
  const [deletingSnapshot, setDeletingSnapshot] = useState(false);
  const [freezingSelection, setFreezingSelection] = useState(false);

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
    if (!serverBulk.job || !['done', 'partial', 'failed'].includes(serverBulk.job.state) || refreshedBulkJob.current === serverBulk.job.jobId) return;
    refreshedBulkJob.current = serverBulk.job.jobId;
    void servers.refreshAll({ recoverOutOfRange: true }).catch(() => {});
    void loadGroups();
  }, [loadGroups, serverBulk.job?.jobId, serverBulk.job?.state, servers]);

  const serverImport = useServerImport(() => {
    void servers.refreshAll({ recoverOutOfRange: true }).catch(() => {});
    void loadGroups();
    void loadDashboard();
  });

  useEffect(() => {
    void loadDashboard();
    void loadGroups();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void loadDashboard();
    }, 10000);
    return () => clearInterval(timer);
  }, [loadDashboard, loadGroups]);

  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { group, count } of servers.facets.groups) counts.set(group, count);
    return counts;
  }, [servers.facets.groups]);

  const groupColorMap = useMemo(() => {
    const map = new Map<string, GroupColor>();
    for (const group of groups) map.set(group.name, group.color);
    return map;
  }, [groups]);

  const selectedIps = useMemo(
    () => Array.from(servers.selected.values()).filter((ip): ip is string => typeof ip === 'string'),
    [servers.selected],
  );
  const allPageSelected = serverRows.length > 0 && serverRows.every((item) => servers.selected.has(item.id));
  const somePageSelected = !allPageSelected && serverRows.some((item) => servers.selected.has(item.id));

  const bulkActionBusy = !!serverBulk.pending || !!serverBulk.job && ['queued', 'running'].includes(serverBulk.job.state);
  const manualBulkDisabled = bulkActionBusy || servers.selected.size > 5000;
  const freezeReady = canFreezeServerSelection(
    serverSearch, servers.query.q, servers.totalCount,
    servers.countLoading, servers.countError, servers.pageLoading, servers.pageError,
  );

  function quickTest(mode: 'connectivity' | 'speed' | 'full') {
    if (!selectedIps.length) return;
    sessionStorage.setItem('probe_selected_endpoints', JSON.stringify(selectedIps));
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

  async function deleteSelected() {
    const targets = [...servers.selected.entries()];
    setDeletingSelected(false);
    try {
      const next = await serverBulk.submit('delete', {}, targets.map(([id]) => id));
      toast.success(`删除任务已提交（${next.total} 台）`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除任务提交失败');
    }
  }

  async function freezeMatchingServers() {
    setFreezingSelection(true);
    try {
      const next = await serverBulk.freezeAllMatching(servers.query);
      toast.success(next.state === 'ready' ? `已冻结 ${next.count} 台匹配服务器` : '正在生成服务器选择快照');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建选择快照失败');
    } finally {
      setFreezingSelection(false);
    }
  }

  async function submitSnapshotUpdate(payload: Record<string, unknown>) {
    return serverBulk.submit('update', payload);
  }

  async function submitSnapshotDelete() {
    setDeletingSnapshot(false);
    try {
      const next = await serverBulk.submit('delete', {});
      toast.success(`批量删除任务已提交（${next.total} 台）`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '批量删除提交失败');
    }
  }

  return (
    <div className="mx-auto max-w-[1600px] px-6 py-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">服务器库</h2>
        <Badge tone="muted">frps 验收</Badge>
        <div className="ml-auto flex items-center gap-3">
          <Button size="sm" variant="outline" onClick={() => navigate('/test-nodes')}>测试节点</Button>
          <ProbeStatCards stats={stats} />
          <Button size="sm" variant="outline" onClick={() => { void loadDashboard(); servers.refreshAll().catch(() => {}); }} disabled={loading}>
            <RefreshCw size={13} />刷新
          </Button>
        </div>
      </div>

      {dashboardError && <p role="alert" className="mb-3 text-sm text-destructive">{dashboardError}；统计不可用，请重试。</p>}
      <p className="mb-3 text-sm text-muted-foreground">当前结果反映最近一次被接受的主用或备用测量；执行来源与任务进度请查看测试任务和历史记录。</p>

      <div className="mt-4">
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
              <Button size="sm" variant="outline" onClick={() => quickTest('connectivity')}>
                <Play size={13} />测连通
              </Button>
              <Button size="sm" variant="outline" onClick={() => quickTest('speed')}>
                <Gauge size={13} />测速率
              </Button>
              <Button size="sm" onClick={() => quickTest('full')}>
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
                      <IndeterminateCheckbox
                        aria-label="全选"
                        className="size-3.5 accent-[var(--primary)]"
                        checked={allPageSelected}
                        indeterminate={somePageSelected}
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
                      {visibleServerColumns.includes('ip') && <Td><div className="flex flex-col gap-1"><div className="font-mono text-[12px] font-medium">{item.ip}</div><GeoInfo geo={item.geo} labels={item.labels} /></div></Td>}
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
                          <Button size="sm" variant="outline" onClick={() => navigate(`/instances/new?${new URLSearchParams({ server: probeEndpointHost(item.ip), port: String(item.port) })}`)} title="用此服务器创建 frpc 实例">
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
      </div>

      {serverImport.job && <ServerImportStatus task={serverImport} />}

      {editing && (
        <ServerDialog
          server={editing === 'new' ? null : editing}
          groups={groups.map((group) => group.name)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void loadDashboard();
            servers.refreshAll().catch(() => {});
            void loadGroups();
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
      {deletingView && (
        <ConfirmOverlay
          title={`删除保存视图「${deletingView.name}」`}
          description="删除后无法恢复此视图。"
          confirmLabel={deletingViewBusy ? '删除中…' : '删除视图'}
          variant="destructive"
          confirmDisabled={deletingViewBusy}
          keepOpenOnConfirm
          onCancel={() => setDeletingView(null)}
          onConfirm={() => void deleteServerView()}
        />
      )}
      {groupsOpen && (
        <GroupDialog
          groups={groups}
          groupCounts={groupCounts}
          onClose={() => setGroupsOpen(false)}
          onChanged={() => {
            void loadGroups();
            servers.refreshAll().catch(() => {});
          }}
        />
      )}
      <TagManagementDialog open={tagsOpen} onOpenChange={setTagsOpen} onChanged={() => servers.refreshAll().catch(() => {})} />
      <BatchTagDialog
        open={batchTagsOpen}
        onOpenChange={setBatchTagsOpen}
        ids={[...servers.selected.keys()]}
        onSubmitBulk={(payload) => serverBulk.submit('update', payload, [...servers.selected.keys()]).then(() => {})}
        onSaved={() => { setBatchTagsOpen(false); servers.refreshAll({ recoverOutOfRange: true }).catch(() => {}); }}
      />
      <BatchTagDialog
        open={batchTagsSnapshotOpen}
        onOpenChange={setBatchTagsSnapshotOpen}
        ids={[]}
        count={serverBulk.selection?.count ?? 0}
        snapshotMode
        onSubmitBulk={(payload) => serverBulk.submit('update', payload).then(() => {})}
        onSaved={() => { setBatchTagsSnapshotOpen(false); }}
      />
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
            void loadGroups();
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
          onSaved={() => {
            setBatchEditSnapshot(null);
            servers.refreshAll({ recoverOutOfRange: true }).catch(() => {});
            void loadGroups();
          }}
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
    </div>
  );
}
