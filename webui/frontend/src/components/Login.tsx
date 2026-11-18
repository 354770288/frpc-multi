import React, { useState } from 'react';
import { AlertCircle, Boxes, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import type { AuthState } from '../lib/types';
import { extractMessage } from '../lib/api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

export function Login({ onSuccess }: { onSuccess: (state: AuthState) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
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
        body: JSON.stringify({ username, password }),
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

  function handleKeyCheck(event: React.KeyboardEvent<HTMLInputElement>) {
    if (typeof event.getModifierState === 'function') {
      setCapsLock(event.getModifierState('CapsLock'));
    }
  }

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-background px-4 py-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/12 via-background to-background"
      />
      <div className="relative z-10 w-full max-w-[390px]">
        <div className="mb-7 flex flex-col items-center gap-3">
          <div className="grid size-13 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-md shadow-primary/20">
            <Boxes className="size-6" />
          </div>
          <div className="text-center">
            <div className="text-xl font-semibold tracking-tight text-foreground">
              frpc 多实例管理
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              资源探测 · 域名选优 · 多节点穿透编排控制台
            </div>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="flex flex-col gap-4 rounded-xl border border-border/80 bg-card/95 p-6 shadow-sm backdrop-blur"
        >
          <div className="space-y-1.5">
            <Label htmlFor="login-username" className="text-xs">用户名</Label>
            <Input
              id="login-username"
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="请输入用户名"
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="login-password" className="text-xs">密码</Label>
              {capsLock && (
                <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
                  大写锁定已开启
                </span>
              )}
            </div>
            <div className="relative">
              <Input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyUp={handleKeyCheck}
                onKeyDown={handleKeyCheck}
                placeholder="请输入密码"
                className="pr-9"
              />
              <button
                type="button"
                tabIndex={-1}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                onClick={() => setShowPassword((prev) => !prev)}
                className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md bg-destructive/10 p-2.5 text-xs text-destructive"
            >
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <Button variant="default" type="submit" disabled={loading} className="mt-1 h-9">
            <ShieldCheck className="size-4" data-icon="inline-start" />
            {loading ? '登录中…' : '登录'}
          </Button>
        </form>
      </div>
    </div>
  );
}
