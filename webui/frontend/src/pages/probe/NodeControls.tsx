import type { ProbeMode } from '../../lib/types';

export const MODE_NAMES: Record<ProbeMode, string> = {
  discover: '网段发现',
  route: '路由追踪',
  connectivity: '连通性',
  speed: '速率',
  full: '完整测试',
};
