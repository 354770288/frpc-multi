import React, { useEffect, useState } from 'react';
import { Key, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { bytesToHuman } from '../lib/format';
import type { AuthState, SystemInfo, ToastKind } from '../lib/types';

export function SystemPage({
  system,
  toast,
  onPasswordChanged
}: {
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

  useEffect(() => {
    if (system?.username) {
      setCurrentUsername((prev) => prev || system.username || '');
      setNewUsername((prev) => prev || system.username || '');
    }
  }, [system?.username]);

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
      onPasswordChanged({ token: data.token, username: data.username, expiresAt: data.expiresAt });
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

  const diskRatio = system && system.disk.total > 0 ? (system.disk.used / system.disk.total) * 100 : 0;

  return (
    <main className="content">
      <h2>系统设置</h2>
      <section className="editor-layout">
        <div className="panel">
          <h3>系统信息</h3>
          <div className="summary-table">
            <span>面板版本</span>
            <strong>{system?.version || '--'}</strong>
            <span>frpc 镜像</span>
            <strong>{system?.frpImage || '--'}</strong>
            <span>frpc 版本</span>
            <strong>{system?.frpVersion || '--'}</strong>
            <span>Docker 版本</span>
            <strong>{system?.dockerVersion || '未连接'}</strong>
            <span>项目目录</span>
            <strong>{system?.projectDir || '--'}</strong>
            <span>面板地址</span>
            <strong>{system ? `${system.webuiHost}:${system.webuiPort}` : '--'}</strong>
            <span>当前登录</span>
            <strong>{system?.username || '--'}</strong>
            <span>磁盘占用</span>
            <strong>
              {system
                ? `${diskRatio.toFixed(1)}%（${bytesToHuman(system.disk.used)} / ${bytesToHuman(system.disk.total)}）`
                : '--'}
            </strong>
          </div>
        </div>
        <aside className="side-stack">
          <form className="panel create-panel" onSubmit={submit}>
            <h3>
              <Key size={16} style={{ verticalAlign: '-2px', marginRight: 6 }} />
              修改管理员账号密码
            </h3>
            <label>当前用户名</label>
            <input
              value={currentUsername}
              onChange={(event) => setCurrentUsername(event.target.value)}
              autoComplete="username"
            />
            <label>当前密码</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
            />
            <label>新用户名（默认沿用当前用户名）</label>
            <input
              value={newUsername}
              onChange={(event) => setNewUsername(event.target.value)}
              autoComplete="username"
            />
            <label>新密码（至少 8 位）</label>
            <input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
            />
            <label>确认新密码</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
            />
            <button className="primary" type="submit" disabled={submitting}>
              <ShieldCheck size={16} />
              {submitting ? '提交中…' : '保存修改'}
            </button>
            <p className="muted" style={{ marginTop: 4, fontSize: 12 }}>
              新凭据保存到 .webui/credentials.json（PBKDF2-SHA256 哈希），优先级高于 .env 中的默认账号。
            </p>
          </form>
        </aside>
      </section>
    </main>
  );
}
