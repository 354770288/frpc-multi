import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ChevronDown, Cloud, Globe, ListChecks, Pencil, Plus, RefreshCw, RefreshCcw, Trash2, Users,
} from 'lucide-react';
import { toast } from 'sonner';
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
  const [inspecting, setInspecting] = useState<LbDomain | null>(null);
  const [deleting, setDeleting] = useState<LbDomain | null>(null);
  const [managingCandidates, setManagingCandidates] = useState<LbDomain | null>(null);
  const [syncing, setSyncing] = useState<Record<number, boolean>>({});

  const load = useCallback(async () => {
    try {
      const [list, info, healthSnapshot,selection,testNodes] = await Promise.all([
        lbApi.domains(), lbApi.cloudflare(), lbApi.health(),lbApi.selectionConfig(),probeApi.testNodes().catch(()=>({items:[]})),
      ]);
      setDomains(list);
      setTokenConfigured(info.configured);
      setHealth(healthSnapshot);
      setSelectionConfig(selection);
      const policy = await probeApi.executionPolicy();
      setPrimaryNodeName(testNodes.items.find((node)=>node.id===policy.primaryNodeId)?.name || policy.primaryNodeId || '未配置');
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '域名数据加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(()=>{if(!domainId || !domains.length)return;setInspecting(domains.find((item)=>item.id===Number(domainId)) || null);},[domainId,domains]);

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
    <div className="mx-auto max-w-[1600px] px-6 py-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">域名选优</h2>
        <Badge tone="muted">Cloudflare DDNS · 单 A 主备</Badge>
        <Button asChild variant="outline" size="sm"><Link to="/lb/settings">域名设置</Link></Button>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            <RefreshCw size={13} />刷新
          </Button>
        </div>
      </div>
      {loadError && <p role="alert" className="mb-4 rounded-md border border-destructive/30 p-3 text-sm text-destructive">{loadError}；当前信息可能不是最新。请重试。</p>}
      <p className="mb-4 text-sm text-muted-foreground">测量执行策略主用节点：{primaryNodeName || '加载中'} · 结果读取统一测量投影 · 有效期 {selectionConfig?.maxAgeHours ?? '—'} 小时 · 实时健康检查：主控</p>

      <div>
        <Card>
          <CardHeader className="flex-row flex-wrap items-center gap-2">
            <CardTitle className="text-sm">候选域名</CardTitle>
            <Badge tone="muted">{domains.length} 个</Badge>
            <Button size="sm" className="ml-auto" onClick={() => setEditing('new')} disabled={!tokenConfigured}
              title={tokenConfigured ? undefined : '请先配置 Cloudflare API Token'}>
              <Plus size={13} />新增域名
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px]">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <Th>域名</Th><Th>候选服务器</Th><Th>当前指向 / 选优</Th><Th>主控健康</Th><Th>最近同步</Th><Th align="right">操作</Th>
                  </tr>
                </thead>
                <tbody>
                  {domains.map((domain) => {
                    const domainHealth = health?.domains.find((item) => item.domainId === domain.id) ?? null;
                    const poolStates = domainHealth
                      ? domainHealth.poolIps.map((ip) => health?.states.find((s) => s.ip === ip) ?? null)
                      : [];
                    const healthyCount = poolStates.filter((s) => s?.ok === true).length;
                    const unknownCount = domainHealth ? poolStates.filter((s) => s?.ok == null).length : domain.poolSize;
                    const pendingSwitch = domainHealth?.bestIp && domainHealth.bestIp !== domain.currentIp;
                    return (
                    <tr key={domain.id} className="border-b last:border-b-0 hover:bg-muted/50 transition-colors">
                      <Td>
                        <div className="flex items-center gap-1.5">
                          <Globe size={12} className="shrink-0 text-muted-foreground" />
                          <span className="font-mono text-[12px] font-medium">{domain.name}</span>
                          {!domain.enabled && <Badge tone="muted">已停用</Badge>}
                        </div>
                      </Td>
                      <Td>
                        <div className="flex items-center gap-1.5">
                          <Badge tone={domain.poolSize ? 'muted' : 'warning'}>{domain.poolSize} 台</Badge>
                          {!domain.poolSize && <span className="text-[11px] text-muted-foreground">待添加</span>}
                        </div>
                      </Td>
                      <Td>
                        {domain.currentIp ? (
                          <div className="flex items-center gap-1.5" title={pendingSwitch ? `健康监测建议切换到 ${domainHealth?.bestIp}` : undefined}>
                            <span className="font-mono text-[12px]">{domain.currentIp}</span>
                            {pendingSwitch
                              ? <Badge tone="warning">建议 → {domainHealth?.bestIp}</Badge>
                              : <Badge tone={poolStates.some((state) => state?.ip === domain.currentIp && state.ok === false) ? 'danger' : 'muted'} dot>{poolStates.some((state) => state?.ip === domain.currentIp && state.ok === false) ? '健康检查失败' : poolStates.some((state)=>state?.ip===domain.currentIp && state.ok===true) ? '健康' : '待检查'}</Badge>}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">未同步</span>
                        )}
                        {domainHealth?.selection && <div className="mt-2"><SelectionReason selection={domainHealth.selection} /></div>}
                      </Td>
                      <Td>
                        <span className="font-mono text-sm tabular-nums" title={poolStates.map((s) => s ? `${s.ip} ${s.ok === false ? '失败' : s.ok === true ? '健康' : '待检查'}` : '').filter(Boolean).join('\n')}>
                          {healthyCount}/{domain.poolSize} 已确认健康{unknownCount ? ` · ${unknownCount} 待检查` : ''}
                        </span>
                      </Td>
                      <Td>
                        {domain.lastSyncAt ? (
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <Badge tone={domain.lastSyncOk ? 'success' : 'danger'}>
                                {domain.lastSyncOk ? '成功' : '失败'}
                              </Badge>
                              <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                                {formatLastSeen(domain.lastSyncAt)}
                              </span>
                            </div>
                            <div className="mt-0.5 max-w-64 truncate text-[11px] text-muted-foreground" title={domain.lastSyncMessage}>
                              {domain.lastSyncMessage}
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">未同步</span>
                        )}
                      </Td>
                      <Td align="right">
                        <div className="flex items-center justify-end gap-1">
                          <Button size="sm" variant="outline" onClick={() => syncNow(domain)} disabled={!!syncing[domain.id]}>
                            <RefreshCcw size={13} />{syncing[domain.id] ? '同步中…' : '立即同步'}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setManagingCandidates(domain)}>
                            <Users size={13} />候选服务器
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => {setInspecting(domain);navigate(`/lb/${domain.id}`);}}>
                            <ListChecks size={13} />记录
                          </Button>
                          <Button size="icon-sm" variant="secondary" onClick={() => setEditing(domain)} aria-label="编辑"><Pencil size={13} /></Button>
                          <Button size="icon-sm" variant="destructive" onClick={() => setDeleting(domain)} aria-label="删除"><Trash2 size={13} /></Button>
                        </div>
                      </Td>
                    </tr>
                    );
                  })}
                  {!domains.length && (
                    <tr><td colSpan={6} className="px-0 py-0">
                      {loading ? (
                        <div className="px-4 py-10 text-center text-xs text-muted-foreground">加载中…</div>
                      ) : !tokenConfigured ? (
                        <Empty className="py-10">
                          <EmptyHeader>
                            <EmptyMedia variant="icon"><Cloud /></EmptyMedia>
                            <EmptyTitle>先配置 Cloudflare</EmptyTitle>
                            <EmptyDescription>在“域名设置”中配置 Cloudflare API Token 后即可添加候选域名。</EmptyDescription>
                          </EmptyHeader>
                        </Empty>
                      ) : (
                        <Empty className="py-10">
                          <EmptyHeader>
                            <EmptyMedia variant="icon"><Globe /></EmptyMedia>
                            <EmptyTitle>还没有候选域名</EmptyTitle>
                            <EmptyDescription>为每个域名手动指定候选服务器；主控根据健康状态自动切换，健康时优先使用手动固定的服务器。</EmptyDescription>
                          </EmptyHeader>
                          <EmptyContent>
                            <div className="flex flex-col gap-2 text-left text-xs leading-5 text-muted-foreground">
                              <div>
                                <span className="mr-1 font-medium text-foreground">① 建域名</span>
                                点右上方「新增域名」，选择 Zone 并创建域名
                              </div>
                              <div>
                                <span className="mr-1 font-medium text-foreground">② 选候选</span>
                                打开域名的「候选服务器」，从服务器库逐页搜索并勾选
                              </div>
                              <div>
                                <span className="mr-1 font-medium text-foreground">③ 使用</span>
                                创建实例时选择该域名，serverAddr 自动填域名
                                <Link to="/instances/new" className="ml-1 text-primary underline underline-offset-2">去创建实例 →</Link>
                              </div>
                            </div>
                          </EmptyContent>
                        </Empty>
                      )}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

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
        <RecordsDialog domain={inspecting} onClose={() => {setInspecting(null);navigate('/lb');}} />
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
function RecordsDialog({ domain, onClose }: { domain: LbDomain; onClose: () => void }) {
  const [records, setRecords] = useState<LbDnsRecord[] | null>(null);
  const [logs, setLogs] = useState<LbSyncLog[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    lbApi.domainRecords(domain.id).then(setRecords).catch((err) => setError(err instanceof Error ? err.message : '加载失败'));
    lbApi.domainLogs(domain.id).then(setLogs).catch(() => {});
  }, [domain.id]);

  return (
    <Overlay title={`${domain.name} · DNS 记录与同步日志`} onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="text-[11px] font-medium text-muted-foreground">当前 A 记录（Cloudflare）</div>
          {records === null && !error && <div className="text-xs text-muted-foreground">加载中…</div>}
          {error && <div className="text-xs text-destructive">{error}</div>}
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
          {logs.length ? (
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
