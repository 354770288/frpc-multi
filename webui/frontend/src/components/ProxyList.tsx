import { useState } from 'react';
import {
  AlertTriangle, ChevronDown, ChevronRight, Plus, Trash2, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { PROXY_TYPES, createEmptyProxy, validateProxy, type ProxyDraft } from '../lib/proxyToml';

export function ProxyList({
  proxies,
  onChange,
  emptyHint,
}: {
  proxies: ProxyDraft[];
  onChange: (next: ProxyDraft[]) => void;
  emptyHint?: string;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);

  function addProxy() {
    const next = [...proxies, createEmptyProxy()];
    onChange(next);
    setExpanded(next.length - 1);
  }

  function removeProxy(index: number) {
    onChange(proxies.filter((_, i) => i !== index));
    setExpanded((c) => (c === index ? null : c));
    setConfirmingDelete(null);
    toast.info('已删除该代理，未保存前不会写入磁盘');
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">共 {proxies.length} 条代理</div>
        <Button size="sm" onClick={addProxy}><Plus size={12} />新增代理</Button>
      </div>
      <div className="rounded-md border overflow-hidden">
        {proxies.length === 0 ? (
          <div className="px-4 py-10 text-center text-xs text-muted-foreground">{emptyHint || '还没有代理。点击「新增代理」开始配置。'}</div>
        ) : (
          <ul className="divide-y">
            {proxies.map((d, i) => (
              <li key={i}>
                <ProxyRow d={d} ex={expanded === i} cd={confirmingDelete === i} ve={validateProxy(d, proxies)}
                  onT={() => setExpanded((c) => (c === i ? null : i))}
                  onChange={(p) => onChange(proxies.map((dd, ii) => (ii === i ? { ...dd, ...p } : dd)))}
                  onAD={() => setConfirmingDelete(i)}
                  onCD={() => setConfirmingDelete(null)}
                  onConfD={() => removeProxy(i)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ProxyRow({ d, ex, cd, ve, onT, onChange, onAD, onCD, onConfD }: {
  d: ProxyDraft; ex: boolean; cd: boolean; ve: string[];
  onT: () => void; onChange: (p: Partial<ProxyDraft>) => void; onAD: () => void; onCD: () => void; onConfD: () => void;
}) {
  const summary = [d.localIP || '—', d.localPort ? `:${d.localPort}` : '', d.remotePort ? ` → :${d.remotePort}` : '', d.subdomain ? ` · ${d.subdomain}` : ''].join('');
  return (
    <div>
      <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted cursor-pointer" onClick={onT} role="button" tabIndex={0} aria-expanded={ex}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onT(); } }}>
        <span className="text-muted-foreground shrink-0">{ex ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        <span className="text-[13px] font-medium min-w-[120px]">{d.name || <span className="text-muted-foreground/60 italic">未命名</span>}</span>
        <span className="inline-flex h-5 items-center rounded border bg-muted px-1.5 text-[11px] font-mono text-muted-foreground">{d.type || '—'}</span>
        <span className="text-[11px] font-mono text-muted-foreground truncate">{summary}</span>
        {ve.length > 0 && <span className="inline-flex items-center gap-1 text-[11px] text-destructive ml-auto"><AlertTriangle size={12} />{ve.length} 个问题</span>}
      </div>
      {ex && (
        <div className="bg-muted/50 border-t px-3 py-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FR label="代理名"><Input value={d.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="ssh" /></FR>
            <FR label="类型">
              <select value={d.type} onChange={(e) => onChange({ type: e.target.value })}
                className="h-9 w-full rounded-md border bg-card px-3 text-xs outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/30">
                {PROXY_TYPES.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </FR>
            <FR label="本地 IP"><Input value={d.localIP} onChange={(e) => onChange({ localIP: e.target.value })} placeholder="127.0.0.1" /></FR>
            <FR label="本地端口"><Input value={d.localPort} onChange={(e) => onChange({ localPort: e.target.value })} inputMode="numeric" placeholder="22" /></FR>
            <FR label="远端端口" hint={d.type === 'tcp' || d.type === 'udp' ? '必填' : 'http/https 可不填'}>
              <Input value={d.remotePort} onChange={(e) => onChange({ remotePort: e.target.value })} inputMode="numeric" placeholder="6001" /></FR>
            <FR label="子域名 (http/https)"><Input value={d.subdomain} onChange={(e) => onChange({ subdomain: e.target.value })} placeholder="nas" /></FR>
            <FR label="自定义域名（逗号分隔）" full><Input value={d.customDomains} onChange={(e) => onChange({ customDomains: e.target.value })} placeholder="nas.example.com" /></FR>
          </div>
          {ve.length > 0 && <ul className="mt-3 space-y-1">{ve.map((m, i) => <li key={i} className="text-[11px] text-destructive flex items-start gap-1.5"><XCircle size={11} className="mt-0.5 shrink-0" />{m}</li>)}</ul>}
          <div className="mt-3 flex justify-end gap-2">
            {cd ? (
              <><Button size="sm" onClick={onCD}>取消</Button><Button size="sm" variant="destructive" onClick={onConfD}><Trash2 size={12} />确认删除</Button></>
            ) : (
              <Button size="sm" variant="destructive" onClick={onAD}><Trash2 size={12} />删除该代理</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
function FR({ label, hint, full, children }: { label: string; hint?: string; full?: boolean; children: React.ReactNode }) {
  return <label className={`flex flex-col gap-1 ${full ? 'sm:col-span-2' : ''}`}><span className="text-[11px] font-medium text-muted-foreground">{label}{hint && <span className="ml-1.5 text-[10px] text-muted-foreground/60">{hint}</span>}</span>{children}</label>;
}
