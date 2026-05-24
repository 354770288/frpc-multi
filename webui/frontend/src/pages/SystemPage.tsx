import React, { useEffect, useState } from 'react';
import { Key, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { bytesToHuman } from '../lib/format';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Input } from '../components/ui/Input';
import { Panel } from '../components/ui/Panel';
import type { AuthMe, AuthState, SystemInfo, ToastKind } from '../lib/types';

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
  toast,
  onPasswordChanged
}: {
  auth: AuthState;
  system: SystemInfo | null;
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

  const diskRatio =
    system && system.disk.total > 0 ? (system.disk.used / system.disk.total) * 100 : 0;

  const tokenTtlText =
    tokenTtlSeconds && tokenTtlSeconds > 0 ? formatDuration(tokenTtlSeconds) : undefined;
  const remainingSeconds = auth.expiresAt - now;
  const sessionExpiresText =
    auth.expiresAt > 0
      ? `${formatTimestamp(auth.expiresAt)}（剩余 ${formatDuration(remainingSeconds)}）`
      : undefined;

  return (
    <main className="px-6 py-6 max-w-[1600px]">
      <h2 className="mb-6 text-[18px] font-semibold tracking-tight text-[var(--color-fg)]">
        系统设置
      </h2>

      <section className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-4">
        <Panel title="系统信息">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-[12px]">
            <InfoItem label="面板版本" value={system?.version} mono />
            <InfoItem label="frpc 镜像" value={system?.frpImage} mono />
            <InfoItem label="frpc 版本" value={system?.frpVersion} mono />
            <InfoItem label="Docker 版本" value={system?.dockerVersion || '未连接'} mono />
            <InfoItem label="项目目录" value={system?.projectDir} mono />
            <InfoItem
              label="面板地址"
              value={system ? `${system.webuiHost}:${system.webuiPort}` : undefined}
              mono
            />
            <InfoItem label="当前登录" value={system?.username} />
            <InfoItem label="登录有效期" value={tokenTtlText} />
            <InfoItem label="本次会话到期" value={sessionExpiresText} />
            <InfoItem
              label="磁盘占用"
              value={
                system
                  ? `${diskRatio.toFixed(1)}%（${bytesToHuman(system.disk.used)} / ${bytesToHuman(system.disk.total)}）`
                  : undefined
              }
            />
          </dl>
        </Panel>

        <aside>
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
        </aside>
      </section>
    </main>
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
