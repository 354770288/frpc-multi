import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeApi } from '../../lib/api';
import type { ServerQuery } from '../../lib/types';
import { serverSelectionFilters } from './useServerBulk';

afterEach(() => vi.unstubAllGlobals());

describe('durable server bulk API', () => {
  it('freezes only current matching filters and copies mutable filter arrays', () => {
    const query: ServerQuery = {
      page: 4, pageSize: 100, q: '198.51.100', group: 'edge', label: 'legacy-cn2', groupIds: ['g1'],
      includeTagIds: ['t1', 't2'], excludeTagIds: ['t3'], tagMode: 'all', conn: 'pass',
      sort: 'time', order: 'desc', cursor: 'cursor-4',
    };

    const frozen = serverSelectionFilters(query);
    query.q = 'changed after snapshot';
    query.label = 'changed-label';
    query.groupIds?.push('g2');
    query.includeTagIds?.splice(0, 1);

    expect(frozen).toEqual({
      q: '198.51.100', group: 'edge', label: 'legacy-cn2', groupIds: ['g1'], includeTagIds: ['t1', 't2'],
      excludeTagIds: ['t3'], tagMode: 'all', conn: 'pass',
    });
    expect(frozen).not.toHaveProperty('page');
    expect(frozen).not.toHaveProperty('sort');
    expect(frozen).not.toHaveProperty('cursor');
  });

  it('submits and polls asynchronous snapshots/jobs, pages failures, and retries failed rows', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      requests.push({ path: String(path), init });
      if (String(path) === '/api/probe/server-selections') return json({ selectionId: 'sel-1', state: 'queued', count: 0, processed: 0 });
      if (String(path) === '/api/probe/server-bulk-jobs') return json({ jobId: 'job-1', selectionId: 'sel-1', operation: 'update', state: 'queued', total: 500, processed: 0, succeeded: 0, failed: 0 });
      if (String(path) === '/api/probe/server-bulk-jobs/job-1') return json({ jobId: 'job-1', selectionId: 'sel-1', operation: 'update', state: 'partial', total: 500, processed: 500, succeeded: 497, failed: 3 });
      if (String(path).startsWith('/api/probe/server-bulk-jobs/job-1/failures')) return json({ items: [{ serverId: 9, ip: '198.51.100.9', error: 'server no longer exists' }], nextCursor: 9 });
      return json({ jobId: 'job-2', selectionId: 'sel-1', operation: 'update', state: 'queued', total: 3, processed: 0, succeeded: 0, failed: 0, retryOf: 'job-1' });
    }));

    const selection = await probeApi.createServerSelection({ allMatching: true, q: '198.51.100', label: 'legacy-cn2', conn: 'pass' });
    expect(selection.state).toBe('queued');
    await probeApi.createServerBulkJob({ selectionId: selection.selectionId, operation: 'update', payload: { group: 'edge' }, idempotencyKey: 'idem-1' });
    expect((await probeApi.serverBulkJob('job-1')).state).toBe('partial');
    const failures = await probeApi.serverBulkFailures('job-1', 0, 1);
    expect(failures.items[0].ip).toBe('198.51.100.9');
    expect(failures.nextCursor).toBe(9);
    expect((await probeApi.retryServerBulkFailures('job-1', 'idem-2')).retryOf).toBe('job-1');

    expect(JSON.parse(String(requests[0].init?.body))).toMatchObject({ allMatching: true, q: '198.51.100', label: 'legacy-cn2', conn: 'pass' });
    expect(JSON.parse(String(requests[1].init?.body))).toMatchObject({ selectionId: 'sel-1', operation: 'update', payload: { group: 'edge' }, idempotencyKey: 'idem-1' });
    expect(requests[3].path).toContain('cursor=0&limit=1');
    expect(JSON.parse(String(requests[4].init?.body))).toEqual({ idempotencyKey: 'idem-2' });
  });
});
