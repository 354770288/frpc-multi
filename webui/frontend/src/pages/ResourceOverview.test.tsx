import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AnomalyWindowCard } from './ResourceOverview';
import type { LbDomain, LbPortHealthResponse, SummaryResponse, TestNode } from '../lib/types';

const baseDomain: LbDomain = {
  id: 1,
  name: 'us1.zmfrp.eu.org',
  zoneId: 'z1',
  zoneName: 'zmfrp.eu.org',
  group: '',
  groupId: null,
  syncGroupId: 'g1',
  syncGroup: '美国US1',
  ttl: 60,
  syncMode: 'scheduled',
  intervalSeconds: 300,
  enabled: true,
  lastSyncAt: '2026-11-17T10:00:00Z',
  lastSyncOk: true,
  lastSyncMessage: 'ok',
  currentIp: '198.51.100.20',
  createdAt: '2026-11-01T00:00:00Z',
  poolSize: 2,
  preferredServerId: null,
};

describe('ResourceOverview AnomalyWindowCard', () => {
  it('renders healthy summary when no port or node anomalies exist', () => {
    const portHealth: LbPortHealthResponse = {
      alerts: [],
      gfwBlocks: [],
      domains: [
        {
          domainId: 1,
          name: 'us1.zmfrp.eu.org',
          enabled: true,
          currentIp: '198.51.100.20',
          businessPorts: [
            { port: 22022, instances: [{ nodeId: 1, nodeName: 'hk-node', instanceName: 'ssh', displayName: 'SSH' }] },
            { port: 28080, instances: [{ nodeId: 1, nodeName: 'hk-node', instanceName: 'web', displayName: 'Web' }] },
          ],
        },
      ],
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AnomalyWindowCard portHealth={portHealth} domains={[baseDomain]} summary={null} testNodes={[]} />
      </MemoryRouter>,
    );
    expect(html).toContain('异常监控窗口');
    expect(html).toContain('运行正常');
    expect(html).toContain('已监控 1 个启用域名 · 2 个运行中业务端口');
  });

  it('renders business port unreachable alert, GFW failover alert, and instance deep links', () => {
    const portHealth: LbPortHealthResponse = {
      alerts: [
        {
          id: 101,
          alertKey: 'port_unreachable:1:198.51.100.20:28080',
          kind: 'port_unreachable',
          severity: 'error',
          status: 'active',
          domainId: 1,
          domainName: 'us1.zmfrp.eu.org',
          ip: '198.51.100.20',
          port: 28080,
          instances: [{ nodeId: 3, nodeName: 'sz-agent', instanceName: 'erp-web', displayName: 'ERP业务' }],
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
          id: 102,
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
          backupDetail: '11ms',
          switched: true,
          switchedToIp: '198.51.100.20',
          message: '检测到 GFW 屏蔽并已自动切换至 198.51.100.20',
          firstSeenAt: '2026-11-17T11:50:00Z',
          lastCheckedAt: '2026-11-17T11:50:00Z',
          resolvedAt: null,
        },
      ],
      gfwBlocks: [
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
          backupDetail: '11ms',
          blockedAt: '2026-11-17T11:50:00Z',
          lastCheckedAt: '2026-11-17T11:50:00Z',
        },
      ],
      domains: [],
    };
    const summary: SummaryResponse = {
      total: 2,
      running: 1,
      stopped: 0,
      error: 1,
      nodeCount: 1,
      onlineCount: 0,
      dockerAvailable: false,
      dockerError: '部分节点离线',
      instances: [],
      nodes: [{ id: 3, name: 'sz-agent', uuid: 'u3', status: 'offline', lastSeenAt: null, total: 0, running: 0, stopped: 0, errorCount: 0 }],
    };
    const testNodes: TestNode[] = [
      { id: 'w1', name: '深圳电信主节点', kind: 'worker', version: 'v1', capabilities: ['discover'], online: false, lastSeen: null, createdAt: 'now', tokenMasked: 'a…b', installCommand: '' },
    ];
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AnomalyWindowCard
          portHealth={portHealth}
          domains={[{ ...baseDomain, lastSyncOk: false, lastSyncMessage: '候选全不健康' }]}
          summary={summary}
          testNodes={testNodes}
          onCheckNow={() => {}}
          onUnblockIp={() => {}}
          onDismissAlert={() => {}}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('异常 6 项');
    expect(html).toContain('业务端口异常');
    expect(html).toContain('198.51.100.20:28080');
    expect(html).toContain('/instances/3/erp-web');
    expect(html).toContain('GFW 屏蔽 · 已自动切换');
    expect(html).toContain('原 IP 198.51.100.10:22022 → 新 IP 198.51.100.20');
    expect(html).toContain('解除 198.51.100.10 屏蔽');
    expect(html).toContain('DNS 同步失败');
    expect(html).toContain('实例运行异常');
    expect(html).toContain('部署节点离线');
    expect(html).toContain('测试节点离线');
  });
});
