import { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Plus } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Input, Textarea } from '../components/ui/Input';
import { Panel } from '../components/ui/Panel';
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
  const [description, setDescription] = useState('');
  const [configText, setConfigText] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [startAfterCreate, setStartAfterCreate] = useState(false);
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
        body: JSON.stringify({
          name,
          displayName,
          description,
          configText,
          enabled,
          startAfterCreate: enabled && startAfterCreate
        })
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
    <main className="px-6 py-6 max-w-[1600px]">
      <button
        onClick={onCancel}
        className="inline-flex items-center gap-1.5 mb-4 text-[12px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] rounded-sm"
      >
        <ArrowLeft size={13} />
        返回总览
      </button>

      <h2 className="mb-6 text-[18px] font-semibold tracking-tight text-[var(--color-fg)]">
        创建 frpc 实例
      </h2>

      <section className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-4">
        <Panel title="基本信息">
          <div className="flex flex-col gap-4">
            <Field
              label="实例名"
              hint="只能包含字母、数字、下划线和短横线，作为目录与容器名"
            >
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="client-001"
              />
            </Field>
            <Field label="显示名称" hint="可选，仅用于界面展示">
              <Input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="家里 NAS"
              />
            </Field>
            <Field label="备注描述" hint="可选，方便区分用途，比如「家里 NAS」「办公室相机」">
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="家中 NAS，SSH + 文件下载"
              />
            </Field>
            <Field label="frpc.toml" hint="实例的初始配置内容，创建后仍可在配置页编辑">
              <Textarea
                value={configText}
                onChange={(event) => setConfigText(event.target.value)}
                spellCheck={false}
                className="min-h-[420px]"
              />
            </Field>
            <div className="flex flex-col gap-2 pt-1">
              <Toggle
                checked={enabled}
                onChange={setEnabled}
                label="启用该实例"
                hint="关闭时仅保留配置，不写入 compose.generated.yaml，也不会被启动"
              />
              <Toggle
                checked={enabled && startAfterCreate}
                disabled={!enabled}
                onChange={setStartAfterCreate}
                label="创建后立即启动"
                hint={enabled ? '勾选则在写入后自动 docker compose up' : '需要先启用该实例'}
              />
            </div>
            <div className="flex justify-end pt-2">
              <Button variant="primary" onClick={create} disabled={submitting}>
                <Plus size={13} />
                {submitting ? '创建中…' : '创建实例'}
              </Button>
            </div>
          </div>
        </Panel>

        <aside>
          <Panel title="创建后自动完成">
            <ul className="flex flex-col gap-2.5 text-[12px] text-[var(--color-fg-muted)]">
              <ChecklistItem>
                写入 <code className="font-mono text-[11px] text-[var(--color-fg)]">instances/{name || '<name>'}/frpc.toml</code>
              </ChecklistItem>
              <ChecklistItem>写入 meta.json</ChecklistItem>
              <ChecklistItem>重新生成 compose.generated.yaml</ChecklistItem>
              {enabled && startAfterCreate && <ChecklistItem>docker compose up -d 启动该实例</ChecklistItem>}
            </ul>
          </Panel>
        </aside>
      </section>
    </main>
  );
}

function ChecklistItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <CheckCircle2
        size={13}
        className="mt-0.5 shrink-0 text-[var(--color-success)]"
      />
      <span>{children}</span>
    </li>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-3 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`mt-0.5 relative inline-flex w-9 h-5 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] ${
          checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
        }`}
      >
        <span
          className={`absolute top-0.5 inline-block w-4 h-4 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-[18px]' : 'translate-x-0.5'
          }`}
        />
      </button>
      <span className="flex flex-col gap-0.5">
        <span className="text-[12px] font-medium text-[var(--color-fg)]">{label}</span>
        {hint && <span className="text-[11px] text-[var(--color-fg-muted)]">{hint}</span>}
      </span>
    </label>
  );
}
