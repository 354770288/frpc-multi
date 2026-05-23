import React, { useState } from 'react';
import { Boxes, ShieldCheck, AlertCircle } from 'lucide-react';
import type { AuthState } from '../lib/types';
import { extractMessage } from '../lib/api';
import { Button } from './ui/Button';
import { Field } from './ui/Field';
import { Input } from './ui/Input';

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
      const data = (await result.json()) as {
        token: string;
        username: string;
        expiresAt: number;
      };
      onSuccess({ token: data.token, username: data.username, expiresAt: data.expiresAt });
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center px-4 py-8 bg-[var(--color-bg)]">
      <div className="w-full max-w-[380px]">
        <div className="flex items-center gap-2.5 mb-6">
          <div className="grid place-items-center w-9 h-9 rounded-md bg-[var(--color-fg)] text-[var(--color-bg)]">
            <Boxes size={18} />
          </div>
          <div className="leading-tight">
            <div className="text-[14px] font-semibold text-[var(--color-fg)]">
              frpc 多实例管理
            </div>
            <div className="text-[11px] text-[var(--color-fg-muted)]">WebUI 控制台</div>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="flex flex-col gap-4 p-6 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
        >
          <Field label="用户名">
            <Input
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="admin"
            />
          </Field>
          <Field label="密码">
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="请输入密码"
            />
          </Field>

          {error && (
            <div className="flex items-start gap-2 p-2.5 rounded-md bg-[var(--color-danger-soft)] text-[12px] text-[var(--color-danger)]">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <Button variant="primary" type="submit" disabled={loading} className="h-9 mt-1">
            <ShieldCheck size={13} />
            {loading ? '登录中…' : '登录'}
          </Button>
        </form>

        <p className="mt-4 text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
          默认凭证由{' '}
          <code className="font-mono text-[10px] text-[var(--color-fg)]">.env</code> 中的
          WEBUI_USERNAME / WEBUI_PASSWORD 控制；首次修改后持久化到{' '}
          <code className="font-mono text-[10px] text-[var(--color-fg)]">
            .webui/credentials.json
          </code>
          。
        </p>
      </div>
    </div>
  );
}
