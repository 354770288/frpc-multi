import { expect, test } from '@playwright/test';

test('global command palette, server detail sheet, and structured LB domain rebinding work end-to-end', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'frpc-webui-auth',
      JSON.stringify({ token: 'fixture', username: 'qa', expiresAt: Date.now() / 1000 + 3600 }),
    ),
  );

  const domain = {
    id: 1,
    name: 'hk1.zmfrp.eu.org',
    zoneId: 'z1',
    zoneName: 'zmfrp.eu.org',
    group: '',
    groupId: null,
    syncGroupId: 'g-hk',
    syncGroup: '香港HK1',
    ttl: 60,
    syncMode: 'scheduled',
    intervalSeconds: 300,
    enabled: true,
    lastSyncAt: '2026-11-18T00:00:00Z',
    lastSyncOk: true,
    lastSyncMessage: 'ok',
    currentIp: '1.32.216.28',
    createdAt: 'now',
    poolSize: 1,
    preferredServerId: null,
  };

  const node = {
    id: 1,
    name: 'sz-office-agent',
    uuid: 'uuid-sz-01',
    status: 'online',
    online: true,
    lastSeenAt: '2026-11-18T00:00:00Z',
    createdAt: 'now',
    updatedAt: 'now',
  };

  const inst = {
    name: 'nas-ssh',
    displayName: '办公NAS',
    enabled: true,
    description: 'SSH转发',
    configPath: '/opt/frpc/nas-ssh/frpc.toml',
    createdAt: 'now',
    updatedAt: 'now',
    nodeId: 1,
    nodeName: 'sz-office-agent',
    summary: {
      serverAddr: 'hk1.zmfrp.eu.org',
      serverPort: 7000,
      proxyCount: 1,
      proxyTypes: { tcp: 1 },
      remotePorts: [22022],
      tcpRemotePorts: [22022],
    },
    runtime: {
      service: 'frpc-nas-ssh',
      containerName: 'frpc-nas-ssh',
      containerId: 'c1',
      state: 'running',
      status: 'Up 2 hours',
      health: 'healthy',
      exitCode: null,
      cpuPercent: '0.2%',
      memUsage: '12.0MiB / 2.0GiB',
      memPercent: '0.6%',
      netIO: '1MB / 2MB',
      blockIO: '0B / 0B',
      pids: '4',
      restartCount: 0,
    },
  };

  const seenDomainStatuses: string[] = [];

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/api/workspace/overview') {
      return json({
        dashboard: {
          servers: 2,
          connectivity: { tested: 2, reachable: 2, tunnels: 2, firewallOpen: 2 },
          speed: { tested: 2, avgDownloadMbps: 150, avgUploadMbps: 80, maxDownloadMbps: 200 },
        },
        activeJobs: { items: [], page: 1, pageSize: 5, total: 0 },
        failedJobs: { items: [], page: 1, pageSize: 5, total: 0 },
        testNodes: [{ id: 'p1', name: '深圳主节点', kind: 'worker', version: 'v1', capabilities: ['discover', 'route', 'connectivity', 'speed'], online: true }],
        domains: [domain],
        portHealth: { alerts: [], gfwBlocks: [], domains: [{ domainId: 1, name: domain.name, enabled: true, currentIp: domain.currentIp, businessPorts: [{ port: 22022, instances: [] }] }] },
        summary: {
          total: 1,
          running: 1,
          stopped: 0,
          error: 0,
          nodeCount: 1,
          onlineCount: 1,
          dockerAvailable: true,
          dockerError: '',
          nodes: [{ id: 1, name: node.name, uuid: node.uuid, status: 'online', lastSeenAt: node.lastSeenAt, total: 1, running: 1, stopped: 0, errorCount: 0 }],
          instances: [inst],
        },
        badges: { anomalies: 0, activeJobs: 0, offlineNodes: 0, errorInstances: 0 },
      });
    }
    if (path === '/api/probe/servers/cursor') {
      seenDomainStatuses.push(url.searchParams.get('domainStatus') || 'all');
      const items = [
        {
          id: 10,
          ip: '1.32.216.28',
          port: 7000,
          nodeId: 'p1',
          nodeName: '深圳主节点',
          group: '香港HK1',
          domainId: 1,
          domainName: 'hk1.zmfrp.eu.org',
          labels: ['CN2'],
          createdAt: 'now',
          latestConnectivity: { frpsReachable: true, tunnelEstablished: true, firewallOpen: true, detail: 'ok', testTime: '2026-11-18T00:00:00Z' },
          latestSpeed: { downloadOk: true, uploadOk: true, downloadMbps: 185.4, uploadOk_: true, uploadMbps: 92.1, testTime: '2026-11-18T00:00:00Z' },
          latestRoute: { id: 1, node_id: 'p1', server_ip: '1.32.216.28', port: 7000, test_time: '2026-11-18T00:00:00Z', ok: true, isCn2: true, hops: [{ hop: 1, host: '59.43.246.1', loss: 0, avg: 12.4 }], error: '' },
        },
      ];
      const filtered = url.searchParams.get('domainStatus') === 'unassigned' ? [] : items;
      return json({ items: filtered, nextCursor: null, hasMore: false });
    }
    if (path === '/api/probe/servers/count') {
      return json({ total: url.searchParams.get('domainStatus') === 'unassigned' ? 0 : 1 });
    }
    if (path === '/api/probe/servers/facets') return json({ labels: [], tagItems: [], groups: [], tagPage: 1, tagPageSize: 50, tagTotal: 0 });
    if (path === '/api/probe/servers/groups') return json([{ id: 'g-hk', name: '香港HK1', color: 'green' }]);
    if (path === '/api/probe/server-views') return json({ items: [] });
    if (path === '/api/probe/dashboard') return json({ servers: 1, connectivity: { tested: 1, reachable: 1, tunnels: 1, firewallOpen: 1 }, speed: { tested: 1, avgDownloadMbps: 185.4, avgUploadMbps: 92.1, maxDownloadMbps: 185.4 } });
    if (path.startsWith('/api/probe/history/')) return json([]);
    if (path === '/api/nodes') return json([node]);
    if (path === '/api/summary') {
      return json({
        total: 1,
        running: 1,
        stopped: 0,
        error: 0,
        nodeCount: 1,
        onlineCount: 1,
        dockerAvailable: true,
        dockerError: '',
        nodes: [{ id: 1, name: node.name, uuid: node.uuid, status: 'online', lastSeenAt: node.lastSeenAt, total: 1, running: 1, stopped: 0, errorCount: 0 }],
        instances: [inst],
      });
    }
    if (path === '/api/lb/domains') return json([domain]);
    if (path === '/api/nodes/1/instances/nas-ssh') return json({ ...inst, warnings: [], errors: [] });
    if (path === '/api/nodes/1/instances/nas-ssh/config' && req.method() === 'GET') {
      return json({
        configText: 'serverAddr = "198.51.100.99"\nserverPort = 7000\n\n[[proxies]]\nname = "ssh"\ntype = "tcp"\nlocalIP = "127.0.0.1"\nlocalPort = 22\nremotePort = 22022\n',
        validation: { valid: true, errors: [], warnings: [], summary: inst.summary },
      });
    }
    if (path === '/api/nodes/1/instances/nas-ssh/config/validate') {
      return json({ valid: true, errors: [], warnings: [], summary: inst.summary });
    }
    if (path === '/api/console-info') return json({ version: 'qa', buildVersion: 'release-qa', webuiHost: 'localhost', webuiPort: 5184, projectDir: '/opt', role: 'console', username: 'qa', nodeCount: 1 });
    return json({});
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/workspace');
  await expect(page.getByText('全域资源与运维工作台')).toBeVisible();
  await expect(page.getByText('运行中实例')).toBeVisible();

  // 1. 打开全局快捷搜索面板并检索跳转至服务器库
  await page.getByRole('button', { name: '打开全局快捷搜索' }).click();
  const cmdInput = page.getByLabel('全局快捷搜索输入');
  await expect(cmdInput).toBeVisible();
  await cmdInput.fill('服务器库');
  await page.getByRole('option', { name: /服务器库/ }).first().click();
  await expect(page).toHaveURL(/\/servers/);

  // 2. 服务器库展示优选域名徽章、支持右侧详情抽屉与域名归属筛选
  await expect(page.getByRole('link', { name: 'hk1.zmfrp.eu.org' })).toBeVisible();
  await page.getByRole('button', { name: '查看 1.32.216.28 详情' }).click();
  await expect(page.getByText('最近路由追踪跳点（共 1 跳）')).toBeVisible();
  await expect(page.getByText('59.43.246.1')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('combobox', { name: '域名归属筛选' }).click();
  await page.getByRole('option', { name: '未分配域名' }).click();
  await expect.poll(() => seenDomainStatuses.includes('unassigned')).toBe(true);

  // 3. 实例列表内联展示优选域名徽章，且配置编辑器支持结构化切换优选域名与差异对比
  await page.goto('/instances');
  await expect(page.getByRole('link', { name: 'hk1.zmfrp.eu.org' })).toBeVisible();
  await page.goto('/instances/1/nas-ssh?tab=config');
  await expect(page.getByText('frps 服务端连接设置')).toBeVisible();
  await page.getByRole('radio', { name: '优选域名' }).click();
  await page.getByRole('combobox', { name: '绑定优选域名' }).click();
  await page.getByRole('option', { name: /hk1\.zmfrp\.eu\.org/ }).click();
  await page.getByRole('button', { name: '对比差异' }).click();
  await expect(page.getByText('+ serverAddr = "hk1.zmfrp.eu.org"')).toBeVisible();
});
