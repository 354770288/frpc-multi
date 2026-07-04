import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertTriangle, CheckCircle2, ClipboardCopy, KeyRound,
  ShieldAlert, Terminal, Trash2, UploadCloud, X, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import type { Node, NodeInstall, NodeInstanceHealth } from '../../lib/types';

export type NodeConfirmAction = 'rotate' | 'upgrade' | 'delete';

const EMPTY_HEALTH: NodeInstanceHealth = { total: 0, running: 0, stopped: 0, error: 0, disabled: 0 };

export function healthOrEmpty(health?: NodeInstanceHealth): NodeInstanceHealth { return health || EMPTY_HEALTH; }

export function StatusBadge({ node }: { node: Node }) {
  if (node.online || node.status === 'online') return <Badge tone="success"><CheckCircle2 size={12} />在线</Badge>;
  if (node.status === 'pending') return <Badge tone="warning">待连接</Badge>;
  if (node.status === 'offline') return <Badge tone="warning">离线</Badge>;
  if (node.status === 'error') return <Badge tone="danger"><XCircle size={12} />异常</Badge>;
  return <Badge tone="muted">未知</Badge>;
}

export function NodeHealthSummary({ health }: { health?: NodeInstanceHealth }) {
  const s = healthOrEmpty(health);
  return (
    <div className="flex min-w-[180px] flex-wrap items-center gap-1.5">
      <HC label="实例" value={s.total} />
      <HC label="运行" value={s.running} tone="success" />
      <HC label="异常" value={s.error} tone={s.error ? 'danger' : 'muted'} />
      {s.disabled > 0 && <HC label="停用" value={s.disabled} tone="warning" />}
    </div>
  );
}
function HC({ label, value, tone = 'muted' }: { label: string; value: number; tone?: 'success' | 'warning' | 'danger' | 'muted' }) {
  const c = tone === 'success' ? 'bg-primary/10 text-primary' : tone === 'warning' ? 'bg-secondary text-secondary-foreground' : tone === 'danger' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground';
  return <span className={`inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] ${c}`}><span>{label}</span><span className="font-mono font-semibold tabular-nums">{value}</span></span>;
}

export function OfflineHint({ node }: { node: Node }) {
  if (node.online || node.status === 'online') return null;
  return null;
}

export function ConnectionGuidePanel({ offlineCount }: { offlineCount: number }) {
  return (
    <Card>
      <CardHeader><CardTitle className="inline-flex items-center gap-2 text-sm"><Terminal size={14} />接入状态</CardTitle></CardHeader>
      <CardContent>
        <div className="rounded-md border bg-muted p-3">
          <div className="text-[11px] text-muted-foreground">未在线节点</div>
          <div className="mt-1 font-mono text-lg font-semibold tabular-nums">{offlineCount}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export function InstallPanel({ nodeName, info, onClose }: { nodeName: string; info: NodeInstall; onClose: () => void }) {
  async function copy(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); toast.success(`${label}已复制`); return; } catch {}
    try {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok = document.execCommand('copy'); document.body.removeChild(ta);
      if (ok) toast.success(`${label}已复制`); else toast.error('复制失败，请手动选择文本复制');
    } catch { toast.error('复制失败，请手动选择文本复制'); }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="inline-flex items-center gap-2 text-sm"><Terminal size={14} />安装命令</CardTitle>
        <Button variant="ghost" size="icon" onClick={onClose}><X size={14} /></Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="text-xs font-semibold">{nodeName}</div>
        {!info.serverConfigured && <div className="flex items-start gap-2 rounded-md bg-secondary p-2 text-xs text-secondary-foreground"><AlertTriangle size={13} className="mt-0.5 shrink-0" /><span>主控未配置对外可达地址，命令里的 <code className="font-mono text-[11px]">{info.server}</code> 需手动替换。</span></div>}
        <div className="relative">
          <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted p-3 pr-10 font-mono text-[11px] leading-relaxed">{info.installCommand}</pre>
          <Button variant="ghost" size="icon" className="absolute right-2 top-2" onClick={() => copy(info.installCommand, '安装命令')}><ClipboardCopy size={14} /></Button>
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px]">
          <span className="text-muted-foreground">主控地址</span><span className="min-w-0 break-all font-mono">{info.server}</span>
          <span className="text-muted-foreground">UUID</span><span className="min-w-0 break-all font-mono">{info.uuid}</span>
          <span className="text-muted-foreground">TLS</span><span className="min-w-0 break-all font-mono">{info.tls ? 'wss（已启用）' : 'ws（未启用）'}</span>
          <span className="text-muted-foreground">镜像</span><span className="min-w-0 break-all font-mono">{info.image}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => copy(info.installCommand, '安装命令')}><ClipboardCopy size={13} />复制命令</Button>
          <Button size="sm" variant="ghost" onClick={onClose}>关闭</Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ConfirmNodeAction({ action, node, health, onCancel, onConfirm }: { action: NodeConfirmAction; node: Node; health?: NodeInstanceHealth; onCancel: () => void; onConfirm: () => void }) {
  const [typedName, setTypedName] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const summary = healthOrEmpty(health);
  const meta = useMemo(() => confirmMeta(action), [action]);
  const requiresName = action === 'delete';
  const canConfirm = !requiresName || typedName === node.name;

  useEffect(() => { setTypedName(''); }, [action, node.id]);
  useEffect(() => { if (requiresName) inputRef.current?.focus(); }, [requiresName]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 py-6" role="presentation" onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="nc-title" className="w-full max-w-[520px] overflow-hidden rounded-xl border bg-card shadow-xl">
        <div className="flex items-start gap-3 border-b bg-muted/50 px-4 py-3">
          <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${meta.iconClass}`}>{meta.icon}</span>
          <div className="min-w-0">
            <h2 id="nc-title" className="text-sm font-semibold">{meta.title}</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">目标节点：<span className="font-semibold">{node.name}</span></p>
          </div>
        </div>
        <div className="space-y-4 p-4">
          <p className="text-xs leading-5 text-muted-foreground">{meta.description}</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <RM label="实例" value={summary.total} /><RM label="运行" value={summary.running} /><RM label="异常" value={summary.error} /><RM label="停用" value={summary.disabled} />
          </div>
          <ul className="space-y-2 text-xs leading-5 text-muted-foreground">
            {meta.impacts.map((i) => <li key={i} className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" /><span>{i}</span></li>)}
          </ul>
          {requiresName && (
            <div className="rounded-md border border-destructive/25 bg-destructive/10 p-3">
              <label className="text-xs font-medium text-destructive">输入节点名确认删除</label>
              <Input ref={inputRef} value={typedName} onChange={(e) => setTypedName(e.target.value)} placeholder={node.name} className="mt-2 bg-card" />
              <p className="mt-2 text-[11px] leading-4 text-destructive">离线节点删除只会移除主控记录；目标机上的 Agent 和实例容器需要手动清理。</p>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-muted/50 px-4 py-3">
          <Button variant="outline" onClick={onCancel}>取消</Button>
          <Button variant={meta.variant} onClick={onConfirm} disabled={!canConfirm}>{meta.buttonIcon}{meta.confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}
function RM({ label, value }: { label: string; value: number }) { return <div className="rounded-md border bg-card p-2"><div className="text-[10px] text-muted-foreground">{label}</div><div className="mt-1 font-mono text-sm font-semibold tabular-nums">{value}</div></div>; }
function confirmMeta(action: NodeConfirmAction): { title: string; description: string; confirmLabel: string; impacts: string[]; icon: ReactNode; buttonIcon: ReactNode; iconClass: string; variant: 'destructive' | 'default' } {
  if (action === 'rotate') return { title: '轮换节点密钥', description: '轮换后旧 Agent 会失去连接能力，需要用新安装命令重新部署或更新密钥。', confirmLabel: '轮换密钥', impacts: ['生成新的 Agent secret 并展示新的安装命令。', '旧安装命令里的密钥将不再适用于后续连接。'], icon: <KeyRound size={16} />, buttonIcon: <KeyRound size={13} />, iconClass: 'bg-secondary text-secondary-foreground', variant: 'default' };
  if (action === 'upgrade') return { title: '升级 Agent', description: '主控会要求在线 Agent 拉取当前镜像标签并重建自身容器，过程中节点会短暂离线。', confirmLabel: '发起升级', impacts: ['仅在线节点可执行。', '升级期间该节点实例操作可能暂时不可用。'], icon: <UploadCloud size={16} />, buttonIcon: <UploadCloud size={13} />, iconClass: 'bg-primary/10 text-primary', variant: 'default' };
  return { title: '删除节点', description: '这是破坏性操作。后端会在节点在线时尝试清理实例和 Agent；节点离线时只能删除主控记录。', confirmLabel: '删除节点', impacts: ['该节点下的所有已知 frpc 实例会从主控范围移除。', '若 Agent 在线，后端会尝试停止并删除实例容器、配置目录和 Agent 容器。', '若 Agent 离线，请到目标机手动清理残留容器和配置目录。'], icon: <ShieldAlert size={16} />, buttonIcon: <Trash2 size={13} />, iconClass: 'bg-destructive/10 text-destructive', variant: 'destructive' };
}
