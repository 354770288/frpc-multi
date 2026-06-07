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

export type Page =
  | 'overview'
  | 'nodes'
  | 'audit'
  | 'detail'
  | 'config'
  | 'create'
  | 'system';

export type AuthState = {
  token: string;
  username: string;
  expiresAt: number;
};

export type ToastKind = 'success' | 'error' | 'info';
export type Toast = { id: number; kind: ToastKind; text: string };

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
