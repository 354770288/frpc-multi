import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeApi } from '../../lib/api';

afterEach(() => vi.unstubAllGlobals());

describe('asynchronous server import API', () => {
  it('submits idempotently, reads progress and paginates/retries failures', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const job = { jobId: 'import-1', state: 'partial', total: 3, processed: 3, inserted: 1, skipped: 1, failed: 1, retryableFailed: 1, createdAt: 'now', updatedAt: 'now', error: null };
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      requests.push({ path: String(path), init });
      if (String(path) === '/api/probe/server-import-jobs') return json(job);
      if (String(path) === '/api/probe/server-import-jobs/import-1') return json(job);
      if (String(path).includes('/failures?')) return json({ items: [{ line: 2, input: 'not-an-ip', error: 'invalid address', retryable: true }], nextCursor: '2' });
      return json({ ...job, jobId: 'retry-1', state: 'queued', failed: 0 });
    }));

    await probeApi.createServerImportJob({ text: '192.0.2.1\nnot-an-ip', group: 'QA', idempotencyKey: 'idem-1' });
    expect((await probeApi.serverImportJob('import-1')).failed).toBe(1);
    const page = await probeApi.serverImportFailures('import-1', undefined, 1);
    expect(page.items[0]).toEqual({ line: 2, input: 'not-an-ip', error: 'invalid address', retryable: true });
    expect(await probeApi.retryServerImportFailures('import-1', 'idem-2')).toMatchObject({ jobId: 'retry-1', state: 'queued' });

    expect(requests[0].path).toBe('/api/probe/server-import-jobs');
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ text: '192.0.2.1\nnot-an-ip', group: 'QA', idempotencyKey: 'idem-1' });
    expect(requests[2].path).toContain('limit=1');
    expect(JSON.parse(String(requests[3].init?.body))).toEqual({ idempotencyKey: 'idem-2' });
  });
});
