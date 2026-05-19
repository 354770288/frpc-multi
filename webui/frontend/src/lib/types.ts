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

export type Page = 'overview' | 'detail' | 'config' | 'create' | 'system';

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
