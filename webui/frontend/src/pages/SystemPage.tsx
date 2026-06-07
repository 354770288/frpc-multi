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
  XCircle
} from 'lucide-react';
import { api, nodesApi } from '../lib/api';
import { bytesToHuman, shortNodeUuid } from '../lib/format';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Input } from '../components/ui/Input';
import { Panel } from '../components/ui/Panel';
import type { AuthMe, AuthState, ConsoleInfo, Node, SystemInfo, ToastKind } from '../lib/types';

type SystemTab = 'console' | 'nodes' | 'security';

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

export function SystemPage({
  auth,
  system,
  nodes,
  toast,
  onPasswordChanged
}: {
  auth: AuthState;
  system: ConsoleInfo | null;
  nodes: Node[];
  toast: (kind: ToastKind, text: string) => void;
  onPasswordChanged: (state: AuthState) => void;
}) {
  const [currentUsername, setCurrentUsername] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [tokenTtlSeconds, setTokenTtlSeconds] = useState<number | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [tab, setTab] = useState<SystemTab>('console');
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
      toast('error', '请完整填写当前账号、当前密码和新密码');
      return;
    }
    if (newPassword.length < 8) {
      toast('error', '新密码至少 8 位');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast('error', '两次输入的新密码不一致');
      return;
    }
    setSubmitting(true);
    try {
      const data = await api<{ token: string; username: string; expiresAt: number }>(
        '/api/auth/change-password',
        {
          method: 'POST',
          body: JSON.stringify({
            currentUsername,
            currentPassword,
            newUsername: newUsername || currentUsername,
            newPassword
          })
        }
      );
      onPasswordChanged({
        token: data.token,
        username: data.username,
        expiresAt: data.expiresAt
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast('success', '账号密码已更新，登录态已刷新');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '修改失败');
    } finally {
      setSubmitting(false);
    }
  }

  const tokenTtlText =
    tokenTtlSeconds && tokenTtlSeconds > 0 ? formatDuration(tokenTtlSeconds) : undefined;
  const remainingSeconds = auth.expiresAt - now;
  const sessionExpiresText =
    auth.expiresAt > 0
      ? `${formatTimestamp(auth.expiresAt)}（剩余 ${formatDuration(remainingSeconds)}）`
      : undefined;
  const onlineCount = nodes.filter((node) => node.online || node.status === 'online').length;
  const offlineCount = nodes.length - onlineCount;

  return (
    <main className="px-6 py-6 max-w-[1600px]">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className="text-[18px] font-semibold tracking-tight text-[var(--color-fg)]">
          系统设置
        </h2>
        <Badge tone="muted">{system?.role || 'console'}</Badge>
        <Badge tone={offlineCount > 0 ? 'warning' : 'success'}>
          {onlineCount} / {nodes.length} 节点在线
        </Badge>
        {tab === 'nodes' && (
          <Button
            className="ml-auto"
            onClick={() => setNodeSystemRefreshKey((value) => value + 1)}
          >
            <RefreshCw size={13} />
            刷新节点系统
          </Button>
        )}
      </div>

      <div className="mb-4 flex gap-1.5 overflow-x-auto border-b border-[var(--color-border)]">
        <TabButton active={tab === 'console'} onClick={() => setTab('console')} icon={<MonitorCog size={13} />}>
          Console 信息
        </TabButton>
        <TabButton active={tab === 'nodes'} onClick={() => setTab('nodes')} icon={<Server size={13} />}>
          节点系统
        </TabButton>
        <TabButton active={tab === 'security'} onClick={() => setTab('security')} icon={<Key size={13} />}>
          账号安全
        </TabButton>
      </div>

      {tab === 'console' && (
        <Panel title="Console 信息">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-[12px]">
            <InfoItem label="面板版本" value={system?.version} mono />
            <InfoItem label="角色" value={system?.role} mono />
            <InfoItem label="节点数" value={system?.nodeCount} />
            <InfoItem label="项目目录" value={system?.projectDir} mono />
            <InfoItem
              label="面板地址"
              value={system ? `${system.webuiHost}:${system.webuiPort}` : undefined}
              mono
            />
            <InfoItem label="当前登录" value={system?.username} />
            <InfoItem label="登录有效期" value={tokenTtlText} />
            <InfoItem label="本次会话到期" value={sessionExpiresText} />
          </dl>
        </Panel>
      )}

      {tab === 'nodes' && (
        <section className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Metric label="节点总数" value={nodes.length} />
            <Metric label="在线节点" value={onlineCount} tone="success" />
            <Metric label="离线/待连接" value={offlineCount} tone={offlineCount ? 'warning' : 'muted'} />
          </div>
          {nodes.length > 0 ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {nodes.map((node) => (
                <NodeSystemCard key={node.id} node={node} refreshKey={nodeSystemRefreshKey} />
              ))}
            </div>
          ) : (
            <Panel title="节点系统">
              <div className="flex items-start gap-2 rounded-md border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-muted)] p-4 text-[12px] text-[var(--color-fg-muted)]">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>还没有节点。添加 Agent 节点后，这里会展示每个节点的 Docker、frpc、磁盘和项目目录信息。</span>
              </div>
            </Panel>
          )}
        </section>
      )}

      {tab === 'security' && (
        <section className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px] gap-4">
          <Panel title="登录态">
            <dl className="grid grid-cols-1 gap-y-4 text-[12px]">
              <InfoItem label="当前登录" value={auth.username || system?.username} />
              <InfoItem label="登录有效期" value={tokenTtlText} />
              <InfoItem label="本次会话到期" value={sessionExpiresText} />
            </dl>
          </Panel>
          <Panel
            title={
              <span className="inline-flex items-center gap-1.5">
                <Key size={13} />
                修改管理员账号密码
              </span>
            }
          >
            <form onSubmit={submit} className="flex flex-col gap-3">
              <Field label="当前用户名">
                <Input
                  value={currentUsername}
                  onChange={(event) => setCurrentUsername(event.target.value)}
                  autoComplete="username"
                />
              </Field>
              <Field label="当前密码">
                <Input
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  autoComplete="current-password"
                />
              </Field>
              <Field label="新用户名" hint="留空将沿用当前用户名">
                <Input
                  value={newUsername}
                  onChange={(event) => setNewUsername(event.target.value)}
                  autoComplete="username"
                />
              </Field>
              <Field label="新密码" hint="至少 8 位">
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="确认新密码">
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </Field>
              <Button variant="primary" type="submit" disabled={submitting} className="mt-1">
                <ShieldCheck size={13} />
                {submitting ? '提交中…' : '保存修改'}
              </Button>
              <p className="text-[11px] text-[var(--color-fg-muted)] leading-relaxed">
                新凭据保存到{' '}
                <code className="font-mono text-[10px] text-[var(--color-fg)]">
                  .webui/credentials.json
                </code>{' '}
                （PBKDF2-SHA256 哈希），优先级高于 .env 中的默认账号。
              </p>
            </form>
          </Panel>
        </section>
      )}
    </main>
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
    nodesApi
      .system(node.id)
      .then((data) => {
        if (!cancelled) setInfo(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '节点不可达');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [node.id, refreshKey]);

  const diskRatio = info && info.disk.total > 0 ? (info.disk.used / info.disk.total) * 100 : 0;

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          {node.name}
          <span className="font-mono text-[11px] font-normal text-[var(--color-fg-muted)]">
            {shortNodeUuid(node.uuid)}
          </span>
          {online ? (
            <Badge tone="success">
              <CheckCircle2 size={12} />
              在线
            </Badge>
          ) : (
            <Badge tone="danger">
              <WifiOff size={12} />
              离线
            </Badge>
          )}
        </span>
      }
    >
      {loading ? (
        <p className="text-[12px] text-[var(--color-fg-muted)]">加载中...</p>
      ) : error ? (
        <div className="flex items-start gap-2 rounded-md border border-[var(--color-danger)]/25 bg-[var(--color-danger-soft)] p-3 text-[12px] leading-5 text-[var(--color-danger)]">
          <XCircle size={14} className="mt-0.5 shrink-0" />
          <span>节点系统信息不可达：{error}</span>
        </div>
      ) : info ? (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-[12px]">
            <InfoItem label="Docker 版本" value={info.dockerVersion || '未连接'} mono />
            <InfoItem label="frpc 镜像" value={info.frpImage} mono />
            <InfoItem label="frpc 版本" value={info.frpVersion} mono />
            <InfoItem label="项目目录" value={info.projectDir} mono />
          </dl>
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
            <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-[var(--color-fg)]">
              <HardDrive size={13} />
              磁盘占用
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white">
              <div
                className={`h-full rounded-full ${
                  diskRatio >= 90
                    ? 'bg-[var(--color-danger)]'
                    : diskRatio >= 75
                      ? 'bg-[var(--color-warning)]'
                      : 'bg-[var(--color-success)]'
                }`}
                style={{ width: `${Math.min(100, diskRatio).toFixed(1)}%` }}
              />
            </div>
            <div className="mt-2 text-[11px] text-[var(--color-fg-muted)]">
              {info.disk && info.disk.total > 0
                ? `${diskRatio.toFixed(1)}% (${bytesToHuman(info.disk.used)} / ${bytesToHuman(info.disk.total)})`
                : '磁盘信息不可用'}
            </div>
          </div>
        </div>
      ) : (
        <p className="text-[12px] text-[var(--color-fg-muted)]">-</p>
      )}
    </Panel>
  );
}

function Metric({
  label,
  value,
  tone = 'muted'
}: {
  label: string;
  value: number;
  tone?: 'success' | 'warning' | 'muted';
}) {
  const toneClass =
    tone === 'success'
      ? 'text-[var(--color-success)]'
      : tone === 'warning'
        ? 'text-[var(--color-warning)]'
        : 'text-[var(--color-fg)]';
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="text-[11px] text-[var(--color-fg-muted)]">{label}</div>
      <div className={`mt-1 font-mono text-[22px] font-semibold tabular-nums ${toneClass}`}>
        {value}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-3 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
        active
          ? 'border-[var(--color-accent)] text-[var(--color-fg)]'
          : 'border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function InfoItem({
  label,
  value,
  mono = false
}: {
  label: string;
  value?: string | number | null;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[var(--color-fg-muted)] mb-1">{label}</dt>
      <dd
        className={`text-[var(--color-fg)] font-medium break-all ${mono ? 'font-mono text-[12px]' : ''}`}
      >
        {value ?? '—'}
      </dd>
    </div>
  );
}
