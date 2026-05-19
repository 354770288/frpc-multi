import { getAuthToken, notifyUnauthorized, AuthError } from './auth';

export function extractMessage(text: string, fallback: string): string {
  if (!text) return fallback;
  try {
    const data = JSON.parse(text);
    if (typeof data?.detail === 'string') return data.detail;
    if (data?.detail && typeof data.detail === 'object') {
      const detail = data.detail as Record<string, unknown>;
      if (Array.isArray(detail.errors) && detail.errors.length) {
        return (detail.errors as string[]).join('；');
      }
      if (typeof detail.stderr === 'string' && detail.stderr.trim()) return detail.stderr.trim();
    }
    if (typeof data?.message === 'string') return data.message;
  } catch {
    // 非 JSON，按原文回退
  }
  return text;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const isString = typeof init?.body === 'string';
  const explicitContentType =
    init?.headers && (init.headers as Record<string, string>)['Content-Type'];
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string>) || {})
  };
  if (!explicitContentType && init?.method && init.method !== 'GET' && isString) {
    headers['Content-Type'] = 'application/json';
  }
  const token = getAuthToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(path, { ...init, headers });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new AuthError('登录已过期，请重新登录');
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(extractMessage(text, response.statusText || '请求失败'));
  }
  if (response.status === 204) return undefined as T;
  const ctype = response.headers.get('content-type') || '';
  if (ctype.includes('application/json')) return (await response.json()) as T;
  return (await response.text()) as unknown as T;
}
