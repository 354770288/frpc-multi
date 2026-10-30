import { expect, test } from '@playwright/test';

test('domains use explicit paged candidates and manual switches preserve failure state', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('frpc-webui-auth', JSON.stringify({ token: 'local-fixture', username: 'qa', expiresAt: Date.now() / 1000 + 3600 })));

  let domains: Record<string, unknown>[] = [];
  let members: Record<string, unknown>[] = [];
  let domainCreateBody: Record<string, unknown> | null = null;
  let addedIds: number[] = [];
  let removedIds: number[] = [];
  let lastSwitchId: number | null = null;
  let failSwitch = true;
  let currentId: number | null = null;
  let preferredId: number | null = null;
  const measuredAt = '2026-10-30T05:00:00.000Z';
  const server = (id: number, ip: string) => ({
    id, ip, port: 7000, group: id === 101 ? 'west' : 'east', labels: [], createdAt: 'now', latestRoute: null,
    latestConnectivity: { frpsReachable: true, tunnelEstablished: true, firewallOpen: true, detail: 'ok', testTime: measuredAt },
    latestSpeed: { downloadOk: true, uploadOk: true, downloadMbps: id === 101 ? 0 : 80, uploadMbps: 40, testTime: measuredAt },
  });
  const candidate = (id: number, ip: string, preferred = false, current = false) => ({
    id, ip, group: id === 101 ? 'west' : 'east',
    latestConnectivity: { frpsReachable: true, tunnelEstablished: true, firewallOpen: true, detail: 'ok', testTime: measuredAt },
    latestSpeed: { downloadOk: true, uploadOk: true, downloadMbps: id === 101 ? 0 : 80, uploadMbps: 40, testTime: measuredAt }, preferred, current,
  });
  const json = (value: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(value) });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/lb/domains' && request.method() === 'GET') return route.fulfill(json(domains));
    if (path === '/api/lb/domains' && request.method() === 'POST') {
      domainCreateBody = request.postDataJSON();
      domains = [{ id: 8, name: 'edge.example.com', zoneId: 'z1', zoneName: 'example.com', group: '', ttl: 60, syncMode: 'manual', intervalSeconds: 300, enabled: true, lastSyncAt: null, lastSyncOk: null, lastSyncMessage: '', currentIp: null, createdAt: 'now', poolSize: 0, preferredServerId: null }];
      return route.fulfill(json(domains[0]));
    }
    if (path === '/api/lb/cloudflare') return route.fulfill(json({ configured: true, tokenMasked: 'qa…token' }));
    if (path === '/api/lb/cloudflare/verify') return route.fulfill(json({ ok: true, zones: [{ id: 'z1', name: 'example.com' }] }));
    if (path === '/api/lb/selection-config') return route.fulfill(json({ nodeId: 'remote', maxAgeHours: 24, healthSource: 'console' }));
    if (path === '/api/lb/health') return route.fulfill(json({ states: [], domains: [] }));
    if (path === '/api/probe/nodes') return route.fulfill(json({ items: [{ id: 'remote', name: 'QA', online: true }] }));
    if (path === '/api/probe/nodes/execution-policy') return route.fulfill(json({ configured: true, primaryNodeId: 'remote', backupNodeIds: [] }));
    if (path === '/api/lb/domains/8/servers' && request.method() === 'GET') {
      const pageNo = Number(url.searchParams.get('page') || 1);
      const items = members.slice((pageNo - 1) * 50, pageNo * 50).map((item) => ({ ...item, current: item.id === currentId, preferred: item.id === preferredId }));
      return route.fulfill(json({ items, page: pageNo, pageSize: 50, total: members.length }));
    }
    if (path === '/api/lb/domains/8/servers' && request.method() === 'POST') {
      addedIds = (request.postDataJSON() as { serverIds: number[] }).serverIds;
      for (const id of addedIds) if (!members.some((item) => item.id === id)) members.push(candidate(id, id === 101 ? '192.0.2.101' : '192.0.2.102'));
      currentId = 102;
      domains = domains.map((item) => ({ ...item, currentIp: '192.0.2.102' }));
      return route.fulfill(json({ ok: true, total: members.length }));
    }
    if (path === '/api/lb/domains/8/servers' && request.method() === 'DELETE') {
      removedIds = (request.postDataJSON() as { serverIds: number[] }).serverIds;
      members = members.filter((item) => !removedIds.includes(item.id as number));
      return route.fulfill(json({ ok: true, total: members.length }));
    }
    if (path === '/api/probe/servers/cursor') {
      const isSecond = url.searchParams.get('cursor') === 'page-two';
      return route.fulfill(json({ items: [server(isSecond ? 102 : 101, isSecond ? '192.0.2.102' : '192.0.2.101')], nextCursor: isSecond ? null : 'page-two', hasMore: !isSecond }));
    }
    if (path === '/api/probe/servers/count') return route.fulfill(json({ total: 2 }));
    if (path === '/api/lb/domains/8/switch' && request.method() === 'POST') {
      lastSwitchId = (request.postDataJSON() as { serverId: number }).serverId;
      if (failSwitch) return route.fulfill(json({ ok: false, targetIp: null, previousIp: null, switched: false, added: [], removed: [], poolSize: members.length, healthySize: 0, unmanagedCount: 0, errors: ['offline'], message: '目标服务器不健康', syncedAt: 'now' }));
      currentId = lastSwitchId;
      preferredId = lastSwitchId;
      members = members.map((item) => ({ ...item, current: item.id === lastSwitchId, preferred: item.id === lastSwitchId }));
      domains = domains.map((item) => ({ ...item, currentIp: lastSwitchId === 101 ? '192.0.2.101' : '192.0.2.102', preferredServerId: lastSwitchId }));
      return route.fulfill(json({ ok: true, targetIp: lastSwitchId === 101 ? '192.0.2.101' : '192.0.2.102', previousIp: null, switched: true, added: [], removed: [], poolSize: members.length, healthySize: members.length, unmanagedCount: 0, errors: [], message: 'DNS 已同步', syncedAt: 'now' }));
    }
    return route.fulfill(json({}));
  });

  await page.goto('/lb');
  await page.getByRole('button', { name: '新增域名' }).click();
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'example.com' }).click();
  await page.getByPlaceholder('frps.example.com').fill('edge.example.com');
  await page.getByRole('switch').click();
  await expect(page.getByText('绑定服务器分组')).toHaveCount(0);
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('heading', { name: /edge\.example\.com · 候选服务器/ })).toBeVisible();
  expect(domainCreateBody).toMatchObject({ name: 'edge.example.com', zoneId: 'z1', zoneName: 'example.com' });
  expect(domainCreateBody).toMatchObject({ enabled: false });
  expect(domainCreateBody).not.toHaveProperty('group');
  await expect(page.getByText(/成员调整不会立即写 DNS/)).toBeVisible();

  await expect(page.getByRole('table').nth(1).getByTitle(measuredAt)).toHaveCount(2);
  await expect(page.getByRole('table').nth(1).getByText('↓ 0.0 · ↑ 40.0 Mbps')).toBeVisible();
  await page.getByLabel('选择 192.0.2.101').check();
  await page.getByRole('button', { name: '服务器库下一页' }).click();
  await page.getByLabel('选择 192.0.2.102').check();
  await expect(page.getByText('已选 2 台（新增 2）')).toBeVisible();
  await page.getByRole('button', { name: '添加所选' }).click();
  expect(addedIds).toEqual([101, 102]);
  await expect(page.getByRole('table').first().getByTitle(measuredAt)).toHaveCount(4);
  await expect(page.getByText('192.0.2.101')).toBeVisible();
  await page.getByRole('button', { name: '移除 192.0.2.101' }).click();
  expect(removedIds).toEqual([101]);
  await expect(page.getByRole('table').first().getByText('192.0.2.101')).toHaveCount(0);

  const failureSwitch = page.getByRole('button', { name: '固定并同步 DNS' });
  await failureSwitch.click();
  await expect(page.getByRole('alertdialog', { name: '切换并同步 DNS？' })).toBeVisible();
  await expect(page.getByText('edge.example.com 将从 192.0.2.102 切换到 192.0.2.102，并同步 Cloudflare A 记录。')).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button', { name: '切换并同步 DNS' }).click();
  expect(lastSwitchId).toBe(102);
  await expect(page.getByRole('alertdialog', { name: '切换并同步 DNS？' })).toBeVisible();
  await expect(page.getByText('目标服务器不健康')).toBeVisible();
  await expect(page.getByText('DNS 已同步')).toHaveCount(0);

  failSwitch = false;
  await page.getByRole('alertdialog').getByRole('button', { name: '取消' }).click();
  await page.getByRole('button', { name: '固定并同步 DNS' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '切换并同步 DNS' }).click();
  await expect(page.getByText('手动固定', { exact: true })).toBeVisible();
  await expect(page.getByText('当前', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '移除 192.0.2.102' }).click();
  await expect(page.getByRole('alertdialog', { name: '移除候选服务器？' })).toBeVisible();
  await expect(page.getByText(/edge\.example\.com · 192\.0\.2\.102。当前 DNS 指向 192\.0\.2\.102/)).toBeVisible();
  await expect(page.getByText(/移除后候选池为空，下一次同步会清理托管 A 记录/)).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button', { name: '确认移除' }).click();
  expect(removedIds).toEqual([102]);
  await expect(page.getByText('还没有候选服务器，请从服务器库添加。')).toBeVisible();
});
