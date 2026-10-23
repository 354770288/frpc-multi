import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { probeApi } from '../lib/api';
import type { GroupInfo, ProbeMode, ServerSelection, TestNode, TestNodeExecutionPolicy } from '../lib/types';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { MODE_NAMES } from './probe/NodeControls';

type Scope = '' | 'selected' | 'group' | 'manual' | 'all' | 'selection';
const MODES: Exclude<ProbeMode, 'discover'>[] = ['full','route','connectivity','speed'];
const SELECTION_SUBMISSION_KEY = 'probe_selection_test_submission';
type PendingSelectionSubmission = { selectionId: string; mode: Exclude<ProbeMode, 'discover'>; idempotencyKey: string };
function selectionIdempotencyKey(selectionId: string, mode: Exclude<ProbeMode, 'discover'>) {
  try {
    const current = JSON.parse(sessionStorage.getItem(SELECTION_SUBMISSION_KEY) || 'null') as PendingSelectionSubmission | null;
    if (current?.selectionId === selectionId && current.mode === mode && current.idempotencyKey) return current.idempotencyKey;
  } catch { /* replace stale session data below */ }
  const pending = { selectionId, mode, idempotencyKey: crypto.randomUUID() } satisfies PendingSelectionSubmission;
  sessionStorage.setItem(SELECTION_SUBMISSION_KEY, JSON.stringify(pending));
  return pending.idempotencyKey;
}
function clearSelectionIdempotencyKey(selectionId: string, mode: Exclude<ProbeMode, 'discover'>, idempotencyKey: string) {
  try {
    const current = JSON.parse(sessionStorage.getItem(SELECTION_SUBMISSION_KEY) || 'null') as PendingSelectionSubmission | null;
    if (current?.selectionId === selectionId && current.mode === mode && current.idempotencyKey === idempotencyKey) sessionStorage.removeItem(SELECTION_SUBMISSION_KEY);
  } catch { sessionStorage.removeItem(SELECTION_SUBMISSION_KEY); }
}
function rotateMismatchedSelectionIdempotencyKey(selectionId: string, mode: Exclude<ProbeMode, 'discover'>) {
  try {
    const current = JSON.parse(sessionStorage.getItem(SELECTION_SUBMISSION_KEY) || 'null') as PendingSelectionSubmission | null;
    if (current && (current.selectionId !== selectionId || current.mode !== mode)) sessionStorage.removeItem(SELECTION_SUBMISSION_KEY);
  } catch { sessionStorage.removeItem(SELECTION_SUBMISSION_KEY); }
}
function savedTargets(): string[] {
  try { const value=JSON.parse(sessionStorage.getItem('probe_selected_endpoints') || '[]'); return Array.isArray(value) ? value.filter((x):x is string=>typeof x==='string') : []; }
  catch { return []; }
}

export function TestCreatePage() {
  const [params,setParams] = useSearchParams();
  const navigate = useNavigate();
  const [step,setStep] = useState(1);
  const deepLinkSelectionId = params.get('selectionId') || '';
  const paramsKey = params.toString();
  const [scope,setScope] = useState<Scope>(params.get('scope') === 'group' ? 'group' : params.get('scope') === 'all' ? 'all' : deepLinkSelectionId ? 'selection' : params.has('group') ? 'group' : params.get('selected') === '1' ? 'selected' : '');
  const [group,setGroup] = useState(params.get('group') || '');
  const [manual,setManual] = useState(params.get('target') || '');
  const [selected] = useState(savedTargets);
  const [mode,setMode] = useState<Exclude<ProbeMode,'discover'>>(() => MODES.includes(params.get('mode') as Exclude<ProbeMode,'discover'>) ? params.get('mode') as Exclude<ProbeMode,'discover'> : 'full');
  const [nodes,setNodes] = useState<TestNode[]>([]);
  const [nodesError,setNodesError] = useState('');
  const [policy,setPolicy] = useState<TestNodeExecutionPolicy | null>(null);
  const [policyError,setPolicyError] = useState('');
  const [optionsLoading,setOptionsLoading] = useState(true);
  const [groups,setGroups] = useState<GroupInfo[]>([]);
  const [targets,setTargets] = useState<string[]>([]);
  const [targetCount,setTargetCount] = useState<number | null>(null);
  const [serverSelection,setServerSelection] = useState<ServerSelection | null>(null);
  const [targetError,setTargetError] = useState('');
  const [loading,setLoading] = useState(false);
  const [submitting,setSubmitting] = useState(false);
  const optionsRequest = useRef(0);
  const request = useRef(0);
  const selectionCreation = useRef<{ key: string; promise: Promise<ServerSelection> } | null>(null);
  const parsedManual = useMemo(() => [...new Set(manual.split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean))], [manual]);

  const loadOptions = async () => {
    const generation=++optionsRequest.current;
    setOptionsLoading(true);
    const [nodeResult,policyResult,groupResult]=await Promise.allSettled([probeApi.testNodes(),probeApi.executionPolicy(),probeApi.groups()]);
    if(generation!==optionsRequest.current)return;
    if(nodeResult.status==='fulfilled'){setNodes(nodeResult.value.items);setNodesError('');}
    else {setNodesError(nodeResult.reason instanceof Error ? nodeResult.reason.message : '节点列表加载失败');}
    if(groupResult.status==='fulfilled')setGroups(groupResult.value);
    if(policyResult.status==='fulfilled'){setPolicy(policyResult.value);setPolicyError('');}
    else {setPolicy(null);setPolicyError(policyResult.reason instanceof Error ? policyResult.reason.message : '执行节点策略加载失败');}
    setOptionsLoading(false);
    const failure=[nodeResult,policyResult,groupResult].find((result)=>result.status==='rejected');
    if(failure?.status==='rejected')toast.error(failure.reason instanceof Error ? failure.reason.message : '测试选项加载失败');
  };
  useEffect(() => { void loadOptions(); return () => { optionsRequest.current++; }; }, []);
  useLayoutEffect(() => {
    const requestedScope=params.get('scope');
    const nextScope:Scope=requestedScope==='group' || requestedScope==='all' || requestedScope==='manual' || requestedScope==='selected' || requestedScope==='selection'
      ? requestedScope
      : deepLinkSelectionId ? 'selection' : params.has('group') ? 'group' : params.get('selected')==='1' ? 'selected' : '';
    const requestedMode=params.get('mode') as Exclude<ProbeMode,'discover'> | null;
    setScope((current)=>current===nextScope ? current : nextScope);
    setGroup((current)=>current===(params.get('group') || '') ? current : (params.get('group') || ''));
    setMode((current)=>current===(requestedMode && MODES.includes(requestedMode) ? requestedMode : 'full') ? current : (requestedMode && MODES.includes(requestedMode) ? requestedMode : 'full'));
  }, [paramsKey]);
  const changeScope = (nextScope: Scope) => {
    selectionCreation.current=null;
    setScope(nextScope);
    setParams((current) => {
      const next=new URLSearchParams(current);
      next.delete('selectionId');
      if(nextScope)next.set('scope',nextScope);else next.delete('scope');
      if(nextScope!=='group')next.delete('group');
      return next;
    });
  };
  const changeGroup = (nextGroup: string) => {
    selectionCreation.current=null;
    setGroup(nextGroup);
    setParams((current) => {const next=new URLSearchParams(current);next.delete('selectionId');if(nextGroup)next.set('group',nextGroup);else next.delete('group');return next;});
  };
  const changeMode = (nextMode: Exclude<ProbeMode,'discover'>) => {
    setMode(nextMode);
    setParams((current) => {const next=new URLSearchParams(current);next.set('mode',nextMode);return next;});
  };
  useEffect(() => {
    const id=++request.current;
    let cancelled=false;
    const current=()=>!cancelled && id===request.current;
    setTargetError('');
    if (scope === 'selected') { setServerSelection(null);setTargets(selected);setTargetCount(selected.length);setLoading(false);return; }
    if (scope === 'manual') { setServerSelection(null);setTargets(parsedManual);setTargetCount(parsedManual.length);setLoading(false);return; }
    if (scope === '' || (scope === 'group' && !group)) { setServerSelection(null);setTargets([]);setTargetCount(null);setLoading(false);return; }
    setServerSelection(null);setTargets([]);setTargetCount(null);setLoading(true);
    const resolveSelection=async () => {
      try {
        let next: ServerSelection;
        if (scope === 'selection' || deepLinkSelectionId) {
          if (!deepLinkSelectionId) throw new Error('缺少服务器选择快照 ID');
          next=await probeApi.serverSelection(deepLinkSelectionId);
        } else {
          const creationKey=`${scope}:${scope==='group' ? group : ''}`;
          const existing=selectionCreation.current;
          const promise=existing?.key===creationKey
            ? existing.promise
            : probeApi.createServerSelection({allMatching:true,...(scope==='group' ? {group} : {})});
          if (existing?.key!==creationKey) selectionCreation.current={key:creationKey,promise};
          try { next=await promise; }
          catch (err) { if (selectionCreation.current?.key===creationKey) selectionCreation.current=null; throw err; }
          if (current()) {
            setParams((currentParams) => {
              const updated=new URLSearchParams(currentParams);
              updated.set('selectionId',next.selectionId);
              updated.set('scope',scope);
              return updated;
            },{replace:true});
          }
        }
        while (current()) {
          setServerSelection(next);setTargetCount(next.count);
          if (!['queued','building'].includes(next.state)) break;
          await new Promise((resolve)=>window.setTimeout(resolve,1000));
          if (!current()) return;
          next=await probeApi.serverSelection(next.selectionId);
        }
      } catch (err) {
        if (current()) setTargetError(err instanceof Error ? err.message : '目标快照加载失败');
      } finally {
        if (current()) setLoading(false);
      }
    };
    void resolveSelection();
    return () => { cancelled=true;request.current++; };
  }, [scope,group,selected,parsedManual,deepLinkSelectionId,setParams]);

  const selectionScope = scope === 'selection' || scope === 'group' || scope === 'all';
  const tooManySelected = scope === 'selected' && selected.length > 5000;
  const tooManyManualTargets = scope === 'manual' && parsedManual.length > 5000;
  const submittedTargetCount = selectionScope ? serverSelection?.count ?? null : targetCount;
  const targetsReady = selectionScope
    ? serverSelection?.state === 'ready' && (serverSelection.count ?? 0) > 0
    : targets.length > 0 && !tooManySelected && !tooManyManualTargets;
  useEffect(() => {
    if (selectionScope && serverSelection) rotateMismatchedSelectionIdempotencyKey(serverSelection.selectionId,mode);
  }, [selectionScope,serverSelection?.selectionId,mode]);

  const primaryNode=policy?.primaryNodeId ? nodes.find((node)=>node.id===policy.primaryNodeId) : undefined;
  const backupNodes=(policy?.backupNodeIds || []).map((id)=>nodes.find((node)=>node.id===id)).filter((node):node is TestNode=>!!node);
  const policyReady=Boolean(!optionsLoading && !nodesError && !policyError && policy?.configured && primaryNode);
  const next=() => {
    if (step===1 && (!scope || loading || !targetsReady || invalidManualPort)) {
      toast.error(invalidManualPort ? '目标端口固定为 7000' : tooManySelected ? '此前勾选超过 5000 台，请返回服务器库冻结匹配范围' : tooManyManualTargets ? '手动目标超过 5000 个，请使用冻结服务器快照' : '请先选择已就绪且非空的目标范围');return;
    }
    if (step===2 && !policyReady) { toast.error(nodesError || policyError || '请先在测试节点设置中配置主节点');return; }
    setStep(step+1);
  };
  const submit=async () => {
    if (submitting || !policyReady || !targetsReady || loading || invalidManualPort) return;
    setSubmitting(true);
    try {
      const selectionKey = selectionScope && serverSelection ? selectionIdempotencyKey(serverSelection.selectionId,mode) : null;
      const payload = selectionKey && serverSelection
        ? {mode,targetScope:'selection' as const,selectionId:serverSelection.selectionId,idempotencyKey:selectionKey}
        : {mode,ips:targets,targetScope:'explicit' as const};
      const job=await probeApi.createJob(payload);
      if (selectionKey && serverSelection) clearSelectionIdempotencyKey(serverSelection.selectionId,mode,selectionKey);
      toast.success('测试批次已提交');
      navigate(`/tests/${job.id}`);
    } catch(err) { toast.error(err instanceof Error ? err.message : '测试提交失败'); }
    finally { setSubmitting(false); }
  };
  const invalidManualPort=scope==='manual' && parsedManual.some((endpoint)=>{
    const match=/^(?:\[[^\]]+\]|[^:]+):(\d+)$/.exec(endpoint);
    return Boolean(match && Number(match[1])!==7000);
  });
  return <main className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6">
    <div><Link className="text-sm text-muted-foreground hover:underline" to="/tests">← 返回测试任务</Link><h2 className="mt-3 text-xl font-semibold">新建测试</h2><p className="text-sm text-muted-foreground">选择目标 → 测试方式与执行节点 → 核对并提交</p></div>
    <p className="text-sm" aria-live="polite">第 {step} 步 / 3 步</p>
    {step===1 && <Card><CardHeader><CardTitle>选择目标</CardTitle></CardHeader><CardContent className="space-y-4">
      <div><label className="block text-sm" htmlFor="test-target-scope">目标范围</label><select id="test-target-scope" className="mt-2 w-full rounded-md border bg-background p-2" value={scope} onChange={(e)=>changeScope(e.target.value as Scope)}><option value="">请选择目标</option><option value="selected" disabled={!selected.length}>此前勾选的目标（{selected.length}）</option>{scope==='selection' && <option value="selection">服务器库冻结快照</option>}<option value="group">指定分组</option><option value="manual">手动输入端点</option><option value="all">全部服务器</option></select></div>
      {scope==='group' && <div><label className="block text-sm" htmlFor="test-target-group">分组</label><select id="test-target-group" className="mt-2 w-full rounded-md border bg-background p-2" value={group} onChange={(e)=>changeGroup(e.target.value)}><option value="">请选择分组</option>{groups.map((item)=><option key={item.name} value={item.name}>{item.name}</option>)}</select></div>}
      {scope==='manual' && <label className="block text-sm">端点（每行一个 IP、域名或 host:7000；端口固定为 7000）<Textarea className="mt-2 min-h-32" value={manual} onChange={(e)=>setManual(e.target.value)} placeholder={'192.0.2.1\nexample.com:7000'} /></label>}
      {scope==='manual' && invalidManualPort && <p role="alert" className="text-sm text-destructive">目标端口固定为 7000，请移除其他端口或改为 :7000。</p>}
      {targetError && <p role="alert" className="text-sm text-destructive">目标快照加载失败：{targetError}</p>}
      {loading && <p role="status" className="text-sm text-muted-foreground">正在生成或读取服务器目标快照…</p>}
      {selectionScope && serverSelection && <div className="rounded-md border p-3 text-sm" aria-label="冻结目标快照">
        <p>冻结快照目标：{serverSelection.count} 台 · 状态：{serverSelection.state}</p>
        <p className="text-muted-foreground">有效期至 {new Date(serverSelection.expiresAt).toLocaleString()}</p>
        {serverSelection.error && <p role="alert" className="text-destructive">{serverSelection.error}</p>}
        {serverSelection.state !== 'ready' && <p className="text-muted-foreground">快照就绪前不能继续提交测试。</p>}
      </div>}
      {!selectionScope && <p className="text-sm text-muted-foreground">{loading ? '正在核对目标…' : targetCount===null ? '请选择目标范围' : `将测试 ${targets.length} 个不同端点${targetCount!==targets.length ? `（资产记录 ${targetCount} 条）` : ''}`}</p>}
      {tooManySelected && <p role="alert" className="text-sm text-destructive">显式勾选最多支持 5000 台。请回到服务器库冻结匹配结果后再创建测试。</p>}
      {tooManySelected && <Link className="text-sm underline" to="/servers">返回服务器库冻结匹配结果</Link>}
      {tooManyManualTargets && <p role="alert" className="text-sm text-destructive">手动目标共 {parsedManual.length} 个，超过 5000 个上限。请到服务器库筛选目标并冻结匹配结果后再创建测试。</p>}
      {tooManyManualTargets && <Link className="text-sm underline" to="/servers">前往服务器库冻结匹配结果</Link>}
      {!selectionScope && !!targets.length && <p className="break-all text-sm text-muted-foreground">示例：{targets.slice(0,3).join('、')}{targets.length>3 ? '…' : ''}</p>}
    </CardContent></Card>}
    {step===2 && <Card><CardHeader><CardTitle>测试方式与执行节点策略</CardTitle></CardHeader><CardContent className="space-y-4">
      <label className="block text-sm">测试方式<select className="mt-2 w-full rounded-md border bg-background p-2" value={mode} onChange={(e)=>changeMode(e.target.value as typeof mode)}>{MODES.map((value)=><option key={value} value={value}>{MODE_NAMES[value]}</option>)}</select></label>
      {optionsLoading ? <p role="status" className="text-sm text-muted-foreground">正在加载节点与执行策略…</p> : nodesError ? <div role="alert" className="space-y-2 text-sm"><p>节点列表加载失败：{nodesError}</p><Button variant="outline" size="sm" onClick={()=>void loadOptions()}>重试加载</Button></div> : policyError ? <div role="alert" className="space-y-2 text-sm"><p>执行节点策略加载失败：{policyError}</p><Link className="underline" to="/test-nodes">打开测试节点设置修复</Link><Button variant="outline" size="sm" onClick={()=>void loadOptions()}>重试加载策略</Button></div> : policyReady && primaryNode ? <div className="space-y-2 text-sm">
        <p>主节点：{primaryNode.name} <span className={primaryNode.online ? 'text-primary' : 'text-destructive'}>（{primaryNode.online ? '在线' : '离线'}）</span></p>
        <p>备用节点顺序：{backupNodes.length ? backupNodes.map((node,index)=><span key={node.id}>{index>0?' → ':''}{node.name}（{node.online?'在线':'离线'}）</span>) : '未配置'}</p>
        <p className="text-muted-foreground">当前任务由主节点执行；备份顺序由测试节点设置管理。</p>
      </div> : <div className="space-y-2 text-sm"><p>尚未配置有效的主节点。</p><Link className="underline" to="/test-nodes">前往测试节点设置</Link></div>}
    </CardContent></Card>}
    {step===3 && <Card><CardHeader><CardTitle>核对本次提交</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
      <p>目标：{selectionScope ? `${submittedTargetCount ?? 0} 台冻结快照` : `${targets.length} 个端点`} · {scope==='group' ? `分组 ${group}` : scope==='all' ? '全部服务器' : scope==='selection' ? '服务器库快照' : scope==='selected' ? '此前勾选目标' : '手动输入'}</p>
      <p>测试：{MODE_NAMES[mode]}</p><p>执行主节点：{primaryNode?.name || '未配置'}</p>
      <p>目标服务端口固定为 7000。完成后可在批次详情和按节点筛选的历史记录中查看结果。</p>
    </CardContent></Card>}
    <div className="flex justify-between gap-2"><Button variant="outline" disabled={step===1||submitting} onClick={()=>setStep(step-1)}>上一步</Button>{step<3 ? <Button disabled={loading || (step===1 && (!targetsReady || invalidManualPort)) || (step===2 && !policyReady)} onClick={next}>下一步</Button> : <Button disabled={submitting || !policyReady || !targetsReady || invalidManualPort} onClick={submit}>{submitting ? '提交中…' : '提交测试'}</Button>}</div>
  </main>;
}
