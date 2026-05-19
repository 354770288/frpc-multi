import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../lib/api';
import type { ToastKind } from '../lib/types';

export function CreateInstance({
  toast,
  onCreated,
  onCancel
}: {
  toast: (kind: ToastKind, text: string) => void;
  onCreated: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [configText, setConfigText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<{ configText: string }>('/api/config/default')
      .then((data) => setConfigText(data.configText))
      .catch(() => setConfigText(''));
  }, []);

  async function create() {
    if (!name.trim()) {
      toast('error', '请填写实例名');
      return;
    }
    setSubmitting(true);
    try {
      await api('/api/instances', {
        method: 'POST',
        body: JSON.stringify({ name, displayName, configText, enabled: true, startAfterCreate: false })
      });
      toast('success', '实例创建成功');
      onCreated(name);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="content">
      <button className="back" onClick={onCancel}>
        返回
      </button>
      <h2>创建 frpc 实例</h2>
      <section className="editor-layout">
        <div className="panel create-panel">
          <label>实例名</label>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="client-001" />
          <label>显示名称</label>
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="家里 NAS"
          />
          <label>frpc.toml</label>
          <textarea
            value={configText}
            onChange={(event) => setConfigText(event.target.value)}
            spellCheck={false}
          />
          <button className="primary" onClick={create} disabled={submitting}>
            <Plus size={16} />
            {submitting ? '创建中…' : '创建实例'}
          </button>
        </div>
        <aside className="side-stack">
          <div className="panel">
            <h3>创建后会自动完成</h3>
            <p className="check ok">写入 instances/name/frpc.toml</p>
            <p className="check ok">写入 meta.json</p>
            <p className="check ok">重新生成 compose.generated.yaml</p>
          </div>
        </aside>
      </section>
    </main>
  );
}
