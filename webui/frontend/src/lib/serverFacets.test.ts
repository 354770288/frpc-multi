import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeApi } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('server facet API candidate options', () => {
  it('keeps no-argument legacy facets unpaged', async () => {
    let requested = '';
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      requested = String(path);
      return new Response(JSON.stringify({ groups: [], labels: [], tagItems: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await probeApi.serverFacets();

    expect(requested).toBe('/api/probe/servers/facets');
  });

  it('sends explicit candidate search and page options with contextual filters', async () => {
    let requested = '';
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      requested = String(path);
      return new Response(JSON.stringify({ groups: [], labels: [], tagItems: [], tagPage: 2, tagPageSize: 50, tagTotal: 52 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const query = { page: 1, pageSize: 50, groupIds: ['group-qa'], includeTagIds: ['tag-cn'], tagMode: 'all' as const, conn: 'all' as const, sort: 'ip' as const, order: 'asc' as const };

    const result = await probeApi.serverFacets(query, undefined, { tagSearch: 'special', tagPage: 2, tagPageSize: 50 });

    const params = new URL(requested, 'http://local').searchParams;
    expect(params.get('groupIds')).toBe('group-qa');
    expect(params.get('includeTagIds')).toBe('tag-cn');
    expect(params.get('tagMode')).toBe('all');
    expect(params.get('tagSearch')).toBe('special');
    expect(params.get('tagPage')).toBe('2');
    expect(params.get('tagPageSize')).toBe('50');
    expect(result.tagTotal).toBe(52);
  });
});
