import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Globe,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  IconAction,
  NodeCard,
  PanelHead,
  RowMenu,
  Select,
  SummaryCards,
  Switch,
  Td,
  Th,
} from './overview/WorkspaceParts';
import { CopyableText } from '../components/CopyableText';
import { Badge } from '../components/ui/badge';
import { EmptyState } from '../components/EmptyState';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import { Button } from '../components/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '../components/ui/input-group';
import {
  formatLastSeen,
  instanceStateBadge,
  shortNodeUuid,
} from '../lib/format';
import { useConsole } from '../context/ConsoleContext';
import type {
  InstanceRef,
  InstanceSummary,
  LbDomain,
  NodeStatus,
} from '../lib/types';

type StatusFilter = 'all' | 'running' | 'error' | 'stopped' | 'disabled';
type EnabledFilter = 'all' | 'enabled' | 'disabled';

export function Overview() {
  const {
    nodes,
    instances,
    instanceSummaries,
    overviewDomains,
    stats,
    counts,
    summaryLoaded,
    summaryError,
    loadSummary,
    dockerAvailable,
    dockerError,
    pendingAction,
    workspaceNodeId: selectedNodeId,
    setWorkspaceNodeId,
    workspaceSearch: instanceKeyword,
    setWorkspaceSearch,
    action,
    patchInstance,
    deleteInstance,
  } = useConsole();
  const navigate = useNavigate();
  const [nodeKeyword, setNodeKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [enabledFilter, setEnabledFilter] = useState<EnabledFilter>('all');
  const [proxyTypeFilter, setProxyTypeFilter] = useState('all');
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [batchBusy, setBatchBusy] = useState(false);

  const domainByName = useMemo(() => {
    const map = new Map<string, LbDomain>();
    for (const d of overviewDomains) {
      map.set(d.name.toLowerCase(), d);
    }
    return map;
  }, [overviewDomains]);

  function openInstance(item: InstanceRef, tab?: 'config') {
    const suffix = tab === 'config' ? '?tab=config' : '';
    navigate(`/instances/${item.nodeId}/${encodeURIComponent(item.name)}${suffix}`);
  }

  function cloneInstance(item: InstanceRef) {
    navigate(
      `/instances/new?${new URLSearchParams({
        cloneNode: String(item.nodeId),
        cloneName: item.name,
      })}`,
    );
  }

  useEffect(() => {
    if (selectedNodeId === 'all') return;
    if (!nodes.some((node) => node.id === selectedNodeId)) setWorkspaceNodeId('all');
  }, [nodes, selectedNodeId, setWorkspaceNodeId]);

  const nodeSummaries = useMemo(() => {
    return nodes.map((node) => {
      const nodeInstances = instances.filter((item) => item.nodeId === node.id);
      let running = 0;
      let error = 0;
      let stopped = 0;
      let disabled = 0;
      for (const item of nodeInstances) {
        const badge = instanceStateBadge(stats[instanceKey(item)], item.enabled);
        if (!item.enabled) disabled += 1;
        if (badge.tone === 'success') running += 1;
        else if (badge.tone === 'danger') error += 1;
        else stopped += 1;
      }
      return {
        ...node,
        total: nodeInstances.length,
        running,
        error,
        stopped,
        disabled,
      };
    });
  }, [instances, nodes, stats]);

  const selectedNode =
    selectedNodeId === 'all'
      ? null
      : nodeSummaries.find((node) => node.id === selectedNodeId) || null;

  const selectedNodeInstances = useMemo(() => {
    return selectedNode ? instances.filter((item) => item.nodeId === selectedNode.id) : instances;
  }, [instances, selectedNode]);

  const baseVisibleInstances = useMemo(() => {
    const lower = instanceKeyword.trim().toLowerCase();
    return selectedNodeInstances.filter((item) => {
      const key = instanceKey(item);
      const stat = stats[key];
      const summary = instanceSummaries[key] ?? item.summary;
      const badge = instanceStateBadge(stat, item.enabled);
      const searchable = [
        item.name,
        item.displayName,
        item.description,
        item.nodeName,
        item.configPath,
        summary?.serverAddr,
        summary?.serverPort,
        summary?.remotePorts?.join(' '),
        summary?.proxyTypes ? Object.keys(summary.proxyTypes).join(' ') : '',
        stat?.containerName,
        stat?.status,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (lower && !searchable.includes(lower)) return false;
      if (enabledFilter === 'enabled' && !item.enabled) return false;
      if (enabledFilter === 'disabled' && item.enabled) return false;
      if (statusFilter === 'running') return badge.tone === 'success';
      if (statusFilter === 'error') return badge.tone === 'danger';
      if (statusFilter === 'stopped') return item.enabled && badge.tone !== 'success' && badge.tone !== 'danger';
      if (statusFilter === 'disabled') return !item.enabled;
      return true;
    });
  }, [enabledFilter, instanceKeyword, instanceSummaries, selectedNodeInstances, stats, statusFilter]);

  const visibleInstances = useMemo(() => {
    if (proxyTypeFilter === 'all') return baseVisibleInstances;
    return baseVisibleInstances.filter((item) => {
      const summary = instanceSummaries[instanceKey(item)] ?? item.summary;
      return !!summary?.proxyTypes?.[proxyTypeFilter];
    });
  }, [baseVisibleInstances, instanceSummaries, proxyTypeFilter]);

  const proxyTypeOptions = useMemo(() => {
    const types = new Set<string>();
    for (const item of instances) {
      const summary = instanceSummaries[instanceKey(item)] ?? item.summary;
      if (!summary?.proxyTypes) continue;
      for (const type of Object.keys(summary.proxyTypes)) types.add(type);
    }
    return Array.from(types).sort();
  }, [instances, instanceSummaries]);

  const filteredNodes = useMemo(() => {
    const lower = nodeKeyword.trim().toLowerCase();
    if (!lower) return nodeSummaries;
    return nodeSummaries.filter((node) =>
      [node.name, node.uuid, node.status].join(' ').toLowerCase().includes(lower),
    );
  }, [nodeKeyword, nodeSummaries]);

  const selectedItems = useMemo(
    () => instances.filter((item) => selectedKeys.has(instanceKey(item))),
    [instances, selectedKeys],
  );
  const allVisibleSelected =
    visibleInstances.length > 0 && visibleInstances.every((item) => selectedKeys.has(instanceKey(item)));

  function toggleSelect(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSelectAllVisible(checked: boolean) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      for (const item of visibleInstances) {
        const key = instanceKey(item);
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }

  async function runBatchVerb(verb: 'start' | 'stop' | 'restart') {
    const targets = selectedItems.filter((item) => verb === 'stop' || item.enabled);
    if (!targets.length) {
      toast.warning('所选实例均处于已停用状态，请先启用后再操作');
      return;
    }
    setBatchBusy(true);
    try {
      await Promise.allSettled(targets.map((item) => action(item, verb)));
      setSelectedKeys(new Set());
    } finally {
      setBatchBusy(false);
    }
  }

  const onlineNodes = nodes.filter((node) => node.online || node.status === 'online').length;
  const offlineNodes = nodes.length - onlineNodes;
  const selectedRunning = selectedNode
    ? selectedNode.running
    : nodeSummaries.reduce((sum, node) => sum + node.running, 0);
  const selectedError = selectedNode
    ? selectedNode.error
    : nodeSummaries.reduce((sum, node) => sum + node.error, 0);
  const selectedDisabled = selectedNode
    ? selectedNode.disabled
    : nodeSummaries.reduce((sum, node) => sum + node.disabled, 0);
  const scopedTotal = selectedNode ? selectedNode.total : counts.total;
  const selectedNodeOnline = selectedNode
    ? selectedNode.online || selectedNode.status === 'online'
    : false;
  const scopedStatusValue = selectedNode
    ? selectedNodeOnline
      ? '在线'
      : nodeStatusLabel(selectedNode.status)
    : `${onlineNodes} / ${nodes.length || 0}`;

  if (!summaryLoaded) {
    return (
      <main role="status" className="mx-auto max-w-[1200px] p-6 text-sm text-muted-foreground">
        实例信息加载中…
      </main>
    );
  }
  if (summaryError && nodes.length === 0 && instances.length === 0) {
    return (
      <main className="mx-auto max-w-[1200px] p-6">
        <p role="alert" className="text-sm text-destructive">{summaryError}；实例数量尚未确认。</p>
        <Button className="mt-3" onClick={() => void loadSummary()}>重试</Button>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-[1720px] px-4 py-5 sm:px-6 sm:py-6">
      <SummaryCards
        items={[
          {
            label: selectedNode ? `节点状态 · ${selectedNode.name}` : '在线节点',
            value: scopedStatusValue,
            badge: selectedNode
              ? undefined
              : nodes.length > 0
                ? offlineNodes > 0
                  ? { label: `${offlineNodes} 台离线`, tone: 'warning' }
                  : { label: '全部在线', tone: 'success' }
                : undefined,
          },
          {
            label: '运行实例',
            value: `${selectedRunning} / ${scopedTotal}`,
          },
          {
            label: '异常实例',
            value: String(selectedError),
            badge: selectedError > 0 ? { label: '需处理', tone: 'danger' } : undefined,
          },
          {
            label: '已停用',
            value: String(selectedDisabled),
          },
        ]}
      />

      {!dockerAvailable && dockerError && (
        <div className="mb-4 rounded-lg border border-secondary bg-secondary px-3 py-2 text-[12px] text-secondary-foreground">
          Console 摘要：{dockerError}
        </div>
      )}

      <section className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[270px_minmax(0,1fr)]">
        <aside className="overflow-hidden rounded-xl border border-border bg-card shadow-2xs">
          <PanelHead title="部署节点" badge={`${onlineNodes} 在线`} />

          <div className="border-b border-border bg-muted/40 p-3">
            <InputGroup>
              <InputGroupAddon>
                <Search aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                value={nodeKeyword}
                onChange={(event) => setNodeKeyword(event.target.value)}
                placeholder="搜索节点名称"
                aria-label="搜索节点名称"
              />
            </InputGroup>
          </div>

          <div className="grid gap-2.5 p-3">
            {nodes.length === 0 ? (
              <EmptyState
                title="还没有部署节点"
                actions={
                  <Button size="sm" onClick={() => navigate('/nodes')}>
                    <Plus data-icon="inline-start" />
                    添加节点
                  </Button>
                }
              />
            ) : (
              <>
                <NodeCard
                  active={selectedNodeId === 'all'}
                  name="全部节点"
                  uuid="跨节点实例检索"
                  total={counts.total}
                  running={counts.running}
                  error={counts.error}
                  onClick={() => setWorkspaceNodeId('all')}
                />
                {filteredNodes.map((node) => (
                  <NodeCard
                    key={node.id}
                    active={selectedNodeId === node.id}
                    offline={!(node.online || node.status === 'online')}
                    name={node.name}
                    uuid={`uuid ${shortNodeUuid(node.uuid, 8)} · ${formatLastSeen(node.lastSeenAt)}`}
                    statusLabel={node.online || node.status === 'online' ? '在线' : nodeStatusLabel(node.status)}
                    statusTone={node.online || node.status === 'online' ? 'green' : node.status === 'error' ? 'red' : 'gray'}
                    total={node.total}
                    running={node.running}
                    error={node.error}
                    onClick={() => setWorkspaceNodeId(node.id)}
                  />
                ))}
                {filteredNodes.length === 0 && (
                  <EmptyState
                    title="没有匹配的节点"
                    actions={
                      <Button variant="outline" size="sm" onClick={() => setNodeKeyword('')}>
                        清除搜索
                      </Button>
                    }
                  />
                )}
              </>
            )}
          </div>
        </aside>

        <section className="overflow-hidden rounded-xl border border-border bg-card shadow-2xs">
          <PanelHead
            title={selectedNode ? selectedNode.name : '全部节点'}
            badge={`${selectedNodeInstances.length} 实例 · ${selectedRunning} 运行中`}
          />

          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-2.5">
            <ToggleGroup
              type="single"
              value={statusFilter}
              onValueChange={(value) => setStatusFilter((value || 'all') as StatusFilter)}
              className="flex-wrap justify-start"
            >
              <ToggleGroupItem value="all" className="text-xs">全部 {selectedNodeInstances.length}</ToggleGroupItem>
              <ToggleGroupItem value="running" className="text-xs">运行中 {selectedRunning}</ToggleGroupItem>
              <ToggleGroupItem value="error" className="text-xs">异常 {selectedError}</ToggleGroupItem>
              <ToggleGroupItem value="disabled" className="text-xs">已停用 {selectedDisabled}</ToggleGroupItem>
            </ToggleGroup>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => navigate('/nodes')}>
                节点管理
              </Button>
              <Button size="sm" onClick={() => navigate('/instances/new')} disabled={nodes.length === 0}>
                <Plus data-icon="inline-start" />
                {selectedNode ? '在此节点创建实例' : '创建实例'}
              </Button>
            </div>
          </div>

          {nodes.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="先添加节点"
                actions={
                  <Button size="sm" onClick={() => navigate('/nodes')}>
                    <Plus data-icon="inline-start" />
                    打开节点管理
                  </Button>
                }
              />
            </div>
          ) : (
            <>
              <div className="grid gap-2 border-b border-border bg-muted/40 p-3 lg:grid-cols-[minmax(220px,1fr)_140px_140px_145px_auto]">
                <InputGroup>
                  <InputGroupAddon>
                    <Search aria-hidden="true" />
                  </InputGroupAddon>
                  <InputGroupInput
                    value={instanceKeyword}
                    onChange={(event) => setWorkspaceSearch(event.target.value)}
                    placeholder="搜索实例、优选域名、端口或节点"
                    aria-label="搜索实例"
                  />
                </InputGroup>
                <Select
                  value={statusFilter}
                  onChange={(value) => setStatusFilter(value as StatusFilter)}
                  label="状态"
                  options={[
                    { value: 'all', label: '全部状态' },
                    { value: 'running', label: '运行中' },
                    { value: 'error', label: '异常' },
                    { value: 'stopped', label: '已停止' },
                    { value: 'disabled', label: '已停用' },
                  ]}
                />
                <Select
                  value={enabledFilter}
                  onChange={(value) => setEnabledFilter(value as EnabledFilter)}
                  label="启用"
                  options={[
                    { value: 'all', label: '启用状态' },
                    { value: 'enabled', label: '已启用' },
                    { value: 'disabled', label: '已停用' },
                  ]}
                />
                <Select
                  value={proxyTypeFilter}
                  onChange={setProxyTypeFilter}
                  label="代理类型"
                  options={[
                    { value: 'all', label: '代理类型' },
                    ...proxyTypeOptions.map((type) => ({ value: type, label: type })),
                  ]}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setWorkspaceSearch('');
                    setStatusFilter('all');
                    setEnabledFilter('all');
                    setProxyTypeFilter('all');
                  }}
                >
                  清除筛选
                </Button>
              </div>

              {selectedItems.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-4 py-2 text-xs">
                  <Badge tone="info">已选 {selectedItems.length} 个实例</Badge>
                  <Button size="sm" variant="outline" disabled={batchBusy} onClick={() => void runBatchVerb('start')}>
                    <Play className="size-3.5" />批量启动
                  </Button>
                  <Button size="sm" variant="outline" disabled={batchBusy} onClick={() => void runBatchVerb('stop')}>
                    <Pause className="size-3.5" />批量停止
                  </Button>
                  <Button size="sm" variant="outline" disabled={batchBusy} onClick={() => void runBatchVerb('restart')}>
                    <RotateCcw className="size-3.5" />批量重启
                  </Button>
                  <Button size="sm" variant="ghost" disabled={batchBusy} onClick={() => setSelectedKeys(new Set())}>
                    <X className="size-3.5" />清除勾选
                  </Button>
                </div>
              )}

              {selectedNodeInstances.length === 0 && !instanceKeyword.trim() && statusFilter === 'all' && enabledFilter === 'all' ? (
                <div className="p-4">
                  <EmptyState
                    title={selectedNode ? '该节点还没有实例' : '还没有实例'}
                    actions={
                      selectedNode ? (
                        <Button size="sm" onClick={() => navigate('/instances/new')}>
                          <Plus data-icon="inline-start" />
                          在此节点创建实例
                        </Button>
                      ) : (
                        <Button size="sm" onClick={() => setWorkspaceNodeId(nodes[0].id)}>
                          选择 {nodes[0].name}
                        </Button>
                      )
                    }
                  />
                </div>
              ) : (
                <>
                  {/* 移动端卡片视图 */}
                  <div className="grid gap-3 p-3 lg:hidden">
                    {visibleInstances.map((item) => {
                      const key = instanceKey(item);
                      const stat = stats[key];
                      const summary = instanceSummaries[key] ?? item.summary;
                      const badge = instanceStateBadge(stat, item.enabled);
                      const badgeTone = badge.tone === 'danger' ? 'danger' : badge.tone;
                      const pending = pendingAction[key];
                      const isRunning = stat?.state === 'running';
                      const server = formatServer(summary);
                      const ports = formatPorts(summary);
                      const types = formatTypes(summary);
                      const memoryUsage = formatMemoryUsage(stat?.memUsage);
                      const matchedDomain = summary?.serverAddr ? domainByName.get(summary.serverAddr.toLowerCase()) : undefined;

                      return (
                        <article
                          key={key}
                          className="min-w-0 rounded-lg border border-border bg-card p-3 shadow-2xs"
                        >
                          <div className="flex min-w-0 items-start justify-between gap-3">
                            <button
                              onClick={() => openInstance(item)}
                              className="min-w-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                            >
                              <span className="block truncate text-[13px] font-semibold text-foreground hover:text-primary hover:underline">
                                {item.displayName || item.name}
                              </span>
                              <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                                {item.name} · {item.nodeName}
                              </span>
                            </button>
                            <Badge tone={badgeTone} dot>{badge.label}</Badge>
                          </div>

                          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <MobileFact label="frps 连接" value={server} mono />
                            <MobileFact label="暴露端口" value={ports} mono />
                            <MobileFact label="代理类型" value={types} />
                            <MobileFact label="优选域名" value={matchedDomain ? matchedDomain.name : '手动地址'} mono />
                          </div>

                          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                              <span className="font-mono">代理 {summary ? summary.proxyCount : '--'}</span>
                              <span className="font-mono">CPU {stat?.cpuPercent || '--'}</span>
                              <span className="font-mono">内存 {memoryUsage}</span>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <Switch
                                checked={item.enabled}
                                disabled={pending === 'toggle'}
                                label={item.enabled ? '点击停用' : '点击启用'}
                                onChange={(next) => patchInstance(item, { enabled: next, applyImmediately: true })}
                              />
                              {isRunning ? (
                                <IconAction onClick={() => action(item, 'stop')} disabled={!!pending} label="停止">
                                  <Pause size={13} />
                                </IconAction>
                              ) : (
                                <IconAction
                                  onClick={() => action(item, 'start')}
                                  disabled={!!pending || !item.enabled}
                                  label={item.enabled ? '启动' : '已停用，无法启动'}
                                  primary
                                >
                                  <Play size={13} />
                                </IconAction>
                              )}
                              <IconAction
                                onClick={() => action(item, 'restart')}
                                disabled={!!pending || !item.enabled}
                                label={item.enabled ? '重启' : '已停用，无法重启'}
                              >
                                <RotateCcw size={13} />
                              </IconAction>
                              <RowMenu
                                onOpen={() => openInstance(item)}
                                onConfig={() => openInstance(item, 'config')}
                                onClone={() => cloneInstance(item)}
                                onDelete={() => deleteInstance(item)}
                                deleting={pending === 'delete'}
                              />
                            </div>
                          </div>
                        </article>
                      );
                    })}
                    {visibleInstances.length === 0 && (
                      <div className="rounded-lg border border-dashed border-input bg-muted/40 p-6 text-center text-[12px] text-muted-foreground">
                        当前筛选条件下没有匹配的实例
                      </div>
                    )}
                  </div>

                  {/* 桌面端表格视图（lg 及以上启用） */}
                  <div className="hidden overflow-x-auto lg:block">
                    <table className="w-full min-w-[820px] border-collapse">
                      <thead>
                        <tr className="h-9 border-y border-border bg-muted/40">
                          <Th className="w-9">
                            <input
                              type="checkbox"
                              aria-label="全选当前列表实例"
                              className="size-3.5 accent-[var(--primary)]"
                              checked={allVisibleSelected}
                              onChange={(e) => toggleSelectAllVisible(e.target.checked)}
                            />
                          </Th>
                          <Th className="min-w-[200px]">实例</Th>
                          <Th className="w-[120px]">状态</Th>
                          <Th className="min-w-[220px]">frps 目标与暴露端口</Th>
                          <Th className="w-[165px]">资源</Th>
                          <Th align="right" className="w-[136px]">操作</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleInstances.map((item) => {
                          const key = instanceKey(item);
                          const stat = stats[key];
                          const summary = instanceSummaries[key] ?? item.summary;
                          const badge = instanceStateBadge(stat, item.enabled);
                          const badgeTone = badge.tone === 'danger' ? 'danger' : badge.tone;
                          const pending = pendingAction[key];
                          const isRunning = stat?.state === 'running';
                          const server = formatServer(summary);
                          const types = formatTypes(summary);
                          const memoryUsage = formatMemoryUsage(stat?.memUsage);
                          const matchedDomain = summary?.serverAddr
                            ? domainByName.get(summary.serverAddr.toLowerCase())
                            : undefined;
                          const firstEndpoint =
                            summary?.serverAddr && summary?.remotePorts?.length
                              ? `${summary.serverAddr}:${summary.remotePorts[0]}`
                              : '';
                          const metaTip = [
                            item.configPath ? `配置：${item.configPath}` : '',
                            stat?.containerName || stat?.service ? `容器：${stat?.containerName || stat?.service}` : '',
                          ]
                            .filter(Boolean)
                            .join('\n');

                          return (
                            <tr
                              key={key}
                              className="h-[58px] border-b border-border bg-card transition-colors last:border-b-0 hover:bg-muted/40"
                            >
                              <Td>
                                <input
                                  type="checkbox"
                                  aria-label={`选择实例 ${item.name}`}
                                  className="size-3.5 accent-[var(--primary)]"
                                  checked={selectedKeys.has(key)}
                                  onChange={() => toggleSelect(key)}
                                />
                              </Td>
                              <Td>
                                <button
                                  onClick={() => openInstance(item)}
                                  title={metaTip || undefined}
                                  className="block w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                                >
                                  <span className="block truncate text-[13px] font-semibold text-foreground hover:text-primary hover:underline">
                                    {item.displayName || item.name}
                                  </span>
                                  <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                                    {item.name} · {item.nodeName}
                                    {item.description ? ` · ${item.description}` : ''}
                                  </span>
                                </button>
                              </Td>
                              <Td>
                                <div className="flex flex-col items-start gap-1">
                                  <Badge tone={badgeTone} dot>{badge.label}</Badge>
                                  <Switch
                                    checked={item.enabled}
                                    disabled={pending === 'toggle'}
                                    label={item.enabled ? '点击停用' : '点击启用'}
                                    onChange={(next) => patchInstance(item, { enabled: next, applyImmediately: true })}
                                  />
                                </div>
                              </Td>
                              <Td>
                                <div className="min-w-0 space-y-1">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    {matchedDomain ? (
                                      <Link
                                        to={`/lb/${matchedDomain.id}`}
                                        title={`已绑定优选域名 ${matchedDomain.name}${matchedDomain.currentIp ? `（当前指向 ${matchedDomain.currentIp}）` : ''}`}
                                        className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 font-mono text-[11px] font-medium text-primary hover:bg-primary/15"
                                      >
                                        <Globe className="size-3" />
                                        {matchedDomain.name}
                                      </Link>
                                    ) : (
                                      <span className="truncate font-mono text-[11.5px] text-foreground">
                                        {server}
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                                    <span>{summary ? `${summary.proxyCount} 条代理` : '代理 --'}</span>
                                    {types !== '--' && <span>· {types}</span>}
                                    {firstEndpoint && (
                                      <CopyableText
                                        value={firstEndpoint}
                                        display={summary!.remotePorts.slice(0, 3).map((p) => `:${p}`).join(', ')}
                                        label={`${item.name} 暴露端点`}
                                        textClassName="text-[11px] text-foreground/80"
                                      />
                                    )}
                                  </div>
                                </div>
                              </Td>
                              <Td>
                                <div
                                  className="min-w-0 font-mono text-[11px] tabular-nums text-muted-foreground"
                                  title={stat?.containerName || stat?.service || ''}
                                >
                                  <span className="block truncate">
                                    CPU {stat?.cpuPercent || '--'} · 内存 {memoryUsage}
                                  </span>
                                  <span className="mt-0.5 block truncate">
                                    重启 {stat ? stat.restartCount : '--'}
                                  </span>
                                </div>
                              </Td>
                              <Td align="right">
                                <div className="flex items-center justify-end gap-1">
                                  {isRunning ? (
                                    <IconAction onClick={() => action(item, 'stop')} disabled={!!pending} label="停止">
                                      <Pause size={13} />
                                    </IconAction>
                                  ) : (
                                    <IconAction
                                      onClick={() => action(item, 'start')}
                                      disabled={!!pending || !item.enabled}
                                      label={item.enabled ? '启动' : '已停用，无法启动'}
                                      primary
                                    >
                                      <Play size={13} />
                                    </IconAction>
                                  )}
                                  <IconAction
                                    onClick={() => action(item, 'restart')}
                                    disabled={!!pending || !item.enabled}
                                    label={item.enabled ? '重启' : '已停用，无法重启'}
                                  >
                                    <RotateCcw size={13} />
                                  </IconAction>
                                  <RowMenu
                                    onOpen={() => openInstance(item)}
                                    onConfig={() => openInstance(item, 'config')}
                                    onClone={() => cloneInstance(item)}
                                    onDelete={() => deleteInstance(item)}
                                    deleting={pending === 'delete'}
                                  />
                                </div>
                              </Td>
                            </tr>
                          );
                        })}
                        {visibleInstances.length === 0 && (
                          <tr>
                            <td colSpan={6} className="px-4 py-10 text-center text-[12px] text-muted-foreground">
                              当前筛选条件下没有匹配的实例
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </section>
      </section>
    </main>
  );
}

function MobileFact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-md bg-muted/60 px-2.5 py-2">
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

function instanceKey(item: InstanceRef): string {
  return `${item.nodeId}:${item.name}`;
}

function nodeStatusLabel(status: NodeStatus): string {
  if (status === 'pending') return '待连接';
  if (status === 'offline') return '离线';
  if (status === 'error') return '异常';
  return '未知';
}

function formatServer(summary: InstanceSummary | null | undefined): string {
  if (!summary?.serverAddr) return '--';
  return summary.serverPort ? `${summary.serverAddr}:${summary.serverPort}` : summary.serverAddr;
}

function formatPorts(summary: InstanceSummary | null | undefined): string {
  if (!summary?.remotePorts?.length) return '--';
  return summary.remotePorts.join(', ');
}

function formatTypes(summary: InstanceSummary | null | undefined): string {
  if (!summary?.proxyTypes) return '--';
  const entries = Object.entries(summary.proxyTypes);
  if (!entries.length) return '--';
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type} ${count}`)
    .join(', ');
}

function formatMemoryUsage(value: string | undefined): string {
  if (!value) return '--';
  const parts = value.split('/').map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2) return formatMemoryPart(value);
  const used = parseMemoryPart(parts[0]);
  const total = parseMemoryPart(parts[1]);
  if (!used || !total) return value;
  if (used.unit === total.unit) {
    return `${used.value.toFixed(1)} / ${total.value.toFixed(1)} ${used.unit}`;
  }
  return `${used.value.toFixed(1)}${used.unit} / ${total.value.toFixed(1)}${total.unit}`;
}

function formatMemoryPart(value: string): string {
  const parsed = parseMemoryPart(value);
  return parsed ? `${parsed.value.toFixed(1)}${parsed.unit}` : value;
}

function parseMemoryPart(value: string): { value: number; unit: string } | null {
  const match = /^([\d.]+)\s*([KMGTPE]?i?B)$/i.exec(value.trim());
  if (!match) return null;
  const parsedValue = Number(match[1]);
  if (!Number.isFinite(parsedValue)) return null;
  return { value: parsedValue, unit: match[2] };
}
