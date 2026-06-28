import { useEffect, useMemo, useState } from 'react';
import {
  KeyRound,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
  UploadCloud,
  XCircle
} from 'lucide-react';
import { nodesApi } from '../lib/api';
import { bytesToHuman, shortNodeUuid } from '../lib/format';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Field } from '../components/ui/Field';
import { Input } from '../components/ui/input';
import { Panel } from '../components/ui/Panel';
import {
  ConfirmNodeAction,
  ConnectionGuidePanel,
  InstallPanel,
  NodeHealthSummary,
  OfflineHint,
  StatusBadge,
  type NodeConfirmAction
} from './nodes/NodeParts';
import type { Node, NodeInstall, NodeInstanceHealth, SystemInfo, ToastKind } from '../lib/types';

type ConfirmState = {
  action: NodeConfirmAction;
  node: Node;
};

type NodeSystemSnapshot = Record<number, { info: SystemInfo | null; error: string | null }>;

export function NodesPage({
  toast,
  onChanged,
  nodeHealthById = {},
  nodeSystems = {}
}: {
  toast: (kind: ToastKind, text: string) => void;
  onChanged?: () => void;
  nodeHealthById?: Record<number, NodeInstanceHealth>;
  nodeSystems?: NodeSystemSnapshot;
}) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<Record<number, string>>({});
  const [install, setInstall] = useState<{ node: Node; info: NodeInstall } | null>(null);
  const [confirming, setConfirming] = useState<ConfirmState | null>(null);

  async function loadNodes() {
    setLoading(true);
    try {
      setNodes(await nodesApi.list());
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '节点加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadNodes();
    // 反转模型下节点上线靠 Agent 主动连回，这里轮询刷新在线状态。
    const timer = setInterval(loadNodes, 10000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const formError = useMemo(() => {
    if (!name.trim()) return '请填写节点名称';
    return '';
  }, [name]);

  const offlineCount = useMemo(
    () => nodes.filter((node) => !(node.online || node.status === 'online')).length,
    [nodes]
  );

  async function createNode() {
    if (formError) {
      toast('error', formError);
      return;
    }
    setSaving(true);
    try {
      const created = await nodesApi.create({ name: name.trim() });
      setName('');
      setInstall({ node: created, info: created.install });
      toast('success', '节点已创建，请在目标机运行安装命令');
      await loadNodes();
      onChanged?.();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '节点新增失败');
    } finally {
      setSaving(false);
    }
  }

  async function showInstall(node: Node) {
    setPending((prev) => ({ ...prev, [node.id]: 'install' }));
    try {
      const info = await nodesApi.install(node.id);
      setInstall({ node, info });
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '获取安装命令失败');
    } finally {
      setPending((prev) => {
        const next = { ...prev };
        delete next[node.id];
        return next;
      });
    }
  }

  async function rotateSecret(node: Node) {
    setPending((prev) => ({ ...prev, [node.id]: 'rotate' }));
    try {
      const updated = await nodesApi.rotateSecret(node.id);
      setInstall({ node: updated, info: updated.install });
      toast('success', `${node.name} 密钥已轮换`);
      await loadNodes();
      onChanged?.();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '轮换密钥失败');
    } finally {
      setPending((prev) => {
        const next = { ...prev };
        delete next[node.id];
        return next;
      });
    }
  }

  async function upgradeAgent(node: Node) {
    setPending((prev) => ({ ...prev, [node.id]: 'upgrade' }));
    try {
      const result = await nodesApi.upgradeAgent(node.id);
      toast(
        'success',
        result?.image
          ? `${node.name} Agent 升级已发起：${result.image}`
          : `${node.name} Agent 升级已发起`
      );
      await loadNodes();
      onChanged?.();
    } catch (err) {
      toast('error', `${node.name} Agent 升级失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setPending((prev) => {
        const next = { ...prev };
        delete next[node.id];
        return next;
      });
    }
  }

  async function deleteNode(node: Node) {
    setPending((prev) => ({ ...prev, [node.id]: 'delete' }));
    try {
      const result = await nodesApi.delete(node.id);
      if (install?.node.id === node.id) setInstall(null);
      if (result?.detail) {
        toast('info', result.detail);
      } else {
        toast('success', `${node.name} 及其实例已删除`);
      }
      await loadNodes();
      onChanged?.();
    } catch (err) {
      toast('error', `${node.name} 删除失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setPending((prev) => {
        const next = { ...prev };
        delete next[node.id];
        return next;
      });
    }
  }

  function confirmAction() {
    if (!confirming) return;
    const { action, node } = confirming;
    setConfirming(null);
    if (action === 'rotate') {
      rotateSecret(node);
    } else if (action === 'upgrade') {
      upgradeAgent(node);
    } else {
      deleteNode(node);
    }
  }

  return (
    <main className="px-6 py-6 max-w-[1600px]">
      <div className="mb-6 flex items-center gap-3">
        <h2 className="text-[18px] font-semibold tracking-tight text-[var(--color-fg)]">节点</h2>
        <Badge tone="muted">{nodes.length} 个</Badge>
        <Button className="ml-auto" onClick={loadNodes} disabled={loading}>
          <RefreshCw size={13} />
          刷新
        </Button>
      </div>

      <section className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-4">
        <div className="flex flex-col gap-4">
          <Panel title="节点列表" bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px]">
                <thead>
                  <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]">
                    <Th>名称</Th>
                    <Th>状态</Th>
                    <Th>实例健康</Th>
                    <Th>系统摘要</Th>
                    <Th>UUID</Th>
                    <Th>最近在线</Th>
                    <Th align="right">操作</Th>
                  </tr>
                </thead>
                <tbody>
                  {nodes.map((node) => (
                    <tr
                      key={node.id}
                      className="border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--color-surface-muted)] transition-colors"
                    >
                      <Td>
                        <span className="text-[13px] font-medium text-[var(--color-fg)]">{node.name}</span>
                        <OfflineHint node={node} />
                      </Td>
                      <Td>
                        <StatusBadge node={node} />
                      </Td>
                      <Td>
                        <NodeHealthSummary health={nodeHealthById[node.id]} />
                      </Td>
                      <Td>
                        <NodeSystemSummary node={node} snapshot={nodeSystems[node.id]} />
                      </Td>
                      <Td>
                        <span className="font-mono text-[11px] text-[var(--color-fg-muted)]">
                          {shortNodeUuid(node.uuid)}
                        </span>
                      </Td>
                      <Td>
                        <span className="text-[12px] text-[var(--color-fg-muted)]">
                          {node.lastSeenAt || '—'}
                        </span>
                      </Td>
                      <Td align="right">
                        <div className="flex items-center justify-end gap-1">
                          <Button size="sm" onClick={() => showInstall(node)} disabled={!!pending[node.id]}>
                            <Terminal size={13} />
                            安装命令
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => setConfirming({ action: 'rotate', node })}
                            disabled={!!pending[node.id]}
                          >
                            <KeyRound size={13} />
                            轮换密钥
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => setConfirming({ action: 'upgrade', node })}
                            disabled={!!pending[node.id] || !node.online}
                            title={node.online ? undefined : '离线节点需先接入 Agent，才能发起升级'}
                          >
                            <UploadCloud size={13} />
                            升级 Agent
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => setConfirming({ action: 'delete', node })}
                            disabled={!!pending[node.id]}
                          >
                            <Trash2 size={13} />
                            删除
                          </Button>
                        </div>
                      </Td>
                    </tr>
                  ))}
                  {!nodes.length && (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-[12px] text-[var(--color-fg-muted)]">
                        {loading ? '加载中…' : '暂无节点，先在右侧创建一个'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>

        <aside className="flex flex-col gap-4 xl:sticky xl:top-20 xl:self-start">
          {install && (
            <InstallPanel
              nodeName={install.node.name}
              info={install.info}
              onClose={() => setInstall(null)}
              toast={toast}
            />
          )}

          <ConnectionGuidePanel offlineCount={offlineCount} />

          <Panel title="新增节点">
            <div className="flex flex-col gap-4">
              <p className="text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
                创建节点后会生成一条一键安装命令。在目标机器上运行它，Agent 会主动连回主控并自动上线。
              </p>
              <Field label="节点名称">
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="vps-hk-01"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') createNode();
                  }}
                />
              </Field>
              {formError && (
                <div className="flex items-start gap-2 rounded-md bg-[var(--color-warning-soft)] p-2 text-[12px] text-[var(--color-warning)]">
                  <XCircle size={13} className="mt-0.5 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}
              <Button variant="default" onClick={createNode} disabled={saving || !!formError}>
                <Plus size={13} />
                {saving ? '创建中…' : '创建节点'}
              </Button>
            </div>
          </Panel>
        </aside>
      </section>

      {confirming && (
        <ConfirmNodeAction
          action={confirming.action}
          node={confirming.node}
          health={nodeHealthById[confirming.node.id]}
          onCancel={() => setConfirming(null)}
          onConfirm={confirmAction}
        />
      )}
    </main>
  );
}

function NodeSystemSummary({
  node,
  snapshot
}: {
  node: Node;
  snapshot?: { info: SystemInfo | null; error: string | null };
}) {
  const online = node.online || node.status === 'online';
  if (!online) {
    return <span className="text-[12px] text-[var(--color-fg-muted)]">Agent 未在线</span>;
  }
  if (!snapshot) {
    return <span className="text-[12px] text-[var(--color-fg-muted)]">加载中...</span>;
  }
  if (snapshot.error || !snapshot.info) {
    return (
      <span className="text-[12px] text-[var(--color-danger)]">
        系统信息不可达{snapshot.error ? `：${snapshot.error}` : ''}
      </span>
    );
  }
  const info = snapshot.info;
  const diskRatio = info.disk.total > 0 ? (info.disk.used / info.disk.total) * 100 : null;
  return (
    <div className="min-w-[240px] space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <SystemChip label="Agent" value="在线" tone="success" />
        <SystemChip label="Docker" value={info.dockerVersion || '未连接'} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <SystemChip label="frpc" value={info.frpVersion || info.frpImage || '未配置'} />
        <SystemChip
          label="磁盘"
          value={
            diskRatio === null
              ? '不可用'
              : `${diskRatio.toFixed(1)}% · ${bytesToHuman(info.disk.used)} / ${bytesToHuman(info.disk.total)}`
          }
          tone={diskRatio !== null && diskRatio >= 90 ? 'danger' : diskRatio !== null && diskRatio >= 75 ? 'warning' : 'muted'}
        />
      </div>
    </div>
  );
}

function SystemChip({
  label,
  value,
  tone = 'muted'
}: {
  label: string;
  value: string;
  tone?: 'success' | 'warning' | 'danger' | 'muted';
}) {
  const toneClass =
    tone === 'success'
      ? 'bg-[var(--color-success-soft)] text-[var(--color-success)]'
      : tone === 'warning'
        ? 'bg-[var(--color-warning-soft)] text-[var(--color-warning)]'
        : tone === 'danger'
          ? 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]'
          : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]';
  return (
    <span className={`inline-flex h-6 max-w-[240px] items-center gap-1 rounded-md px-2 text-[11px] ${toneClass}`}>
      <span>{label}</span>
      <span className="truncate font-mono text-[10px] tabular-nums">{value}</span>
    </span>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={`px-4 py-2.5 text-[11px] font-medium text-[var(--color-fg-muted)] ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = 'left'
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <td className={`px-4 py-3 align-middle ${align === 'right' ? 'text-right' : 'text-left'}`}>
      {children}
    </td>
  );
}
