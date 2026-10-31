import { describe, expect, it } from 'vitest';
import type { LbDomain, LbHealth } from './types';
import { domainRows, filterDomainRows, readDomainFilters } from './lbDomainView';

const base: LbDomain = { id: 1, name: 'edge.example.com', zoneId: 'z', zoneName: 'example.com', group: '', groupId: null, ttl: 60, syncMode: 'manual', intervalSeconds: 300, enabled: true, lastSyncAt: null, lastSyncOk: null, lastSyncMessage: '', currentIp: '192.0.2.1', createdAt: 'now', poolSize: 2, preferredServerId: null };
const health: LbHealth = { states: [
  { ip: '192.0.2.1', ok: true, consecutiveFail: 0, lastCheck: 'now', lastOk: 'now', detail: '', port: 7000 },
], domains: [{ domainId: 1, name: base.name, group: '', currentIp: base.currentIp, bestIp: base.currentIp, poolIps: ['192.0.2.1', '192.0.2.2'], selection: { nodeId: 'console', maxAgeHours: 24, healthSource: 'console', bestIp: base.currentIp, reason: 'keep_healthy_current', observedAt: null, validCandidates: 0 } }] };

describe('domain list presentation and filters', () => {
  it('keeps missing checks separate from confirmed health and failed checks', () => {
    const row = domainRows([base], health)[0];
    expect([row.healthyCount, row.unhealthyCount, row.unknownCount]).toEqual([1, 0, 1]);
    expect(row.currentHealth).toBe('healthy');
    expect(domainRows([base], null)[0].currentHealth).toBe('unknown');
    expect(domainRows([{ ...base, enabled: false }], health)[0]).toMatchObject({ currentHealth: 'unknown', healthyCount: 0, unknownCount: 2 });
    expect(domainRows([{ ...base, currentIp: null }], health)[0].currentHealth).toBe('unassigned');
  });

  it('distinguishes never-synced and unknown sync results from failure', () => {
    expect(domainRows([base], null)[0].syncState).toBe('never');
    expect(domainRows([{ ...base, lastSyncAt: 'now' }], null)[0].syncState).toBe('unknown');
    expect(domainRows([{ ...base, lastSyncAt: 'now', lastSyncOk: false }], null)[0].syncState).toBe('failed');
  });

  it('applies search and each status as an intersection without changing original order', () => {
    const other = { ...base, id: 2, name: 'backup.example.com', currentIp: '192.0.2.99', enabled: false };
    const rows = domainRows([base, other], health);
    expect(filterDomainRows(rows, readDomainFilters(new URLSearchParams('q=EDGE&health=healthy'))).map((row) => row.domain.id)).toEqual([1]);
    expect(filterDomainRows(rows, readDomainFilters(new URLSearchParams('q=2.99&enabled=disabled&sync=never'))).map((row) => row.domain.id)).toEqual([2]);
    expect(filterDomainRows(rows, readDomainFilters(new URLSearchParams('enabled=disabled&health=healthy')))).toEqual([]);
    expect(rows.map((row) => row.domain.id)).toEqual([1, 2]);
  });

  it('uses safe filter defaults for old links and invalid URL values', () => {
    expect(readDomainFilters(new URLSearchParams('q=x&health=broken&enabled=yes&sync=no'))).toEqual({ q: 'x', enabled: 'all', health: 'all', sync: 'all' });
    const empty = domainRows([{ ...base, poolSize: 0, currentIp: null }], health)[0];
    expect([empty.healthyCount, empty.unhealthyCount, empty.unknownCount]).toEqual([0, 0, 0]);
  });
});
