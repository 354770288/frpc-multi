import { expect, test } from '@playwright/test';

test('workspace anomaly window displays port anomalies, GFW switches, and interactive actions', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'frpc-webui-auth',
      JSON.stringify({ token: 'fixture', username: 'qa', expiresAt: Date.now() / 1000 + 3600 }),
    ),
  );

  let alerts = [
    {
      id: 1,
      alertKey: 'port_unreachable:1:198.51.100.20:28080',
      kind: 'port_unreachable',
      severity: 'error',
      status: 'active',
      domainId: 1,
      domainName: 'us1.zmfrp.eu.org',
      ip: '198.51.100.20',
      port: 28080,
      instances: [{ nodeId: 2, nodeName: 'sz-agent', instanceName: 'erp-web', displayName: 'ERP转发' }],
      primaryNodeId: 'p1',
      primaryNodeName: '深圳电信主节点',
      primaryDetail: 'timeout',
      backupNodeId: 'console',
      backupNodeName: 'Console',
      backupDetail: 'connection refused',
      switched: false,
      switchedToIp: null,
      message: '业务端口异常',
      firstSeenAt: '2026-11-17T12:00:00Z',
      lastCheckedAt: '2026-11-17T12:05:00Z',
      resolvedAt: null,
    },
    {
      id: 2,
      alertKey: 'gfw_blocked:1:198.51.100.10:22022',
      kind: 'gfw_blocked',
      severity: 'warning',
      status: 'active',
      domainId: 1,
      domainName: 'us1.zmfrp.eu.org',
      ip: '198.51.100.10',
      port: 22022,
      instances: [],
      primaryNodeId: 'p1',
      primaryNodeName: '深圳电信主节点',
      primaryDetail: 'timeout',
      backupNodeId: 'b1',
      backupNodeName: '洛杉矶备用',
      backupDetail: '10ms',
      switched: true,
      switchedToIp: '198.51.100.20',
      message: '检测到业务端口 22022 被 GFW 屏蔽，已自动切换至 198.51.100.20',
      firstSeenAt: '2026-11-17T11:50:00Z',
      lastCheckedAt: '2026-11-17T11:50:00Z',
      resolvedAt: null,
    },
  ];
  let gfwBlocks = [
    {
      ip: '198.51.100.10',
      domainId: 1,
      domainName: 'us1.zmfrp.eu.org',
      blockedPort: 22022,
      primaryNodeId: 'p1',
      primaryNodeName: '深圳电信主节点',
      primaryDetail: 'timeout',
      backupNodeId: 'b1',
      backupNodeName: '洛杉矶备用',
      backupDetail: '10ms',
      blockedAt: '2026-11-17T11:50:00Z',
      lastCheckedAt: '2026-11-17T11:50:00Z',
    },
  ];
  let checkTriggered = 0;

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/api/probe/dashboard') {
      return json({ servers: 12, tested: 10, pass: 8, partial: 1, fail: 1, untested: 2, avgDownloadMbps: 120 });
    }
    if (path === '/api/probe/jobs') return json({ items: [], total: 0, page: 1, pageSize: 5 });
    if (path === '/api/probe/nodes') {
      return json({ items: [{ id: 'p1', name: '深圳电信主节点', kind: 'worker', capabilities: ['discover'], online: true }] });
    }
    if (path === '/api/lb/domains') {
      return json([{ id: 1, name: 'us1.zmfrp.eu.org', zoneId: 'z', zoneName: 'zmfrp.eu.org', group: '', groupId: null, syncGroupId: 'g1', syncGroup: '美国US1', ttl: 60, syncMode: 'scheduled', intervalSeconds: 300, enabled: true, lastSyncAt: '2026-11-17T12:00:00Z', lastSyncOk: true, lastSyncMessage: 'ok', currentIp: '198.51.100.20', createdAt: 'now', poolSize: 2, preferredServerId: null }]);
    }
    if (path === '/api/lb/port-health' && req.method() === 'GET') {
      return json({
        alerts,
        gfwBlocks,
        domains: [{ domainId: 1, name: 'us1.zmfrp.eu.org', enabled: true, currentIp: '198.51.100.20', businessPorts: [{ port: 28080, instances: [] }] }],
      });
    }
    if (path === '/api/lb/port-health/check' && req.method() === 'POST') {
      checkTriggered += 1;
      return json({ checkedAt: '2026-11-17T12:10:00Z', checkedDomains: [{ domainId: 1 }], switchedCount: 0, policySkipReason: null, alerts, gfwBlocks });
    }
    if (path === '/api/lb/gfw-blocks/198.51.100.10' && req.method() === 'DELETE') {
      gfwBlocks = [];
      alerts = alerts.filter((a) => a.kind !== 'gfw_blocked');
      return json({ ok: true, removed: true });
    }
    if (path === '/api/lb/port-alerts/1/dismiss' && req.method() === 'POST') {
      alerts = alerts.filter((a) => a.id !== 1);
      return json({ ok: true, dismissed: true });
    }
    if (path === '/api/nodes') return json([]);
    if (path === '/api/summary') return json({ total: 1, running: 1, stopped: 0, error: 0, dockerAvailable: true, dockerError: '', nodes: [], instances: [] });
    if (path === '/api/console-info') return json({ version: 'fixture', role: 'console', username: 'qa', nodeCount: 1 });
    return json({});
  });

  await page.goto('/workspace');
  const card = page.getByTestId('anomaly-window');
  await expect(card).toBeVisible();
  await expect(card.getByText('异常 2 项')).toBeVisible();
  await expect(card.getByText('业务端口异常')).toBeVisible();
  await expect(card.getByText('198.51.100.20:28080')).toBeVisible();
  await expect(card.getByRole('link', { name: 'sz-agent / ERP转发' })).toHaveAttribute('href', '/instances/2/erp-web');
  await expect(card.getByText('GFW 屏蔽 · 已自动切换')).toBeVisible();

  await card.getByRole('button', { name: '立即检测业务端口' }).click();
  await expect.poll(() => checkTriggered).toBe(1);

  await card.getByRole('button', { name: '解除 198.51.100.10 屏蔽' }).click();
  await expect(card.getByText('异常 1 项')).toBeVisible();

  await card.getByRole('button', { name: '忽略' }).click();
  await expect(card.getByText('运行正常')).toBeVisible();
  await expect(card.getByText('已监控 1 个启用域名 · 1 个运行中业务端口')).toBeVisible();
});
