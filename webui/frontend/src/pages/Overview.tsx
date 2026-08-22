import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
} from 'lucide-react';
import {
  IconAction,
  NodeCard,
  PanelHead,
  RowMenu,
  Select,
  SummaryCards,
  Switch,
  Td,
  Th
} from './overview/WorkspaceParts';
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
  shortNodeUuid
} from '../lib/format';
import { api, lbApi, probeApi, nodesApi } from '../lib/api';
import { useConsole } from '../context/ConsoleContext';
import type {
  InstanceDetail,
  InstanceRef,
  InstanceSummary,
  LbDomain,
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
  // 部署链路卡：一次性拉取资源侧进度（失败按 0 处理，不打扰工作台）
  const [chain, setChain] = useState<{ reachable: number; domains: number; domainPooled: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      probeApi.dashboard().catch(() => null),
      lbApi.domains().catch(() => null as unknown as LbDomain[]),
    ]).then(([dash, domains]) => {
      if (cancelled) return;
      const list = Array.isArray(domains) ? domains : [];
      setChain({
        reachable: dash?.connectivity?.reachable ?? 0,
        domains: list.filter((item) => item.enabled).length,
        domainPooled: list.reduce((sum, item) => sum + (item.enabled ? item.poolSize : 0), 0),
      });
    });
    return () => { cancelled = true; };
  }, []);

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

  return (
    <main className="w-full max-w-[1720px] mx-auto px-4 sm:px-6 py-5 sm:py-6">
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
                : undefined
          },
          {
            label: '运行实例',
            value: `${selectedRunning} / ${scopedTotal}`
          },
          {
            label: '异常实例',
            value: String(selectedError),
            badge: selectedError > 0 ? { label: '需处理', tone: 'danger' } : undefined
          },
          {
            label: '已停用',
            value: String(selectedDisabled)
          },
        ]}
      />

      <DeployChainCard
        reachable={chain?.reachable ?? null}
        domains={chain?.domains ?? null}
        domainPooled={chain?.domainPooled ?? 0}
        nodesOnline={onlineNodes}
        nodesTotal={nodes.length}
        instances={counts.total}
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
                          <Badge tone={badgeTone} dot>{badge.label}</Badge>
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
                  {/* 精简列：全屏宽度下不溢出、操作列始终可见；容器名/配置路径移入悬停提示与详情页 */}
                  <table className="w-full table-fixed border-collapse">
                    <thead>
                      <tr className="h-9 border-y border-border bg-muted">
                        <Th className="w-[30%] min-w-[220px]">实例</Th>
                        <Th className="w-[120px]">状态</Th>
                        <Th className="min-w-[180px]">穿透</Th>
                        <Th className="w-[170px]">资源</Th>
                        <Th align="right" className="w-[132px]">操作</Th>
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
                        const metaTip = [
                          item.configPath ? `配置：${item.configPath}` : '',
                          stat?.containerName || stat?.service ? `容器：${stat?.containerName || stat?.service}` : '',
                        ].filter(Boolean).join('\n');
                        return (
                          <tr
                            key={key}
                            className="h-[58px] border-b border-border bg-card transition-colors hover:bg-primary/5"
                          >
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
                              <div className="min-w-0" title={[server, `端口：${ports || '—'}`, `类型：${types || '—'}`].join('\n')}>
                                <span className="block truncate font-mono text-[11px] text-foreground">
                                  {server || '—'}
                                </span>
                                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                                  {summary ? `${summary.proxyCount} 条代理` : '代理 --'}
                                  {ports ? ` · ${ports}` : ''}
                                  {types ? ` · ${types}` : ''}
                                </span>
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
                          <td colSpan={5} className="px-4 py-10 text-center text-[12px] text-muted-foreground">
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

/**
 * 部署链路卡：横向四步（测试入池 → 域名池 → 节点 → 实例）。
 * 步骤未完成时即跳转入口，新用户首屏就能看到全链路方向。
 */
function DeployChainCard({ reachable, domains, domainPooled, nodesOnline, nodesTotal, instances }: {
  reachable: number | null;
  domains: number | null;
  domainPooled: number;
  nodesOnline: number;
  nodesTotal: number;
  instances: number;
}) {
  const navigate = useNavigate();
  const steps = [
    {
      to: '/probe',
      title: '① 测试入池',
      done: (reachable ?? 0) > 0,
      detail: reachable === null ? '加载中…' : reachable > 0 ? `${reachable} 台 frps 测通可入池` : '穿透测试通过 → 批量入健康分组',
    },
    {
      to: '/lb',
      title: '② 候选域名',
      done: (domains ?? 0) > 0 && domainPooled > 0,
      detail: domains === null ? '加载中…' : domains > 0
        ? (domainPooled > 0 ? `${domains} 个域名 · 池 ${domainPooled} 台` : '域名已建，池为空（去服务器库入组）')
        : '建候选域名并绑定健康分组',
    },
    {
      to: '/nodes',
      title: '③ Agent 节点',
      done: nodesOnline > 0,
      detail: nodesTotal > 0
        ? `${nodesOnline} / ${nodesTotal} 在线`
        : '在需要穿透的机器上接入 Agent',
    },
    {
      to: '/create',
      title: '④ 创建实例',
      done: instances > 0,
      detail: instances > 0 ? `${instances} 个实例` : '选候选域名，serverAddr 自动填域名',
    },
  ];
  const allDone = steps.every((step) => step.done);

  return (
    <section className="mb-4 rounded-lg border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-4 py-2.5">
        <h2 className="text-sm font-semibold">部署链路</h2>
        <span className="text-[11px] text-muted-foreground">
          服务器库入池 → 域名主备切换 → Agent 节点 → frpc 实例
        </span>
        {allDone && <Badge tone="success">全链就绪</Badge>}
      </div>
      <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map((step, index) => (
          <div key={step.to} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(step.to)}
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2 text-left transition-colors hover:border-primary/50 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {step.done
                ? <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"><Check size={11} /></span>
                : <span className="grid size-5 shrink-0 place-items-center rounded-full border border-border text-[10px] text-muted-foreground">{index + 1}</span>}
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-[12px] font-medium">
                  {step.title}
                  {!step.done && <Badge tone="muted">待完成</Badge>}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground" title={step.detail}>
                  {step.detail}
                </span>
              </span>
            </button>
            {index < steps.length - 1 && (
              <ArrowRight size={14} className="hidden shrink-0 text-muted-foreground xl:block" aria-hidden="true" />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
