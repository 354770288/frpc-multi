import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, PlugZap, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { nodesApi, type NodeCreatePayload } from '../lib/api';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Input } from '../components/ui/Input';
import { Panel } from '../components/ui/Panel';
import type { Node, ToastKind } from '../lib/types';

const EMPTY_FORM: NodeCreatePayload = {
  name: '',
  baseUrl: '',
  token: ''
};

export function NodesPage({
  toast
}: {
  toast: (kind: ToastKind, text: string) => void;
}) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [form, setForm] = useState<NodeCreatePayload>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<Record<number, string>>({});

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const formError = useMemo(() => {
    if (!form.name.trim()) return '请填写节点名称';
    if (!form.baseUrl.trim()) return '请填写 Agent 地址';
    if (!/^https?:\/\//i.test(form.baseUrl.trim())) return 'Agent 地址需要以 http:// 或 https:// 开头';
    if (!form.token.trim()) return '请填写 Agent token';
    return '';
  }, [form]);

  async function createNode() {
    if (formError) {
      toast('error', formError);
      return;
    }
    setSaving(true);
    try {
      await nodesApi.create({
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        token: form.token.trim()
      });
      setForm(EMPTY_FORM);
      toast('success', '节点已新增');
      await loadNodes();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '节点新增失败');
    } finally {
      setSaving(false);
    }
  }

  async function pingNode(node: Node) {
    setPending((prev) => ({ ...prev, [node.id]: 'ping' }));
    try {
      await nodesApi.ping(node.id);
      toast('success', `${node.name} 连接正常`);
      await loadNodes();
    } catch (err) {
      toast('error', `${node.name} 连接失败：${err instanceof Error ? err.message : '未知错误'}`);
      await loadNodes();
    } finally {
      setPending((prev) => {
        const next = { ...prev };
        delete next[node.id];
        return next;
      });
    }
  }

  async function deleteNode(node: Node) {
    if (!window.confirm(`确认删除节点 ${node.name}？`)) return;
    setPending((prev) => ({ ...prev, [node.id]: 'delete' }));
    try {
      await nodesApi.delete(node.id);
      toast('success', `${node.name} 已删除`);
      await loadNodes();
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
        <Panel title="节点列表" bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]">
                  <Th>名称</Th>
                  <Th>状态</Th>
                  <Th>Agent 地址</Th>
                  <Th>最近连接</Th>
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
                      <span className="font-mono text-[11px] text-[var(--color-fg-muted)]">{node.baseUrl}</span>
                    </Td>
                    <Td>
                      <span className="text-[12px] text-[var(--color-fg-muted)]">
                        {node.lastSeenAt || '—'}
                      </span>
                    </Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-1">
                        <Button size="sm" onClick={() => pingNode(node)} disabled={!!pending[node.id]}>
                          <PlugZap size={13} />
                          测试
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
                      {loading ? '加载中…' : '暂无节点'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="新增节点">
          <div className="flex flex-col gap-4">
            <Field label="节点名称">
              <Input
                value={form.name}
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="vps-hk-01"
              />
            </Field>
            <Field label="Agent 地址">
              <Input
                value={form.baseUrl}
                onChange={(event) => setForm((prev) => ({ ...prev, baseUrl: event.target.value }))}
                placeholder="http://127.0.0.1:8082"
              />
            </Field>
            <Field label="Agent token">
              <Input
                type="password"
                value={form.token}
                onChange={(event) => setForm((prev) => ({ ...prev, token: event.target.value }))}
                autoComplete="off"
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
              {saving ? '新增中…' : '新增节点'}
            </Button>
          </div>
        </Panel>
      </section>
    </main>
  );
}

function StatusBadge({ node }: { node: Node }) {
  if (node.status === 'online') {
    return (
      <Badge tone="success">
        <CheckCircle2 size={12} />
        在线
      </Badge>
    );
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
