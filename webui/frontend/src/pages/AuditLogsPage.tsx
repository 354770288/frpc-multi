import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Filter,
  RefreshCw, RotateCcw, XCircle,
} from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { auditLogsApi } from '../lib/api';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/EmptyState';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { useConsole } from '../context/ConsoleContext';
import { toast } from 'sonner';
import type { AuditLog } from '../lib/types';

const AL: Record<string, string> = {
  create_instance: '创建实例', patch_instance: '更新实例', update_config: '修改配置',
  delete_instance: '删除实例', start_instance: '启动', stop_instance: '停止',
  restart_instance: '重启', recreate_instance: '重建', upgrade_agent: '升级 Agent',
  create_node: '创建节点', rename_node: '节点改名', rotate_secret: '轮换密钥', delete_node: '删除节点',
};

export function AuditLogsPage() {
  const { nodes } = useConsole();
  const navigate = useNavigate();
  const [params,setParams] = useSearchParams();
  const page = Math.max(1,Number(params.get('page') || 1) || 1);
  const tf=params.get('time') || 'all', nf=params.get('node') || 'all', af=params.get('action') || 'all', rf=params.get('result') || 'all';
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total,setTotal] = useState<number | null>(null);
  const [error,setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [iq, setIq] = useState(params.get('q') || '');
  const [em, setEm] = useState<Record<number, boolean>>({});
  const generation=useRef(0);

  const nodeNameById = useMemo(() => new Map(nodes.map((n) => [n.id, n.name])), [nodes]);
  const actions = useMemo(() => [...new Set([...Object.keys(AL),...logs.map((l) => l.action)])].sort(), [logs]);
  const filtered=logs;
  const change=(key:string,value:string)=>setParams((current)=>{const next=new URLSearchParams(current);if(value && value!=='all')next.set(key,value);else next.delete(key);next.delete('page');return next;});
  useEffect(()=>{const timer=window.setTimeout(()=>{if(iq!==(params.get('q') || ''))change('q',iq.trim());},300);return()=>window.clearTimeout(timer);},[iq,params]);

  const failedCount = logs.filter((l) => !l.success).length;

  const load = useCallback(async () => {
    const id=++generation.current;
    setLoading(true);
    const query:Record<string,string|number|boolean>={page,pageSize:50};
    if(tf!=='all') {const start=new Date();if(tf==='today')start.setHours(0,0,0,0);else start.setDate(start.getDate()-(tf==='7d' ? 7 : 30));query.fromTime=start.toISOString().replace('Z','+00:00');}
    if(nf==='local')query.local=true;else if(nf.startsWith('node:'))query.nodeId=Number(nf.slice(5));
    if(af!=='all')query.action=af;
    if(rf!=='all')query.success=rf==='success';
    if(params.get('q'))query.q=params.get('q')!;
    try {const data=await auditLogsApi.page(query);if(id===generation.current){setLogs(data.items);setTotal(data.total);setError('');}}
    catch (e) {if(id===generation.current){const message=e instanceof Error ? e.message : '操作记录加载失败';setError(message);toast.error(message);}}
    finally {if(id===generation.current)setLoading(false);}
  }, [page,tf,nf,af,rf,params]);

  useEffect(() => {void load();return()=>{generation.current++;};}, [load]);

  return (
    <div className="mx-auto max-w-[1600px] px-6 py-6">
      <div className="mb-6 flex items-center gap-3">
        <h2 className="text-lg font-semibold">操作记录</h2>
        <Badge tone="muted">{total ?? '—'} 条匹配</Badge>
        {failedCount > 0 && <Badge tone="danger">本页 {failedCount} 条失败</Badge>}
        <Button className="ml-auto" size="sm" variant="outline" onClick={load} disabled={loading}><RefreshCw size={13} />刷新</Button>
      </div>

      <Card className="mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="inline-flex items-center gap-2 text-sm"><Filter size={14} />服务端筛选</CardTitle>
          <CardAction>
            <Button size="sm" variant="ghost" onClick={() => {setParams(new URLSearchParams());setIq('');}}>
              <RotateCcw size={13} />重置
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
            <div className="space-y-1.5"><Label className="text-[11px]">时间范围</Label>
              <S value={tf} onChange={(v)=>change('time',v)} label="时间范围" options={[{ value: 'all', label: '全部时间' }, { value: 'today', label: '今天' }, { value: '7d', label: '最近 7 天' }, { value: '30d', label: '最近 30 天' }]} /></div>
            <div className="space-y-1.5"><Label className="text-[11px]">节点</Label>
              <S value={nf} onChange={(v)=>change('node',v)} label="部署节点" options={[{ value: 'all', label: '全部节点' }, { value: 'local', label: '主控本机' }, ...nodes.map((n) => ({ value: `node:${n.id}`, label: n.name }))]} /></div>
            <div className="space-y-1.5"><Label className="text-[11px]">动作</Label>
              <S value={af} onChange={(v)=>change('action',v)} label="动作" options={[{ value: 'all', label: '全部动作' }, ...actions.map((a) => ({ value: a, label: AL[a] || a }))]} /></div>
            <div className="space-y-1.5"><Label className="text-[11px]">结果</Label>
              <S value={rf} onChange={(v)=>change('result',v)} label="结果" options={[{ value: 'all', label: '全部结果' }, { value: 'success', label: '成功' }, { value: 'failed', label: '失败' }]} /></div>
            <div className="space-y-1.5"><Label className="text-[11px]">实例</Label><Input value={iq} onChange={(e) => setIq(e.target.value)} placeholder="按实例名筛选" /></div>
          </div>
        </CardContent>
      </Card>

      {error && <p role="alert" className="mb-4 rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}；当前列表可能是上一次加载的数据。</p>}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">最近操作</CardTitle>
          <CardAction>
            <span className="text-sm text-muted-foreground">本页 {filtered.length} / 共 {total ?? '—'}</span>
          </CardAction>
        </CardHeader>
        <CardContent className="p-0">
          <div className="grid gap-3 p-3 2xl:hidden">
            {filtered.map((l) => (
              <div key={l.id} className={`min-w-0 rounded-lg border border-border bg-card p-3 ${l.success ? '' : 'bg-destructive/10'}`}>
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="truncate font-mono text-[11px] text-muted-foreground">{fmt(l.createdAt)}</span>
                  {l.success ? <Badge tone="success"><CheckCircle2 size={12} />成功</Badge> : <Badge tone="danger"><XCircle size={12} />失败</Badge>}
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <MobileFact label="操作人" value={l.username || '—'} />
                  <MobileFact label="动作" value={AL[l.action] || l.action} />
                  <MobileFact label="节点" value={nl(l.nodeId, nodeNameById)} />
                  <MobileFact label="实例" value={l.instanceName || '—'} mono />
                  <MobileFact label="消息" value={l.message || '—'} />
                </div>
                <div className="mt-3 flex flex-wrap justify-end gap-1 border-t border-border pt-3">
                  {isRem(l.nodeId) && <Button size="sm" variant="ghost" onClick={() => navigate(`/nodes?focus=${l.nodeId}`)}><ExternalLink size={13} />节点</Button>}
                  {l.instanceName && <Button size="sm" variant="ghost" onClick={() => navigate(`/instances/${l.nodeId ?? 0}/${l.instanceName}`)}><ExternalLink size={13} />实例</Button>}
                </div>
              </div>
            ))}
            {!filtered.length && (
              <EmptyState title={loading ? '加载中…' : logs.length ? '没有匹配' : '暂无审计记录'} />
            )}
          </div>
          <div className="hidden 2xl:block">
            <table className="w-full min-w-[1120px]">
              <thead><tr className="border-b bg-muted/50"><Th>时间</Th><Th>操作人</Th><Th>动作</Th><Th>节点</Th><Th>实例</Th><Th>结果</Th><Th>消息</Th><Th align="right">定位</Th></tr></thead>
              <tbody>
                {filtered.map((l) => (
                  <tr key={l.id} className={`border-b last:border-b-0 hover:bg-muted/50 ${l.success ? '' : 'bg-destructive/10'}`}>
                    <Td mono>{fmt(l.createdAt)}</Td><Td>{l.username || '—'}</Td><Td>{AL[l.action] || l.action}</Td><Td>{nl(l.nodeId, nodeNameById)}</Td><Td mono>{l.instanceName || '—'}</Td>
                    <Td>{l.success ? <Badge tone="success"><CheckCircle2 size={12} />成功</Badge> : <Badge tone="danger"><XCircle size={12} />失败</Badge>}</Td>
                    <Td><Msg l={l} ex={!!em[l.id]} onT={() => setEm((p) => ({ ...p, [l.id]: !p[l.id] }))} /></Td>
                    <Td align="right"><div className="flex justify-end gap-1">
                      {isRem(l.nodeId) && <Button size="sm" variant="ghost" onClick={() => navigate(`/nodes?focus=${l.nodeId}`)}><ExternalLink size={13} />节点</Button>}
                      {l.instanceName && <Button size="sm" variant="ghost" onClick={() => navigate(`/instances/${l.nodeId ?? 0}/${l.instanceName}`)}><ExternalLink size={13} />实例</Button>}
                    </div></Td>
                  </tr>
                ))}
                {!filtered.length && <tr><td colSpan={8} className="px-4 py-10 text-center text-xs text-muted-foreground">{loading ? '加载中…' : logs.length ? '没有匹配' : '暂无审计记录'}</td></tr>}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
      <div className="mt-4 flex items-center justify-end gap-2 text-sm"><span>第 {page} 页 / 共 {total ?? '—'} 条</span><Button variant="outline" size="sm" disabled={page<=1} onClick={()=>setParams((current)=>{const next=new URLSearchParams(current);next.set('page',String(page-1));return next;})}>上一页</Button><Button variant="outline" size="sm" disabled={total===null || page*50>=total} onClick={()=>setParams((current)=>{const next=new URLSearchParams(current);next.set('page',String(page+1));return next;})}>下一页</Button></div>
    </div>
  );
}

function S({ value, onChange, label, options }: { value: string; onChange: (v: string) => void; label: string; options: { value: string; label: string }[] }) { return <Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectGroup></SelectContent></Select>; }
function Msg({ l, ex, onT }: { l: AuditLog; ex: boolean; onT: () => void }) { const m = l.message || '—'; const lo = m.length > 96; return <div className="max-w-[420px]"><span className={`whitespace-pre-wrap break-words text-xs ${l.success ? 'text-muted-foreground' : 'font-medium text-destructive'}`}>{lo && !ex ? `${m.slice(0, 96)}...` : m}</span>{lo && <Button variant="link" size="xs" onClick={onT} className="ml-2 h-auto p-0">{ex ? <ChevronDown /> : <ChevronRight />}{ex ? '收起' : '展开'}</Button>}</div>; }
function MobileFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="min-w-0 rounded-md bg-muted px-2.5 py-2"><div className="text-[10px] text-muted-foreground">{label}</div><div className={`mt-0.5 truncate text-[12px] text-foreground ${mono ? 'font-mono tabular-nums text-muted-foreground' : ''}`} title={value}>{value}</div></div>; }
function nl(id: number | null, m: Map<number, string>) { return id === null || id === 0 ? '本机' : m.get(id) || `节点 #${id}`; }
function isRem(id: number | null) { return typeof id === 'number' && id > 0; }
function fmt(v: string) { if (!v) return '—'; const d = new Date(v); if (Number.isNaN(d.getTime())) return v; const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function Th({ children, align = 'left' }: { children: ReactNode; align?: 'left' | 'right' }) { return <th className={`px-4 py-2.5 text-[11px] font-medium text-muted-foreground ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</th>; }
function Td({ children, mono = false, align = 'left' }: { children: ReactNode; mono?: boolean; align?: 'left' | 'right' }) { return <td className={`px-4 py-2.5 text-[13px] ${align === 'right' ? 'text-right' : 'text-left'} ${mono ? 'font-mono tabular-nums text-xs text-muted-foreground' : ''}`}>{children}</td>; }
