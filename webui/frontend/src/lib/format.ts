import type { InstanceStats } from './types';

export function parsePercent(value: string): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value.replace('%', '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

export type InstanceTone = 'success' | 'warning' | 'danger' | 'muted';

export function instanceStateBadge(
  stat: InstanceStats | undefined,
  enabled: boolean
): { label: string; tone: InstanceTone } {
  if (!stat || !stat.state) {
    return { label: enabled ? '未运行' : '未启用', tone: 'muted' };
  }
  const state = stat.state;
  if (state === 'running') return { label: '运行中', tone: 'success' };
  if (state === 'restarting') return { label: '重启中', tone: 'warning' };
  if (state === 'paused') return { label: '已暂停', tone: 'warning' };
  if (state === 'exited' || state === 'dead') {
    if (stat.exitCode !== null && stat.exitCode !== 0) {
      return { label: `异常退出 (${stat.exitCode})`, tone: 'danger' };
    }
    return { label: '已停止', tone: 'muted' };
  }
  return { label: stat.status || state, tone: 'muted' };
}

export function bytesToHuman(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`;
}

export function shortNodeUuid(value: string | null | undefined, length = 12): string {
  const normalized = (value || '').trim();
  if (!normalized) return '未注册';
  return normalized.length > length ? `${normalized.slice(0, length)}...` : normalized;
}

export function actionLabel(verb: string): string {
  switch (verb) {
    case 'start':
      return '启动';
    case 'stop':
      return '停止';
    case 'restart':
      return '重启';
    case 'recreate':
      return '重建';
    default:
      return verb;
  }
}
