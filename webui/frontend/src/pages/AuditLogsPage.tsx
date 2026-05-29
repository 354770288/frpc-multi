import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { auditLogsApi } from '../lib/api';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Panel } from '../components/ui/Panel';
import type { AuditLog, Node, ToastKind } from '../lib/types';

const ACTION_LABEL: Record<string, string> = {
  create_instance: '创建实例',
  patch_instance: '更新实例',
  update_config: '修改配置',
  delete_instance: '删除实例',
  start_instance: '启动',
  stop_instance: '停止',
  restart_instance: '重启',
  recreate_instance: '重建'
};

export function AuditLogsPage({
  nodes,
  toast
}: {
  nodes: Node[];
  toast: (kind: ToastKind, text: string) => void;
}) {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);

  const nodeNameById = useMemo(() => new Map(nodes.map((node) => [node.id, node.name])), [nodes]);

  async function loadLogs() {
    setLoading(true);
    try {
      setLogs(await auditLogsApi.list(200));
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '审计日志加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="px-6 py-6 max-w-[1600px]">
      <div className="mb-6 flex items-center gap-3">
        <h2 className="text-[18px] font-semibold tracking-tight text-[var(--color-fg)]">
          审计日志
        </h2>
        <Badge tone="muted">{logs.length} 条</Badge>
        <Button className="ml-auto" onClick={loadLogs} disabled={loading}>
          <RefreshCw size={13} />
          刷新
        </Button>
      </div>

      <Panel title="最近操作" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]">
                <Th>时间</Th>
                <Th>操作人</Th>
                <Th>动作</Th>
                <Th>节点</Th>
                <Th>实例</Th>
                <Th>结果</Th>
                <Th>消息</Th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr
                  key={log.id}
                  className="border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--color-surface-muted)] transition-colors"
                >
                  <Td mono>{formatTime(log.createdAt)}</Td>
                  <Td>{log.username || '—'}</Td>
                  <Td>{ACTION_LABEL[log.action] || log.action}</Td>
                  <Td>{nodeLabel(log.nodeId, nodeNameById)}</Td>
                  <Td mono>{log.instanceName || '—'}</Td>
                  <Td>
                    {log.success ? (
                      <Badge tone="success">
                        <CheckCircle2 size={12} />
                        成功
                      </Badge>
                    ) : (
                      <Badge tone="danger">
                        <XCircle size={12} />
                        失败
                      </Badge>
                    )}
                  </Td>
                  <Td>
                    <span className="text-[12px] text-[var(--color-fg-muted)]">
                      {log.message || '—'}
                    </span>
                  </Td>
                </tr>
              ))}
              {!logs.length && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-10 text-center text-[12px] text-[var(--color-fg-muted)]"
                  >
                    {loading ? '加载中…' : '暂无审计记录'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </main>
  );
}

function nodeLabel(nodeId: number | null, nodeNameById: Map<number, string>): string {
  if (nodeId === null) return '本机';
  return nodeNameById.get(nodeId) || `节点 #${nodeId}`;
}

function formatTime(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-2.5 text-left text-[11px] font-medium text-[var(--color-fg-muted)]">
      {children}
    </th>
  );
}

function Td({
  children,
  mono = false
}: {
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <td
      className={`px-4 py-2.5 text-[13px] text-[var(--color-fg)] ${mono ? 'font-mono tabular-nums text-[12px] text-[var(--color-fg-muted)]' : ''}`}
    >
      {children}
    </td>
  );
}
