import React, { useState } from 'react';
import { Boxes, ShieldCheck } from 'lucide-react';
import type { AuthState } from '../lib/types';
import { extractMessage } from '../lib/api';

export function Login({ onSuccess }: { onSuccess: (state: AuthState) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (!username || !password) {
      setError('请输入用户名和密码');
      return;
    }
    setLoading(true);
    try {
      const result = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      if (!result.ok) {
        const text = await result.text();
        throw new Error(extractMessage(text, '登录失败'));
      }
      const data = (await result.json()) as { token: string; username: string; expiresAt: number };
      onSuccess({ token: data.token, username: data.username, expiresAt: data.expiresAt });
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <Boxes size={32} />
          <div>
            <strong>frpc 多实例管理</strong>
            <span>WebUI 控制台登录</span>
          </div>
        </div>
        <label>用户名</label>
        <input
          autoFocus
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="admin"
        />
        <label>密码</label>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="请输入密码"
        />
        {error && <p className="login-error">{error}</p>}
        <button className="primary" type="submit" disabled={loading}>
          <ShieldCheck size={16} />
          {loading ? '登录中...' : '登录'}
        </button>
        <p className="login-hint">
          默认凭证由 .env 中的 WEBUI_USERNAME / WEBUI_PASSWORD 控制；首次修改后会持久化到 .webui/credentials.json。
        </p>
      </form>
    </div>
  );
}
