import { expect, test } from '@playwright/test';

const geo = { status: 'ready', countryCode: 'US', country: 'United States', asn: 'AS15169', asName: 'Google LLC', asDomain: 'google.com', source: 'ipinfo_lite', databaseVersion: '2026-10', lookedUpAt: '2026-10-30T00:00:00Z', stale: false };
const status = { enabled: true, path: '/data/geoip/ipinfo_lite.mmdb', version: '2026-10', buildEpoch: 1792281600, updatedAt: '2026-10-30T00:00:00Z', lastCheckAt: null, lastError: '', tokenConfigured: true, updating: false, counts: { pending: 0, ready: 1, notFound: 0, nonPublic: 0, error: 0 }, backfill: { phase: 'done', cursor: 1, done: true } };
const categories = [{ id: 'geo', name: '自动归属地', source: 'geoip', readOnly: true }, { id: 'asn', name: '自动 ASN', source: 'geoip', readOnly: true }, { id: 'purpose', name: '用途', source: 'manual', readOnly: false }];
const tags = [{ id: 'US', categoryId: 'geo', category: '自动归属地', name: 'US', source: 'geoip', readOnly: true, serverCount: 1 }, { id: 'AS15169', categoryId: 'asn', category: '自动 ASN', name: 'AS15169', source: 'geoip', readOnly: true, serverCount: 1 }, { id: 'prod', categoryId: 'purpose', category: '用途', name: '生产', source: 'manual', readOnly: false, serverCount: 1 }];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('frpc-webui-auth', JSON.stringify({ token: 'fixture', username: 'qa', expiresAt: Date.now() / 1000 + 3600 })));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (data: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname === '/api/geoip/status') return json(status);
    if (url.pathname === '/api/geoip/update' || url.pathname === '/api/geoip/refresh') return json({ queued: true });
    if (url.pathname === '/api/nodes') return json([]);
    if (url.pathname === '/api/summary') return json({ total: 0, running: 0, stopped: 0, error: 0, nodes: [], instances: [] });
    if (url.pathname === '/api/console-info') return json({ version: 'fixture', role: 'console', username: 'qa', nodeCount: 0 });
    if (url.pathname === '/api/probe/nodes') return json({ items: [] });
    if (url.pathname === '/api/probe/nodes/execution-policy') return json({ configured: false, primaryNodeId: null, backupNodeIds: [] });
    if (url.pathname === '/api/probe/servers/groups') return json([]);
    if (url.pathname === '/api/probe/server-views') return json({ items: [] });
    if (url.pathname === '/api/probe/tags/categories') return json({ items: categories });
    if (url.pathname === '/api/probe/tags') return json({ items: tags });
    if (url.pathname === '/api/probe/servers/facets') return json({ labels: [{ label: 'US', count: 1 }], tagItems: tags.map((tag) => ({ ...tag, tagId: tag.id, count: 1 })), groups: [], tagPage: 1, tagPageSize: 50, tagTotal: 3 });
    if (url.pathname === '/api/probe/servers/count') return json({ total: 1 });
    if (url.pathname === '/api/probe/servers/cursor') return json({ items: [{ id: 1, ip: '8.8.8.8', port: 7000, nodeId: 'console', nodeName: 'Console', group: '', labels: ['US', 'AS15169', '生产'], manualLabels: ['生产'], geo, createdAt: '2026-10-30T00:00:00Z', latestConnectivity: null, latestSpeed: null, latestRoute: null }], nextCursor: null, hasMore: false });
    if (url.pathname === '/api/probe/dashboard') return json({ servers: 1, connectivity: { tested: 0, reachable: 0, tunnels: 0, firewallOpen: 0 }, speed: { tested: 0, avgDownloadMbps: 0, avgUploadMbps: 0, maxDownloadMbps: 0 } });
    if (url.pathname === '/api/probe/jobs') return json({ items: [], page: 1, pageSize: 20, total: 0 });
    return json({});
  });
});

test('system shows local database status and queues explicit update and refresh actions', async ({ page }) => {
  const actions: string[] = [];
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().includes('/api/geoip/')) actions.push(new URL(request.url()).pathname); });
  await page.goto('/system');
  await expect(page.getByText('数据库已就绪', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'IP geolocation by IPinfo' })).toHaveAttribute('href', 'https://ipinfo.io/');
  expect(actions).toEqual([]);
  await page.getByRole('button', { name: '更新数据库', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新归属地', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '刷新归属地', exact: true }).click();
  await expect.poll(() => actions).toEqual(['/api/geoip/update', '/api/geoip/refresh']);
});

test('disabled and missing databases retain status details and appropriate actions', async ({ page }) => {
  let missing = false;
  await page.route('**/api/geoip/status', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...status, enabled: missing, version: null, tokenConfigured: false }) }));
  await page.goto('/system');
  await expect(page.getByText('已停用', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '更新数据库', exact: true })).toBeDisabled();
  missing = true;
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  await expect(page.getByText('待安装数据库', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '刷新归属地', exact: true })).toBeDisabled();
});

test('automatic tags remain filterable and read-only while editing manual labels and optional business group', async ({ page }) => {
  await page.goto('/servers');
  await expect(page.getByText('美国 · Google LLC', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '自动归属地 US 1', exact: true }).click();
  await expect(page).toHaveURL(/tagId=US/);
  await page.getByRole('button', { name: '管理分类标签', exact: true }).click();
  const management = page.getByRole('dialog');
  await expect(management.getByRole('textbox', { name: '自动归属地分类名称', exact: true })).toBeDisabled();
  await expect(management.getByRole('textbox', { name: '用途分类名称', exact: true })).toBeEnabled();
  await expect(management.getByRole('button', { name: '删除标签 US', exact: true })).toHaveCount(0);
  await expect(management.getByRole('button', { name: '删除标签 生产', exact: true })).toBeVisible();
  await management.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const editing = page.getByRole('dialog');
  await expect(editing.getByRole('textbox').nth(1)).toHaveValue('生产');
  await expect(editing.getByPlaceholder('例如：生产入口、备用池')).toHaveValue('');
  await expect(editing.getByText('业务分组（可选，可输入新分组）', { exact: true })).toBeVisible();
  await expect(editing.getByRole('link', { name: 'IPinfo Lite', exact: true })).toBeVisible();
  await editing.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 8.8.8.8', exact: true }).check();
  await page.getByRole('button', { name: '分类标签', exact: true }).click();
  const bulk = page.getByRole('dialog');
  await expect(bulk.getByText('生产', { exact: true })).toBeVisible();
  await expect(bulk.getByText('US', { exact: true })).toHaveCount(0);
  await expect(bulk.getByText('AS15169', { exact: true })).toHaveCount(0);
});

test('manual country-code labels retain source identity when saving an optional business group', async ({ page }) => {
  let saved: Record<string, unknown> | null = null;
  await page.route('**/api/probe/servers/cursor**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    items: [{ id: 1, ip: '8.8.8.8', group: '', labels: ['US', 'AS15169', '生产'], manualLabels: ['US', '生产'], geo, createdAt: 'now', latestConnectivity: null, latestSpeed: null, latestRoute: null }], nextCursor: null, hasMore: false,
  }) }));
  await page.route('**/api/probe/servers/1', async (route) => {
    saved = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/servers');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const editing = page.getByRole('dialog');
  await expect(editing.getByRole('textbox').nth(1)).toHaveValue('US,生产');
  await editing.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => saved).toMatchObject({ group: '', labels: ['US', '生产'] });
});
