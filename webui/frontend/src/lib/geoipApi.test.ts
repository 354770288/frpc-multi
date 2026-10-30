import { afterEach, describe, expect, it, vi } from 'vitest';
import { geoipApi } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('local geolocation API', () => {
  it('reads status and queues database update and asset refresh without request bodies', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ queued: true }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await geoipApi.status();
    expect(await geoipApi.update()).toEqual({ queued: true });
    expect(await geoipApi.refresh()).toEqual({ queued: true });
    expect(fetchMock.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['/api/geoip/status', '/api/geoip/update', '/api/geoip/refresh']);
    const requests = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(requests[1][1]).toMatchObject({ method: 'POST' });
    expect(requests[2][1]).toMatchObject({ method: 'POST' });
    expect(requests[1][1].body).toBeUndefined();
    expect(requests[2][1].body).toBeUndefined();
  });
});
