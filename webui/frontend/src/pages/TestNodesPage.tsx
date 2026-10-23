import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { probeApi } from '../lib/api';
import type { TestNode, TestNodeExecutionPolicy } from '../lib/types';
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

  useEffect(() => {
    void load();
    void loadPolicy(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [load, loadPolicy]);

  const eligibleNodes = useMemo(() => nodes.filter(isEligibleRoleNode), [nodes]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const markDirty = () => {
    dirty.current = true;
    setNotice('');
  };

  const choosePrimary = (nodeId: string) => {
    markDirty();
    setPrimaryNodeId(nodeId);
    setBackupNodeIds((current) => current.filter((id) => id !== nodeId));
  };

  const toggleBackup = (nodeId: string, checked: boolean) => {
    markDirty();
    setBackupNodeIds((current) => checked
      ? current.includes(nodeId) ? current : [...current, nodeId]
      : current.filter((id) => id !== nodeId));
  };

  const moveBackup = (index: number, offset: -1 | 1) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= backupNodeIds.length) return;
    markDirty();
    setBackupNodeIds((current) => {
      const next = [...current];
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
      const saved = await probeApi.saveExecutionPolicy(primaryNodeId, backupNodeIds);
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

  return <main className="mx-auto max-w-[1300px] px-4 py-6 sm:px-6">
    <div className="mb-5 flex items-center gap-3">
      <div><h2 className="text-lg font-semibold">测试节点</h2><p className="text-sm text-muted-foreground">执行网段发现、路由、穿透与速率测量</p></div>
      <Button ref={manageButton} className="ml-auto" onClick={() => setOpen(true)}>接入或管理节点</Button>
    </div>
    {error && <p role="alert" className="mb-4 text-sm text-destructive">{error} <Button variant="link" onClick={load}>重试</Button></p>}

    <Card className="mb-6">
      <CardHeader>
        <CardTitle>测试节点主备策略</CardTitle>
        <p className="text-sm text-muted-foreground">选择一个主用测试节点，并按顺序设置备用测试节点。保存后仅影响后续策略读取。</p>
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
              <FieldLegend>备用测试节点</FieldLegend>
              <FieldDescription>勾选后加入顺序列表；主用测试节点不能同时作为备用。</FieldDescription>
              <FieldGroup className="grid gap-2 sm:grid-cols-2">
                {eligibleNodes.filter((node) => node.id !== primaryNodeId).map((node) => {
                  const checkboxId = `backup-node-${node.id}`;
                  return <Field key={node.id} orientation="horizontal" className="items-center rounded-md border p-3">
                    <input
                      id={checkboxId}
                      type="checkbox"
                      disabled={saving}
                      checked={backupNodeIds.includes(node.id)}
                      onChange={(event) => toggleBackup(node.id, event.target.checked)}
                      className="size-4 accent-primary"
                    />
                    <FieldLabel htmlFor={checkboxId} className="min-w-0 flex-1 truncate">{node.name}</FieldLabel>
                    <Badge tone={node.online ? 'success' : 'muted'}>{node.online ? '在线' : '离线'}</Badge>
                  </Field>;
                })}
                {eligibleNodes.length === (primaryNodeId ? 1 : 0) && <FieldDescription>没有其他可选的备用测试节点。</FieldDescription>}
              </FieldGroup>
            </FieldSet>
          </FieldGroup>

          {backupNodeIds.length > 0 && <FieldSet className="gap-2">
            <FieldLegend>备用顺序</FieldLegend>
            <ol className="flex flex-col gap-2">
              {backupNodeIds.map((nodeId, index) => {
                const node = nodeById.get(nodeId);
                return <li key={nodeId} className="flex items-center gap-3 rounded-md border p-3 text-sm">
                  <span className="w-6 text-center font-semibold">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{node?.name ?? nodeId}</span>
                  <Badge tone={node?.online ? 'success' : 'muted'}>{node ? node.online ? '在线' : '离线' : '节点不可用'}</Badge>
                  <Button variant="outline" size="sm" disabled={saving || index === 0} aria-label={`上移备用节点 ${node?.name ?? nodeId}`} onClick={() => moveBackup(index, -1)}>上移</Button>
                  <Button variant="outline" size="sm" disabled={saving || index === backupNodeIds.length - 1} aria-label={`下移备用节点 ${node?.name ?? nodeId}`} onClick={() => moveBackup(index, 1)}>下移</Button>
                </li>;
              })}
            </ol>
          </FieldSet>}

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
