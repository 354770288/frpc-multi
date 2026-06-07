import { useEffect, useMemo, useState } from 'react';
import {
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
} from 'lucide-react';
import {
  Badge,
  ContextCell,
  EmptyState,
  IconAction,
  Metric,
  NodeCard,
  PanelHead,
  RowMenu,
  Select,
  StatusTab,
  Switch,
  Td,
  Th
} from './overview/WorkspaceParts';
import {
  instanceStateBadge,
  parsePercent,
  shortNodeUuid
} from '../lib/format';
import { api, nodesApi } from '../lib/api';
import type {
  ConsoleInfo,
  InstanceDetail,
  InstanceRef,
  InstanceSummary,
  Node as ConsoleNode,
  Page,
  StatsMap
} from '../lib/types';

type InstancePatch = {
  displayName?: string;
  description?: string;
  enabled?: boolean;
  applyImmediately?: boolean;
};

type StatusFilter = 'all' | 'running' | 'error' | 'stopped' | 'disabled';
type EnabledFilter = 'all' | 'enabled' | 'disabled';
type SummaryCache = Record<string, InstanceSummary | null>;

export function Overview({
  nodes,
  selectedNodeId,
  instanceKeyword,
  instances,
  stats,
  counts,
  dockerAvailable,
  dockerError,
  system,
  pendingAction,
  onSelect,
  onSelectedNodeChange,
  onInstanceKeywordChange,
  onPage,
  onAction,
  onPatch,
  onDelete
}: {
  nodes: ConsoleNode[];
  selectedNodeId: number | 'all';
  instanceKeyword: string;
  instances: InstanceRef[];
  stats: StatsMap;
  counts: { total: number; running: number; stopped: number; error: number };
  dockerAvailable: boolean;
  dockerError: string;
  system: ConsoleInfo | null;
  pendingAction: Record<string, string>;
  onSelect: (instance: InstanceRef) => void;
  onSelectedNodeChange: (nodeId: number | 'all') => void;
  onInstanceKeywordChange: (keyword: string) => void;
  onPage: (page: Page) => void;
  onAction: (instance: InstanceRef, action: string) => void;
  onPatch: (instance: InstanceRef, patch: InstancePatch) => void;
  onDelete: (instance: InstanceRef) => void;
}) {
  const [nodeKeyword, setNodeKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [enabledFilter, setEnabledFilter] = useState<EnabledFilter>('all');
  const [proxyTypeFilter, setProxyTypeFilter] = useState('all');
  const [summaryCache, setSummaryCache] = useState<SummaryCache>({});

  useEffect(() => {
    if (selectedNodeId === 'all') return;
    if (!nodes.some((node) => node.id === selectedNodeId)) onSelectedNodeChange('all');
  }, [nodes, onSelectedNodeChange, selectedNodeId]);

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
  const offlineNodes = Math.max(nodes.length - onlineNodes, 0);
  const selectedRunning = selectedNode
    ? selectedNode.running
    : nodeSummaries.reduce((sum, node) => sum + node.running, 0);
  const selectedError = selectedNode
    ? selectedNode.error
    : nodeSummaries.reduce((sum, node) => sum + node.error, 0);
  const selectedDisabled = selectedNode
    ? selectedNode.disabled
    : nodeSummaries.reduce((sum, node) => sum + node.disabled, 0);

  return (
    <main className="w-full max-w-[1720px] mx-auto px-4 sm:px-6 py-5 sm:py-6">
      <section className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Metric tone="blue" label="在线节点" value={`${onlineNodes} / ${nodes.length || 0}`} />
        <Metric tone="green" label="运行实例" value={`${counts.running} / ${counts.total}`} />
        <Metric tone="orange" label={selectedNode ? `${selectedNode.name} 过滤` : '当前范围'} value={`${visibleInstances.length} 条`} />
        <Metric tone="red" label="异常实例" value={String(counts.error)} />
      </section>

      {!dockerAvailable && dockerError && (
        <div className="mb-4 rounded-lg border border-[var(--color-warning)]/25 bg-[var(--color-warning-soft)] px-3 py-2 text-[12px] text-[var(--color-warning)]">
          Console 摘要：{dockerError}
        </div>
      )}

      <section className="grid grid-cols-1 xl:grid-cols-[360px_minmax(0,1fr)] gap-4 items-start">
        <aside className="rounded-lg border border-purple-200 bg-white shadow-sm overflow-hidden">
          <PanelHead
            label="节点"
            labelClass="bg-violet-50 text-violet-700"
            title="Agent 节点"
            description="节点卡片固定在左侧，作为第一层操作入口。"
            badge={`${onlineNodes} 在线`}
            tone="violet"
          />

          <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
            <label className="flex h-8 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-white px-2.5 text-[12px] text-[var(--color-fg-muted)] focus-within:border-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--color-accent)]/15">
              <Search size={13} aria-hidden="true" />
              <input
                value={nodeKeyword}
                onChange={(event) => setNodeKeyword(event.target.value)}
                placeholder="搜索节点名称"
                aria-label="搜索节点名称"
                className="min-w-0 flex-1 bg-transparent outline-none text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)]"
              />
            </label>
          </div>

          <div className="p-3 grid gap-2.5">
            {nodes.length === 0 ? (
              <EmptyState
                title="还没有 Agent 节点"
                text="先添加节点并完成 Agent 接入，工作台才会出现可创建实例的目标范围。"
                actions={
                  <button
                    onClick={() => onPage('nodes')}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-[12px] font-semibold text-white hover:bg-[var(--color-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2"
                  >
                    <Plus size={13} />
                    添加节点
                  </button>
                }
              />
            ) : (
              <>
                <NodeCard
                  active={selectedNodeId === 'all'}
                  name="全部节点"
                  uuid="跨节点实例检索"
                  statusLabel="聚合"
                  statusTone="gray"
                  total={counts.total}
                  running={counts.running}
                  error={counts.error}
                  onClick={() => onSelectedNodeChange('all')}
                />
                {filteredNodes.map((node) => (
                  <NodeCard
                    key={node.id}
                    active={selectedNodeId === node.id}
                    offline={!(node.online || node.status === 'online')}
                    name={node.name}
                    uuid={`uuid ${shortNodeUuid(node.uuid, 8)} · ${formatLastSeen(node.lastSeenAt)}`}
                    statusLabel={node.online || node.status === 'online' ? '在线' : node.status}
                    statusTone={node.online || node.status === 'online' ? 'green' : 'red'}
                    total={node.total}
                    running={node.running}
                    error={node.error}
                    onClick={() => onSelectedNodeChange(node.id)}
                  />
                ))}
                {filteredNodes.length === 0 && (
                  <EmptyState
                    title="没有匹配的节点"
                    text="清除节点搜索后可重新查看全部节点。"
                    actions={
                      <button
                        onClick={() => setNodeKeyword('')}
                        className="inline-flex h-8 items-center rounded-lg border border-[var(--color-border)] bg-white px-3 text-[12px] font-semibold text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                      >
                        清除搜索
                      </button>
                    }
                  />
                )}
              </>
            )}
          </div>
        </aside>

        <section className="rounded-lg border border-blue-200 bg-white shadow-sm overflow-hidden">
          <PanelHead
            label="当前节点"
            labelClass="bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
            title={selectedNode ? selectedNode.name : '全部节点'}
            description={
              selectedNode
                ? '右侧展示选中节点信息和该节点下的实例列表。'
                : '当前展示所有节点实例；选择左侧节点可收敛到单节点范围。'
            }
            badge={`${selectedNodeInstances.length} 实例 · ${selectedRunning} 运行中`}
            tone="blue"
          />

          <div className="border-b border-[var(--color-border)] bg-gradient-to-r from-[var(--color-accent-soft)] to-white px-4 py-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h2 className="text-[17px] font-semibold text-[var(--color-fg)]">
                  {selectedNode ? `${selectedNode.name} 节点信息` : '全部节点工作台'}
                </h2>
                <p className="mt-1 text-[11px] leading-5 text-[var(--color-fg-muted)]">
                  {selectedNode
                    ? `Agent ${selectedNode.online || selectedNode.status === 'online' ? '在线' : '离线'}，实例列表只显示当前节点范围。`
                    : 'Console 只聚合在线 Agent 上报的数据；节点安装、轮换密钥和升级 Agent 仍在节点页执行。'}
                </p>
              </div>
              <div className="flex flex-wrap gap-2 lg:justify-end">
                <button
                  onClick={() => onPage('nodes')}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-white px-3 text-[12px] font-semibold text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                >
                  节点管理
                </button>
                <button
                  onClick={() => onPage('create')}
                  disabled={nodes.length === 0}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-[12px] font-semibold text-white hover:bg-[var(--color-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                >
                  <Plus size={13} />
                  {selectedNode ? '在此节点创建实例' : '创建实例'}
                </button>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 lg:grid-cols-5 gap-2">
              <ContextCell label="Console 角色" value={system?.role || '--'} />
              <ContextCell label="在线节点" value={`${onlineNodes} / ${nodes.length || 0}`} mono />
              <ContextCell label="离线节点" value={String(offlineNodes)} mono />
              <ContextCell label="CPU 采样" value={cpuTotal} mono />
              <ContextCell label="内存采样" value={memoryTotal} mono />
            </div>
          </div>

          {nodes.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="先添加节点"
                text="节点工作台以 Agent 节点为操作边界。添加节点后，再在选中节点范围内创建和管理实例。"
                actions={
                  <button
                    onClick={() => onPage('nodes')}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-[12px] font-semibold text-white hover:bg-[var(--color-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2"
                  >
                    <Plus size={13} />
                    打开节点管理
                  </button>
                }
              />
            </div>
          ) : (
            <>
              <div className="grid gap-2 border-b border-[var(--color-border)] bg-blue-50/70 p-3 lg:grid-cols-[minmax(240px,1fr)_145px_145px_150px_auto]">
                <label className="flex h-8 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-white px-2.5 text-[12px] text-[var(--color-fg-muted)] focus-within:border-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--color-accent)]/15">
                  <Search size={13} aria-hidden="true" />
                  <input
                    value={instanceKeyword}
                    onChange={(event) => onInstanceKeywordChange(event.target.value)}
                    placeholder="搜索实例、节点、配置路径"
                    aria-label="搜索实例"
                    className="min-w-0 flex-1 bg-transparent outline-none text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)]"
                  />
                </label>
                <Select value={statusFilter} onChange={(value) => setStatusFilter(value as StatusFilter)} label="状态">
                  <option value="all">全部状态</option>
                  <option value="running">运行中</option>
                  <option value="error">异常</option>
                  <option value="stopped">已停止</option>
                  <option value="disabled">已停用</option>
                </Select>
                <Select value={enabledFilter} onChange={(value) => setEnabledFilter(value as EnabledFilter)} label="启用">
                  <option value="all">启用状态</option>
                  <option value="enabled">已启用</option>
                  <option value="disabled">已停用</option>
                </Select>
                <Select value={proxyTypeFilter} onChange={setProxyTypeFilter} label="代理类型">
                  <option value="all">代理类型</option>
                  {proxyTypeOptions.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </Select>
                <button
                  onClick={() => {
                    onInstanceKeywordChange('');
                    setStatusFilter('all');
                    setEnabledFilter('all');
                    setProxyTypeFilter('all');
                  }}
                  className="h-8 rounded-lg border border-[var(--color-border)] bg-white px-3 text-[12px] font-semibold text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                >
                  清除筛选
                </button>
              </div>

              <div className="flex gap-1.5 overflow-x-auto px-3 pt-3">
                <StatusTab active={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>
                  全部 {selectedNodeInstances.length}
                </StatusTab>
                <StatusTab active={statusFilter === 'running'} onClick={() => setStatusFilter('running')}>
                  运行中 {selectedRunning}
                </StatusTab>
                <StatusTab active={statusFilter === 'error'} onClick={() => setStatusFilter('error')}>
                  异常 {selectedError}
                </StatusTab>
                <StatusTab active={statusFilter === 'disabled'} onClick={() => setStatusFilter('disabled')}>
                  已停用 {selectedDisabled}
                </StatusTab>
              </div>

              {selectedNodeInstances.length === 0 && !instanceKeyword.trim() && statusFilter === 'all' && enabledFilter === 'all' ? (
                <div className="p-4">
                  <EmptyState
                    title={selectedNode ? '该节点还没有实例' : '还没有实例'}
                    text={selectedNode ? '从当前节点创建实例时，创建页会自动预选这个节点。' : '先在左侧选择一个节点，再从该节点范围创建实例。'}
                    actions={
                      selectedNode ? (
                        <button
                          onClick={() => onPage('create')}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-[12px] font-semibold text-white hover:bg-[var(--color-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2"
                        >
                          <Plus size={13} />
                          在此节点创建实例
                        </button>
                      ) : (
                        <button
                          onClick={() => onSelectedNodeChange(nodes[0].id)}
                          className="inline-flex h-8 items-center rounded-lg bg-[var(--color-accent)] px-3 text-[12px] font-semibold text-white hover:bg-[var(--color-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2"
                        >
                          选择 {nodes[0].name}
                        </button>
                      )
                    }
                  />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1320px] border-collapse">
                    <thead>
                      <tr className="h-9 border-y border-[var(--color-border)] bg-slate-50">
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
                        const pending = pendingAction[key];
                        const isRunning = stat?.state === 'running';
                        const server = formatServer(summary);
                        const ports = formatPorts(summary);
                        const types = formatTypes(summary);
                        return (
                          <tr
                            key={key}
                            className="h-[58px] border-b border-[var(--color-border)] bg-white transition-colors hover:bg-blue-50/45"
                          >
                            <Td>
                              <button
                                onClick={() => {
                                  onSelect(item);
                                  onPage('detail');
                                }}
                                className="block max-w-[240px] rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                              >
                                <span className="block truncate text-[13px] font-semibold text-[var(--color-fg)] hover:text-[var(--color-accent)] hover:underline">
                                  {item.displayName || item.name}
                                </span>
                                <span className="mt-0.5 block truncate font-mono text-[11px] text-[var(--color-fg-muted)]">
                                  {item.name}
                                  {item.description ? ` · ${item.description}` : ''}
                                </span>
                              </button>
                            </Td>
                            <Td>
                              <span className="text-[12px] text-[var(--color-fg-muted)]">
                                {item.nodeName}
                              </span>
                            </Td>
                            <Td>
                              <Badge tone={badge.tone}>{badge.label}</Badge>
                            </Td>
                            <Td>
                              <Switch
                                checked={item.enabled}
                                disabled={pending === 'toggle'}
                                label={item.enabled ? '点击停用' : '点击启用'}
                                onChange={(next) => onPatch(item, { enabled: next, applyImmediately: true })}
                              />
                            </Td>
                            <Td>
                              <span className="block max-w-[150px] truncate font-mono text-[11px] text-[var(--color-fg-muted)]" title={server}>
                                {server}
                              </span>
                            </Td>
                            <Td align="right" mono>{summary ? summary.proxyCount : '--'}</Td>
                            <Td>
                              <span className="block max-w-[120px] truncate font-mono text-[11px] text-[var(--color-fg-muted)]" title={ports}>
                                {ports}
                              </span>
                            </Td>
                            <Td>
                              <span className="block max-w-[120px] truncate text-[11px] text-[var(--color-fg-muted)]" title={types}>
                                {types}
                              </span>
                            </Td>
                            <Td>
                              <span className="block max-w-[150px] truncate font-mono text-[11px] text-[var(--color-fg-muted)]">
                                {stat?.containerName || stat?.service || '--'}
                              </span>
                            </Td>
                            <Td align="right" mono>{stat?.cpuPercent || '--'}</Td>
                            <Td align="right" mono>{stat?.memUsage || '--'}</Td>
                            <Td align="right" mono>{stat ? stat.restartCount : '--'}</Td>
                            <Td>
                              <span className="block max-w-[210px] truncate font-mono text-[11px] text-[var(--color-fg-muted)]" title={item.configPath}>
                                {item.configPath || '--'}
                              </span>
                            </Td>
                            <Td align="right">
                              <div className="flex items-center justify-end gap-1">
                                {isRunning ? (
                                  <IconAction
                                    onClick={() => onAction(item, 'stop')}
                                    disabled={!!pending}
                                    label="停止"
                                  >
                                    <Pause size={13} />
                                  </IconAction>
                                ) : (
                                  <IconAction
                                    onClick={() => onAction(item, 'start')}
                                    disabled={!!pending || !item.enabled}
                                    label={item.enabled ? '启动' : '已停用，无法启动'}
                                    primary
                                  >
                                    <Play size={13} />
                                  </IconAction>
                                )}
                                <IconAction
                                  onClick={() => onAction(item, 'restart')}
                                  disabled={!!pending || !item.enabled}
                                  label={item.enabled ? '重启' : '已停用，无法重启'}
                                >
                                  <RotateCcw size={13} />
                                </IconAction>
                                <RowMenu
                                  onOpen={() => {
                                    onSelect(item);
                                    onPage('detail');
                                  }}
                                  onConfig={() => {
                                    onSelect(item);
                                    onPage('config');
                                  }}
                                  onDelete={() => onDelete(item)}
                                  deleting={pending === 'delete'}
                                />
                              </div>
                            </Td>
                          </tr>
                        );
                      })}
                      {visibleInstances.length === 0 && (
                        <tr>
                          <td colSpan={14} className="px-4 py-10 text-center text-[12px] text-[var(--color-fg-muted)]">
                            当前筛选条件下没有匹配的实例
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="m-3 rounded-lg border border-[var(--color-warning)]/25 bg-[var(--color-warning-soft)] p-3 text-[12px] leading-5 text-[var(--color-warning)]">
                节点安装、密钥轮换和 Agent 升级在节点管理中执行；实例启动、停止、重启和配置编辑只作用于当前实例。
              </div>
            </>
          )}
        </section>
      </section>
    </main>
  );
}

function instanceKey(item: InstanceRef): string {
  return `${item.nodeId}:${item.name}`;
}

function formatLastSeen(value: string | null): string {
  if (!value) return '未连接';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const diff = Date.now() - timestamp;
  if (diff < 0) return '刚刚';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
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
