import { getAuthToken, notifyUnauthorized, AuthError } from './auth';
import type {
  AuditLog,
  CloudflareInfo,
  CloudflareZone,
  DiscoverFacets,
  DiscoverPage,
  DiscoverQuery,
  DiscoverStatus,
  GroupColor,
  GroupInfo,
  Instance,
  InstanceDetail,
  LabelCount,
  LbDomain,
  LbDnsRecord,
  LbHealth,
  LbSyncLog,
  LbSyncResult,
  Node,
  NodeInstall,
  RouteNodeInfo,
  RouteStatusView,
  NodeWithInstall,
  ProbeConnectivityHistory,
  ProbeDashboard,
  ProbeServer,
  ProbeSpeedHistory,
  ProbeTestConfig,
  ProbeTestStatus,
  ServerFacets,
  ServerPage,
  ServerQuery,
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
  upgradeAgent: (id: number) =>
    api<{
      accepted: boolean;
      mode: string;
      targetContainer?: string;
      helperContainer?: string;
      image?: string;
    }>(`/api/nodes/${id}/agent/upgrade`, { method: 'POST' }),
  patch: (id: number, payload: NodePatchPayload) =>
    api<Node>(`/api/nodes/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  delete: (id: number) =>
    api<{ deleted: boolean; decommissioned?: boolean; detail?: string }>(`/api/nodes/${id}`, {
      method: 'DELETE'
    }),
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

export type ProbeServerPayload = {
  ip?: string;
  labels?: string[];
  group?: string;
};

export const probeApi = {
  servers: (query: ServerQuery, signal?: AbortSignal) => {
    const params = new URLSearchParams({
      page: String(query.page),
      pageSize: String(query.pageSize),
      q: query.q?.trim() ?? '',
      conn: query.conn,
      sort: query.sort,
      order: query.order,
    });
    // group/label 显式空串=筛空值；undefined=不筛选（与后端 None 语义对齐）
    if (query.group !== undefined) params.set('group', query.group);
    if (query.label !== undefined) params.set('label', query.label);
    return api<ServerPage>(`/api/probe/servers?${params.toString()}`, { signal });
  },
  serverFacets: (signal?: AbortSignal) =>
    api<ServerFacets>('/api/probe/servers/facets', { signal }),
  groups: () => api<GroupInfo[]>('/api/probe/servers/groups'),
  createGroup: (name: string, color?: GroupColor) =>
    api<{ ok: boolean; name: string }>('/api/probe/servers/groups', {
      method: 'POST',
      body: JSON.stringify({ name, color: color ?? '' })
    }),
  setGroupColor: (name: string, color: GroupColor) =>
    api<{ ok: boolean; color: GroupColor }>('/api/probe/servers/groups/color', {
      method: 'PATCH',
      body: JSON.stringify({ name, color })
    }),
  deleteGroup: (name: string) =>
    api<{ ok: boolean }>(`/api/probe/servers/groups/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  batchUpdateServers: (ids: number[], changes: { group?: string; addLabels?: string[]; removeLabels?: string[] }) =>
    api<{ updated: number }>('/api/probe/servers/batch-update', {
      method: 'POST',
      body: JSON.stringify({ ids, ...changes })
    }),
  createServer: (payload: ProbeServerPayload) =>
    api<{ id: number; ip: string; labels: string[]; group: string }>('/api/probe/servers', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  updateServer: (id: number, payload: ProbeServerPayload) =>
    api<{ id: number; ip: string; labels: string[]; group: string }>(`/api/probe/servers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    }),
  deleteServer: (id: number) => api<{ ok: boolean }>(`/api/probe/servers/${id}`, { method: 'DELETE' }),
  importServers: (payload: { text: string; group?: string }) =>
    api<{ inserted: number; skipped: number }>('/api/probe/servers/batch', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  startTest: (payload: { mode: 'connectivity' | 'speed' | 'full'; ips?: string[]; group?: string }) =>
    api<{ ok: boolean; mode: string; count: number }>('/api/probe/test', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  testStatus: () => api<ProbeTestStatus>('/api/probe/test/status'),
  skipCurrent: () => api<{ ok: boolean }>('/api/probe/test/skip', { method: 'POST' }),
  stopTest: () => api<{ ok: boolean }>('/api/probe/test/stop', { method: 'POST' }),
  connectivityHistory: (ip?: string, limit = 200) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (ip) params.set('ip', ip);
    return api<ProbeConnectivityHistory[]>(`/api/probe/history/connectivity?${params.toString()}`);
  },
  speedHistory: (ip?: string, limit = 200) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (ip) params.set('ip', ip);
    return api<ProbeSpeedHistory[]>(`/api/probe/history/speed?${params.toString()}`);
  },
  clearHistory: (kind: 'connectivity' | 'speed') =>
    api<{ deleted: number }>(`/api/probe/history/${kind}`, { method: 'DELETE' }),
  getConfig: () => api<ProbeTestConfig>('/api/probe/config'),
  updateConfig: (values: Record<string, string | number>) =>
    api<ProbeTestConfig>('/api/probe/config', {
      method: 'POST',
      body: JSON.stringify({ values })
    }),
  dashboard: () => api<ProbeDashboard>('/api/probe/dashboard'),
  renameGroup: (old: string, name: string) =>
    api<{ renamed: string }>('/api/probe/servers/groups/rename', {
      method: 'PATCH', body: JSON.stringify({ old, new: name })
    }),
  discoverStart: (payload: {
    targets: string; exclude?: string; sourceUrl?: string; port?: number; concurrency?: number; timeout?: number;
    autoRoute?: boolean;
  }) => api<DiscoverStatus>('/api/probe/discover/start', {
    method: 'POST', body: JSON.stringify(payload)
  }),
  discoverStatus: () => api<DiscoverStatus>('/api/probe/discover/status'),
  discoverStop: () => api<{ stopped: boolean }>('/api/probe/discover/stop', { method: 'POST' }),
  discoverResults: (query: DiscoverQuery, signal?: AbortSignal) => {
    const params = new URLSearchParams({
      page: String(query.page),
      pageSize: String(query.pageSize),
      q: query.q?.trim() ?? '',
      library: query.library,
      sort: query.sort,
      order: query.order,
    });
    // group/label 的显式空串是有意义的筛选（查空分组/空标签），undefined 才是不筛选——此时缺省参数
    if (query.group !== undefined) params.set('group', query.group);
    if (query.label !== undefined) params.set('label', query.label);
    return api<DiscoverPage>(`/api/probe/discover/results?${params.toString()}`, { signal });
  },
  discoverFacets: (signal?: AbortSignal) =>
    api<DiscoverFacets>('/api/probe/discover/facets', { signal }),
  discoverUpdateBatch: (ids: number[], changes: { group?: string; addLabels?: string[]; removeLabels?: string[] }) =>
    api<{ updated: number }>('/api/probe/discover/results/batch', {
      method: 'PATCH', body: JSON.stringify({ ids, group: changes.group ?? null, addLabels: changes.addLabels ?? [], removeLabels: changes.removeLabels ?? [] })
    }),
  discoverLabelsPreview: (ids: number[]) =>
    api<{ labels: LabelCount[] }>('/api/probe/discover/labels-preview', {
      method: 'POST', body: JSON.stringify({ ids })
    }),
  serversLabelsPreview: (ids: number[]) =>
    api<{ labels: LabelCount[] }>('/api/probe/servers/labels-preview', {
      method: 'POST', body: JSON.stringify({ ids })
    }),
  discoverDelete: (ids: number[] | null) =>
    api<{ deleted: number }>('/api/probe/discover/results', {
      method: 'DELETE', body: JSON.stringify({ ids })
    }),
  discoverImport: (ids: number[], group?: string) =>
    api<{ inserted: number; skipped: number }>('/api/probe/discover/import', {
      method: 'POST', body: JSON.stringify({ ids, group: group ?? '' })
    }),
  routeStart: (ids: number[]) =>
    api<{ enqueued: number }>('/api/probe/route/start', {
      method: 'POST', body: JSON.stringify({ ids })
    }),
  routeStatus: () => api<RouteStatusView>('/api/probe/route/status'),
  routeStop: () => api<{ cleared: number }>('/api/probe/route/stop', { method: 'POST' }),
  routeNodes: () => api<RouteNodeInfo[]>('/api/probe/route/nodes'),
  routeNodeCreate: (name: string) =>
    api<{ name: string; token: string }>('/api/probe/route/nodes', {
      method: 'POST', body: JSON.stringify({ name })
    }),
  routeNodeDelete: (name: string) =>
    api<{ ok: boolean }>(`/api/probe/route/nodes/${encodeURIComponent(name)}`, { method: 'DELETE' })
};

export const lbApi = {
  cloudflare: () => api<CloudflareInfo>('/api/lb/cloudflare'),
  saveCloudflareToken: (token: string) =>
    api<CloudflareInfo>('/api/lb/cloudflare', { method: 'PUT', body: JSON.stringify({ token }) }),
  verifyCloudflare: (token?: string) =>
    api<{ ok: boolean; zones: CloudflareZone[] }>('/api/lb/cloudflare/verify', {
      method: 'POST',
      body: JSON.stringify(token ? { token } : {})
    }),
  domains: () => api<LbDomain[]>('/api/lb/domains'),
  createDomain: (payload: {
    name: string; zoneId: string; zoneName: string; group: string;
    ttl?: number; syncMode?: 'manual' | 'scheduled'; intervalSeconds?: number; enabled?: boolean;
  }) => api<LbDomain>('/api/lb/domains', { method: 'POST', body: JSON.stringify(payload) }),
  updateDomain: (id: number, payload: {
    group?: string; ttl?: number; syncMode?: 'manual' | 'scheduled'; intervalSeconds?: number; enabled?: boolean;
  }) => api<LbDomain>(`/api/lb/domains/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteDomain: (id: number, removeRecords: boolean) =>
    api<{ ok: boolean; removedRecords: string[] }>(`/api/lb/domains/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ removeRecords })
    }),
  syncDomain: (id: number) => api<LbSyncResult>(`/api/lb/domains/${id}/sync`, { method: 'POST' }),
  domainRecords: (id: number) => api<LbDnsRecord[]>(`/api/lb/domains/${id}/records`),
  domainLogs: (id: number, limit = 50) => api<LbSyncLog[]>(`/api/lb/domains/${id}/logs?limit=${limit}`),
  health: () => api<LbHealth>('/api/lb/health')
};
