import { useCallback, useEffect, useState } from 'react';
import {
  Cloud, Globe, ListChecks, Pencil, Plus, RefreshCw, RefreshCcw, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { lbApi, probeApi } from '../lib/api';
import { formatLastSeen } from '../lib/format';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Switch } from '../components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from '../components/ui/select';
import { ConfirmOverlay, Overlay } from '../components/Overlay';
import type { CloudflareZone, LbDomain, LbDnsRecord, LbSyncLog } from '../lib/types';

export function LbPage() {
  const [domains, setDomains] = useState<LbDomain[]>([]);
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [tokenMasked, setTokenMasked] = useState('');
  const [zones, setZones] = useState<CloudflareZone[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const [editing, setEditing] = useState<LbDomain | 'new' | null>(null);
  const [inspecting, setInspecting] = useState<LbDomain | null>(null);
  const [deleting, setDeleting] = useState<LbDomain | null>(null);
  const [syncing, setSyncing] = useState<Record<number, boolean>>({});

  const load = useCallback(async () => {
    try {
      const [list, info, groupList] = await Promise.all([
        lbApi.domains(), lbApi.cloudflare(), probeApi.groups(),
      ]);
      setDomains(list);
      setTokenConfigured(info.configured);
      setTokenMasked(info.tokenMasked);
      setGroups(groupList);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '负载均衡数据加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
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
    <div className="mx-auto max-w-[1600px] px-6 py-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">负载均衡</h2>
        <Badge tone="muted">Cloudflare DDNS 域名池</Badge>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            <RefreshCw size={13} />刷新
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="flex flex-col gap-4">
          <CloudflareCard
            configured={tokenConfigured}
            masked={tokenMasked}
            zones={zones}
            onZones={setZones}
            onSaved={load}
          />
          <Card>
            <CardHeader><CardTitle className="text-sm">工作原理</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-2 text-[11px] leading-5 text-muted-foreground">
              <p>候选域名绑定服务器库的一个分组；同步把分组内服务器 IP 写成 Cloudflare 多条灰云 A 记录。</p>
              <p>frpc 的 serverAddr 填该域名，连接/重连时 DNS 轮询到不同 frps —— 负载均衡 + 故障切换。</p>
              <p>建议流程：穿透测试 → 通过的服务器批量改入健康分组 → 此处绑定该分组并同步。</p>
              <p>只增删带「frpc-multi-lb」托管标记的记录，手动添加的 DNS 记录不受影响。</p>
            </CardContent>
          </Card>
        </aside>

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
              <table className="w-full min-w-[880px]">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <Th>域名</Th><Th>Zone</Th><Th>绑定分组</Th><Th>池</Th><Th>模式</Th><Th>最近同步</Th><Th align="right">操作</Th>
                  </tr>
                </thead>
                <tbody>
                  {domains.map((domain) => (
                    <tr key={domain.id} className="border-b last:border-b-0 hover:bg-muted/50 transition-colors">
                      <Td>
                        <div className="flex items-center gap-1.5">
                          <Globe size={12} className="shrink-0 text-muted-foreground" />
                          <span className="font-mono text-[12px] font-medium">{domain.name}</span>
                          {!domain.enabled && <Badge tone="muted">已停用</Badge>}
                        </div>
                      </Td>
                      <Td><span className="text-xs text-muted-foreground">{domain.zoneName}</span></Td>
                      <Td><Badge tone="muted">{domain.group}</Badge></Td>
                      <Td><span className="font-mono text-xs tabular-nums">{domain.poolSize} 台</span></Td>
                      <Td>
                        <span className="text-xs">
                          {domain.syncMode === 'scheduled'
                            ? `定时 ${Math.round(domain.intervalSeconds / 60)} 分钟`
                            : '手动'}
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
                          <Button size="sm" variant="outline" onClick={() => setInspecting(domain)}>
                            <ListChecks size={13} />记录
                          </Button>
                          <Button size="icon-sm" variant="secondary" onClick={() => setEditing(domain)} aria-label="编辑"><Pencil size={13} /></Button>
                          <Button size="icon-sm" variant="destructive" onClick={() => setDeleting(domain)} aria-label="删除"><Trash2 size={13} /></Button>
                        </div>
                      </Td>
                    </tr>
                  ))}
                  {!domains.length && (
                    <tr><td colSpan={7} className="px-4 py-10 text-center text-xs text-muted-foreground">
                      {loading ? '加载中…' : tokenConfigured ? '暂无候选域名，点「新增域名」创建' : '请先在左侧配置 Cloudflare API Token'}
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
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
          onNeedZones={async () => {
            const result = await lbApi.verifyCloudflare();
            setZones(result.zones);
            return result.zones;
          }}
        />
      )}
      {inspecting && (
        <RecordsDialog domain={inspecting} onClose={() => setInspecting(null)} />
      )}
      {deleting && (
        <DeleteDomainDialog domain={deleting} onCancel={() => setDeleting(null)}
          onDone={() => { setDeleting(null); load(); }} />
      )}
    </div>
  );
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
    <Card>
      <CardHeader className="flex-row items-center gap-2">
        <CardTitle className="text-sm">Cloudflare</CardTitle>
        {configured
          ? <Badge tone="success"><Cloud size={11} />已配置 {masked}</Badge>
          : <Badge tone="warning">未配置</Badge>}
      </CardHeader>
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
    </Card>
  );
}

/** 新增 / 编辑候选域名弹窗。 */
function DomainDialog({ domain, zones, groups, onClose, onSaved, onNeedZones }: {
  domain: LbDomain | null;
  zones: CloudflareZone[];
  groups: string[];
  onClose: () => void;
  onSaved: () => void;
  onNeedZones: () => Promise<CloudflareZone[]>;
}) {
  const [zoneId, setZoneId] = useState(domain?.zoneId ?? '');
  const [name, setName] = useState(domain?.name ?? '');
  const [group, setGroup] = useState(domain?.group ?? '');
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
    if (!group) { toast.error('请选择绑定的服务器分组'); return; }
    if (!/^\d+$/.test(ttl) || Number(ttl) < 30 || Number(ttl) > 3600) { toast.error('TTL 需在 30-3600 秒'); return; }
    const intervalSeconds = Math.round(Number(interval) * 60);
    if (mode === 'scheduled' && (!/^\d+(\.5)?$/.test(interval) || intervalSeconds < 60 || intervalSeconds > 86400)) {
      toast.error('同步间隔需在 1 分钟 - 24 小时'); return;
    }
    setSaving(true);
    try {
      if (domain) {
        await lbApi.updateDomain(domain.id, {
          group, ttl: Number(ttl), syncMode: mode, intervalSeconds, enabled,
        });
        toast.success('候选域名已更新');
      } else {
        await lbApi.createDomain({
          name: name.trim(), zoneId, zoneName: selectedZone!.name, group,
          ttl: Number(ttl), syncMode: mode, intervalSeconds, enabled,
        });
        toast.success('候选域名已创建，点「立即同步」生成 A 记录');
      }
      onSaved();
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
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">绑定服务器分组（池 = 组内全部服务器）</Label>
          <Select value={group} onValueChange={setGroup}>
            <SelectTrigger><SelectValue placeholder="选择分组" /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {groups.length
                  ? groups.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)
                  : <div className="px-3 py-2 text-xs text-muted-foreground">还没有分组，去「服务器库 → 分组管理」创建</div>}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">A 记录 TTL（秒）</Label>
            <Input value={ttl} onChange={(e) => setTtl(e.target.value)} inputMode="numeric" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">同步模式</Label>
            <Select value={mode} onValueChange={(value) => setMode(value as 'manual' | 'scheduled')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="manual">手动</SelectItem>
                  <SelectItem value="scheduled">定时</SelectItem>
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
        <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2">
          <span className="text-xs">启用（停用后不参与定时同步）</span>
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
