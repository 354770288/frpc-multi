import { getAuthToken, notifyUnauthorized, AuthError } from './auth';
import type {
  AuditLog,
  Instance,
  InstanceDetail,
  Node,
  NodeInstall,
  NodeWithInstall,
  SystemInfo,
  ValidationData
} from './types';

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

export type NodeCreatePayload = {
  name: string;
};

export type NodePatchPayload = {
  name?: string;
};

export const nodesApi = {
  list: () => api<Node[]>('/api/nodes'),
  create: (payload: NodeCreatePayload) =>
    api<NodeWithInstall>('/api/nodes', { method: 'POST', body: JSON.stringify(payload) }),
  get: (id: number) => api<Node>(`/api/nodes/${id}`),
  install: (id: number) => api<NodeInstall>(`/api/nodes/${id}/install`),
  rotateSecret: (id: number) =>
    api<NodeWithInstall>(`/api/nodes/${id}/rotate-secret`, { method: 'POST' }),
  patch: (id: number, payload: NodePatchPayload) =>
    api<Node>(`/api/nodes/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  delete: (id: number) => api<{ deleted: boolean }>(`/api/nodes/${id}`, { method: 'DELETE' }),
  ping: (id: number) => api<{ ok: boolean; node: Node }>(`/api/nodes/${id}/ping`, { method: 'POST' }),
  system: (id: number) => api<SystemInfo>(`/api/nodes/${id}/system`),
  instances: {
    list: (nodeId: number) => api<Instance[]>(`/api/nodes/${nodeId}/instances`),
    create: (nodeId: number, payload: Record<string, unknown>) =>
      api<{ name: string }>(`/api/nodes/${nodeId}/instances`, { method: 'POST', body: JSON.stringify(payload) }),
    get: (nodeId: number, name: string) => api<InstanceDetail>(`/api/nodes/${nodeId}/instances/${name}`),
    patch: (nodeId: number, name: string, payload: Record<string, unknown>) =>
      api<Instance>(`/api/nodes/${nodeId}/instances/${name}`, { method: 'PATCH', body: JSON.stringify(payload) }),
    delete: (nodeId: number, name: string) =>
      api<{ deleted: string }>(`/api/nodes/${nodeId}/instances/${name}`, { method: 'DELETE' }),
    action: (nodeId: number, name: string, verb: string) =>
      api(`/api/nodes/${nodeId}/instances/${name}/${verb}`, { method: 'POST' }),
    getConfig: (nodeId: number, name: string) =>
      api<{ configText: string; validation: ValidationData }>(`/api/nodes/${nodeId}/instances/${name}/config`),
    updateConfig: (nodeId: number, name: string, payload: Record<string, unknown>) =>
      api<{ validation: ValidationData }>(`/api/nodes/${nodeId}/instances/${name}/config`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      }),
    validateConfig: (nodeId: number, name: string, configText: string) =>
      api<ValidationData>(`/api/nodes/${nodeId}/instances/${name}/config/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: configText
      }),
    logs: (nodeId: number, name: string, params: URLSearchParams) =>
      api<{ lines: string[] }>(`/api/nodes/${nodeId}/instances/${name}/logs?${params.toString()}`)
  }
};

export const auditLogsApi = {
  list: (limit = 100) => api<AuditLog[]>(`/api/audit-logs?limit=${limit}`)
};
