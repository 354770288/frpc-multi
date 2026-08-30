import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  HardDrive,
  Key,
  MonitorCog,
  RefreshCw,
  Server,
  ShieldCheck,
  WifiOff,
  XCircle,
} from 'lucide-react';
import { api, nodesApi } from '../lib/api';
import { bytesToHuman, shortNodeUuid } from '../lib/format';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Meter } from '../components/ui/meter';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { useConsole } from '../context/ConsoleContext';
import { toast as sonner } from 'sonner';
import type { AuthMe, AuthState, Node, SystemInfo } from '../lib/types';

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '已过期';
  if (seconds >= 86400) {
    const days = seconds / 86400;
    return `${days >= 10 ? days.toFixed(0) : days.toFixed(1)} 天`;
  }
  if (seconds >= 3600) {
    const hours = seconds / 3600;
    return `${hours >= 10 ? hours.toFixed(0) : hours.toFixed(1)} 小时`;
  }
  if (seconds >= 60) return `${Math.round(seconds / 60)} 分钟`;
  return `${Math.round(seconds)} 秒`;
}

function formatTimestamp(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function SystemPage() {
  const { auth, system, nodes, onAuthRefresh } = useConsole();
  const [tab, setTab] = useState('console');
  const [currentUsername, setCurrentUsername] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [tokenTtlSeconds, setTokenTtlSeconds] = useState<number | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [nodeSystemRefreshKey, setNodeSystemRefreshKey] = useState(0);

  useEffect(() => {
    if (system?.username) {
      setCurrentUsername((prev) => prev || system.username || '');
      setNewUsername((prev) => prev || system.username || '');
    }
  }, [system?.username]);

  useEffect(() => {
    api<AuthMe>('/api/auth/me')
      .then((data) => setTokenTtlSeconds(data.tokenTtlSeconds))
      .catch(() => setTokenTtlSeconds(null));
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!currentUsername || !currentPassword || !newPassword) {
      sonner.error('请完整填写当前账号、当前密码和新密码');
      return;
    }
    if (newPassword.length < 8) {
      sonner.error('新密码至少 8 位');
      return;
    }
    if (newPassword !== confirmPassword) {
      sonner.error('两次输入的新密码不一致');
      return;
    }
    setSubmitting(true);
    try {
      const data = await api<{ token: string; username: string; expiresAt: number }>(
        '/api/auth/change-password',
        {
          method: 'POST',
          body: JSON.stringify({ currentUsername, currentPassword, newUsername: newUsername || currentUsername, newPassword }),
        }
      );
      onAuthRefresh({ token: data.token, username: data.username, expiresAt: data.expiresAt });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      sonner.success('账号密码已更新，登录态已刷新');
    } catch (err) {
      sonner.error(err instanceof Error ? err.message : '修改失败');
    } finally {
      setSubmitting(false);
    }
  }

  const tokenTtlText = tokenTtlSeconds && tokenTtlSeconds > 0 ? formatDuration(tokenTtlSeconds) : undefined;
  const remainingSeconds = auth.expiresAt - now;
  const sessionExpiresText =
    auth.expiresAt > 0 ? `${formatTimestamp(auth.expiresAt)}（剩余 ${formatDuration(remainingSeconds)}）` : undefined;
  const onlineCount = nodes.filter((node) => node.online || node.status === 'online').length;
  const offlineCount = nodes.length - onlineCount;

  return (
    <div className="mx-auto max-w-[1600px] px-6 py-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">系统设置</h2>
        <Badge tone="muted">{system?.role || 'console'}</Badge>
        <Badge tone={offlineCount > 0 ? 'warning' : 'success'}>
          {onlineCount} / {nodes.length} 节点在线
        </Badge>
        {tab === 'nodes' && (
          <Button className="ml-auto" size="sm" variant="outline" onClick={() => setNodeSystemRefreshKey((v) => v + 1)}>
            <RefreshCw size={13} />刷新节点系统
          </Button>
        )}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="console"><MonitorCog size={13} className="mr-1" />Console 信息</TabsTrigger>
          <TabsTrigger value="nodes"><Server size={13} className="mr-1" />节点系统</TabsTrigger>
          <TabsTrigger value="security"><Key size={13} className="mr-1" />账号安全</TabsTrigger>
        </TabsList>

        <TabsContent value="console" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Console 信息</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-4 text-xs sm:grid-cols-2">
                <InfoItem label="面板版本" value={system?.version} mono />
                <InfoItem label="角色" value={system?.role} mono />
                <InfoItem label="节点数" value={system?.nodeCount} />
                <InfoItem label="项目目录" value={system?.projectDir} mono />
                <InfoItem label="面板地址" value={system ? `${system.webuiHost}:${system.webuiPort}` : undefined} mono />
                <InfoItem label="当前登录" value={system?.username} />
                <InfoItem label="登录有效期" value={tokenTtlText} />
                <InfoItem label="本次会话到期" value={sessionExpiresText} />
              </dl>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="nodes" className="mt-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <MetricCard label="节点总数" value={nodes.length} />
            <MetricCard label="在线节点" value={onlineCount} tone="success" />
            <MetricCard label="离线/待连接" value={offlineCount} tone={offlineCount ? 'warning' : 'muted'} />
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {nodes.length > 0 ? (
              nodes.map((node) => <NodeSystemCard key={node.id} node={node} refreshKey={nodeSystemRefreshKey} />)
            ) : (
              <Card className="lg:col-span-2">
                <CardContent className="py-8">
                  <div className="flex items-start gap-2 rounded-md border border-dashed p-4 text-xs text-muted-foreground">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    <span>还没有节点。添加 Agent 节点后，这里会展示每个节点的 Docker、frpc、磁盘和项目目录信息。</span>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        <TabsContent value="security" className="mt-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">登录态</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-1 gap-y-4 text-xs">
                  <InfoItem label="当前登录" value={auth.username || system?.username} />
                  <InfoItem label="登录有效期" value={tokenTtlText} />
                  <InfoItem label="本次会话到期" value={sessionExpiresText} />
                </dl>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="inline-flex items-center gap-1.5 text-sm">
                  <Key size={13} />修改管理员账号密码
                </CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={submit} className="flex flex-col gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">当前用户名</Label>
                    <Input value={currentUsername} onChange={(e) => setCurrentUsername(e.target.value)} autoComplete="username" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">当前密码</Label>
                    <Input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">新用户名</Label>
                    <Input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} autoComplete="username" />
                    <p className="text-[11px] text-muted-foreground">留空将沿用当前用户名</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">新密码</Label>
                    <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
                    <p className="text-[11px] text-muted-foreground">至少 8 位</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">确认新密码</Label>
                    <Input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" />
                  </div>
                  <Button type="submit" disabled={submitting} className="mt-1">
                    <ShieldCheck size={13} />
                    {submitting ? '提交中…' : '保存修改'}
                  </Button>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    新凭据保存到 <code className="font-mono text-[10px]">.webui/credentials.json</code>（PBKDF2-SHA256 哈希），优先级高于 .env 中的默认账号。
                  </p>
                </form>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function NodeSystemCard({ node, refreshKey }: { node: Node; refreshKey: number }) {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const online = node.online || node.status === 'online';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    nodesApi.system(node.id)
      .then((data) => { if (!cancelled) setInfo(data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : '节点不可达'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [node.id, refreshKey]);

  const diskRatio = info && info.disk.total > 0 ? (info.disk.used / info.disk.total) * 100 : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2 text-sm font-normal">
          {node.name}
          <span className="font-mono text-[11px] text-muted-foreground">{shortNodeUuid(node.uuid)}</span>
          {online ? (
            <Badge tone="success"><CheckCircle2 size={12} />在线</Badge>
          ) : (
            <Badge tone="danger"><WifiOff size={12} />离线</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading && !info && !error ? (
          <p className="text-xs text-muted-foreground">加载中…</p>
        ) : error ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/10 p-3 text-xs leading-5 text-destructive">
            <XCircle size={14} className="mt-0.5 shrink-0" />
            <span>节点系统信息不可达：{error}</span>
          </div>
        ) : info ? (
          // refetch 期间保留旧渲染，仅降不透明度（dataviz：no skeleton flash on refetch）
          <div className={`space-y-4 ${loading ? 'opacity-60' : ''}`}>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-4 text-xs sm:grid-cols-2">
              <InfoItem label="Agent 版本" value={info.agentVersion || '未知'} mono />
              <InfoItem label="frpc 镜像" value={info.frpImage} mono />
              <InfoItem label="frpc 版本" value={info.frpVersion} mono />
              <InfoItem label="项目目录" value={info.projectDir} mono />
            </dl>
            <div className="rounded-md border bg-muted p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium">
                <HardDrive size={13} />磁盘占用
              </div>
              <Meter
                value={info.disk && info.disk.total > 0 ? diskRatio : null}
                className="h-2"
                aria-label="磁盘占用"
              />
              <div className="mt-2 text-[11px] text-muted-foreground">
                {info.disk && info.disk.total > 0
                  ? `${diskRatio.toFixed(1)}% (${bytesToHuman(info.disk.used)} / ${bytesToHuman(info.disk.total)})`
                  : '磁盘信息不可用'}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">-</p>
        )}
      </CardContent>
    </Card>
  );
}

function MetricCard({ label, value, tone = 'muted' as const }: { label: string; value: number; tone?: 'success' | 'warning' | 'muted' }) {
  // dataviz：数值文字用 text token，状态色由旁边的圆点标记承载
  const dotClass = tone === 'success' ? 'bg-primary' : tone === 'warning' ? 'bg-warning' : 'bg-muted-foreground/50';
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
          {label}
        </div>
        <div className="mt-1 font-mono text-[22px] font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

function InfoItem({ label, value, mono = false }: { label: string; value?: string | number | null; mono?: boolean }) {
  return (
    <div>
      <dt className="mb-1 text-muted-foreground">{label}</dt>
      <dd className={`font-medium break-all ${mono ? 'font-mono text-xs' : ''}`}>{value ?? '—'}</dd>
    </div>
  );
}
