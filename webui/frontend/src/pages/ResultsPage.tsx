import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { probeApi } from '../lib/api';
import type { ProbeResultBase } from '../lib/types';
import { formatLastSeen } from '../lib/format';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

type Kind='route'|'connectivity'|'speed';
type Row=ProbeResultBase & Record<string,unknown>;
const KIND_NAMES:Record<Kind,string>={route:'路由',connectivity:'穿透连通性',speed:'上下行速率'};
function result(row:Row,kind:Kind):string {
  if(kind==='route')return row.ok===true ? (row.isCn2 ? 'CN2' : '非 CN2') : '路由失败';
  if(kind==='connectivity')return `frps ${row.frps_reachable ? '可达':'失败'} · 隧道 ${row.tunnel_established ? '已建立':'失败'} · 端口 ${row.firewall_open ? '开放':'失败'}`;
  const rate=(prefix:string)=>row[`${prefix}_ok`] ? `${(Number(row[`${prefix}_speed_bps`] || 0)*8/1048576).toFixed(2)} Mbps` : '失败';
  return `下载 ${rate('dl')} · 上传 ${rate('ul')}`;
}

export function ResultsPage() {
  const [params,setParams]=useSearchParams();
  const kind=(['route','connectivity','speed'].includes(params.get('kind') || '') ? params.get('kind') : 'connectivity') as Kind;
  const ip=params.get('ip') || '';
  const port=params.get('port') || '';
  const jobId=params.get('jobId') || '';
  const from=params.get('from') || '';
  const to=params.get('to') || '';
  const page=Math.max(1,Number(params.get('page') || 1) || 1);
  const [rows,setRows]=useState<Row[]>([]);
  const [total,setTotal]=useState<number|null>(null);
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(true);
  const request=useRef(0);
  const change=(key:string,value:string)=>setParams((current)=>{const next=new URLSearchParams(current);if(value)next.set(key,value);else next.delete(key);next.delete('page');return next;});
  useEffect(()=>{
    const id=++request.current;
    const query:Record<string,string|number>={page,pageSize:50};
    if(ip)query.ip=ip;
    if(port && Number(port)>0)query.port=Number(port);
    if(jobId)query.jobId=jobId;
    const start=from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? new Date(`${from}T00:00:00`) : null;
    const end=to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(`${to}T23:59:59.999`) : null;
    if(start && Number.isFinite(start.getTime()))query.fromTime=start.toISOString().replace('Z','+00:00');
    if(end && Number.isFinite(end.getTime()))query.toTime=end.toISOString().replace('Z','+00:00');
    setLoading(true);
    void probeApi.historyPage(kind,query).then((data)=>{
      if(id===request.current){setRows(data.items as Row[]);setTotal(data.total);setError('');}
    }).catch((err)=>{if(id===request.current)setError(err instanceof Error ? err.message : '结果加载失败');})
      .finally(()=>{if(id===request.current)setLoading(false);});
    return()=>{request.current++;};
  },[kind,ip,port,jobId,from,to,page]);
  return <main className="mx-auto max-w-[1400px] space-y-4 px-4 py-6 sm:px-6">
    <div><h2 className="text-xl font-semibold">测试结果</h2><p className="text-sm text-muted-foreground">按端点和批次查看完整历史；来源信息保留在每条记录中。0 是已测得的数值，— 表示缺少观测。</p></div>
    <Card><CardHeader><CardTitle>筛选结果</CardTitle></CardHeader><CardContent className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
      <label>测试项目<select className="mt-1 w-full rounded-md border bg-background p-2" value={kind} onChange={(event)=>change('kind',event.target.value)}>{(Object.keys(KIND_NAMES) as Kind[]).map((item)=><option key={item} value={item}>{KIND_NAMES[item]}</option>)}</select></label>
      <label>目标主机<input className="mt-1 w-full rounded-md border bg-background p-2" value={ip} onChange={(event)=>change('ip',event.target.value)} placeholder="IP 或域名" /></label>
      <label>端口<input className="mt-1 w-full rounded-md border bg-background p-2" type="number" min={1} max={65535} value={port} onChange={(event)=>change('port',event.target.value)} placeholder="全部端口" /></label>
      <label>批次 ID<input className="mt-1 w-full rounded-md border bg-background p-2" value={jobId} onChange={(event)=>change('jobId',event.target.value)} placeholder="全部批次" /></label>
      <label>开始日期<input className="mt-1 w-full rounded-md border bg-background p-2" type="date" value={from} onChange={(event)=>change('from',event.target.value)} /></label>
      <label>结束日期<input className="mt-1 w-full rounded-md border bg-background p-2" type="date" value={to} onChange={(event)=>change('to',event.target.value)} /></label>
    </CardContent></Card>
    {error && <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{error}；显示的可能是上一次成功加载的数据。</p>}
    <Card><CardHeader><CardTitle>{KIND_NAMES[kind]} · {total===null ? '加载中' : `共 ${total} 条`}</CardTitle></CardHeader><CardContent className="space-y-3">
      {loading && <p role="status" className="text-sm text-muted-foreground">正在加载…</p>}
      {rows.map((row)=><div key={row.id} className="rounded-lg border p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2"><strong className="font-mono">{row.server_ip}:{row.port}</strong><Badge tone="muted">{result(row,kind)}</Badge><span className="text-muted-foreground">来源 {row.node_id}</span><span className="text-muted-foreground" title={row.test_time}>{formatLastSeen(row.test_time)}</span></div>
        {kind==='route' && Array.isArray(row.hops) && <details className="mt-2 text-muted-foreground"><summary className="cursor-pointer">路由跳点（{row.hops.length}）</summary><ol className="mt-2 space-y-1 font-mono">{row.hops.map((hop,index)=><li key={index}>{index+1}. {String((hop as {host?:string}).host || '*')}</li>)}</ol></details>}
        {row.detail && <p className="mt-2 text-muted-foreground">{row.detail}</p>}
      </div>)}
      {!loading && !rows.length && !error && <p className="py-8 text-center text-sm text-muted-foreground">暂无匹配结果</p>}
      <div className="flex items-center justify-end gap-2 text-sm"><span>第 {page} 页</span><Button size="sm" variant="outline" disabled={page<=1} onClick={()=>setParams((current)=>{const next=new URLSearchParams(current);next.set('page',String(page-1));return next;})}>上一页</Button><Button size="sm" variant="outline" disabled={total===null || page*50>=total} onClick={()=>setParams((current)=>{const next=new URLSearchParams(current);next.set('page',String(page+1));return next;})}>下一页</Button></div>
    </CardContent></Card>
  </main>;
}
