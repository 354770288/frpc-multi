import type { InstanceStats } from './types';

export function parsePercent(value: string): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value.replace('%', '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

export function instanceStateLabel(stat: InstanceStats | undefined, enabled: boolean): { label: string; cls: string } {
  if (!stat || !stat.state) return { label: enabled ? '未运行' : '未启用', cls: 'status stopped' };
  const state = stat.state;
  if (state === 'running') return { label: '运行中', cls: 'status ok' };
  if (state === 'restarting') return { label: '重启中', cls: 'status' };
  if (state === 'paused') return { label: '已暂停', cls: 'status' };
  if (state === 'exited' || state === 'dead') {
    if (stat.exitCode !== null && stat.exitCode !== 0) {
      return { label: `异常退出 (${stat.exitCode})`, cls: 'status' };
    }
    return { label: '已停止', cls: 'status stopped' };
  }
  return { label: stat.status || state, cls: 'status' };
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
