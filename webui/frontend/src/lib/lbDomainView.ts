import type { LbDomain, LbHealth, LbHealthDomain } from './types';

export type CurrentHealth = 'healthy' | 'unhealthy' | 'unknown' | 'unassigned';
export type SyncState = 'success' | 'failed' | 'never' | 'unknown';
export type DomainFilters = {
  q: string;
  enabled: 'all' | 'enabled' | 'disabled';
  health: 'all' | CurrentHealth;
  sync: 'all' | SyncState;
};
export type DomainRow = {
  domain: LbDomain;
  health: LbHealthDomain | null;
  currentHealth: CurrentHealth;
  syncState: SyncState;
  healthyCount: number;
  unhealthyCount: number;
  unknownCount: number;
  pendingSwitch: boolean;
};

export const CURRENT_HEALTH_LABELS: Record<CurrentHealth, string> = {
  healthy: '健康', unhealthy: '检查失败', unknown: '待检查', unassigned: '未同步',
};
export const SYNC_LABELS: Record<SyncState, string> = {
  success: '成功', failed: '失败', never: '未同步', unknown: '结果未知',
};

export function readDomainFilters(params: URLSearchParams): DomainFilters {
  const choice = <T extends string>(key: string, values: readonly T[]) => values.find((value) => value === params.get(key)) ?? values[0];
  return {
    q: params.get('q') ?? '',
    enabled: choice('enabled', ['all', 'enabled', 'disabled'] as const),
    health: choice('health', ['all', 'healthy', 'unhealthy', 'unknown', 'unassigned'] as const),
    sync: choice('sync', ['all', 'success', 'failed', 'never', 'unknown'] as const),
  };
}

export function domainRows(domains: LbDomain[], health: LbHealth | null): DomainRow[] {
  const states = new Map(health?.states.map((item) => [item.ip, item]));
  const snapshots = new Map(health?.domains.map((item) => [item.domainId, item]));
  return domains.map((domain) => {
    const snapshot = domain.enabled ? snapshots.get(domain.id) ?? null : null;
    const pool = domain.poolSize ? [...new Set(snapshot?.poolIps ?? [])] : [];
    const healthyCount = Math.min(domain.poolSize, pool.filter((ip) => states.get(ip)?.ok === true).length);
    const unhealthyCount = Math.min(domain.poolSize - healthyCount, pool.filter((ip) => states.get(ip)?.ok === false).length);
    const current = domain.currentIp && pool.includes(domain.currentIp) ? states.get(domain.currentIp) : undefined;
    const currentHealth = !domain.currentIp ? 'unassigned' : current?.ok === true ? 'healthy' : current?.ok === false ? 'unhealthy' : 'unknown';
    const syncState = !domain.lastSyncAt ? 'never' : domain.lastSyncOk === true ? 'success' : domain.lastSyncOk === false ? 'failed' : 'unknown';
    return {
      domain, health: snapshot, currentHealth, syncState, healthyCount, unhealthyCount,
      unknownCount: domain.poolSize - healthyCount - unhealthyCount,
      pendingSwitch: !!(snapshot?.bestIp && domain.currentIp && snapshot.bestIp !== domain.currentIp),
    };
  });
}

export function filterDomainRows(rows: DomainRow[], filters: DomainFilters): DomainRow[] {
  const query = filters.q.trim().toLowerCase();
  return rows.filter(({ domain, currentHealth, syncState }) =>
    (!query || domain.name.toLowerCase().includes(query) || domain.currentIp?.toLowerCase().includes(query)) &&
    (filters.enabled === 'all' || domain.enabled === (filters.enabled === 'enabled')) &&
    (filters.health === 'all' || currentHealth === filters.health) &&
    (filters.sync === 'all' || syncState === filters.sync));
}
