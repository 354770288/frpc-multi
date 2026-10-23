import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { probeApi } from '../lib/api';
import type { GroupInfo, ProbeMode, TestNode } from '../lib/types';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { NodePicker, MODE_NAMES, supports } from './probe/NodeControls';

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
  const [selectedNodes,setSelectedNodes] = useState<string[]>(params.get('nodeId') ? [params.get('nodeId')!] : []);
  const [groups,setGroups] = useState<GroupInfo[]>([]);
  const [targets,setTargets] = useState<string[]>([]);
  const [targetCount,setTargetCount] = useState<number | null>(null);
  const [loading,setLoading] = useState(false);
  const [submitting,setSubmitting] = useState(false);
  const request = useRef(0);
  const parsedManual = useMemo(() => [...new Set(manual.split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean))], [manual]);

  useEffect(() => {
    let mounted=true;
    Promise.all([probeApi.testNodes(),probeApi.groups()]).then(([nodeList, groupList]) => {
      if (mounted) { setNodes(nodeList.items);setGroups(groupList); }
    }).catch((err) => { if (mounted) toast.error(err instanceof Error ? err.message : '测试选项加载失败'); });
    return () => { mounted=false; };
  }, []);
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

  const validNodes=selectedNodes.length>0 && selectedNodes.every((id)=>nodes.some((node)=>node.id===id && supports(node,mode)));
  const next=() => {
    if (step===1 && (!scope || loading || !targets.length)) { toast.error('请先选择非空目标范围');return; }
    if (step===2 && !validNodes) { toast.error('请选择具备当前能力的执行节点');return; }
    setStep(step+1);
  };
  const submit=async () => {
    if (submitting || !validNodes || !targets.length || loading) return;
    setSubmitting(true);
    try {
      const job=await probeApi.createJob({mode,nodeIds:selectedNodes,ips:targets,targetScope:'explicit'});
      toast.success('测试批次已提交');
      navigate(`/tests/${job.id}`);
    } catch(err) { toast.error(err instanceof Error ? err.message : '测试提交失败'); }
    finally { setSubmitting(false); }
  };
  return <main className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6">
    <div><Link className="text-sm text-muted-foreground hover:underline" to="/tests">← 返回测试任务</Link><h2 className="mt-3 text-xl font-semibold">新建测试</h2><p className="text-sm text-muted-foreground">选择目标 → 测试方式与执行节点 → 核对并提交</p></div>
    <p className="text-sm" aria-live="polite">第 {step} 步 / 3 步</p>
    {step===1 && <Card><CardHeader><CardTitle>选择目标</CardTitle></CardHeader><CardContent className="space-y-4">
      <div><label className="block text-sm" htmlFor="test-target-scope">目标范围</label><select id="test-target-scope" className="mt-2 w-full rounded-md border bg-background p-2" value={scope} onChange={(e)=>setScope(e.target.value as Scope)}><option value="">请选择目标</option><option value="selected" disabled={!selected.length}>此前勾选的目标（{selected.length}）</option><option value="group">指定分组</option><option value="manual">手动输入端点</option><option value="all">全部服务器（需主动选择）</option></select></div>
      {scope==='group' && <div><label className="block text-sm" htmlFor="test-target-group">分组</label><select id="test-target-group" className="mt-2 w-full rounded-md border bg-background p-2" value={group} onChange={(e)=>setGroup(e.target.value)}><option value="">请选择分组</option>{groups.map((item)=><option key={item.name} value={item.name}>{item.name}</option>)}</select></div>}
      {scope==='manual' && <label className="block text-sm">端点（每行一个 IP、域名或 host:port）<Textarea className="mt-2 min-h-32" value={manual} onChange={(e)=>setManual(e.target.value)} placeholder="192.0.2.1:7000" /></label>}
      <p className="text-sm text-muted-foreground">{loading ? '正在核对目标…' : targetCount===null ? '请选择目标范围' : `将测试 ${targets.length} 个不同端点${targetCount!==targets.length ? `（资产记录 ${targetCount} 条）` : ''}`}</p>
      {!!targets.length && <p className="break-all text-sm text-muted-foreground">示例：{targets.slice(0,3).join('、')}{targets.length>3 ? '…' : ''}</p>}
    </CardContent></Card>}
    {step===2 && <Card><CardHeader><CardTitle>测试方式与执行节点</CardTitle></CardHeader><CardContent className="space-y-4">
      <label className="block text-sm">测试方式<select className="mt-2 w-full rounded-md border bg-background p-2" value={mode} onChange={(e)=>setMode(e.target.value as typeof mode)}>{MODES.map((value)=><option key={value} value={value}>{MODE_NAMES[value]}</option>)}</select></label>
      <NodePicker nodes={nodes} selected={selectedNodes} onChange={setSelectedNodes} mode={mode} />
      <p className="text-sm text-muted-foreground">每个执行节点分别测试全部 {targets.length} 个端点；离线节点的任务会排队等待该节点上线。</p>
    </CardContent></Card>}
    {step===3 && <Card><CardHeader><CardTitle>核对本次提交</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
      <p>目标：{targets.length} 个端点 · {scope==='group' ? `分组 ${group}` : scope==='all' ? '全部服务器' : scope==='selected' ? '勾选目标' : '手动输入'}</p>
      <p>测试：{MODE_NAMES[mode]}</p><p>执行节点：{selectedNodes.map((id)=>nodes.find((node)=>node.id===id)?.name || id).join('、')}</p>
      <p>各节点分别执行全部目标。完成后可在批次详情和来源对比中查看结果。</p>
    </CardContent></Card>}
    <div className="flex justify-between gap-2"><Button variant="outline" disabled={step===1||submitting} onClick={()=>setStep(step-1)}>上一步</Button>{step<3 ? <Button disabled={loading} onClick={next}>下一步</Button> : <Button disabled={submitting || !validNodes || !targets.length} onClick={submit}>{submitting ? '提交中…' : '提交测试'}</Button>}</div>
  </main>;
}
