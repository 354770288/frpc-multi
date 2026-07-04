import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Filter,
  RefreshCw, RotateCcw, XCircle,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { auditLogsApi } from '../lib/api';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { useConsole } from '../context/ConsoleContext';
import { toast } from 'sonner';
import type { AuditLog } from '../lib/types';

const AL: Record<string, string> = {
  create_instance: '创建实例', patch_instance: '更新实例', update_config: '修改配置',
  delete_instance: '删除实例', start_instance: '启动', stop_instance: '停止',
  restart_instance: '重启', recreate_instance: '重建',
};

export function AuditLogsPage() {
  const { nodes, auditLogs, setAuditLogs } = useConsole();
  const navigate = useNavigate();
  const [logs, setLogs] = useState<AuditLog[]>(auditLogs);
  const [loading, setLoading] = useState(true);
  const [tf, setTf] = useState<string>('all');
  const [nf, setNf] = useState<string>('all');
  const [af, setAf] = useState<string>('all');
  const [rf, setRf] = useState<string>('all');
  const [iq, setIq] = useState('');
  const [em, setEm] = useState<Record<number, boolean>>({});

  const nodeNameById = useMemo(() => new Map(nodes.map((n) => [n.id, n.name])), [nodes]);
  const actions = useMemo(() => [...new Set(logs.map((l) => l.action))].sort(), [logs]);
  const hasLocal = logs.some((l) => isLocal(l.nodeId));

  const filtered = useMemo(() => {
    const kw = iq.trim().toLowerCase();
    return logs.filter((l) => {
      if (!matchTime(l.createdAt, tf)) return false;
      if (nf !== 'all' && nodeVal(l.nodeId) !== nf) return false;
      if (af !== 'all' && l.action !== af) return false;
      if (rf === 'success' && !l.success) return false;
      if (rf === 'failed' && l.success) return false;
      if (kw && !(l.instanceName || '').toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [logs, tf, nf, af, rf, iq]);

  const failedCount = logs.filter((l) => !l.success).length;

  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await auditLogsApi.list(200); setLogs(d); setAuditLogs(d); }
    catch (e) { toast.error(e instanceof Error ? e.message : '审计日志加载失败'); }
    finally { setLoading(false); }
  }, [setAuditLogs]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto max-w-[1600px] px-6 py-6">
      <div className="mb-6 flex items-center gap-3">
        <h2 className="text-lg font-semibold">审计日志</h2>
        <Badge tone="muted">{logs.length} 条</Badge>
        {failedCount > 0 && <Badge tone="danger">{failedCount} 条失败</Badge>}
        <Button className="ml-auto" size="sm" onClick={load} disabled={loading}><RefreshCw size={13} />刷新</Button>
      </div>

      <Card className="mb-4">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="inline-flex items-center gap-2 text-sm"><Filter size={14} />客户端筛选</CardTitle>
          <Button size="sm" variant="ghost" onClick={() => { setTf('all'); setNf('all'); setAf('all'); setRf('all'); setIq(''); }}>
            <RotateCcw size={13} />重置
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
            <div className="space-y-1.5"><Label className="text-[11px]">时间范围</Label>
              <S value={tf} onChange={setTf}><option value="all">全部时间</option><option value="today">今天</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option></S></div>
            <div className="space-y-1.5"><Label className="text-[11px]">节点</Label>
              <S value={nf} onChange={setNf}><option value="all">全部节点</option>{hasLocal && <option value="local">本机</option>}{nodes.map((n) => <option key={n.id} value={`node:${n.id}`}>{n.name}</option>)}</S></div>
            <div className="space-y-1.5"><Label className="text-[11px]">动作</Label>
              <S value={af} onChange={setAf}><option value="all">全部动作</option>{actions.map((a) => <option key={a} value={a}>{AL[a] || a}</option>)}</S></div>
            <div className="space-y-1.5"><Label className="text-[11px]">结果</Label>
              <S value={rf} onChange={setRf}><option value="all">全部结果</option><option value="success">成功</option><option value="failed">失败</option></S></div>
            <div className="space-y-1.5"><Label className="text-[11px]">实例</Label><Input value={iq} onChange={(e) => setIq(e.target.value)} placeholder="按实例名筛选" /></div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm">最近操作</CardTitle>
          <span className="text-[11px] text-muted-foreground">显示 {filtered.length} / {logs.length}</span>
        </CardHeader>
        <CardContent className="p-0">
          <div className="grid gap-3 p-3 2xl:hidden">
            {filtered.map((l) => (
              <div key={l.id} className={`min-w-0 rounded-lg border border-border bg-card p-3 ${l.success ? '' : 'bg-destructive/10/40'}`}>
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
              <div className="rounded-lg border border-dashed border-input bg-muted p-6 text-center text-xs text-muted-foreground">
                {loading ? '加载中…' : logs.length ? '没有匹配' : '暂无审计记录'}
              </div>
            )}
          </div>
          <div className="hidden 2xl:block">
            <table className="w-full min-w-[1120px]">
              <thead><tr className="border-b bg-muted/50"><Th>时间</Th><Th>操作人</Th><Th>动作</Th><Th>节点</Th><Th>实例</Th><Th>结果</Th><Th>消息</Th><Th align="right">定位</Th></tr></thead>
              <tbody>
                {filtered.map((l) => (
                  <tr key={l.id} className={`border-b last:border-b-0 hover:bg-muted/50 ${l.success ? '' : 'bg-destructive/10/40'}`}>
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
    </div>
  );
}

function S({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: ReactNode }) { return <select value={value} onChange={(e) => onChange(e.target.value)} className="h-9 w-full rounded-md border bg-transparent px-3 text-xs outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/30">{children}</select>; }
function Msg({ l, ex, onT }: { l: AuditLog; ex: boolean; onT: () => void }) { const m = l.message || '—'; const lo = m.length > 96; return <div className="max-w-[420px]"><span className={`whitespace-pre-wrap break-words text-xs ${l.success ? 'text-muted-foreground' : 'font-medium text-destructive'}`}>{lo && !ex ? `${m.slice(0, 96)}...` : m}</span>{lo && <button onClick={onT} className="ml-2 inline-flex items-center gap-1 rounded-sm text-[11px] font-medium text-primary hover:underline">{ex ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{ex ? '收起' : '展开'}</button>}</div>; }
function MobileFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="min-w-0 rounded-md bg-muted px-2.5 py-2"><div className="text-[10px] text-muted-foreground">{label}</div><div className={`mt-0.5 truncate text-[12px] text-foreground ${mono ? 'font-mono tabular-nums text-muted-foreground' : ''}`} title={value}>{value}</div></div>; }
function nodeVal(id: number | null) { return isLocal(id) ? 'local' : `node:${id}`; }
function matchTime(v: string, f: string) { if (f === 'all') return true; const t = new Date(v).getTime(); if (Number.isNaN(t)) return false; if (f === 'today') { const s = new Date(); s.setHours(0, 0, 0, 0); return t >= s.getTime(); } return t >= Date.now() - (f === '7d' ? 7 : 30) * 86400000; }
function nl(id: number | null, m: Map<number, string>) { return id === null || id === 0 ? '本机' : m.get(id) || `节点 #${id}`; }
function isLocal(id: number | null) { return id === null || id === 0; }
function isRem(id: number | null) { return typeof id === 'number' && id > 0; }
function fmt(v: string) { if (!v) return '—'; const d = new Date(v); if (Number.isNaN(d.getTime())) return v; const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function Th({ children, align = 'left' }: { children: ReactNode; align?: 'left' | 'right' }) { return <th className={`px-4 py-2.5 text-[11px] font-medium text-muted-foreground ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</th>; }
function Td({ children, mono = false, align = 'left' }: { children: ReactNode; mono?: boolean; align?: 'left' | 'right' }) { return <td className={`px-4 py-2.5 text-[13px] ${align === 'right' ? 'text-right' : 'text-left'} ${mono ? 'font-mono tabular-nums text-xs text-muted-foreground' : ''}`}>{children}</td>; }
