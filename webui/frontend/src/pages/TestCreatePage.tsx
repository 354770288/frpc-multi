import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { probeApi } from '../lib/api';
import type { GroupInfo, ProbeMode, TestNode, TestNodeExecutionPolicy } from '../lib/types';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { MODE_NAMES } from './probe/NodeControls';

type Scope = '' | 'selected' | 'group' | 'manual' | 'all';
const MODES: Exclude<ProbeMode, 'discover'>[] = ['full','route','connectivity','speed'];
function savedTargets(): string[] {
  try { const value=JSON.parse(sessionStorage.getItem('probe_selected_endpoints') || '[]'); return Array.isArray(value) ? value.filter((x):x is string=>typeof x==='string') : []; }
  catch { return []; }
}

export function TestCreatePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [step,setStep] = useState(1);
  const [scope,setScope] = useState<Scope>(params.has('group') ? 'group' : params.get('selected') === '1' ? 'selected' : '');
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
  const [loading,setLoading] = useState(false);
  const [submitting,setSubmitting] = useState(false);
  const optionsRequest = useRef(0);
  const request = useRef(0);
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
  useEffect(() => {
    const id=++request.current;
    if (scope === 'selected') { setTargets(selected);setTargetCount(selected.length);return; }
    if (scope === 'manual') { setTargets(parsedManual);setTargetCount(parsedManual.length);return; }
    if (scope === '' || (scope === 'group' && !group)) { setTargets([]);setTargetCount(null);return; }
    setLoading(true);setTargets([]);setTargetCount(null);
    const collect=async () => {
      const ips:string[]=[];
      let page=1;
      while (true) {
        const result=await probeApi.servers({page,pageSize:200,conn:'all',sort:'ip',order:'asc',...(scope==='group' ? {group} : {})});
        if (id!==request.current)return;
        ips.push(...result.items.map((item)=>item.ip));
        if (page*result.pageSize>=result.total) { setTargets([...new Set(ips)]);setTargetCount(result.total);return; }
        page++;
      }
    };
    void collect().catch((err)=>{ if (id===request.current) toast.error(err instanceof Error ? err.message : '目标加载失败'); })
      .finally(()=>{ if (id===request.current)setLoading(false); });
    return () => { request.current++; };
  }, [scope,group,selected,parsedManual]);

  const primaryNode=policy?.primaryNodeId ? nodes.find((node)=>node.id===policy.primaryNodeId) : undefined;
  const backupNodes=(policy?.backupNodeIds || []).map((id)=>nodes.find((node)=>node.id===id)).filter((node):node is TestNode=>!!node);
  const policyReady=Boolean(!optionsLoading && !nodesError && !policyError && policy?.configured && primaryNode);
  const next=() => {
    if (step===1 && (!scope || loading || !targets.length || invalidManualPort)) { toast.error(invalidManualPort ? '目标端口固定为 7000' : '请先选择非空目标范围');return; }
    if (step===2 && !policyReady) { toast.error(nodesError || policyError || '请先在测试节点设置中配置主节点');return; }
    setStep(step+1);
  };
  const submit=async () => {
    if (submitting || !policyReady || !targets.length || loading || invalidManualPort) return;
    setSubmitting(true);
    try {
      const job=await probeApi.createJob({mode,ips:targets,targetScope:'explicit'});
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
      <div><label className="block text-sm" htmlFor="test-target-scope">目标范围</label><select id="test-target-scope" className="mt-2 w-full rounded-md border bg-background p-2" value={scope} onChange={(e)=>setScope(e.target.value as Scope)}><option value="">请选择目标</option><option value="selected" disabled={!selected.length}>此前勾选的目标（{selected.length}）</option><option value="group">指定分组</option><option value="manual">手动输入端点</option><option value="all">全部服务器（需主动选择）</option></select></div>
      {scope==='group' && <div><label className="block text-sm" htmlFor="test-target-group">分组</label><select id="test-target-group" className="mt-2 w-full rounded-md border bg-background p-2" value={group} onChange={(e)=>setGroup(e.target.value)}><option value="">请选择分组</option>{groups.map((item)=><option key={item.name} value={item.name}>{item.name}</option>)}</select></div>}
      {scope==='manual' && <label className="block text-sm">端点（每行一个 IP、域名或 host:7000；端口固定为 7000）<Textarea className="mt-2 min-h-32" value={manual} onChange={(e)=>setManual(e.target.value)} placeholder={'192.0.2.1\nexample.com:7000'} /></label>}
      {scope==='manual' && invalidManualPort && <p role="alert" className="text-sm text-destructive">目标端口固定为 7000，请移除其他端口或改为 :7000。</p>}
      <p className="text-sm text-muted-foreground">{loading ? '正在核对目标…' : targetCount===null ? '请选择目标范围' : `将测试 ${targets.length} 个不同端点${targetCount!==targets.length ? `（资产记录 ${targetCount} 条）` : ''}`}</p>
      {!!targets.length && <p className="break-all text-sm text-muted-foreground">示例：{targets.slice(0,3).join('、')}{targets.length>3 ? '…' : ''}</p>}
    </CardContent></Card>}
    {step===2 && <Card><CardHeader><CardTitle>测试方式与执行节点策略</CardTitle></CardHeader><CardContent className="space-y-4">
      <label className="block text-sm">测试方式<select className="mt-2 w-full rounded-md border bg-background p-2" value={mode} onChange={(e)=>setMode(e.target.value as typeof mode)}>{MODES.map((value)=><option key={value} value={value}>{MODE_NAMES[value]}</option>)}</select></label>
      {optionsLoading ? <p role="status" className="text-sm text-muted-foreground">正在加载节点与执行策略…</p> : nodesError ? <div role="alert" className="space-y-2 text-sm"><p>节点列表加载失败：{nodesError}</p><Button variant="outline" size="sm" onClick={()=>void loadOptions()}>重试加载</Button></div> : policyError ? <div role="alert" className="space-y-2 text-sm"><p>执行节点策略加载失败：{policyError}</p><Link className="underline" to="/test-nodes">打开测试节点设置修复</Link><Button variant="outline" size="sm" onClick={()=>void loadOptions()}>重试加载策略</Button></div> : policyReady && primaryNode ? <div className="space-y-2 text-sm">
        <p>主节点：{primaryNode.name} <span className={primaryNode.online ? 'text-primary' : 'text-destructive'}>（{primaryNode.online ? '在线' : '离线'}）</span></p>
        <p>备用节点顺序：{backupNodes.length ? backupNodes.map((node,index)=><span key={node.id}>{index>0?' → ':''}{node.name}（{node.online?'在线':'离线'}）</span>) : '未配置'}</p>
        <p className="text-muted-foreground">当前任务由主节点执行；备份顺序由测试节点设置管理。</p>
      </div> : <div className="space-y-2 text-sm"><p>尚未配置有效的主节点。</p><Link className="underline" to="/test-nodes">前往测试节点设置</Link></div>}
    </CardContent></Card>}
    {step===3 && <Card><CardHeader><CardTitle>核对本次提交</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
      <p>目标：{targets.length} 个端点 · {scope==='group' ? `分组 ${group}` : scope==='all' ? '全部服务器' : scope==='selected' ? '勾选目标' : '手动输入'}</p>
      <p>测试：{MODE_NAMES[mode]}</p><p>执行主节点：{primaryNode?.name || '未配置'}</p>
      <p>目标服务端口固定为 7000。完成后可在批次详情和来源对比中查看结果。</p>
    </CardContent></Card>}
    <div className="flex justify-between gap-2"><Button variant="outline" disabled={step===1||submitting} onClick={()=>setStep(step-1)}>上一步</Button>{step<3 ? <Button disabled={loading || (step===1 && invalidManualPort) || (step===2 && !policyReady)} onClick={next}>下一步</Button> : <Button disabled={submitting || !policyReady || !targets.length || invalidManualPort} onClick={submit}>{submitting ? '提交中…' : '提交测试'}</Button>}</div>
  </main>;
}
