import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Cpu,
  ListFilter,
  MemoryStick,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Server,
} from 'lucide-react';
import {
  Badge,
  EmptyState,
  IconAction,
  NodeCard,
  PanelHead,
  RowMenu,
  Select,
  SummaryCard,
  Switch,
  Td,
  Th
} from './overview/WorkspaceParts';
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
  parsePercent,
  shortNodeUuid
} from '../lib/format';
import { api, nodesApi } from '../lib/api';
import { useConsole } from '../context/ConsoleContext';
import type {
  InstanceDetail,
  InstanceRef,
  InstanceSummary,
  NodeStatus,
} from '../lib/types';

type StatusFilter = 'all' | 'running' | 'error' | 'stopped' | 'disabled';
type EnabledFilter = 'all' | 'enabled' | 'disabled';
type SummaryCache = Record<string, InstanceSummary | null>;

export function Overview() {
  const {
    nodes,
    instances,
    stats,
    counts,
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
  const [summaryCache, setSummaryCache] = useState<SummaryCache>({});

  function openInstance(item: InstanceRef, tab?: 'config') {
    const suffix = tab === 'config' ? '?tab=config' : '';
    navigate(`/instances/${item.nodeId}/${encodeURIComponent(item.name)}${suffix}`);
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
        disabled
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
      const stat = stats[instanceKey(item)];
      const summary = summaryCache[instanceKey(item)];
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
        stat?.status
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
  }, [enabledFilter, instanceKeyword, selectedNodeInstances, stats, statusFilter, summaryCache]);

  const visibleInstances = useMemo(() => {
    if (proxyTypeFilter === 'all') return baseVisibleInstances;
    return baseVisibleInstances.filter((item) => {
      const summary = summaryCache[instanceKey(item)];
      return !!summary?.proxyTypes?.[proxyTypeFilter];
    });
  }, [baseVisibleInstances, proxyTypeFilter, summaryCache]);

  const visibleSummaryKey = useMemo(
    () => baseVisibleInstances.slice(0, 25).map(instanceKey).join('|'),
    [baseVisibleInstances]
  );

  useEffect(() => {
    const targets = baseVisibleInstances
      .slice(0, 25)
      .filter((item) => !(instanceKey(item) in summaryCache));
    if (!targets.length) return;
    let cancelled = false;
    async function loadSummaries() {
      const entries = await Promise.all(
        targets.map(async (item) => {
          try {
            const detail =
              item.nodeId > 0
                ? await nodesApi.instances.get(item.nodeId, item.name)
                : await api<InstanceDetail>(`/api/instances/${item.name}`);
            return [instanceKey(item), detail.summary] as const;
          } catch {
            return [instanceKey(item), null] as const;
          }
        })
      );
      if (!cancelled) {
        setSummaryCache((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
      }
    }
    loadSummaries();
    return () => {
      cancelled = true;
    };
    // summaryCache intentionally omitted; visibleSummaryKey marks the request set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSummaryKey]);

  const proxyTypeOptions = useMemo(() => {
    const types = new Set<string>();
    for (const summary of Object.values(summaryCache)) {
      if (!summary?.proxyTypes) continue;
      for (const type of Object.keys(summary.proxyTypes)) types.add(type);
    }
    return Array.from(types).sort();
  }, [summaryCache]);

  const filteredNodes = useMemo(() => {
    const lower = nodeKeyword.trim().toLowerCase();
    if (!lower) return nodeSummaries;
    return nodeSummaries.filter((node) =>
      [node.name, node.uuid, node.status].join(' ').toLowerCase().includes(lower)
    );
  }, [nodeKeyword, nodeSummaries]);

  const cpuTotal = useMemo(() => {
    let total = 0;
    let samples = 0;
    for (const item of selectedNodeInstances) {
      const value = stats[instanceKey(item)]?.cpuPercent;
      if (!value) continue;
      total += parsePercent(value);
      samples += 1;
    }
    return samples ? `${total.toFixed(1)}%` : '--';
  }, [selectedNodeInstances, stats]);

  const memoryTotal = useMemo(() => {
    let total = 0;
    let samples = 0;
    for (const item of selectedNodeInstances) {
      const value = stats[instanceKey(item)]?.memPercent;
      if (!value) continue;
      total += parsePercent(value);
      samples += 1;
    }
    return samples ? `${total.toFixed(1)}%` : '--';
  }, [selectedNodeInstances, stats]);

  const onlineNodes = nodes.filter((node) => node.online || node.status === 'online').length;
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
  const scopedStatusTone = selectedNode
    ? selectedNode.status === 'error'
      ? 'issue'
      : selectedNodeOnline
        ? 'online'
        : 'quiet'
    : 'online';

  return (
    <main className="w-full max-w-[1720px] mx-auto px-4 sm:px-6 py-5 sm:py-6">
      <SummaryCard
        scopeLabel={selectedNode ? selectedNode.name : '全部节点'}
        items={[
          {
            icon: Server,
            tone: scopedStatusTone,
            label: selectedNode ? '节点状态' : '在线节点',
            value: scopedStatusValue,
            mono: !selectedNode
          },
          {
            icon: Activity,
            tone: selectedRunning > 0 ? 'running' : 'quiet',
            label: '运行实例',
            value: `${selectedRunning} / ${scopedTotal}`
          },
          {
            icon: ListFilter,
            tone: 'scope',
            label: '当前范围',
            value: `${visibleInstances.length} 条`
          },
          {
            icon: AlertTriangle,
            tone: selectedError > 0 ? 'issue' : 'quiet',
            label: '异常实例',
            value: String(selectedError)
          },
          {
            icon: Cpu,
            tone: 'quiet',
            label: 'CPU 采样',
            value: cpuTotal
          },
          {
            icon: MemoryStick,
            tone: 'quiet',
            label: '内存采样',
            value: memoryTotal
          },
        ]}
      />

      {!dockerAvailable && dockerError && (
        <div className="mb-4 rounded-lg border border-secondary bg-secondary px-3 py-2 text-[12px] text-secondary-foreground">
          Console 摘要：{dockerError}
        </div>
      )}

      <section className="grid grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)] gap-4 items-start">
        <aside className="rounded-lg border border-border bg-card shadow-sm overflow-hidden">
          <PanelHead
            title="Agent 节点"
            badge={`${onlineNodes} 在线`}
          />

          <div className="border-b border-border bg-muted p-3">
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

          <div className="p-3 grid gap-2.5">
            {nodes.length === 0 ? (
              <EmptyState
                title="还没有 Agent 节点"
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

        <section className="rounded-lg border border-border bg-card shadow-sm overflow-hidden">
          <PanelHead
            title={selectedNode ? selectedNode.name : '全部节点'}
            badge={`${selectedNodeInstances.length} 实例 · ${selectedRunning} 运行中`}
          />

          <div className="border-b border-border bg-muted/50 px-4 py-3">
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => navigate('/nodes')}>
                节点管理
              </Button>
              <Button size="sm" onClick={() => navigate('/create')} disabled={nodes.length === 0}>
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
              <div className="grid gap-2 border-b border-border bg-muted p-3 lg:grid-cols-[minmax(240px,1fr)_145px_145px_150px_auto]">
                <InputGroup>
                  <InputGroupAddon>
                    <Search aria-hidden="true" />
                  </InputGroupAddon>
                  <InputGroupInput
                    value={instanceKeyword}
                    onChange={(event) => setWorkspaceSearch(event.target.value)}
                    placeholder="搜索实例、节点、配置路径"
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

              <ToggleGroup
                type="single"
                value={statusFilter}
                onValueChange={(value) => setStatusFilter((value || 'all') as StatusFilter)}
                className="flex-wrap justify-start px-3 pt-3"
              >
                <ToggleGroupItem value="all">全部 {selectedNodeInstances.length}</ToggleGroupItem>
                <ToggleGroupItem value="running">运行中 {selectedRunning}</ToggleGroupItem>
                <ToggleGroupItem value="error">异常 {selectedError}</ToggleGroupItem>
                <ToggleGroupItem value="disabled">已停用 {selectedDisabled}</ToggleGroupItem>
              </ToggleGroup>

              {selectedNodeInstances.length === 0 && !instanceKeyword.trim() && statusFilter === 'all' && enabledFilter === 'all' ? (
                <div className="p-4">
                  <EmptyState
                    title={selectedNode ? '该节点还没有实例' : '还没有实例'}
                    actions={
                      selectedNode ? (
                        <Button size="sm" onClick={() => navigate('/create')}>
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
                <div className="grid gap-3 p-3 2xl:hidden">
                  {visibleInstances.map((item) => {
                    const key = instanceKey(item);
                    const stat = stats[key];
                    const summary = summaryCache[key];
                    const badge = instanceStateBadge(stat, item.enabled);
                    const badgeTone = badge.tone === 'danger' ? 'muted' : badge.tone;
                    const pending = pendingAction[key];
                    const isRunning = stat?.state === 'running';
                    const server = formatServer(summary);
                    const ports = formatPorts(summary);
                    const types = formatTypes(summary);
                    const memoryUsage = formatMemoryUsage(stat?.memUsage);
                    return (
                      <article
                        key={key}
                        className="min-w-0 rounded-lg border border-border bg-card p-3 shadow-sm"
                      >
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          {/* ponytail: 两行截断的可点击文本区，shadcn 无对应原语（Button 强制单行居中），保留原生 button */}
                          <button
                            onClick={() => openInstance(item)}
                            className="min-w-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          >
                            <span className="block truncate text-[13px] font-semibold text-foreground hover:text-primary hover:underline">
                              {item.displayName || item.name}
                            </span>
                            <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                              {item.name}
                              {item.description ? ` · ${item.description}` : ''}
                            </span>
                          </button>
                          <Badge tone={badgeTone}>{badge.label}</Badge>
                        </div>

                        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <MobileFact label="节点" value={item.nodeName} />
                          <MobileFact label="frps" value={server} mono />
                          <MobileFact label="远端端口" value={ports} mono />
                          <MobileFact label="类型" value={types} />
                          <MobileFact label="容器" value={stat?.containerName || stat?.service || '--'} mono />
                          <MobileFact label="配置路径" value={item.configPath || '--'} mono />
                        </div>

                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                            <span className="font-mono">代理 {summary ? summary.proxyCount : '--'}</span>
                            <span className="font-mono">CPU {stat?.cpuPercent || '--'}</span>
                            <span className="font-mono">内存 {memoryUsage}</span>
                            <span className="font-mono">重启 {stat ? stat.restartCount : '--'}</span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <Switch
                              checked={item.enabled}
                              disabled={pending === 'toggle'}
                              label={item.enabled ? '点击停用' : '点击启用'}
                              onChange={(next) => patchInstance(item, { enabled: next, applyImmediately: true })}
                            />
                            {isRunning ? (
                              <IconAction
                                onClick={() => action(item, 'stop')}
                                disabled={!!pending}
                                label="停止"
                              >
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
                              onDelete={() => deleteInstance(item)}
                              deleting={pending === 'delete'}
                            />
                          </div>
                        </div>
                      </article>
                    );
                  })}
                  {visibleInstances.length === 0 && (
                    <div className="rounded-lg border border-dashed border-input bg-muted p-6 text-center text-[12px] text-muted-foreground">
                      当前筛选条件下没有匹配的实例
                    </div>
                  )}
                </div>

                <div className="hidden 2xl:block">
                  <table className="w-full min-w-[1320px] border-collapse">
                    <thead>
                      <tr className="h-9 border-y border-border bg-muted">
                        <Th>实例</Th>
                        <Th>节点</Th>
                        <Th>状态</Th>
                        <Th>启用</Th>
                        <Th>frps</Th>
                        <Th align="right">代理</Th>
                        <Th>远端端口</Th>
                        <Th>类型</Th>
                        <Th>容器</Th>
                        <Th align="right">CPU</Th>
                        <Th align="right">内存</Th>
                        <Th align="right">重启</Th>
                        <Th>配置路径</Th>
                        <Th align="right">操作</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleInstances.map((item) => {
                        const key = instanceKey(item);
                        const stat = stats[key];
                        const summary = summaryCache[key];
                        const badge = instanceStateBadge(stat, item.enabled);
                        const badgeTone = badge.tone === 'danger' ? 'muted' : badge.tone;
                        const pending = pendingAction[key];
                        const isRunning = stat?.state === 'running';
                        const server = formatServer(summary);
                        const ports = formatPorts(summary);
                        const types = formatTypes(summary);
                        const memoryUsage = formatMemoryUsage(stat?.memUsage);
                        return (
                          <tr
                            key={key}
                            className="h-[58px] border-b border-border bg-card transition-colors hover:bg-primary/5"
                          >
                            <Td>
                              {/* ponytail: 同上，两行截断文本区保留原生 button */}
                              <button
                                onClick={() => openInstance(item)}
                                className="block max-w-[240px] rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                              >
                                <span className="block truncate text-[13px] font-semibold text-foreground hover:text-primary hover:underline">
                                  {item.displayName || item.name}
                                </span>
                                <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                                  {item.name}
                                  {item.description ? ` · ${item.description}` : ''}
                                </span>
                              </button>
                            </Td>
                            <Td>
                              <span className="text-[12px] text-muted-foreground">
                                {item.nodeName}
                              </span>
                            </Td>
                            <Td>
                              <Badge tone={badgeTone}>{badge.label}</Badge>
                            </Td>
                            <Td>
                              <Switch
                                checked={item.enabled}
                                disabled={pending === 'toggle'}
                                label={item.enabled ? '点击停用' : '点击启用'}
                                onChange={(next) => patchInstance(item, { enabled: next, applyImmediately: true })}
                              />
                            </Td>
                            <Td>
                              <span className="block max-w-[150px] truncate font-mono text-[11px] text-muted-foreground" title={server}>
                                {server}
                              </span>
                            </Td>
                            <Td align="right" mono>{summary ? summary.proxyCount : '--'}</Td>
                            <Td>
                              <span className="block max-w-[120px] truncate font-mono text-[11px] text-muted-foreground" title={ports}>
                                {ports}
                              </span>
                            </Td>
                            <Td>
                              <span className="block max-w-[120px] truncate text-[11px] text-muted-foreground" title={types}>
                                {types}
                              </span>
                            </Td>
                            <Td>
                              <span className="block max-w-[150px] truncate font-mono text-[11px] text-muted-foreground">
                                {stat?.containerName || stat?.service || '--'}
                              </span>
                            </Td>
                            <Td align="right" mono>{stat?.cpuPercent || '--'}</Td>
                            <Td align="right" mono>{memoryUsage}</Td>
                            <Td align="right" mono>{stat ? stat.restartCount : '--'}</Td>
                            <Td>
                              <span className="block max-w-[210px] truncate font-mono text-[11px] text-muted-foreground" title={item.configPath}>
                                {item.configPath || '--'}
                              </span>
                            </Td>
                            <Td align="right">
                              <div className="flex items-center justify-end gap-1">
                                {isRunning ? (
                                  <IconAction
                                    onClick={() => action(item, 'stop')}
                                    disabled={!!pending}
                                    label="停止"
                                  >
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
                          <td colSpan={14} className="px-4 py-10 text-center text-[12px] text-muted-foreground">
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
