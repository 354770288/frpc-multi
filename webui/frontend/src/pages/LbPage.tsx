import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useNavigationType, useParams, useSearchParams } from 'react-router-dom';
import {
  ChevronDown, Cloud, Globe, ListChecks, Pencil, Plus, RefreshCw, RefreshCcw, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { HugeiconsIcon } from '@hugeicons/react';
import { Search01Icon, MoreHorizontalIcon } from '@hugeicons/core-free-icons';
import { CURRENT_HEALTH_LABELS, SYNC_LABELS, domainRows, filterDomainRows, readDomainFilters, type DomainFilters, type DomainRow } from '../lib/lbDomainView';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../components/ui/input-group';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { Skeleton } from '../components/ui/skeleton';
import { lbApi, probeApi } from '../lib/api';
import { formatLastSeen } from '../lib/format';
import { LbSelectionCard, SelectionReason } from './probe/LbSelectionCard';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '../components/ui/collapsible';
import {
  Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '../components/ui/empty';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Switch } from '../components/ui/switch';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from '../components/ui/select';
import { ConfirmOverlay, Overlay } from '../components/Overlay';
import type { CloudflareZone, LbDomain, LbDnsRecord, LbHealth, LbSyncLog, LbSelectionConfig } from '../lib/types';
import { DomainCandidatesDialog } from './DomainCandidatesDialog';

export function LbPage() {
  const navigate=useNavigate();
  const {domainId}=useParams<{domainId:string}>();
  const [domains, setDomains] = useState<LbDomain[]>([]);
  const [health, setHealth] = useState<LbHealth | null>(null);
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [zones, setZones] = useState<CloudflareZone[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectionConfig,setSelectionConfig]=useState<LbSelectionConfig|null>(null);
  const [primaryNodeName,setPrimaryNodeName]=useState('');
  const [loadError,setLoadError]=useState('');

  const [editing, setEditing] = useState<LbDomain | 'new' | null>(null);
  const [params, setParams] = useSearchParams();
  const navigationType = useNavigationType();
  const urlQuery = params.get('q') ?? '';
  const [queryText, setQueryText] = useState(urlQuery);
  const [refreshing, setRefreshing] = useState(false);
  const requestId = useRef(0);
  // Router replacements may settle after the next keystroke. Keep the input
  // immediate; actual history navigation restores the committed URL query.
  useEffect(() => {
    if (navigationType !== 'REPLACE') setQueryText(urlQuery);
  }, [urlQuery, navigationType]);
  const filters = { ...readDomainFilters(params), q: queryText };
  const rows = useMemo(() => domainRows(domains, health), [domains, health]);
  const visible = filterDomainRows(rows, filters);
  const inspected = rows.find((row) => row.domain.id === Number(domainId));
  const inspecting = inspected?.domain ?? null;
  const filtered = !!(filters.q.trim() || filters.enabled !== 'all' || filters.health !== 'all' || filters.sync !== 'all');
  const updateFilter = (key: keyof DomainFilters, value: string) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (key !== 'q') {
      if (queryText) next.set('q', queryText); else next.delete('q');
    }
    if (value && (key === 'q' || value !== 'all')) next.set(key, value); else next.delete(key);
    return next;
  }, { replace: key === 'q' });
  const clearFilters = () => { setQueryText(''); setParams((current) => {
    const next = new URLSearchParams(current);
    for (const key of ['q', 'enabled', 'health', 'sync']) next.delete(key);
    return next;
  }); };
  const listParams = new URLSearchParams(params);
  if (queryText) listParams.set('q', queryText); else listParams.delete('q');
  const listSearch = listParams.toString();
  const openDetails = (domain: LbDomain) => navigate({ pathname: `/lb/${domain.id}`, search: listSearch });
  const [deleting, setDeleting] = useState<LbDomain | null>(null);
  const [managingCandidates, setManagingCandidates] = useState<LbDomain | null>(null);
  const [syncing, setSyncing] = useState<Record<number, boolean>>({});

  const load = useCallback(async () => {
    const request = ++requestId.current;
    setRefreshing(true);
    try {
      const [list, info, healthSnapshot,selection,testNodes] = await Promise.all([
        lbApi.domains(), lbApi.cloudflare(), lbApi.health(),lbApi.selectionConfig(),probeApi.testNodes().catch(()=>({items:[]})),
      ]);
      const policy = await probeApi.executionPolicy();
      if (request !== requestId.current) return;
      setDomains(list);
      setTokenConfigured(info.configured);
      setHealth(healthSnapshot);
      setSelectionConfig(selection);
      setPrimaryNodeName(testNodes.items.find((node)=>node.id===policy.primaryNodeId)?.name || policy.primaryNodeId || '未配置');
      setLoadError('');
    } catch (err) {
      if (request === requestId.current) setLoadError(err instanceof Error ? err.message : '域名数据加载失败');
    } finally {
      if (request === requestId.current) { setLoading(false); setRefreshing(false); }
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => { clearInterval(timer); requestId.current += 1; };
  }, [load]);

  const syncNow = async (domain: LbDomain) => {
    setSyncing((prev) => ({ ...prev, [domain.id]: true }));
    try {
      const result = await lbApi.syncDomain(domain.id);
      if (result.ok) toast.success(`${domain.name}：${result.message}`);
      else toast.warning(`${domain.name}：${result.message}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '同步失败');
    } finally {
      setSyncing((prev) => { const next = { ...prev }; delete next[domain.id]; return next; });
    }
  };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2"><h2 className="text-lg font-semibold">域名选优</h2><Badge variant="outline">Cloudflare</Badge></div>
          <p className="text-sm text-muted-foreground">管理当前指向与候选服务器，健康异常时自动切换。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm"><Link to="/lb/settings">域名设置</Link></Button>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={refreshing}><RefreshCw data-icon="inline-start" />{refreshing ? '刷新中…' : '刷新'}</Button>
          <Button size="sm" onClick={() => setEditing('new')} disabled={!tokenConfigured} title={tokenConfigured ? undefined : '请先配置 Cloudflare API Token'}><Plus data-icon="inline-start" />新增域名</Button>
        </div>
      </div>
      {loadError && <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{loadError}；{domains.length ? '保留上次加载的信息，请刷新重试。' : '请刷新重试。'}</p>}
      <Card>
        <CardHeader className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-2"><CardTitle className="text-sm">候选域名</CardTitle><span aria-live="polite" className="text-xs text-muted-foreground">{loading ? '正在加载' : `显示 ${visible.length} / ${domains.length} 个域名`}</span></div>
          <div className="flex flex-wrap items-center gap-2">
            <InputGroup className="min-w-48 flex-1 sm:min-w-64">
              <InputGroupAddon><HugeiconsIcon icon={Search01Icon} /></InputGroupAddon>
              <InputGroupInput aria-label="搜索域名或当前 IP" placeholder="搜索域名或当前 IP" value={queryText} onChange={(event) => { setQueryText(event.target.value); updateFilter('q', event.target.value); }} />
            </InputGroup>
            <DomainFilter label="启用状态筛选" value={filters.enabled} onChange={(value) => updateFilter('enabled', value)} options={[
              ['all', '全部启用状态'], ['enabled', '已启用'], ['disabled', '已停用'],
            ]} />
            <DomainFilter label="当前 IP 健康筛选" value={filters.health} onChange={(value) => updateFilter('health', value)} options={[
              ['all', '全部 IP 健康'], ['healthy', '当前 IP 健康'], ['unhealthy', '当前 IP 检查失败'], ['unknown', '当前 IP 待检查'], ['unassigned', '尚未同步 IP'],
            ]} />
            <DomainFilter label="最近同步筛选" value={filters.sync} onChange={(value) => updateFilter('sync', value)} options={[
              ['all', '全部同步结果'], ['success', '最近同步成功'], ['failed', '最近同步失败'], ['never', '尚未同步'], ['unknown', '同步结果未知'],
            ]} />
            {filtered && <Button size="sm" variant="ghost" onClick={clearFilters}>清空筛选</Button>}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table aria-label="候选域名列表" className="w-full min-w-[780px]">
              <thead><tr className="border-y bg-muted/50"><Th>域名</Th><Th>当前 IP</Th><Th>候选健康</Th><Th>最近同步</Th><Th align="right">操作</Th></tr></thead>
              <tbody>
                {loading && !domains.length ? Array.from({ length: 3 }, (_, row) => <tr key={row}><td colSpan={5} className="px-4 py-4"><Skeleton className="h-9 w-full" /></td></tr>) : visible.map((row) => {
                  const { domain } = row;
                  return <tr key={domain.id} className="border-b transition-colors last:border-b-0 hover:bg-muted/40">
                    <Td>
                      <div className="flex items-center gap-2">
                        <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                        <Link to={{ pathname: `/lb/${domain.id}`, search: listSearch }} aria-label={`查看 ${domain.name} 详情`} className="max-w-64 truncate font-mono text-[13px] font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title={domain.name}>{domain.name}</Link>
                        {!domain.enabled && <Badge tone="muted">已停用</Badge>}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">{domain.preferredServerId != null ? '手动固定' : '自动选优'} · {domain.syncMode === 'scheduled' ? '定时同步' : '手动同步'}</div>
                    </Td>
                    <Td>
                      <div className="flex flex-col items-start gap-1.5">
                        <span className="font-mono text-[13px]">{domain.currentIp || '—'}</span>
                        <div className="flex flex-wrap gap-1"><Badge tone={row.currentHealth === 'healthy' ? 'success' : row.currentHealth === 'unhealthy' ? 'danger' : 'muted'} dot>{CURRENT_HEALTH_LABELS[row.currentHealth]}</Badge>{row.pendingSwitch && <Badge tone="warning">建议切换</Badge>}</div>
                      </div>
                    </Td>
                    <Td>
                      {domain.poolSize ? <div className="flex flex-col gap-1"><span className="text-sm tabular-nums">{row.healthyCount}<span className="text-muted-foreground"> / {domain.poolSize} 健康</span></span><span className="text-xs text-muted-foreground">{[row.unhealthyCount ? `${row.unhealthyCount} 检查失败` : '', row.unknownCount ? `${row.unknownCount} 待检查` : ''].filter(Boolean).join(' · ') || '候选均健康'}</span></div> : <Badge tone="warning">无候选</Badge>}
                    </Td>
                    <Td>
                      <div className="flex flex-col items-start gap-1.5"><Badge tone={row.syncState === 'success' ? 'success' : row.syncState === 'failed' ? 'danger' : 'muted'}>{SYNC_LABELS[row.syncState]}</Badge>{domain.lastSyncAt && <span className="whitespace-nowrap text-xs text-muted-foreground">{formatLastSeen(domain.lastSyncAt)}</span>}</div>
                    </Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-1">
                        <Button size="sm" variant="outline" onClick={() => setManagingCandidates(domain)}>候选服务器</Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={`${domain.name} 更多操作`}><HugeiconsIcon icon={MoreHorizontalIcon} /></Button></DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuGroup>
                              <DropdownMenuItem disabled={!!syncing[domain.id]} onSelect={() => void syncNow(domain)}><RefreshCcw />{syncing[domain.id] ? '同步中…' : '立即同步'}</DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => openDetails(domain)}><ListChecks />查看详情与记录</DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => setEditing(domain)}><Pencil />编辑域名</DropdownMenuItem>
                            </DropdownMenuGroup>
                            <DropdownMenuSeparator />
                            <DropdownMenuGroup><DropdownMenuItem variant="destructive" onSelect={() => setDeleting(domain)}><Trash2 />删除域名</DropdownMenuItem></DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </Td>
                  </tr>;
                })}
                {!loading && !visible.length && <tr><td colSpan={5}>
                  <Empty className="py-12">
                    <EmptyHeader><EmptyMedia variant="icon">{filtered ? <HugeiconsIcon icon={Search01Icon} /> : <Globe />}</EmptyMedia><EmptyTitle>{loadError && !domains.length ? '域名数据加载失败' : filtered ? '没有匹配的域名' : !tokenConfigured ? '先配置 Cloudflare' : '还没有候选域名'}</EmptyTitle><EmptyDescription>{loadError && !domains.length ? '请刷新重试。' : filtered ? '试试其他关键词或清空筛选条件。' : !tokenConfigured ? '在域名设置中配置 Cloudflare API Token 后即可添加域名。' : '新增域名后添加候选服务器，健康时使用手动固定的目标，故障后自动切换。'}</EmptyDescription></EmptyHeader>
                    <EmptyContent>{filtered ? <Button variant="outline" size="sm" onClick={clearFilters}>清空筛选</Button> : loadError ? <Button variant="outline" size="sm" onClick={() => void load()}>重新加载</Button> : !tokenConfigured ? <Button asChild variant="outline" size="sm"><Link to="/lb/settings">前往域名设置</Link></Button> : null}</EmptyContent>
                  </Empty>
                </td></tr>}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">主用测试节点：{primaryNodeName || '加载中'} · 观测有效期 {selectionConfig?.maxAgeHours ?? '—'} 小时 · 健康检查由主控执行</p>

      {editing && (
        <DomainDialog
          domain={editing === 'new' ? null : editing}
          zones={zones}
          onClose={() => setEditing(null)}
          onSaved={(savedDomain) => { setEditing(null); void load(); if (editing === 'new') setManagingCandidates(savedDomain); }}
          onNeedZones={async () => {
            const result = await lbApi.verifyCloudflare();
            setZones(result.zones);
            return result.zones;
          }}
        />
      )}
      {inspecting && (
        <RecordsDialog domain={inspecting} row={inspected!} onClose={() => navigate({ pathname: '/lb', search: listSearch })} />
      )}
      {managingCandidates && (
        <DomainCandidatesDialog key={managingCandidates.id} domain={managingCandidates} onClose={() => setManagingCandidates(null)} onChanged={() => void load()} />
      )}
      {deleting && (
        <DeleteDomainDialog domain={deleting} onCancel={() => setDeleting(null)}
          onDone={() => { setDeleting(null); load(); }} />
      )}
    </div>
  );
}

function DomainFilter({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
}) {
  return <Select value={value} onValueChange={onChange}>
    <SelectTrigger aria-label={label} className="w-full sm:w-40"><SelectValue /></SelectTrigger>
    <SelectContent><SelectGroup>{options.map(([key, text]) => <SelectItem key={key} value={key}>{text}</SelectItem>)}</SelectGroup></SelectContent>
  </Select>;
}

export function LbSettingsPage() {
  const [configured,setConfigured]=useState(false);
  const [masked,setMasked]=useState('');
  const [zones,setZones]=useState<CloudflareZone[]>([]);
  const [error,setError]=useState('');
  const load=useCallback(async()=>{
    try {const info=await lbApi.cloudflare();setConfigured(info.configured);setMasked(info.tokenMasked);setError('');}
    catch(err){setError(err instanceof Error ? err.message : '域名设置加载失败');}
  },[]);
  useEffect(()=>{void load();},[load]);
  return <main className="mx-auto max-w-3xl space-y-4 px-4 py-6 sm:px-6">
    <div><Link to="/lb" className="text-sm text-muted-foreground hover:underline">← 返回域名选优</Link><h2 className="mt-3 text-xl font-semibold">域名设置</h2><p className="text-sm text-muted-foreground">配置统一测量结果有效期与 Cloudflare 接入</p></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <LbSelectionCard onSaved={()=>{}} />
    <CloudflareCard configured={configured} masked={masked} zones={zones} onZones={setZones} onSaved={()=>void load()} />
    <Card><CardHeader><CardTitle>工作原理</CardTitle></CardHeader><CardContent className="space-y-2 text-sm text-muted-foreground"><p>域名池内的候选按最近被接受的主用或备用测量结果排序，主控持续检查当前 IP 的实时健康。</p><p>执行来源与任务进度可在测试任务和历史记录中查看。启用域名会在当前目标故障时切换到健康候选；“手动/定时”描述平时同步频率。</p><p>客户端 DNS 缓存和 frpc 重连时间会影响实际切换时长。</p></CardContent></Card>
  </main>;
}

/** Cloudflare 凭据配置卡。 */
function CloudflareCard({ configured, masked, zones, onZones, onSaved }: {
  configured: boolean;
  masked: string;
  zones: CloudflareZone[];
  onZones: (zones: CloudflareZone[]) => void;
  onSaved: () => void;
}) {
  const [token, setToken] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [saving, setSaving] = useState(false);

  const verify = async (value: string | undefined) => {
    setVerifying(true);
    try {
      const result = await lbApi.verifyCloudflare(value);
      onZones(result.zones);
      toast.success(`令牌有效：${result.zones.length} 个 zone`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '验证失败');
    } finally {
      setVerifying(false);
    }
  };

  const save = async () => {
    if (!token.trim()) { toast.error('请填写 API Token'); return; }
    setSaving(true);
    try {
      const info = await lbApi.saveCloudflareToken(token.trim());
      toast.success(`Token 已保存（${info.tokenMasked}）`);
      setToken('');
      onSaved();
      await verify(undefined);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Collapsible defaultOpen={!configured}>
      <Card data-slot="cloudflare-card">
        <CardHeader className="flex-row items-center gap-2">
          <CollapsibleTrigger className="group/collapsible-trigger flex min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <CardTitle className="text-sm">Cloudflare</CardTitle>
            {configured
              ? <Badge tone="success"><Cloud size={11} />已配置 {masked}</Badge>
              : <Badge tone="warning">未配置</Badge>}
            <ChevronDown
              size={14}
              className="ml-auto shrink-0 text-muted-foreground transition-transform group-data-[state=open]/collapsible-trigger:rotate-180"
            />
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">API Token（需要 Zone 读 + DNS 编辑权限）</Label>
              <Input
                type="password" value={token} onChange={(e) => setToken(e.target.value)}
                placeholder={configured ? '输入新 Token 覆盖' : '粘贴 Cloudflare API Token'}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" onClick={() => verify(token.trim() || undefined)} disabled={verifying}>
                {verifying ? '验证中…' : '验证令牌'}
              </Button>
              <Button size="sm" onClick={save} disabled={saving || !token.trim()}>
                {saving ? '保存中…' : '保存'}
              </Button>
            </div>
            {!!zones.length && (
              <div className="rounded-md bg-muted px-2.5 py-2 text-[11px] leading-5 text-muted-foreground">
                可用 Zone：{zones.map((zone) => zone.name).join('、')}
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

/** 新增 / 编辑候选域名弹窗。 */
function DomainDialog({ domain, zones, onClose, onSaved, onNeedZones }: {
  domain: LbDomain | null;
  zones: CloudflareZone[];
  onClose: () => void;
  onSaved: (domain: LbDomain) => void;
  onNeedZones: () => Promise<CloudflareZone[]>;
}) {
  const [zoneId, setZoneId] = useState(domain?.zoneId ?? '');
  const [name, setName] = useState(domain?.name ?? '');
  const [ttl, setTtl] = useState(String(domain?.ttl ?? 60));
  const [mode, setMode] = useState<'manual' | 'scheduled'>(domain?.syncMode ?? 'manual');
  const [interval, setIntervalValue] = useState(String(Math.round((domain?.intervalSeconds ?? 300) / 60)));
  const [enabled, setEnabled] = useState(domain?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [zoneList, setZoneList] = useState<CloudflareZone[]>(zones);

  useEffect(() => {
    if (!zoneList.length) {
      onNeedZones().then(setZoneList).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedZone = zoneList.find((zone) => zone.id === zoneId);

  const submit = async () => {
    if (!zoneId) { toast.error('请选择 Zone'); return; }
    if (!name.trim()) { toast.error('请填写域名'); return; }
    if (selectedZone && name.trim().toLowerCase() !== selectedZone.name.toLowerCase()
      && !name.trim().toLowerCase().endsWith(`.${selectedZone.name.toLowerCase()}`)) {
      toast.error(`域名必须等于 ${selectedZone.name} 或是其子域名`);
      return;
    }
    if (!/^\d+$/.test(ttl) || Number(ttl) < 30 || Number(ttl) > 3600) { toast.error('TTL 需在 30-3600 秒'); return; }
    const intervalSeconds = Math.round(Number(interval) * 60);
    if (mode === 'scheduled' && (!/^\d+(\.5)?$/.test(interval) || intervalSeconds < 60 || intervalSeconds > 86400)) {
      toast.error('同步间隔需在 1 分钟 - 24 小时'); return;
    }
    setSaving(true);
    try {
      if (domain) {
        const saved = await lbApi.updateDomain(domain.id, {
          ttl: Number(ttl), syncMode: mode, intervalSeconds, enabled,
        });
        toast.success('候选域名已更新');
        onSaved(saved);
      } else {
        const saved = await lbApi.createDomain({
          name: name.trim(), zoneId, zoneName: selectedZone!.name,
          ttl: Number(ttl), syncMode: mode, intervalSeconds, enabled,
        });
        toast.success('域名已创建，下一步请添加候选服务器');
        onSaved(saved);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay title={domain ? `编辑 ${domain.name}` : '新增候选域名'} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Cloudflare Zone</Label>
          <Select value={zoneId} onValueChange={setZoneId} disabled={!!domain}>
            <SelectTrigger><SelectValue placeholder={zoneList.length ? '选择 Zone' : '验证令牌后可选'} /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {zoneList.map((zone) => (
                  <SelectItem key={zone.id} value={zone.id}>{zone.name}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">完整域名（须属于所选 Zone）</Label>
          <Input
            value={name} onChange={(e) => setName(e.target.value)}
            placeholder={selectedZone ? `如 frps.${selectedZone.name}` : 'frps.example.com'}
            disabled={!!domain}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">A 记录 TTL（秒）</Label>
            <Input value={ttl} onChange={(e) => setTtl(e.target.value)} inputMode="numeric" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-sm">常规 DNS 同步方式</Label>
            <Select value={mode} onValueChange={(value) => setMode(value as 'manual' | 'scheduled')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="manual">手动同步</SelectItem>
                  <SelectItem value="scheduled">定时同步</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
        {mode === 'scheduled' && (
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">同步间隔（分钟）</Label>
            <Input value={interval} onChange={(e) => setIntervalValue(e.target.value)} inputMode="numeric" />
          </div>
        )}
        <p className="text-sm text-muted-foreground">启用域名仍会按主控健康检查自动故障切换；这里设置的是平时的 DNS 同步方式。</p>
        <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2">
          <span className="text-xs">启用（停用后不参与定时同步与故障切换）</span>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button onClick={submit} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
      </div>
    </Overlay>
  );
}

/** 域名详情弹窗：当前 DNS 记录 + 同步日志。 */
function RecordsDialog({ domain, row, onClose }: { domain: LbDomain; row: DomainRow; onClose: () => void }) {
  const [records, setRecords] = useState<LbDnsRecord[] | null>(null);
  const [logs, setLogs] = useState<LbSyncLog[]>([]);
  const [error, setError] = useState('');
  const [logsLoading, setLogsLoading] = useState(true);
  const [logsError, setLogsError] = useState('');

  useEffect(() => {
    let active = true;
    setRecords(null); setLogs([]); setError(''); setLogsError(''); setLogsLoading(true);
    lbApi.domainRecords(domain.id)
      .then((value) => { if (active) setRecords(value); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : '记录加载失败'); });
    lbApi.domainLogs(domain.id)
      .then((value) => { if (active) setLogs(value); })
      .catch((err) => { if (active) setLogsError(err instanceof Error ? err.message : '日志加载失败'); })
      .finally(() => { if (active) setLogsLoading(false); });
    return () => { active = false; };
  }, [domain.id]);

  return (
    <Overlay title={`${domain.name} · 域名详情与同步记录`} onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <dl className="grid gap-4 rounded-md bg-muted/50 p-4 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-muted-foreground">当前指向</dt><dd className="mt-1 font-mono">{domain.currentIp || '未同步'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">选优方式</dt><dd className="mt-1">{domain.preferredServerId != null ? '手动固定，健康期间保持当前目标' : '自动选优'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">常规同步</dt><dd className="mt-1">{domain.syncMode === 'scheduled' ? `每 ${Math.round(domain.intervalSeconds / 60)} 分钟` : '手动同步'} · TTL {domain.ttl}s</dd></div>
          <div><dt className="text-xs text-muted-foreground">候选健康</dt><dd className="mt-1">{row.healthyCount} / {domain.poolSize} 已确认健康{row.unknownCount ? ` · ${row.unknownCount} 待检查` : ''}</dd></div>
        </dl>
        {row.pendingSwitch && <p className="text-sm">健康监测建议切换到 <span className="font-mono">{row.health?.bestIp}</span></p>}
        {row.health?.selection && <SelectionReason selection={row.health.selection} />}
        {domain.lastSyncMessage && <div className="flex flex-col gap-1 text-sm"><span className="text-xs text-muted-foreground">最近同步说明</span><p className="break-words">{domain.lastSyncMessage}</p></div>}
        <div className="flex flex-col gap-1.5">
          <div className="text-[11px] font-medium text-muted-foreground">当前 A 记录（Cloudflare）</div>
          {records === null && !error && <div className="text-xs text-muted-foreground">加载中…</div>}
          {error && <div role="alert" className="text-xs text-destructive">{error}</div>}
          {records && (
            records.length ? (
              <div className="flex flex-col gap-1">
                {records.map((record) => (
                  <div key={record.id} className="flex items-center gap-2 rounded-md bg-muted/60 px-2.5 py-1.5">
                    <span className="w-32 shrink-0 font-mono text-[12px]">{record.ip}</span>
                    <span className="text-[11px] text-muted-foreground">TTL {record.ttl}s</span>
                    {record.managed
                      ? <Badge tone="success">托管</Badge>
                      : <Badge tone="muted">手动添加（不受管理）</Badge>}
                  </div>
                ))}
              </div>
            ) : <div className="rounded-md border border-dashed border-input p-3 text-center text-xs text-muted-foreground">暂无 A 记录</div>
          )}
        </div>
        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <div className="text-[11px] font-medium text-muted-foreground">最近同步日志</div>
          {logsLoading ? <div role="status" className="text-xs text-muted-foreground">日志加载中…</div> : logsError ? <div role="alert" className="text-xs text-destructive">{logsError}</div> : logs.length ? (
            <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
              {logs.map((log) => (
                <div key={log.id} className="rounded-md bg-muted/60 px-2.5 py-1.5">
                  <div className="flex items-center gap-2">
                    <Badge tone={log.success ? 'success' : 'danger'}>{log.success ? '成功' : '失败'}</Badge>
                    <span className="text-[11px] text-muted-foreground">{formatLastSeen(log.createdAt)}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{log.message}</div>
                </div>
              ))}
            </div>
          ) : <div className="text-xs text-muted-foreground">还没有同步记录</div>}
        </div>
      </div>
    </Overlay>
  );
}

/** 删除确认（可选顺带清理托管 DNS 记录）。 */
function DeleteDomainDialog({ domain, onCancel, onDone }: {
  domain: LbDomain;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [removeRecords, setRemoveRecords] = useState(true);
  const [deleting, setDeleting] = useState(false);

  const confirm = async () => {
    setDeleting(true);
    try {
      const result = await lbApi.deleteDomain(domain.id, removeRecords);
      toast.success(removeRecords && result.removedRecords.length
        ? `${domain.name} 已删除，清理 ${result.removedRecords.length} 条托管记录`
        : `${domain.name} 已删除`);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <ConfirmOverlay
      title={`删除候选域名 ${domain.name}`}
      description="删除后创建实例页不再提供该域名。"
      confirmLabel={deleting ? '删除中…' : '删除'} variant="destructive"
      onCancel={onCancel} onConfirm={confirm}
    >
      <label className="mt-3 flex items-center gap-2 rounded-md bg-muted px-3 py-2">
        <input
          type="checkbox" checked={removeRecords} onChange={(e) => setRemoveRecords(e.target.checked)}
          className="size-3.5 accent-[var(--primary)]"
        />
        <span className="text-xs">同时清理 Cloudflare 上的托管 A 记录</span>
      </label>
    </ConfirmOverlay>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <th className={`whitespace-nowrap px-4 py-2.5 text-[11px] font-medium text-muted-foreground ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</th>;
}
function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <td className={`px-4 py-3 align-middle ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</td>;
}
