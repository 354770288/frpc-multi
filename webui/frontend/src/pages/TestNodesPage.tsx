import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { probeApi } from '../lib/api';
import type { ProbeFailover, TestNode, TestNodeExecutionPolicy } from '../lib/types';
import { formatLastSeen } from '../lib/format';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../components/ui/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Separator } from '../components/ui/separator';
import { TestNodesDialog } from './probe/TestNodesDialog';

const REQUIRED_CAPABILITIES = ['discover', 'route', 'connectivity', 'speed'];

function isEligibleRoleNode(node: TestNode) {
  return node.kind === 'worker' && REQUIRED_CAPABILITIES.every((capability) => node.capabilities.includes(capability));
}

export function TestNodesPage() {
  const [nodes, setNodes] = useState<TestNode[]>([]);
  const [failovers, setFailovers] = useState<ProbeFailover[]>([]);
  const [failoverPage, setFailoverPage] = useState(1);
  const [failoverTotal, setFailoverTotal] = useState(0);
  const [failoverError, setFailoverError] = useState('');
  const [failoverLoading, setFailoverLoading] = useState(true);
  const [error, setError] = useState('');
  const [policyError, setPolicyError] = useState('');
  const [open, setOpen] = useState(false);
  const [primaryNodeId, setPrimaryNodeId] = useState('');
  const [backupNodeIds, setBackupNodeIds] = useState<string[]>([]);
  const [suggestedPrimaryNodeId, setSuggestedPrimaryNodeId] = useState<string | null>(null);
  const [policyConfigured, setPolicyConfigured] = useState<boolean | null>(null);
  const [policyLoaded, setPolicyLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const manageButton = useRef<HTMLButtonElement>(null);
  const dirty = useRef(false);
  const savingRef = useRef(false);
  const policyRequestRevision = useRef(0);
  const failoverRequestRevision = useRef(0);
  const close = () => { setOpen(false); requestAnimationFrame(() => manageButton.current?.focus()); };

  const load = useCallback(async () => {
    try { setNodes((await probeApi.testNodes()).items); setError(''); }
    catch (err) { setError(err instanceof Error ? err.message : '测试节点加载失败'); }
  }, []);

  const applyPolicy = useCallback((policy: TestNodeExecutionPolicy, preserveDraft = false) => {
    setPolicyError('');
    setPolicyLoaded(true);
    setPolicyConfigured(policy.configured);
    if (preserveDraft && dirty.current) return;
    const suggested = !policy.configured ? policy.suggestedPrimaryNodeId : null;
    setSuggestedPrimaryNodeId(suggested);
    setPrimaryNodeId(policy.primaryNodeId ?? suggested ?? '');
    setBackupNodeIds(policy.backupNodeIds ?? []);
    dirty.current = false;
  }, []);

  const loadPolicy = useCallback(async (preserveDraft = false) => {
    const revision = ++policyRequestRevision.current;
    try {
      const policy = await probeApi.executionPolicy();
      if (revision !== policyRequestRevision.current) return false;
      applyPolicy(policy, preserveDraft);
      return true;
    } catch (err) {
      if (revision !== policyRequestRevision.current) return false;
      setPolicyLoaded(true);
      setPolicyError(err instanceof Error ? err.message : '主备测试策略加载失败');
      return false;
    }
  }, [applyPolicy]);

  const loadFailovers = useCallback(async () => {
    const revision = ++failoverRequestRevision.current;
    setFailoverLoading(true);
    try {
      const result = await probeApi.failoversPage({ page: failoverPage, pageSize: 20 });
      if (revision !== failoverRequestRevision.current) return;
      setFailovers(result.items);
      setFailoverTotal(result.total);
      setFailoverError('');
    } catch (err) {
      if (revision !== failoverRequestRevision.current) return;
      setFailoverError(err instanceof Error ? err.message : '任务转移历史加载失败');
    } finally {
      if (revision === failoverRequestRevision.current) setFailoverLoading(false);
    }
  }, [failoverPage]);

  useEffect(() => {
    void load();
    void loadPolicy(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [load, loadPolicy]);

  useEffect(() => {
    void loadFailovers();
    return () => { failoverRequestRevision.current += 1; };
  }, [loadFailovers]);

  const eligibleNodes = useMemo(() => nodes.filter(isEligibleRoleNode), [nodes]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const orderedBackupIds = useMemo(() => {
    const eligibleIds = eligibleNodes.filter((node) => node.id !== primaryNodeId).map((node) => node.id);
    const savedOrder = backupNodeIds.filter((id) => id !== primaryNodeId && eligibleIds.includes(id));
    return [...savedOrder, ...eligibleIds.filter((id) => !savedOrder.includes(id))];
  }, [eligibleNodes, primaryNodeId, backupNodeIds]);
  const markDirty = () => {
    dirty.current = true;
    setNotice('');
  };

  const choosePrimary = (nodeId: string) => {
    markDirty();
    setPrimaryNodeId(nodeId);
    setBackupNodeIds((current) => current.filter((id) => id !== nodeId));
  };

  const moveBackup = (index: number, offset: -1 | 1) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= orderedBackupIds.length) return;
    markDirty();
    setBackupNodeIds(() => {
      const next = [...orderedBackupIds];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  const savePolicy = async () => {
    if (!primaryNodeId || savingRef.current) return;
    savingRef.current = true;
    policyRequestRevision.current += 1;
    setSaving(true);
    setNotice('');
    try {
      const saved = await probeApi.saveExecutionPolicy(primaryNodeId, orderedBackupIds);
      applyPolicy(saved);
      setNotice('主备测试策略已保存。');
      if (!(await loadPolicy())) {
        setNotice('主备测试策略已保存；状态刷新失败，请重试读取。');
      }
    } catch (err) {
      setPolicyError(err instanceof Error ? err.message : '主备测试策略保存失败');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const roleFor = (nodeId: string) => {
    if (nodeId === primaryNodeId) return '主用';
    const backupIndex = backupNodeIds.indexOf(nodeId);
    return backupIndex >= 0 ? `备用 ${backupIndex + 1}` : '';
  };
  const supportsTaskGeneration = (node: TestNode) => node.protocolFeatures?.includes('task-generation-v1') === true;
  const failoverReason = (reason: string) => ({
    lease_expired_owner_offline: '主用节点离线且任务租约到期',
    owner_protocol_feature_lost: '主用节点未声明所需协议能力',
    pending_owner_offline: '主用节点离线时转移待处理任务',
  }[reason] ?? reason);

  return <main className="mx-auto max-w-[1300px] px-4 py-6 sm:px-6">
    <div className="mb-5 flex items-center gap-3">
      <div><h2 className="text-lg font-semibold">测试节点</h2><p className="text-sm text-muted-foreground">执行网段发现、路由、穿透与速率测量</p></div>
      <Button ref={manageButton} className="ml-auto" onClick={() => setOpen(true)}>接入或管理节点</Button>
    </div>
    {error && <p role="alert" className="mb-4 text-sm text-destructive">{error} <Button variant="link" onClick={load}>重试</Button></p>}

    <Card className="mb-6">
      <CardHeader>
        <CardTitle>测试节点主备策略</CardTitle>
        <p className="text-sm text-muted-foreground">选择一个主用测试节点。其他具备完整能力的外部节点自动加入备用顺序，可调整先后；主控作为最后备用。</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {policyError && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          主备测试策略读取或保存失败：{policyError}。可选择有效测试节点并保存新的策略。
        </p>}
        {!policyLoaded && <p className="text-sm text-muted-foreground">正在读取主备测试策略…</p>}
        {eligibleNodes.length === 0 ? <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>暂无可选测试节点</EmptyTitle>
            <EmptyDescription>需接入具备发现、路由、连通性和速率能力的外部 worker。</EmptyDescription>
          </EmptyHeader>
        </Empty> : <>
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="primary-test-node">主用测试节点</FieldLabel>
              <Select value={primaryNodeId} onValueChange={choosePrimary} disabled={saving}>
                <SelectTrigger id="primary-test-node" aria-label="主用测试节点" className="w-full max-w-xl">
                  <SelectValue placeholder="请选择主用测试节点" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {eligibleNodes.map((node) => <SelectItem key={node.id} value={node.id}>
                      {node.name}{node.online ? ' · 在线' : ' · 离线'}
                    </SelectItem>)}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {!primaryNodeId && !policyError && <FieldDescription>请选择一个主用测试节点后再保存。</FieldDescription>}
              {suggestedPrimaryNodeId && nodeById.has(suggestedPrimaryNodeId) && <FieldDescription>建议主用：{nodeById.get(suggestedPrimaryNodeId)?.name}。这是未保存的建议，可自行调整后保存。</FieldDescription>}
            </Field>

            <FieldSet className="gap-2">
              <FieldLegend>备用顺序</FieldLegend>
              <FieldDescription>所有其他具备完整能力的外部节点都会加入备用顺序。</FieldDescription>
              <ol className="flex flex-col gap-2">
                {orderedBackupIds.map((nodeId, index) => {
                  const node = nodeById.get(nodeId);
                  return <li key={nodeId} className="flex items-center gap-3 rounded-md border p-3 text-sm">
                    <span className="w-6 text-center font-semibold">{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{node?.name ?? nodeId}</span>
                    <Badge tone={node?.online ? 'success' : 'muted'}>{node ? node.online ? '在线' : '离线' : '节点不可用'}</Badge>
                    {node && !supportsTaskGeneration(node) && <Badge tone="warning">需升级 · 等待协议能力</Badge>}
                    <Button variant="outline" size="sm" disabled={saving || index === 0} aria-label={`上移备用节点 ${node?.name ?? nodeId}`} onClick={() => moveBackup(index, -1)}>上移</Button>
                    <Button variant="outline" size="sm" disabled={saving || index === orderedBackupIds.length - 1} aria-label={`下移备用节点 ${node?.name ?? nodeId}`} onClick={() => moveBackup(index, 1)}>下移</Button>
                  </li>;
                })}
                <li className="flex items-center gap-3 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  <span className="w-6 text-center font-semibold">{orderedBackupIds.length + 1}</span>
                  <span className="min-w-0 flex-1">主控 Console（最终备用）</span>
                  <Badge tone="muted">固定</Badge>
                </li>
              </ol>
            </FieldSet>
          </FieldGroup>

          <Separator />
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={savePolicy} disabled={!primaryNodeId || saving}>{saving ? '保存中…' : '保存主备策略'}</Button>
            {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
            {!policyError && !notice && policyLoaded && policyConfigured && !dirty.current && primaryNodeId && <p className="text-sm text-muted-foreground">当前主用与备用测试节点已保存。</p>}
            {!policyError && !notice && policyLoaded && !policyConfigured && primaryNodeId && <p role="status" className="text-sm text-muted-foreground">当前选择尚未保存，请点击“保存主备策略”。</p>}
          </div>
        </>}
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>任务转移历史</CardTitle>
          <Badge tone="muted">共 {failoverTotal} 条</Badge>
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => void loadFailovers()} disabled={failoverLoading}>刷新</Button>
        </div>
        <p className="text-sm text-muted-foreground">这里只记录已转移到备用节点的任务。未声明 task-generation-v1 的备用节点会显示为等待升级；这不表示旧版主用节点上的所有任务都已阻塞。</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {failoverError && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">任务转移历史加载失败：{failoverError} <Button variant="link" onClick={() => void loadFailovers()}>重试</Button></p>}
        {failoverLoading && <p role="status" className="text-sm text-muted-foreground">正在加载任务转移历史…</p>}
        {failovers.map((item) => <div key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border p-3 text-sm">
          <span className="font-mono text-xs text-muted-foreground">{item.taskId}</span>
          <span>{nodeById.get(item.fromNodeId)?.name ?? item.fromNodeId} → {nodeById.get(item.toNodeId)?.name ?? item.toNodeId}</span>
          <Badge tone="muted">第 {item.generation} 代</Badge>
          <span className="text-muted-foreground">{failoverReason(item.reason)}</span>
          <span className="ml-auto text-muted-foreground" title={item.transferredAt}>{formatLastSeen(item.transferredAt)}</span>
        </div>)}
        {!failoverLoading && !failoverError && failovers.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">暂无任务转移记录</p>}
        <div className="flex items-center justify-end gap-2 text-sm">
          <span>第 {failoverPage} 页 / 共 {Math.max(1, Math.ceil(failoverTotal / 20))} 页</span>
          <Button variant="outline" size="sm" disabled={failoverPage <= 1 || failoverLoading} onClick={() => setFailoverPage((page) => Math.max(1, page - 1))}>上一页</Button>
          <Button variant="outline" size="sm" disabled={failoverLoading || failoverPage * 20 >= failoverTotal} onClick={() => setFailoverPage((page) => page + 1)}>下一页</Button>
        </div>
      </CardContent>
    </Card>

    <div className="grid gap-4 md:grid-cols-2">
      {nodes.map((node) => {
        const role = roleFor(node.id);
        return <Card key={node.id}>
          <CardHeader><CardTitle className="flex flex-wrap items-center gap-2">{node.name}<Badge tone={node.online ? 'success' : 'muted'}>{node.online ? '在线' : '离线'}</Badge>{role && <Badge tone="success">{role}{dirty.current || policyConfigured !== true ? ' · 未保存' : ''}</Badge>}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <p>{node.id === 'console' ? '主控测试节点' : node.kind === 'legacy' ? '旧版路由节点' : '外部测试节点'} · 版本 {node.version || '未知'}</p>
            <p className="text-muted-foreground">最近在线：{node.lastSeen ? formatLastSeen(node.lastSeen) : '尚未连接'}</p>
            <div className="flex flex-wrap gap-2">{node.capabilities.map((cap) => <Badge key={cap} tone="muted">{cap}</Badge>)}</div>
          </CardContent>
        </Card>;
      })}
    </div>
    {open && <TestNodesDialog nodes={nodes} onClose={close} onChanged={load} />}
  </main>;
}
