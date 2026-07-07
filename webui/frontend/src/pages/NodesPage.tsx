import { useEffect, useMemo, useState } from 'react';
import {
  KeyRound, Plus, RefreshCw, Terminal, Trash2, UploadCloud, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { nodesApi } from '../lib/api';
import { bytesToHuman, formatLastSeen, shortNodeUuid } from '../lib/format';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import {
  InstallPanel, ConnectionGuidePanel, NodeHealthSummary,
  OfflineHint, StatusBadge, ConfirmNodeAction, type NodeConfirmAction,
} from './nodes/NodeParts';
import { useConsole } from '../context/ConsoleContext';
import type { Node, NodeInstall, SystemInfo } from '../lib/types';

type ConfirmState = { action: NodeConfirmAction; node: Node };

export function NodesPage() {
  const { nodeHealthById, nodeSystems, refreshAll } = useConsole();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<Record<number, string>>({});
  const [install, setInstall] = useState<{ node: Node; info: NodeInstall } | null>(null);
  const [confirming, setConfirming] = useState<ConfirmState | null>(null);

  const loadNodes = async () => {
    setLoading(true);
    try { setNodes(await nodesApi.list()); } catch (err) { toast.error(err instanceof Error ? err.message : '节点加载失败'); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadNodes(); const t = setInterval(loadNodes, 10000); return () => clearInterval(t); }, []);

  const formError = useMemo(() => (!name.trim() ? '请填写节点名称' : ''), [name]);
  const offlineCount = nodes.filter((n) => !(n.online || n.status === 'online')).length;

  const createNode = async () => {
    if (formError) { toast.error(formError); return; }
    setSaving(true);
    try {
      const created = await nodesApi.create({ name: name.trim() });
      setName('');
      setInstall({ node: created, info: created.install });
      toast.success('节点已创建，请在目标机运行安装命令');
      await loadNodes();
      refreshAll();
    } catch (err) { toast.error(err instanceof Error ? err.message : '节点新增失败'); }
    finally { setSaving(false); }
  };

  const showInstall = async (node: Node) => {
    setPending((p) => ({ ...p, [node.id]: 'install' }));
    try { setInstall({ node, info: await nodesApi.install(node.id) }); }
    catch (err) { toast.error(err instanceof Error ? err.message : '获取安装命令失败'); }
    finally { setPending((p) => { const n = { ...p }; delete n[node.id]; return n; }); }
  };

  const rotateSecret = async (node: Node) => {
    setPending((p) => ({ ...p, [node.id]: 'rotate' }));
    try { const u = await nodesApi.rotateSecret(node.id); setInstall({ node: u, info: u.install }); toast.success(`${node.name} 密钥已轮换`); await loadNodes(); refreshAll(); }
    catch (err) { toast.error(err instanceof Error ? err.message : '轮换密钥失败'); }
    finally { setPending((p) => { const n = { ...p }; delete n[node.id]; return n; }); }
  };

  const upgradeAgent = async (node: Node) => {
    setPending((p) => ({ ...p, [node.id]: 'upgrade' }));
    try { const r = await nodesApi.upgradeAgent(node.id); toast.success(r?.image ? `${node.name} Agent 升级已发起：${r.image}` : `${node.name} Agent 升级已发起`); await loadNodes(); refreshAll(); }
    catch (err) { toast.error(`${node.name} Agent 升级失败：${err instanceof Error ? err.message : '未知错误'}`); }
    finally { setPending((p) => { const n = { ...p }; delete n[node.id]; return n; }); }
  };

  const deleteNode = async (node: Node) => {
    setPending((p) => ({ ...p, [node.id]: 'delete' }));
    try { const r = await nodesApi.delete(node.id); if (install?.node.id === node.id) setInstall(null); toast.success(r?.detail || `${node.name} 及其实例已删除`); await loadNodes(); refreshAll(); }
    catch (err) { toast.error(`${node.name} 删除失败：${err instanceof Error ? err.message : '未知错误'}`); }
    finally { setPending((p) => { const n = { ...p }; delete n[node.id]; return n; }); }
  };

  const confirmAction = () => {
    if (!confirming) return;
    const { action, node } = confirming;
    setConfirming(null);
    if (action === 'rotate') rotateSecret(node);
    else if (action === 'upgrade') upgradeAgent(node);
    else deleteNode(node);
  };

  return (
    <div className="mx-auto max-w-[1600px] px-6 py-6">
      <div className="mb-6 flex items-center gap-3">
        <h2 className="text-lg font-semibold">节点</h2>
        <Badge tone="muted">{nodes.length} 个</Badge>
        <Button className="ml-auto" size="sm" onClick={loadNodes} disabled={loading}><RefreshCw size={13} />刷新</Button>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardHeader><CardTitle className="text-sm">节点列表</CardTitle></CardHeader>
          <CardContent className="p-0">
            <div className="grid gap-3 p-3 2xl:hidden">
              {nodes.map((node) => (
                <div key={node.id} className="min-w-0 rounded-lg border border-border bg-card p-3">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-semibold text-foreground">{node.name}</div>
                      <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{shortNodeUuid(node.uuid)}</div>
                    </div>
                    <StatusBadge node={node} />
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <div className="min-w-0 rounded-md bg-muted px-2.5 py-2">
                      <div className="text-[10px] text-muted-foreground">实例健康</div>
                      <div className="mt-1"><NodeHealthSummary health={nodeHealthById[node.id]} /></div>
                    </div>
                    <div className="min-w-0 rounded-md bg-muted px-2.5 py-2">
                      <div className="text-[10px] text-muted-foreground">系统摘要</div>
                      <div className="mt-1"><NodeSystemSummary node={node} snapshot={nodeSystems[node.id]} /></div>
                    </div>
                    <MobileFact label="最近在线" value={node.lastSeenAt || '—'} />
                  </div>
                  <div className="mt-3 flex flex-wrap justify-end gap-1.5 border-t border-border pt-3">
                    <Button size="sm" onClick={() => showInstall(node)} disabled={!!pending[node.id]}><Terminal size={13} />安装命令</Button>
                    <Button size="sm" onClick={() => setConfirming({ action: 'rotate', node })} disabled={!!pending[node.id]}><KeyRound size={13} />轮换密钥</Button>
                    <Button size="sm" onClick={() => setConfirming({ action: 'upgrade', node })} disabled={!!pending[node.id] || !node.online} title={node.online ? undefined : '离线节点需先接入 Agent'}><UploadCloud size={13} />升级</Button>
                    <Button size="sm" variant="destructive" onClick={() => setConfirming({ action: 'delete', node })} disabled={!!pending[node.id]}><Trash2 size={13} />删除</Button>
                  </div>
                </div>
              ))}
              {!nodes.length && (
                <div className="rounded-lg border border-dashed border-input bg-muted p-6 text-center text-xs text-muted-foreground">
                  {loading ? '加载中…' : '暂无节点，先在右侧创建一个'}
                </div>
              )}
            </div>
            <div className="hidden overflow-x-auto 2xl:block">
              <table className="w-full min-w-[980px]">
                <thead><tr className="border-b bg-muted/50"><Th>名称</Th><Th>状态</Th><Th>实例健康</Th><Th>系统摘要</Th><Th>UUID</Th><Th>最近在线</Th><Th align="right">操作</Th></tr></thead>
                <tbody>
                  {nodes.map((node) => (
                    <tr key={node.id} className="border-b last:border-b-0 hover:bg-muted/50 transition-colors">
                      <Td><span className="text-[13px] font-medium">{node.name}</span><OfflineHint node={node} /></Td>
                      <Td><StatusBadge node={node} /></Td>
                      <Td><NodeHealthSummary health={nodeHealthById[node.id]} /></Td>
                      <Td><NodeSystemSummary node={node} snapshot={nodeSystems[node.id]} /></Td>
                      <Td><span className="font-mono text-[11px] text-muted-foreground" title={node.uuid || undefined}>{shortNodeUuid(node.uuid, 8)}</span></Td>
                      <Td><span className="whitespace-nowrap text-xs text-muted-foreground" title={node.lastSeenAt || undefined}>{formatLastSeen(node.lastSeenAt)}</span></Td>
                      <Td align="right">
                        <div className="flex items-center justify-end gap-1">
                          <Button size="sm" onClick={() => showInstall(node)} disabled={!!pending[node.id]}><Terminal size={13} />安装命令</Button>
                          <Button size="sm" onClick={() => setConfirming({ action: 'rotate', node })} disabled={!!pending[node.id]}><KeyRound size={13} />轮换密钥</Button>
                          <Button size="icon-sm" variant="secondary" onClick={() => setConfirming({ action: 'upgrade', node })} disabled={!!pending[node.id] || !node.online} title={node.online ? '升级 Agent' : '离线节点需先接入 Agent'} aria-label="升级 Agent"><UploadCloud size={13} /></Button>
                          <Button size="icon-sm" variant="destructive" onClick={() => setConfirming({ action: 'delete', node })} disabled={!!pending[node.id]} title="删除节点" aria-label="删除节点"><Trash2 size={13} /></Button>
                        </div>
                      </Td>
                    </tr>
                  ))}
                  {!nodes.length && <tr><td colSpan={7} className="px-4 py-10 text-center text-xs text-muted-foreground">{loading ? '加载中…' : '暂无节点，先在右侧创建一个'}</td></tr>}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <aside className="flex flex-col gap-4 xl:sticky xl:top-20 xl:self-start">
          {install && <InstallPanel nodeName={install.node.name} info={install.info} onClose={() => setInstall(null)} />}
          <ConnectionGuidePanel offlineCount={offlineCount} />
          <Card>
            <CardHeader><CardTitle className="text-sm">新增节点</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">节点名称</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="vps-hk-01" onKeyDown={(e) => { if (e.key === 'Enter') createNode(); }} />
              </div>
              {formError && <div className="flex items-start gap-2 rounded-md bg-secondary p-2 text-xs text-secondary-foreground"><XCircle size={13} className="mt-0.5 shrink-0" /><span>{formError}</span></div>}
              <Button onClick={createNode} disabled={saving || !!formError}><Plus size={13} />{saving ? '创建中…' : '创建节点'}</Button>
            </CardContent>
          </Card>
        </aside>
      </div>

      {confirming && (
        <ConfirmNodeAction action={confirming.action} node={confirming.node} health={nodeHealthById[confirming.node.id]}
          onCancel={() => setConfirming(null)} onConfirm={confirmAction} />
      )}
    </div>
  );
}

function NodeSystemSummary({ node, snapshot }: { node: Node; snapshot?: { info: SystemInfo | null; error: string | null } }) {
  const online = node.online || node.status === 'online';
  if (!online) return <span className="text-xs text-muted-foreground">Agent 未在线</span>;
  if (!snapshot) return <span className="text-xs text-muted-foreground">加载中...</span>;
  if (snapshot.error || !snapshot.info) return <span className="text-xs text-destructive">系统信息不可达{snapshot.error ? `：${snapshot.error}` : ''}</span>;
  const info = snapshot.info;
  const diskRatio = info.disk.total > 0 ? (info.disk.used / info.disk.total) * 100 : null;
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5"><Chip l="Agent" v="在线" t="success" /><Chip l="Docker" v={info.dockerVersion || '未连接'} /></div>
      <div className="flex flex-wrap items-center gap-1.5"><Chip l="frpc" v={info.frpVersion || info.frpImage || '未配置'} /><Chip l="磁盘" v={diskRatio === null ? '不可用' : `${diskRatio.toFixed(1)}% · ${bytesToHuman(info.disk.used)} / ${bytesToHuman(info.disk.total)}`} t={diskRatio !== null && diskRatio >= 90 ? 'danger' : diskRatio !== null && diskRatio >= 75 ? 'warning' : 'muted'} /></div>
    </div>
  );
}
function Chip({ l, v, t = 'muted' }: { l: string; v: string; t?: 'success' | 'warning' | 'danger' | 'muted' }) {
  const c = t === 'success' ? 'bg-primary/10 text-primary' : t === 'warning' ? 'bg-secondary text-secondary-foreground' : t === 'danger' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground';
  return <span className={`inline-flex h-6 max-w-full items-center gap-1 overflow-hidden rounded-md px-2 text-[11px] whitespace-nowrap ${c}`}><span className="shrink-0">{l}</span><span className="min-w-0 truncate font-mono text-[10px] tabular-nums">{v}</span></span>;
}
function MobileFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-muted px-2.5 py-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-[12px] text-foreground" title={value}>{value}</div>
    </div>
  );
}
function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) { return <th className={`whitespace-nowrap px-4 py-2.5 text-[11px] font-medium text-muted-foreground ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</th>; }
function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) { return <td className={`px-4 py-3 align-middle ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</td>; }
