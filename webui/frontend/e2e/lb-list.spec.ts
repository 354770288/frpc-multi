import { expect, test } from '@playwright/test';

const detailMessage = '检测到旧记录，已保留手动维护记录并将托管记录收敛到当前健康目标；这段详细结果应在详情中展示。';
const makeDomain = (id: number, name: string, extra = {}) => ({ id, name, zoneId: 'z', zoneName: 'example.com', group: '', groupId: null, ttl: 60, syncMode: 'manual', intervalSeconds: 300, enabled: true, lastSyncAt: '2026-10-30T08:00:00Z', lastSyncOk: true, lastSyncMessage: detailMessage, currentIp: `192.0.2.${id}`, createdAt: '2026-10-30T00:00:00Z', poolSize: 2, preferredServerId: null, ...extra });
const domains = [
  makeDomain(1, 'edge.example.com', { syncMode: 'scheduled', preferredServerId: 101 }),
  makeDomain(2, 'bad.example.com', { lastSyncOk: false }),
  makeDomain(3, 'paused.example.com', { enabled: false, poolSize: 1 }),
  makeDomain(4, 'draft.example.com', { currentIp: null, poolSize: 0, lastSyncAt: null, lastSyncOk: null }),
  makeDomain(5, 'unknown.example.com'),
];
const state = (ip: string, ok: boolean | null) => ({ ip, ok, consecutiveFail: ok === false ? 3 : 0, lastCheck: 'now', lastOk: ok ? 'now' : null, detail: '', port: 7000 });
const health = {
  states: [state('192.0.2.1', true), state('192.0.2.11', true), state('192.0.2.2', false), state('192.0.2.12', true), state('192.0.2.3', true), state('192.0.2.15', true)],
  domains: domains.filter((d) => d.enabled).map((d) => ({ domainId: d.id, name: d.name, currentIp: d.currentIp, group: '', bestIp: d.id === 2 ? '192.0.2.12' : d.currentIp, poolIps: d.poolSize ? [d.currentIp, `192.0.2.${d.id + 10}`] : [], selection: { nodeId: 'remote', maxAgeHours: 24, healthSource: 'console', observedAt: '2026-10-30T00:00:00Z', validCandidates: 2, bestIp: d.currentIp, reason: d.preferredServerId ? 'preferred_server' : 'primary_observation' } })),
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('frpc-webui-auth', JSON.stringify({ token: 'fixture', username: 'qa', expiresAt: Date.now() / 1000 + 3600 })));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/lb/domains') return json(domains);
    if (path === '/api/lb/health') return json(health);
    if (path === '/api/lb/cloudflare') return json({ configured: true, tokenMasked: 'fixture' });
    if (path === '/api/lb/cloudflare/verify') return json({ ok: true, zones: [{ id: 'z', name: 'example.com' }] });
    if (path === '/api/lb/selection-config') return json({ nodeId: 'remote', maxAgeHours: 24, healthSource: 'console' });
    if (path === '/api/probe/nodes') return json({ items: [{ id: 'remote', name: '主用节点', online: true }] });
    if (path === '/api/probe/nodes/execution-policy') return json({ configured: true, primaryNodeId: 'remote', backupNodeIds: [] });
    if (path.endsWith('/records')) return json([{ id: 'r', ip: '192.0.2.1', ttl: 60, managed: true }]);
    if (path.endsWith('/logs')) return json([]);
    if (path.endsWith('/sync')) return json({ ok: true, message: '已同步', removed: [], added: [] });
    if (path === '/api/nodes') return json([]);
    if (path === '/api/summary') return json({ total: 0, running: 0, stopped: 0, error: 0, nodes: [], instances: [] });
    if (path === '/api/console-info') return json({ version: 'fixture', role: 'console', username: 'qa', nodeCount: 0 });
    return json({});
  });
});

test('compact list keeps long explanations in details, with correct unknown health', async ({ page }) => {
  await page.goto('/lb');
  const table = page.getByRole('table', { name: '候选域名列表' });
  await expect(table.getByRole('columnheader')).toHaveCount(5);
  await expect(page.getByText('显示 5 / 5 个域名')).toBeVisible();
  await expect(table.getByText(detailMessage)).toHaveCount(0);
  const unknown = table.getByRole('row').filter({ hasText: 'unknown.example.com' });
  await expect(unknown.getByText('待检查', { exact: true })).toBeVisible();
  await expect(unknown.getByText(/1\s*\/\s*2 健康/)).toBeVisible();
  await page.getByRole('link', { name: '查看 edge.example.com 详情' }).click();
  const details = page.getByRole('dialog');
  await expect(details.getByText(detailMessage)).toBeVisible();
  await expect(details.getByText('手动固定目标健康，保持当前选择', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(details).toHaveCount(0);
});

test('search and status filters intersect, survive reload and details navigation, and clear', async ({ page }) => {
  await page.goto('/lb');
  const search = page.getByRole('textbox', { name: '搜索域名或当前 IP' });
  await search.pressSequentially('all');
  await expect(search).toHaveValue('all');
  await expect(page.getByText('没有匹配的域名')).toBeVisible();
  await search.fill('');
  await page.getByRole('combobox', { name: '启用状态筛选' }).click();
  await page.getByRole('option', { name: '已启用', exact: true }).click();
  await page.getByRole('combobox', { name: '当前 IP 健康筛选' }).click();
  await page.getByRole('option', { name: '当前 IP 检查失败', exact: true }).click();
  await page.getByRole('combobox', { name: '最近同步筛选' }).click();
  await page.getByRole('option', { name: '最近同步失败', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索域名或当前 IP' }).fill('192.0.2.2');
  await expect(page.getByText('显示 1 / 5 个域名')).toBeVisible();
  await expect(page).toHaveURL(/health=unhealthy/);
  await page.reload();
  await expect(page.getByRole('textbox', { name: '搜索域名或当前 IP' })).toHaveValue('192.0.2.2');
  await expect(page.getByText('显示 1 / 5 个域名')).toBeVisible();
  await page.getByRole('link', { name: '查看 bad.example.com 详情' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveURL(/\/lb\/2\?/);
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('显示 1 / 5 个域名')).toBeVisible();
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByText('显示 1 / 5 个域名')).toBeVisible();
  await page.getByRole('textbox', { name: '搜索域名或当前 IP' }).fill('missing');
  await expect(page.getByText('没有匹配的域名')).toBeVisible();
  await page.getByRole('button', { name: '清空筛选', exact: true }).first().click();
  await expect(page.getByText('显示 5 / 5 个域名')).toBeVisible();
  await expect(page).toHaveURL(/\/lb$/);
});

test('row menus keep sync explicit and cancellation leaves domains unchanged', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (request) => { if (request.method() !== 'GET' && /\/api\/lb\/domains/.test(request.url())) writes.push(new URL(request.url()).pathname); });
  await page.goto('/lb');
  await page.getByRole('button', { name: 'bad.example.com 更多操作' }).click();
  expect(writes).toEqual([]);
  await page.getByRole('menuitem', { name: '立即同步', exact: true }).click();
  await expect.poll(() => writes).toEqual(['/api/lb/domains/2/sync']);
  await page.getByRole('button', { name: '刷新', exact: true }).waitFor();
  await page.getByRole('button', { name: 'bad.example.com 更多操作' }).click();
  await page.getByRole('menuitem', { name: '删除域名', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(writes).toHaveLength(1);
});

test('failed refresh keeps the last snapshot and loading errors offer a retry', async ({ page }) => {
  let broken = true;
  await page.route('**/api/lb/domains', (route) => broken ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: '暂时离线' }) }) : route.fallback());
  await page.goto('/lb');
  await expect(page.getByText('域名数据加载失败', { exact: true })).toBeVisible();
  await expect(page.getByText('先配置 Cloudflare', { exact: true })).toHaveCount(0);
  broken = false;
  await page.getByRole('button', { name: '重新加载' }).click();
  await expect(page.getByText('显示 5 / 5 个域名')).toBeVisible();
  broken = true;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('保留上次加载的信息');
  await expect(page.getByText('显示 5 / 5 个域名')).toBeVisible();
});

test('table and filters fit desktop and narrow screens in light and dark themes', async ({ page }) => {
  for (const [width, theme] of [[1280, 'light'], [1440, 'dark'], [390, 'light']] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
    await page.goto('/lb');
    await expect(page.getByText('显示 5 / 5 个域名')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await page.screenshot({ path: `/tmp/frpc-lb-ui-${theme}-${width}.png`, fullPage: true });
  }
});
