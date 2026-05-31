import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ClipboardCopy,
  KeyRound,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
  UploadCloud,
  XCircle
} from 'lucide-react';
import { nodesApi } from '../lib/api';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Input } from '../components/ui/Input';
import { Panel } from '../components/ui/Panel';
import type { Node, NodeInstall, ToastKind } from '../lib/types';

export function NodesPage({
  toast,
  onChanged
}: {
  toast: (kind: ToastKind, text: string) => void;
  onChanged?: () => void;
}) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<Record<number, string>>({});
  // 当前展示安装命令的节点（新建或点"安装命令"后填充）。
  const [install, setInstall] = useState<{ node: Node; info: NodeInstall } | null>(null);

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
    if (!window.confirm(`轮换 ${node.name} 的密钥？旧 Agent 需用新命令重新部署才能再次连上。`)) return;
    setPending((prev) => ({ ...prev, [node.id]: 'rotate' }));
    try {
      const updated = await nodesApi.rotateSecret(node.id);
      setInstall({ node: updated, info: updated.install });
      toast('success', `${node.name} 密钥已轮换`);
      await loadNodes();
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
    if (
      !window.confirm(
        `确认升级节点「${node.name}」的 Agent？\n\n` +
          `面板会让该 Agent 拉取当前镜像标签的最新版本，并用 docker run 模式重建 Agent 容器。\n` +
          `升级过程中节点会短暂离线，稍后应自动重新上线。`
      )
    )
      return;
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
    if (
      !window.confirm(
        `确认删除节点「${node.name}」？\n\n` +
          `⚠️ 该节点下的所有 frpc 实例将一并被删除：\n` +
          `· 停止并移除所有实例容器\n` +
          `· 删除所有实例配置目录\n` +
          `· 卸载并移除该节点的 Agent 容器\n\n` +
          `此操作不可撤销，请谨慎选择。`
      )
    )
      return;
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

      <section className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-4">
        <div className="flex flex-col gap-4">
          <Panel title="节点列表" bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]">
                    <Th>名称</Th>
                    <Th>状态</Th>
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
                      </Td>
                      <Td>
                        <StatusBadge node={node} />
                      </Td>
                      <Td>
                        <span className="font-mono text-[11px] text-[var(--color-fg-muted)]">
                          {node.uuid.slice(0, 12)}…
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
                            onClick={() => rotateSecret(node)}
                            disabled={!!pending[node.id]}
                          >
                            <KeyRound size={13} />
                            轮换密钥
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => upgradeAgent(node)}
                            disabled={!!pending[node.id] || !node.online}
                          >
                            <UploadCloud size={13} />
                            升级 Agent
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => deleteNode(node)}
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
                      <td colSpan={5} className="px-4 py-10 text-center text-[12px] text-[var(--color-fg-muted)]">
                        {loading ? '加载中…' : '暂无节点，先在右侧创建一个'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          {install && (
            <InstallPanel
              nodeName={install.node.name}
              info={install.info}
              onClose={() => setInstall(null)}
              toast={toast}
            />
          )}
        </div>

        <Panel title="新增节点">
          <div className="flex flex-col gap-4">
            <p className="text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
              创建节点后会生成一条一键安装命令。在目标机器上运行它，Agent 会主动连回主控并自动上线，
              目标机无需公网或开放任何入站端口。
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
            <Button variant="primary" onClick={createNode} disabled={saving || !!formError}>
              <Plus size={13} />
              {saving ? '创建中…' : '创建节点'}
            </Button>
          </div>
        </Panel>
      </section>
    </main>
  );
}

function InstallPanel({
  nodeName,
  info,
  onClose,
  toast
}: {
  nodeName: string;
  info: NodeInstall;
  onClose: () => void;
  toast: (kind: ToastKind, text: string) => void;
}) {
  async function copy(text: string, label: string) {
    // navigator.clipboard 仅在安全上下文（HTTPS / localhost）可用。
    // 裸 HTTP（如 http://VPS_IP:8081）下它是 undefined，需降级到 execCommand。
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        toast('success', `${label}已复制`);
        return;
      } catch {
        // 落到下面的降级方案
      }
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (ok) {
        toast('success', `${label}已复制`);
      } else {
        toast('error', '复制失败，请手动选择文本复制');
      }
    } catch {
      toast('error', '复制失败，请手动选择文本复制');
    }
  }

  return (
    <Panel title={`安装命令 · ${nodeName}`}>
      <div className="flex flex-col gap-3">
        {!info.serverConfigured && (
          <div className="flex items-start gap-2 rounded-md bg-[var(--color-warning-soft)] p-2 text-[12px] text-[var(--color-warning)]">
            <XCircle size={13} className="mt-0.5 shrink-0" />
            <span>
              主控未配置对外可达地址（CONSOLE_PUBLIC_HOST），命令里的 <code>{info.server}</code> 需手动替换为
              Agent 能访问到的主控地址。
            </span>
          </div>
        )}
        <p className="text-[12px] text-[var(--color-fg-muted)]">
          在目标机器上以 root（或有 docker 权限的用户）运行：
        </p>
        <div className="relative">
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 pr-10 font-mono text-[11px] leading-relaxed text-[var(--color-fg)]">
            {info.installCommand}
          </pre>
          <button
            type="button"
            onClick={() => copy(info.installCommand, '安装命令')}
            className="absolute right-2 top-2 rounded p-1.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]"
            title="复制"
          >
            <ClipboardCopy size={14} />
          </button>
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px]">
          <span className="text-[var(--color-fg-muted)]">主控地址</span>
          <span className="font-mono text-[var(--color-fg)]">{info.server}</span>
          <span className="text-[var(--color-fg-muted)]">UUID</span>
          <span className="font-mono text-[var(--color-fg)]">{info.uuid}</span>
          <span className="text-[var(--color-fg-muted)]">TLS</span>
          <span className="font-mono text-[var(--color-fg)]">{info.tls ? 'wss（已启用）' : 'ws（未启用）'}</span>
          <span className="text-[var(--color-fg-muted)]">镜像</span>
          <span className="font-mono text-[var(--color-fg)]">{info.image}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => copy(info.installCommand, '安装命令')}>
            <ClipboardCopy size={13} />
            复制命令
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </div>
        <p className="text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
          密钥仅在创建/轮换时展示一次。如需重新查看可点节点行的"安装命令"，但出于安全考虑请妥善保管。
        </p>
      </div>
    </Panel>
  );
}

function StatusBadge({ node }: { node: Node }) {
  if (node.online || node.status === 'online') {
    return (
      <Badge tone="success">
        <CheckCircle2 size={12} />
        在线
      </Badge>
    );
  }
  if (node.status === 'pending') {
    return <Badge tone="muted">待连接</Badge>;
  }
  if (node.status === 'offline' || node.status === 'error') {
    return (
      <Badge tone="danger">
        <XCircle size={12} />
        离线
      </Badge>
    );
  }
  return <Badge tone="muted">未知</Badge>;
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
