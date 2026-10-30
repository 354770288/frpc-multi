import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { lbApi, probeApi } from '../lib/api';
import type { LbDomain, LbDomainServer, ProbeServer, ServerConn } from '../lib/types';
import { formatLastSeen } from '../lib/format';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { ConfirmOverlay, Overlay } from '../components/Overlay';

const PAGE_SIZE = 50;
const MAX_CANDIDATES = 5000;

function connectivityLabel(server: Pick<ProbeServer, 'latestConnectivity'>) {
  const status = server.latestConnectivity;
  if (!status) return <Badge tone="muted">未测量</Badge>;
  if (status.frpsReachable && status.tunnelEstablished && status.firewallOpen) return <Badge tone="success">连通</Badge>;
  if (status.frpsReachable || status.tunnelEstablished || status.firewallOpen) return <Badge tone="warning">部分可用</Badge>;
  return <Badge tone="danger">失败</Badge>;
}

function speedText(server: Pick<ProbeServer, 'latestSpeed'>) {
  const speed = server.latestSpeed;
  if (!speed) return '—';
  return `↓ ${speed.downloadOk ? speed.downloadMbps.toFixed(1) : '—'} · ↑ ${speed.uploadOk ? speed.uploadMbps.toFixed(1) : '—'} Mbps`;
}

function measurementTime(value: string | null | undefined) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return <span className="text-muted-foreground" title={value}>{formatLastSeen(value)}</span>;
}

function connectivityCell(server: Pick<ProbeServer, 'latestConnectivity'>) {
  return <div className="flex flex-col items-start gap-1">{connectivityLabel(server)}{measurementTime(server.latestConnectivity?.testTime)}</div>;
}

function speedCell(server: Pick<ProbeServer, 'latestSpeed'>) {
  return <div className="flex flex-col gap-1"><span>{speedText(server)}</span>{measurementTime(server.latestSpeed?.testTime)}</div>;
}

export function DomainCandidatesDialog({ domain, onClose, onChanged }: {
  domain: LbDomain;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [members, setMembers] = useState<LbDomainServer[]>([]);
  const [memberTotal, setMemberTotal] = useState(domain.poolSize);
  const [memberPage, setMemberPage] = useState(1);
  const [memberLoading, setMemberLoading] = useState(true);
  const [memberRefresh, setMemberRefresh] = useState(0);
  const [memberError, setMemberError] = useState('');
  const [memberBusyId, setMemberBusyId] = useState<number | null>(null);
  const [removalTarget, setRemovalTarget] = useState<LbDomainServer | null>(null);
  const [queryText, setQueryText] = useState('');
  const [query, setQuery] = useState('');
  const [conn, setConn] = useState<ServerConn>('all');
  const [library, setLibrary] = useState<ProbeServer[]>([]);
  const [libraryTotal, setLibraryTotal] = useState<number | null>(null);
  const [libraryCursor, setLibraryCursor] = useState<string | undefined>();
  const [libraryNextCursor, setLibraryNextCursor] = useState<string | null>(null);
  const [cursorTrail, setCursorTrail] = useState<(string | undefined)[]>([undefined]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const [switchTarget, setSwitchTarget] = useState<LbDomainServer | null>(null);
  const [switching, setSwitching] = useState(false);
  const memberRequest = useRef(0);
  const libraryRequest = useRef(0);
  const knownMemberIds = useMemo(() => new Set(members.map((item) => item.id)), [members]);
  const selectedAlreadyInDomain = [...selectedIds].filter((id) => knownMemberIds.has(id)).length;
  const selectedToAdd = selectedIds.size - selectedAlreadyInDomain;
  const currentIp = members.find((server) => server.current)?.ip ?? domain.currentIp;

  useEffect(() => {
    const timer = window.setInterval(() => setMemberRefresh((current) => current + 1), 15000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (queryText.trim() === query) return;
    const timer = window.setTimeout(() => {
      setQuery(queryText.trim());
      setCursorTrail([undefined]);
      setLibraryCursor(undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [queryText, query]);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++memberRequest.current;
    setMemberLoading(true);
    lbApi.domainServers(domain.id, { page: memberPage, pageSize: PAGE_SIZE }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || requestId !== memberRequest.current) return;
        setMembers(result.items);
        setMemberTotal(result.total);
        setMemberError('');
      })
      .catch((error) => {
        if (!controller.signal.aborted && requestId === memberRequest.current) {
          setMemberError(error instanceof Error ? error.message : '候选服务器加载失败');
        }
      })
      .finally(() => {
        if (requestId === memberRequest.current) setMemberLoading(false);
      });
    return () => controller.abort();
  }, [domain.id, memberPage, memberRefresh]);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++libraryRequest.current;
    const params = { page: 1, pageSize: PAGE_SIZE, q: query, conn, sort: 'ip' as const, order: 'asc' as const, cursor: libraryCursor };
    setLibraryLoading(true);
    setLibraryError('');
    Promise.all([probeApi.serversCursor(params, controller.signal), probeApi.serverCount(params, controller.signal)])
      .then(([result, count]) => {
        if (controller.signal.aborted || requestId !== libraryRequest.current) return;
        setLibrary(result.items);
        setLibraryTotal(count.total);
        setLibraryNextCursor(result.nextCursor);
        if (libraryCursor && !result.items.length && cursorTrail.length > 1) {
          setCursorTrail((trail) => trail.slice(0, -1));
          setLibraryCursor(cursorTrail[cursorTrail.length - 2]);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted && requestId === libraryRequest.current) {
          setLibraryError(error instanceof Error ? error.message : '服务器库加载失败');
        }
      })
      .finally(() => {
        if (requestId === libraryRequest.current) setLibraryLoading(false);
      });
    return () => controller.abort();
  }, [domain.id, query, conn, libraryCursor, cursorTrail]);

  const toggleServer = (serverId: number) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(serverId)) next.delete(serverId);
    else if (next.size >= MAX_CANDIDATES) toast.error(`一次最多选择 ${MAX_CANDIDATES} 台候选服务器`);
    else next.add(serverId);
    return next;
  });

  const addSelected = async () => {
    const ids = [...selectedIds].filter((id) => !knownMemberIds.has(id));
    if (!ids.length) return;
    setAdding(true);
    try {
      const result = await lbApi.addDomainServers(domain.id, ids);
      setSelectedIds(new Set());
      setMemberPage(1);
      const refreshed = await lbApi.domainServers(domain.id, { page: 1, pageSize: PAGE_SIZE });
      setMembers(refreshed.items);
      setMemberTotal(refreshed.total);
      setMemberError('');
      toast.success(`候选服务器列表已更新，共 ${result.total} 台`);
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '添加候选服务器失败');
    } finally {
      setAdding(false);
    }
  };

  const removeMember = async (server: LbDomainServer) => {
    setMemberBusyId(server.id);
    try {
      await lbApi.removeDomainServers(domain.id, [server.id]);
      setMembers((current) => current.filter((item) => item.id !== server.id));
      setMemberTotal((current) => Math.max(0, current - 1));
      setSelectedIds((current) => { const next = new Set(current); next.delete(server.id); return next; });
      setRemovalTarget(null);
      toast.success(`已移除 ${server.ip}`);
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '移除候选服务器失败');
    } finally {
      setMemberBusyId(null);
    }
  };

  const switchAndSync = async () => {
    if (!switchTarget || switching) return;
    setSwitching(true);
    try {
      const result = await lbApi.switchDomain(domain.id, switchTarget.id);
      if (!result.ok) {
        toast.error(`${domain.name}：${result.message}`);
        return;
      }
      toast.success(`${domain.name}：${result.message}`);
      setSwitchTarget(null);
      onChanged();
      const refreshed = await lbApi.domainServers(domain.id, { page: memberPage, pageSize: PAGE_SIZE });
      setMembers(refreshed.items);
      setMemberTotal(refreshed.total);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '切换并同步 DNS 失败');
    } finally {
      setSwitching(false);
    }
  };

  const removalImpact = removalTarget
    ? [
      removalTarget.current && `当前 DNS 指向 ${removalTarget.ip}；移除成员本身不会立即修改 DNS，后续同步会按剩余候选处理。`,
      memberTotal <= 1 && '移除后候选池为空，下一次同步会清理托管 A 记录。',
    ].filter(Boolean).join(' ')
    : '';

  return <>
    <Overlay title={`${domain.name} · 候选服务器 (${memberTotal})`} onClose={onClose} wide>
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium">已加入候选池</h3>
              <p className="text-xs text-muted-foreground">手动固定的服务器在保持健康时优先使用；故障切换后固定选择会清除，并恢复候选排序。成员调整不会立即写 DNS；启用域名仍按既有策略自动切换，空候选池同步会清理托管 A 记录。</p>
            </div>
            <Badge tone="muted">{memberTotal} 台</Badge>
          </div>
          {memberError && <p role="alert" className="text-xs text-destructive">{memberError}</p>}
          <div className="max-h-60 overflow-auto rounded-md border">
            <table className="w-full min-w-[680px] text-left text-xs">
              <thead className="sticky top-0 bg-muted/80"><tr><th className="px-3 py-2">服务器</th><th className="px-3 py-2">连通性</th><th className="px-3 py-2">最近速度</th><th className="px-3 py-2">状态</th><th className="px-3 py-2 text-right">操作</th></tr></thead>
              <tbody>
                {members.map((server) => <tr key={server.id} className="border-t">
                  <td className="px-3 py-2 font-mono">{server.ip}<span className="ml-2 font-sans text-muted-foreground">{server.group || '未分组'}</span></td>
                  <td className="px-3 py-2">{connectivityCell(server)}</td>
                  <td className="px-3 py-2 font-mono tabular-nums">{speedCell(server)}</td>
                    <td className="px-3 py-2"><div className="flex gap-1">{server.current && <Badge variant="info">当前</Badge>}{server.preferred && <Badge tone="warning">手动固定</Badge>}</div></td>
                  <td className="px-3 py-2"><div className="flex justify-end gap-1">
                    <Button size="sm" variant="outline" disabled={(server.current && server.preferred) || switching || memberBusyId !== null} onClick={() => setSwitchTarget(server)}>{server.current ? '固定并同步 DNS' : '切换并同步 DNS'}</Button>
                    <Button size="icon-sm" variant="ghost" disabled={memberBusyId !== null || adding || switching} aria-label={`移除 ${server.ip}`} onClick={() => { if (server.current || memberTotal <= 1) setRemovalTarget(server); else void removeMember(server); }}><Trash2 /></Button>
                  </div></td>
                </tr>)}
                {!members.length && <tr><td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">{memberLoading ? '加载中…' : '还没有候选服务器，请从服务器库添加。'}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{memberLoading ? '刷新中…' : `第 ${memberPage} / ${Math.max(1, Math.ceil(memberTotal / PAGE_SIZE))} 页`}</span>
            <div className="flex gap-1"><Button size="sm" variant="outline" disabled={memberPage <= 1 || memberLoading} onClick={() => setMemberPage((page) => Math.max(1, page - 1))}>上一页</Button><Button size="sm" variant="outline" disabled={memberPage * PAGE_SIZE >= memberTotal || memberLoading} onClick={() => setMemberPage((page) => page + 1)}>下一页</Button></div>
          </div>
        </section>

        <section className="flex flex-col gap-2 border-t pt-4">
          <div>
            <h3 className="text-sm font-medium">从服务器库添加</h3>
            <p className="text-xs text-muted-foreground">按搜索和连通性筛选，逐页选择；不会自动展开或全选整个服务器库。最多选择 {MAX_CANDIDATES} 台。</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1"><Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><Input aria-label="搜索服务器库" className="pl-8" value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="搜索 IP / 标签 / 分组" /></div>
            <Select value={conn} onValueChange={(value) => { setConn(value as ServerConn); setCursorTrail([undefined]); setLibraryCursor(undefined); }}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">全部连通性</SelectItem><SelectItem value="pass">连通</SelectItem><SelectItem value="partial">部分可用</SelectItem><SelectItem value="fail">失败</SelectItem><SelectItem value="untested">未测量</SelectItem></SelectGroup></SelectContent>
            </Select>
            <Badge tone="muted">{libraryTotal === null ? '…' : `${libraryTotal} 条结果`}</Badge>
          </div>
          {libraryError && <p role="alert" className="text-xs text-destructive">{libraryError}</p>}
          <div className="max-h-60 overflow-auto rounded-md border">
            <table className="w-full min-w-[550px] text-left text-xs">
              <thead className="sticky top-0 bg-muted/80"><tr><th className="w-10 px-3 py-2">选</th><th className="px-3 py-2">服务器</th><th className="px-3 py-2">连通性</th><th className="px-3 py-2">最近速度</th></tr></thead>
              <tbody>
                {library.map((server) => {
                  const alreadyAdded = knownMemberIds.has(server.id);
                  const checked = selectedIds.has(server.id);
                  return <tr key={server.id} className="border-t">
                    <td className="px-3 py-2"><input aria-label={`选择 ${server.ip}`} type="checkbox" checked={checked} disabled={alreadyAdded || adding} onChange={() => toggleServer(server.id)} /></td>
                    <td className="px-3 py-2 font-mono">{server.ip}<span className="ml-2 font-sans text-muted-foreground">{server.group || '未分组'}{alreadyAdded ? ' · 已加入' : ''}</span></td>
                    <td className="px-3 py-2">{connectivityCell(server)}</td>
                    <td className="px-3 py-2 font-mono tabular-nums">{speedCell(server)}</td>
                  </tr>;
                })}
                {!library.length && <tr><td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">{libraryLoading ? '加载中…' : '没有匹配的服务器'}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Button size="icon-sm" variant="outline" aria-label="服务器库上一页" disabled={cursorTrail.length <= 1 || libraryLoading} onClick={() => { const next = cursorTrail.slice(0, -1); setCursorTrail(next); setLibraryCursor(next[next.length - 1]); }}><ChevronLeft /></Button>
              <span>第 {cursorTrail.length} 页</span>
              <Button size="icon-sm" variant="outline" aria-label="服务器库下一页" disabled={libraryLoading || !libraryNextCursor} onClick={() => { if (!libraryNextCursor) return; const next = [...cursorTrail, libraryNextCursor]; setCursorTrail(next); setLibraryCursor(libraryNextCursor); }}><ChevronRight /></Button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">已选 {selectedIds.size} 台（新增 {selectedToAdd}）</span>
              <Button size="sm" onClick={() => void addSelected()} disabled={!selectedToAdd || adding || memberBusyId !== null || switching || selectedIds.size > MAX_CANDIDATES}>
                {adding ? '添加中…' : <><Plus data-icon="inline-start" />添加所选</>}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </Overlay>
    {removalTarget && <ConfirmOverlay
      title="移除候选服务器？"
      description={`${domain.name} · ${removalTarget.ip}。${removalImpact}`}
      confirmLabel={memberBusyId === removalTarget.id ? '移除中…' : '确认移除'}
      variant="destructive"
      onCancel={() => { if (memberBusyId === null) setRemovalTarget(null); }}
      onConfirm={() => void removeMember(removalTarget)}
      confirmDisabled={memberBusyId !== null}
      keepOpenOnConfirm
    />}
    {switchTarget && <ConfirmOverlay
      title="切换并同步 DNS？"
      description={`${domain.name} 将从 ${currentIp || '尚无当前 IP'} 切换到 ${switchTarget.ip}，并同步 Cloudflare A 记录。`}
      confirmLabel={switching ? '同步中…' : '切换并同步 DNS'}
      onCancel={() => { if (!switching) setSwitchTarget(null); }}
      onConfirm={() => void switchAndSync()}
      confirmDisabled={switching}
      keepOpenOnConfirm
    >
      <p className="px-1 text-xs text-muted-foreground">该选择会在服务器保持健康期间固定；发生故障切换后固定选择会清除，随后恢复自动候选排序。</p>
    </ConfirmOverlay>}
  </>;
}
