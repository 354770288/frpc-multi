import React, { useState } from 'react';
import { Boxes, ShieldCheck, AlertCircle } from 'lucide-react';
import type { AuthState } from '../lib/types';
import { extractMessage } from '../lib/api';
import { Button } from './ui/button';
import { Field } from './ui/Field';
import { Input } from './ui/input';

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
        <div className="flex flex-col items-center gap-3 mb-8">
          <div className="grid place-items-center w-14 h-14 rounded-xl bg-[var(--color-fg)] text-[var(--color-bg)]">
            <Boxes size={28} />
          </div>
          <div className="text-center">
            <div className="text-[20px] font-semibold tracking-tight text-[var(--color-fg)]">
              frpc 多实例管理
            </div>
            <div className="mt-1 text-[12px] text-[var(--color-fg-muted)]">WebUI 控制台</div>
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
              placeholder="请输入用户名"
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
            <div
              role="alert"
              className="flex items-start gap-2 p-2.5 rounded-md bg-[var(--color-danger-soft)] text-[12px] text-[var(--color-danger)]"
            >
              <AlertCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <Button variant="default" type="submit" disabled={loading} className="h-9 mt-1">
            <ShieldCheck size={13} />
            {loading ? '登录中…' : '登录'}
          </Button>
        </form>
      </div>
    </div>
  );
}
