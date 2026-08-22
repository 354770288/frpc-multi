export type Instance = {
  name: string;
  displayName: string;
  enabled: boolean;
  description: string;
  configPath: string;
  createdAt: string;
  updatedAt: string;
};

export type InstanceSummary = {
  serverAddr?: string;
  serverPort?: number;
  authMethod?: string;
  tokenMasked?: string;
  proxyCount: number;
  proxyTypes: Record<string, number>;
  remotePorts: number[];
};

export type InstanceDetail = Instance & {
  summary: InstanceSummary;
  warnings: string[];
  errors: string[];
};

export type InstanceStats = {
  service: string;
  containerName: string;
  containerId: string;
  state: string;
  status: string;
  health: string;
  exitCode: number | null;
  cpuPercent: string;
  memUsage: string;
  memPercent: string;
  netIO: string;
  blockIO: string;
  pids: string;
  restartCount: number;
};

export type StatsMap = Record<string, InstanceStats>;

export type StatsResponse = {
  available: boolean;
  error: string;
  containers: StatsMap;
};

export type SystemInfo = {
  projectDir: string;
  webuiHost: string;
  webuiPort: number;
  version: string;
  username?: string;
  dockerVersion?: string;
  frpImage?: string;
  frpVersion?: string;
  disk: { total: number; used: number; free: number };
};

// 主控自身信息（反转模型下 Console 不执行本机 Docker，故不含 Docker/磁盘/frp 字段）。
// Docker 版本、磁盘等改由各节点的 SystemInfo（/api/nodes/{id}/system）提供。
export type ConsoleInfo = {
  version: string;
  webuiHost: string;
  webuiPort: number;
  projectDir: string;
  role: string;
  username?: string;
  nodeCount: number;
};

export type SummaryResponse = {
  total: number;
  running: number;
  stopped: number;
  error: number;
  dockerAvailable: boolean;
  dockerError: string;
  instances: (Instance & {
    runtime: InstanceStats | Record<string, never>;
    nodeId?: number;
    nodeName?: string;
  })[];
  nodes?: NodeSummary[];
};

export type AuthMe = {
  username: string;
  tokenTtlSeconds: number;
};

export type AuthState = {
  token: string;
  username: string;
  expiresAt: number;
};

export type ValidationData = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  summary: InstanceSummary;
};

export type NodeStatus = 'unknown' | 'pending' | 'online' | 'offline' | 'error';

export type Node = {
  id: number;
  name: string;
  uuid: string;
  status: NodeStatus;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NodeInstall = {
  server: string;
  serverConfigured: boolean;
  tls: boolean;
  uuid: string;
  image: string;
  env: Record<string, string>;
  installCommand: string;
};

export type NodeWithInstall = Node & { install: NodeInstall };

export type InstanceRef = Instance & {
  nodeId: number;
  nodeName: string;
};

export type NodeSummary = {
  id: number;
  name: string;
  uuid: string;
  status: NodeStatus;
  lastSeenAt: string | null;
  error?: string;
  total: number;
  running: number;
  stopped: number;
  errorCount: number;
};

export type NodeInstanceHealth = {
  total: number;
  running: number;
  stopped: number;
  error: number;
  disabled: number;
};

export type AuditLog = {
  id: number;
  username: string;
  action: string;
  nodeId: number | null;
  instanceName: string | null;
  success: boolean;
  message: string;
  createdAt: string;
};

/** Page identifier — used to bridge old Console-style navigation with React Router. */
export type Page = 'overview' | 'detail' | 'config' | 'nodes' | 'create' | 'audit' | 'system' | 'probe';

// ---- 穿透测试（frps 验收） ----

export type ProbeConnectivitySummary = {
  frpsReachable: boolean;
  tunnelEstablished: boolean;
  firewallOpen: boolean;
  detail: string;
  testTime: string;
};

export type ProbeSpeedSummary = {
  downloadOk: boolean;
  uploadOk: boolean;
  downloadMbps: number;
  uploadMbps: number;
  testTime: string;
};

export type ProbeServer = {
  id: number;
  ip: string;
  label: string;
  group: string;
  createdAt: string;
  latestConnectivity: ProbeConnectivitySummary | null;
  latestSpeed: ProbeSpeedSummary | null;
};

export type ProbeConnectivityHistory = {
  id: number;
  serverIp: string;
  frpsReachable: boolean;
  tunnelEstablished: boolean;
  firewallOpen: boolean;
  detail: string;
  testTime: string;
};

export type ProbeSpeedHistory = {
  id: number;
  serverIp: string;
  frpsReachable: boolean;
  tunnelOk: boolean;
  downloadOk: boolean;
  downloadMbps: number;
  downloadMbs: number;
  downloadBytes: number;
  downloadSeconds: number;
  uploadOk: boolean;
  uploadMbps: number;
  uploadMbs: number;
  uploadBytes: number;
  uploadSeconds: number;
  detail: string;
  testTime: string;
};

export type ProbeRecentEntry = {
  ip: string;
  kind: 'connectivity' | 'speed';
  skipped: boolean;
  ok: boolean;
  summary: string;
};

export type ProbeWorker = {
  ip: string;
  step: string;
  text: string;
};

export type ProbeTestStatus = {
  running: boolean;
  mode: 'connectivity' | 'speed' | 'full' | '';
  phase: 'connectivity' | 'speed' | '';
  workers: ProbeWorker[];
  done: number;
  total: number;
  startedAt: string | null;
  finishedAt: string | null;
  stopped: boolean;
  recent: ProbeRecentEntry[];
};

export type ProbeTestConfig = {
  frpsPort: number;
  basePort: number;
  tcpingTimeout: number;
  tcpingRetries: number;
  tunnelWait: number;
  speedDuration: number;
  connConcurrency: number;
  speedConcurrency: number;
  hasOverride: boolean;
  running: boolean;
};

export type ProbeDashboard = {
  servers: number;
  connectivity: { tested: number; reachable: number; tunnels: number; firewallOpen: number };
  speed: { tested: number; avgDownloadMbps: number | null; avgUploadMbps: number | null; maxDownloadMbps: number | null };
};

// ---- 负载均衡（DDNS 域名池） ----

export type CloudflareInfo = {
  configured: boolean;
  tokenMasked: string;
};

export type CloudflareZone = {
  id: string;
  name: string;
};

export type LbDomain = {
  id: number;
  name: string;
  zoneId: string;
  zoneName: string;
  group: string;
  ttl: number;
  syncMode: 'manual' | 'scheduled';
  intervalSeconds: number;
  enabled: boolean;
  lastSyncAt: string | null;
  lastSyncOk: boolean | null;
  lastSyncMessage: string;
  createdAt: string;
  poolSize: number;
};

export type LbSyncResult = {
  ok: boolean;
  added: string[];
  removed: string[];
  kept: number;
  poolSize: number;
  unmanagedCount: number;
  errors: string[];
  message: string;
  syncedAt: string;
};

export type LbDnsRecord = {
  id: string;
  ip: string;
  ttl: number;
  managed: boolean;
};

export type LbSyncLog = {
  id: number;
  domainId: number;
  added: string[];
  removed: string[];
  kept: number;
  success: boolean;
  message: string;
  createdAt: string;
};
