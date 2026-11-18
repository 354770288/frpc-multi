import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Gauge,
  Route,
  Server,
  ShieldCheck,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { probeApi } from '../lib/api';
import { createRequestId } from '../lib/requestId';
import type { GroupInfo, ProbeMode, ServerSelection, TestNode, TestNodeExecutionPolicy } from '../lib/types';
import { PageHeader, PageShell } from '../components/PageHeader';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { cn } from '../lib/utils';
import { MODE_NAMES } from './probe/NodeControls';

type Scope = '' | 'selected' | 'group' | 'manual' | 'all' | 'selection';
const MODES: Exclude<ProbeMode, 'discover'>[] = ['full', 'route', 'connectivity', 'speed'];
const SELECTION_SUBMISSION_KEY = 'probe_selection_test_submission';
type PendingSelectionSubmission = { selectionId: string; mode: Exclude<ProbeMode, 'discover'>; idempotencyKey: string };

const MODE_META: Record<Exclude<ProbeMode, 'discover'>, { icon: LucideIcon; desc: string }> = {
  full: { icon: Zap, desc: '依次执行路由追踪、穿透连通性与上下行测速（最常用）' },
  connectivity: { icon: Activity, desc: '验证 frps 7000 可达、隧道建立与远端防火墙端口放行' },
  speed: { icon: Gauge, desc: '在连通性通过门禁后测量真实隧道上下行吞吐速率' },
  route: { icon: Route, desc: '追踪去程跳点，自动识别是否命中 59.43 CN2 精品线路' },
};

const NATIVE_SELECT_CLASS =
  'mt-1.5 flex h-9 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-sm text-foreground shadow-2xs transition-colors focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';

function selectionIdempotencyKey(selectionId: string, mode: Exclude<ProbeMode, 'discover'>) {
  try {
    const current = JSON.parse(sessionStorage.getItem(SELECTION_SUBMISSION_KEY) || 'null') as PendingSelectionSubmission | null;
    if (current?.selectionId === selectionId && current.mode === mode && current.idempotencyKey) return current.idempotencyKey;
  } catch { /* replace stale session data below */ }
  const pending = { selectionId, mode, idempotencyKey: createRequestId() } satisfies PendingSelectionSubmission;
  sessionStorage.setItem(SELECTION_SUBMISSION_KEY, JSON.stringify(pending));
  return pending.idempotencyKey;
}

function clearSelectionIdempotencyKey(selectionId: string, mode: Exclude<ProbeMode, 'discover'>, idempotencyKey: string) {
  try {
    const current = JSON.parse(sessionStorage.getItem(SELECTION_SUBMISSION_KEY) || 'null') as PendingSelectionSubmission | null;
    if (current?.selectionId === selectionId && current.mode === mode && current.idempotencyKey === idempotencyKey) {
      sessionStorage.removeItem(SELECTION_SUBMISSION_KEY);
    }
  } catch {
    sessionStorage.removeItem(SELECTION_SUBMISSION_KEY);
  }
}

function rotateMismatchedSelectionIdempotencyKey(selectionId: string, mode: Exclude<ProbeMode, 'discover'>) {
  try {
    const current = JSON.parse(sessionStorage.getItem(SELECTION_SUBMISSION_KEY) || 'null') as PendingSelectionSubmission | null;
    if (current && (current.selectionId !== selectionId || current.mode !== mode)) {
      sessionStorage.removeItem(SELECTION_SUBMISSION_KEY);
    }
  } catch {
    sessionStorage.removeItem(SELECTION_SUBMISSION_KEY);
  }
}

function savedTargets(): string[] {
  try {
    const value = JSON.parse(sessionStorage.getItem('probe_selected_endpoints') || '[]');
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function TestCreatePage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const deepLinkSelectionId = params.get('selectionId') || '';
  const paramsKey = params.toString();
  const [scope, setScope] = useState<Scope>(
    params.get('scope') === 'group'
      ? 'group'
      : params.get('scope') === 'all'
        ? 'all'
        : deepLinkSelectionId
          ? 'selection'
          : params.has('group')
            ? 'group'
            : params.get('selected') === '1'
              ? 'selected'
              : '',
  );
  const [group, setGroup] = useState(params.get('group') || '');
  const [manual, setManual] = useState(params.get('target') || '');
  const [selected] = useState(savedTargets);
  const mode = MODES.includes(params.get('mode') as Exclude<ProbeMode, 'discover'>)
    ? (params.get('mode') as Exclude<ProbeMode, 'discover'>)
    : 'full';
  const [nodes, setNodes] = useState<TestNode[]>([]);
  const [nodesError, setNodesError] = useState('');
  const [policy, setPolicy] = useState<TestNodeExecutionPolicy | null>(null);
  const [policyError, setPolicyError] = useState('');
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [targetCount, setTargetCount] = useState<number | null>(null);
  const [serverSelection, setServerSelection] = useState<ServerSelection | null>(null);
  const [targetError, setTargetError] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const optionsRequest = useRef(0);
  const request = useRef(0);
  const selectionCreation = useRef<{ key: string; promise: Promise<ServerSelection> } | null>(null);
  const parsedManual = useMemo(
    () => [...new Set(manual.split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean))],
    [manual],
  );

  const loadOptions = async () => {
    const generation = ++optionsRequest.current;
    setOptionsLoading(true);
    const [nodeResult, policyResult, groupResult] = await Promise.allSettled([
      probeApi.testNodes(),
      probeApi.executionPolicy(),
      probeApi.groups(),
    ]);
    if (generation !== optionsRequest.current) return;
    if (nodeResult.status === 'fulfilled') {
      setNodes(nodeResult.value.items);
      setNodesError('');
    } else {
      setNodesError(nodeResult.reason instanceof Error ? nodeResult.reason.message : '节点列表加载失败');
    }
    if (groupResult.status === 'fulfilled') setGroups(groupResult.value);
    if (policyResult.status === 'fulfilled') {
      setPolicy(policyResult.value);
      setPolicyError('');
    } else {
      setPolicy(null);
      setPolicyError(policyResult.reason instanceof Error ? policyResult.reason.message : '执行节点策略加载失败');
    }
    setOptionsLoading(false);
    const failure = [nodeResult, policyResult, groupResult].find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      toast.error(failure.reason instanceof Error ? failure.reason.message : '测试选项加载失败');
    }
  };

  useEffect(() => {
    void loadOptions();
    return () => {
      optionsRequest.current++;
    };
  }, []);

  useLayoutEffect(() => {
    const requestedScope = params.get('scope');
    const nextScope: Scope =
      requestedScope === 'group' ||
      requestedScope === 'all' ||
      requestedScope === 'manual' ||
      requestedScope === 'selected' ||
      requestedScope === 'selection'
        ? requestedScope
        : deepLinkSelectionId
          ? 'selection'
          : params.has('group')
            ? 'group'
            : params.get('selected') === '1'
              ? 'selected'
              : '';
    setScope((current) => (current === nextScope ? current : nextScope));
    setGroup((current) => (current === (params.get('group') || '') ? current : (params.get('group') || '')));
  }, [paramsKey, deepLinkSelectionId, params]);

  const changeScope = (nextScope: Scope) => {
    selectionCreation.current = null;
    setScope(nextScope);
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('selectionId');
      if (nextScope) next.set('scope', nextScope);
      else next.delete('scope');
      if (nextScope !== 'group') next.delete('group');
      return next;
    });
  };

  const changeGroup = (nextGroup: string) => {
    selectionCreation.current = null;
    setGroup(nextGroup);
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('selectionId');
      if (nextGroup) next.set('group', nextGroup);
      else next.delete('group');
      return next;
    });
  };

  const changeMode = (nextMode: Exclude<ProbeMode, 'discover'>) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set('mode', nextMode);
      return next;
    });
  };

  useEffect(() => {
    const id = ++request.current;
    let cancelled = false;
    const current = () => !cancelled && id === request.current;
    setTargetError('');
    if (scope === 'selected') {
      setServerSelection(null);
      setTargets(selected);
      setTargetCount(selected.length);
      setLoading(false);
      return;
    }
    if (scope === 'manual') {
      setServerSelection(null);
      setTargets(parsedManual);
      setTargetCount(parsedManual.length);
      setLoading(false);
      return;
    }
    if (scope === '' || (scope === 'group' && !group)) {
      setServerSelection(null);
      setTargets([]);
      setTargetCount(null);
      setLoading(false);
      return;
    }
    setServerSelection(null);
    setTargets([]);
    setTargetCount(null);
    setLoading(true);
    const resolveSelection = async () => {
      try {
        let next: ServerSelection;
        if (scope === 'selection' || deepLinkSelectionId) {
          if (!deepLinkSelectionId) throw new Error('缺少服务器选择快照 ID');
          next = await probeApi.serverSelection(deepLinkSelectionId);
        } else {
          const creationKey = `${scope}:${scope === 'group' ? group : ''}`;
          const existing = selectionCreation.current;
          const promise =
            existing?.key === creationKey
              ? existing.promise
              : probeApi.createServerSelection({ allMatching: true, ...(scope === 'group' ? { group } : {}) });
          if (existing?.key !== creationKey) selectionCreation.current = { key: creationKey, promise };
          try {
            next = await promise;
          } catch (err) {
            if (selectionCreation.current?.key === creationKey) selectionCreation.current = null;
            throw err;
          }
          if (current()) {
            setParams(
              (currentParams) => {
                const updated = new URLSearchParams(currentParams);
                updated.set('selectionId', next.selectionId);
                updated.set('scope', scope);
                return updated;
              },
              { replace: true },
            );
          }
        }
        while (current()) {
          setServerSelection(next);
          setTargetCount(next.count);
          if (!['queued', 'building'].includes(next.state)) break;
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
          if (!current()) return;
          next = await probeApi.serverSelection(next.selectionId);
        }
      } catch (err) {
        if (current()) setTargetError(err instanceof Error ? err.message : '目标快照加载失败');
      } finally {
        if (current()) setLoading(false);
      }
    };
    void resolveSelection();
    return () => {
      cancelled = true;
      request.current++;
    };
  }, [scope, group, selected, parsedManual, deepLinkSelectionId, setParams]);

  const selectionScope = scope === 'selection' || scope === 'group' || scope === 'all';
  const tooManySelected = scope === 'selected' && selected.length > 5000;
  const tooManyManualTargets = scope === 'manual' && parsedManual.length > 5000;
  const submittedTargetCount = selectionScope ? serverSelection?.count ?? null : targetCount;
  const targetsReady = selectionScope
    ? serverSelection?.state === 'ready' && (serverSelection.count ?? 0) > 0
    : targets.length > 0 && !tooManySelected && !tooManyManualTargets;

  useEffect(() => {
    if (selectionScope && serverSelection) rotateMismatchedSelectionIdempotencyKey(serverSelection.selectionId, mode);
  }, [selectionScope, serverSelection, mode]);

  const primaryNode = policy?.primaryNodeId ? nodes.find((node) => node.id === policy.primaryNodeId) : undefined;
  const backupNodes = (policy?.backupNodeIds || [])
    .map((id) => nodes.find((node) => node.id === id))
    .filter((node): node is TestNode => !!node);
  const policyReady = Boolean(!optionsLoading && !nodesError && !policyError && policy?.configured && primaryNode);

  const invalidManualPort =
    scope === 'manual' &&
    parsedManual.some((endpoint) => {
      const match = /^(?:\[[^\]]+\]|[^:]+):(\d+)$/.exec(endpoint);
      return Boolean(match && Number(match[1]) !== 7000);
    });

  const canSubmit = !submitting && !loading && policyReady && targetsReady && !invalidManualPort;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const selectionKey =
        selectionScope && serverSelection ? selectionIdempotencyKey(serverSelection.selectionId, mode) : null;
      const payload =
        selectionKey && serverSelection
          ? {
              mode,
              targetScope: 'selection' as const,
              selectionId: serverSelection.selectionId,
              idempotencyKey: selectionKey,
            }
          : { mode, ips: targets, targetScope: 'explicit' as const };
      const job = await probeApi.createJob(payload);
      if (selectionKey && serverSelection) {
        clearSelectionIdempotencyKey(serverSelection.selectionId, mode, selectionKey);
      }
      toast.success('测试批次已提交');
      navigate(`/tests/${job.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '测试提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageShell maxWidth="6xl">
      <PageHeader
        back={
          <Link className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" to="/tests">
            <ArrowLeft className="size-3.5" /> 返回测试任务
          </Link>
        }
        title="新建测试"
        description="一屏选定探测目标与测试方式，右侧实时核对主备节点策略与快照范围后立即提交"
      />

      <div className="grid gap-5 lg:grid-cols-12 lg:items-start">
        {/* 左侧配置区 */}
        <div className="space-y-5 lg:col-span-7">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">1. 选择探测目标</CardTitle>
              <CardDescription>支持按业务分组、服务器库冻结快照、此前勾选记录或手动输入端点</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="test-target-scope" className="text-xs">目标范围</Label>
                <select
                  id="test-target-scope"
                  className={NATIVE_SELECT_CLASS}
                  value={scope}
                  onChange={(e) => changeScope(e.target.value as Scope)}
                >
                  <option value="">请选择目标</option>
                  <option value="selected" disabled={!selected.length}>此前勾选的目标（{selected.length}）</option>
                  {scope === 'selection' && <option value="selection">服务器库冻结快照</option>}
                  <option value="group">指定分组</option>
                  <option value="manual">手动输入端点</option>
                  <option value="all">全部服务器</option>
                </select>
              </div>

              {scope === 'group' && (
                <div>
                  <Label htmlFor="test-target-group" className="text-xs">分组</Label>
                  <select
                    id="test-target-group"
                    className={NATIVE_SELECT_CLASS}
                    value={group}
                    onChange={(e) => changeGroup(e.target.value)}
                  >
                    <option value="">请选择分组</option>
                    {groups.map((item) => (
                      <option key={item.name} value={item.name}>{item.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {scope === 'manual' && (
                <div className="space-y-1.5">
                  <Label htmlFor="test-manual-endpoints" className="text-xs">
                    端点（每行一个 IP、域名或 host:7000；端口固定为 7000）
                  </Label>
                  <Textarea
                    id="test-manual-endpoints"
                    className="min-h-32 font-mono text-xs"
                    value={manual}
                    onChange={(e) => setManual(e.target.value)}
                    placeholder={'192.0.2.1\nexample.com:7000'}
                  />
                </div>
              )}

              {scope === 'manual' && invalidManualPort && (
                <p role="alert" className="rounded-md bg-destructive/10 p-2.5 text-xs text-destructive">
                  目标端口固定为 7000，请移除其他端口或改为 :7000。
                </p>
              )}

              {targetError && (
                <p role="alert" className="rounded-md bg-destructive/10 p-2.5 text-xs text-destructive">
                  目标快照加载失败：{targetError}
                </p>
              )}

              {loading && (
                <p role="status" className="text-xs text-muted-foreground">
                  正在生成或读取服务器目标快照…
                </p>
              )}

              {selectionScope && serverSelection && (
                <div className="rounded-lg border bg-muted/20 p-3 text-xs" aria-label="冻结目标快照">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-foreground">
                      冻结快照目标：{serverSelection.count} 台 · 状态：{serverSelection.state}
                    </span>
                    <Badge tone={serverSelection.state === 'ready' ? 'success' : 'warning'}>
                      {serverSelection.state === 'ready' ? '已就绪' : '生成中'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    有效期至 {new Date(serverSelection.expiresAt).toLocaleString()}
                  </p>
                  {serverSelection.error && <p role="alert" className="mt-1 text-destructive">{serverSelection.error}</p>}
                  {serverSelection.state !== 'ready' && (
                    <p className="mt-1 text-muted-foreground">快照就绪前不能提交测试。</p>
                  )}
                </div>
              )}

              {!selectionScope && (
                <p className="text-xs text-muted-foreground">
                  {loading
                    ? '正在核对目标…'
                    : targetCount === null
                      ? '请选择目标范围'
                      : `将测试 ${targets.length} 个不同端点${targetCount !== targets.length ? `（资产记录 ${targetCount} 条）` : ''}`}
                </p>
              )}

              {tooManySelected && (
                <div className="space-y-1.5 rounded-md bg-destructive/10 p-3 text-xs text-destructive">
                  <p role="alert">显式勾选最多支持 5000 台。请回到服务器库冻结匹配结果后再创建测试。</p>
                  <Link className="underline" to="/servers">返回服务器库冻结匹配结果</Link>
                </div>
              )}

              {tooManyManualTargets && (
                <div className="space-y-1.5 rounded-md bg-destructive/10 p-3 text-xs text-destructive">
                  <p role="alert">
                    手动目标共 {parsedManual.length} 个，超过 5000 个上限。请到服务器库筛选目标并冻结匹配结果后再创建测试。
                  </p>
                  <Link className="underline" to="/servers">前往服务器库冻结匹配结果</Link>
                </div>
              )}

              {!selectionScope && !!targets.length && !tooManyManualTargets && !tooManySelected && (
                <p className="break-all font-mono text-xs text-muted-foreground">
                  示例：{targets.slice(0, 3).join('、')}{targets.length > 3 ? '…' : ''}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">2. 选择测试方式</CardTitle>
              <CardDescription>正式探测资产目标服务端口固定为 7000</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3.5">
              <div className="grid gap-2.5 sm:grid-cols-2">
                {MODES.map((value) => {
                  const Icon = MODE_META[value].icon;
                  const active = mode === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => changeMode(value)}
                      className={cn(
                        'flex flex-col items-start gap-1.5 rounded-xl border p-3.5 text-left transition-all',
                        active
                          ? 'border-primary bg-primary/8 shadow-2xs ring-1 ring-primary/30'
                          : 'border-border bg-card hover:bg-muted/40',
                      )}
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
                          <Icon className={cn('size-4', active ? 'text-primary' : 'text-muted-foreground')} />
                          {MODE_NAMES[value]}
                        </span>
                        {active && <CheckCircle2 className="size-4 text-primary" />}
                      </div>
                      <span className="text-xs text-muted-foreground">{MODE_META[value].desc}</span>
                    </button>
                  );
                })}
              </div>

              <div>
                <Label htmlFor="test-mode-select" className="text-xs text-muted-foreground">测试方式</Label>
                <select
                  id="test-mode-select"
                  className={NATIVE_SELECT_CLASS}
                  value={mode}
                  onChange={(e) => changeMode(e.target.value as typeof mode)}
                >
                  {MODES.map((value) => (
                    <option key={value} value={value}>{MODE_NAMES[value]}</option>
                  ))}
                </select>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 右侧粘性核对与提交栏 */}
        <div className="lg:sticky lg:top-20 lg:col-span-5">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="size-4 text-primary" />
                执行节点策略与提交核对
              </CardTitle>
              <CardDescription>任务按全局主节点 → 外部备用顺序自动执行，主控兜底</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {optionsLoading ? (
                <p role="status" className="text-xs text-muted-foreground">正在加载节点与执行策略…</p>
              ) : nodesError ? (
                <div role="alert" className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                  <p>节点列表加载失败：{nodesError}</p>
                  <Button variant="outline" size="sm" onClick={() => void loadOptions()}>重试加载</Button>
                </div>
              ) : policyError ? (
                <div role="alert" className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                  <p>执行节点策略加载失败：{policyError}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link className="underline" to="/test-nodes">打开测试节点设置修复</Link>
                    <Button variant="outline" size="sm" onClick={() => void loadOptions()}>重试加载策略</Button>
                  </div>
                </div>
              ) : policyReady && primaryNode ? (
                <div className="space-y-2 rounded-lg border bg-muted/20 p-3 text-xs">
                  <p className="font-medium text-foreground">
                    主节点：{primaryNode.name}{' '}
                    <span className={primaryNode.online ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                      （{primaryNode.online ? '在线' : '离线'}）
                    </span>
                  </p>
                  <p className="text-muted-foreground">
                    备用节点顺序：
                    {backupNodes.length
                      ? backupNodes.map((node, index) => (
                          <span key={node.id}>
                            {index > 0 ? ' → ' : ''}
                            {node.name}（{node.online ? '在线' : '离线'}）
                          </span>
                        ))
                      : '未配置'}
                  </p>
                </div>
              ) : (
                <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
                  <p>尚未配置有效的主节点。</p>
                  <Link className="underline" to="/test-nodes">前往测试节点设置</Link>
                </div>
              )}

              <div className="space-y-2 rounded-lg border p-3.5 text-xs">
                <div className="flex items-center gap-1.5 font-medium text-foreground">
                  <Server className="size-3.5 text-muted-foreground" />
                  本次批次摘要
                </div>
                {scope ? (
                  <p className="text-foreground/90">
                    目标：{selectionScope ? `${submittedTargetCount ?? 0} 台冻结快照` : `${targets.length} 个端点`} ·{' '}
                    {scope === 'group'
                      ? `分组 ${group || '未选'}`
                      : scope === 'all'
                        ? '全部服务器'
                        : scope === 'selection'
                          ? '服务器库快照'
                          : scope === 'selected'
                            ? '此前勾选目标'
                            : '手动输入'}
                  </p>
                ) : (
                  <p className="text-muted-foreground">请先在左侧选择目标范围</p>
                )}
                <p className="text-foreground/90">测试：{MODE_NAMES[mode]}</p>
                <p className="text-foreground/90">首选执行：{primaryNode?.name || '未配置'}</p>
                <p className="text-muted-foreground">
                  目标服务端口固定为 7000。提交后自动跳转批次实时进度页。
                </p>
              </div>

              <Button
                className="w-full"
                disabled={!canSubmit}
                onClick={() => void submit()}
              >
                {submitting ? '提交中…' : '提交测试'}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </PageShell>
  );
}
