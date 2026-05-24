import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Plus,
  XCircle
} from 'lucide-react';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Input, Textarea } from '../components/ui/Input';
import { Panel } from '../components/ui/Panel';
import { Badge } from '../components/ui/Badge';
import { ProxyList } from '../components/ProxyList';
import {
  emptyFrpcConfig,
  parseFrpcConfig,
  serializeFrpcConfig,
  validateFrpcDraft,
  type FrpcConfigDraft,
  type ProxyDraft
} from '../lib/proxyToml';
import type { Instance, ToastKind } from '../lib/types';

const INSTANCE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

type EditorMode = 'structured' | 'raw';

export function CreateInstance({
  toast,
  instances,
  onCreated,
  onCancel
}: {
  toast: (kind: ToastKind, text: string) => void;
  instances: Instance[];
  onCreated: (name: string) => void;
  onCancel: () => void;
}) {
  const defaultName = useMemo(() => nextClientName(instances), [instances]);
  const initialConfigText = useMemo(() => serializeFrpcConfig(emptyFrpcConfig()), []);

  const [name, setName] = useState(defaultName);
  const [nameDirty, setNameDirty] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [startAfterCreate, setStartAfterCreate] = useState(false);
  const [configText, setConfigText] = useState(initialConfigText);
  const [mode, setMode] = useState<EditorMode>('structured');
  const [submitting, setSubmitting] = useState(false);

  // Re-sync the suggested name once the instance list arrives (the user
  // hasn't typed yet — let the default catch up to the real instances).
  useEffect(() => {
    if (!nameDirty) setName(nextClientName(instances));
  }, [instances, nameDirty]);

  const structured = useMemo(() => parseFrpcConfig(configText), [configText]);
  const structuredErrors = useMemo(() => validateFrpcDraft(structured), [structured]);

  function updateStructured(patch: Partial<FrpcConfigDraft>) {
    const next = { ...structured, ...patch };
    setConfigText(serializeFrpcConfig(next));
  }

  function updateProxies(proxies: ProxyDraft[]) {
    updateStructured({ proxies });
  }

  const nameError = name.trim() === ''
    ? '请填写实例名'
    : INSTANCE_NAME_RE.test(name.trim())
      ? instances.some((item) => item.name === name.trim())
        ? '该实例名已存在'
        : null
      : '只能包含小写字母、数字和短横线，长度 3-40，且不能以短横线开头或结尾';

  const canSubmit = !submitting && !nameError && structuredErrors.length === 0;

  async function create() {
    if (nameError) {
      toast('error', nameError);
      return;
    }
    if (structuredErrors.length) {
      toast('error', structuredErrors[0]);
      return;
    }
    setSubmitting(true);
    try {
      await api('/api/instances', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          displayName,
          description,
          configText,
          enabled,
          startAfterCreate: enabled && startAfterCreate
        })
      });
      toast('success', '实例创建成功');
      onCreated(name.trim());
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

      <div className="mb-2 flex items-center gap-3 flex-wrap">
        <h2 className="text-[18px] font-semibold tracking-tight text-[var(--color-fg)]">
          创建 frpc 实例
        </h2>
        {structuredErrors.length === 0 && !nameError ? (
          <Badge tone="success">校验通过</Badge>
        ) : (
          <Badge tone="warning">
            {structuredErrors.length + (nameError ? 1 : 0)} 项待完善
          </Badge>
        )}
      </div>

      <div className="mb-4 flex items-center gap-1 border-b border-[var(--color-border)]">
        <TabButton active={mode === 'structured'} onClick={() => setMode('structured')}>
          结构化
        </TabButton>
        <TabButton active={mode === 'raw'} onClick={() => setMode('raw')}>
          原始 TOML
        </TabButton>
        <span className="ml-auto text-[11px] text-[var(--color-fg-muted)] pb-2">
          {mode === 'structured'
            ? '常用字段表单，会按当前内容生成 frpc.toml'
            : '直接编辑生成的 TOML，回到结构化页时会按 TOML 内容重新解析'}
        </span>
      </div>

      <section className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-4">
        <div className="flex flex-col gap-4">
          {mode === 'structured' ? (
            <>
              <Panel title="实例">
                <div className="flex flex-col gap-4">
                  <Field
                    label="实例名"
                    hint="只能包含小写字母、数字和短横线；默认会自动递增 client-NNN"
                  >
                    <Input
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                        setNameDirty(true);
                      }}
                      placeholder="client-001"
                      aria-invalid={!!nameError}
                    />
                  </Field>
                  {nameError && (
                    <ErrorLine>{nameError}</ErrorLine>
                  )}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Field label="显示名称" hint="可选，仅用于界面展示">
                      <Input
                        value={displayName}
                        onChange={(event) => setDisplayName(event.target.value)}
                        placeholder="家里 NAS"
                      />
                    </Field>
                    <Field label="备注描述" hint="可选，方便区分用途">
                      <Input
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        placeholder="家中 NAS，SSH + 文件下载"
                      />
                    </Field>
                  </div>
                </div>
              </Panel>

              <Panel title="连接 frps">
                <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_140px] gap-4">
                  <Field label="服务器地址" hint="必填，frps 主机名或 IP">
                    <Input
                      value={structured.serverAddr}
                      onChange={(event) => updateStructured({ serverAddr: event.target.value })}
                      placeholder="frps.example.com"
                      aria-invalid={!structured.serverAddr.trim()}
                    />
                  </Field>
                  <Field label="端口" hint="可选，默认 7000">
                    <Input
                      value={structured.serverPort}
                      onChange={(event) => updateStructured({ serverPort: event.target.value })}
                      placeholder="7000"
                      inputMode="numeric"
                    />
                  </Field>
                </div>
                <div className="mt-4">
                  <Field
                    label="认证密钥 (auth.token)"
                    hint="可选，未填则在 TOML 中注释整个 [auth] 段"
                  >
                    <Input
                      type="password"
                      value={structured.authToken}
                      onChange={(event) => updateStructured({ authToken: event.target.value })}
                      placeholder="留空表示 frps 端未启用 token 认证"
                      autoComplete="off"
                    />
                  </Field>
                </div>
              </Panel>

              <Panel title="代理">
                <ProxyList
                  proxies={structured.proxies}
                  onChange={updateProxies}
                  toast={toast}
                  emptyHint="还没有代理。点击「新增代理」开始配置内网穿透。"
                />
              </Panel>
            </>
          ) : (
            <Panel
              title="frpc.toml"
              actions={
                <span className="text-[11px] text-[var(--color-fg-muted)]">
                  自动生成；可直接编辑
                </span>
              }
            >
              <Textarea
                value={configText}
                onChange={(event) => setConfigText(event.target.value)}
                spellCheck={false}
                className="min-h-[480px]"
              />
            </Panel>
          )}

          <Panel title="选项">
            <div className="flex flex-col gap-2">
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
          </Panel>

          <div className="flex justify-end">
            <Button variant="primary" onClick={create} disabled={!canSubmit}>
              <Plus size={13} />
              {submitting ? '创建中…' : '创建实例'}
            </Button>
          </div>
        </div>

        <aside className="flex flex-col gap-4">
          <Panel title="校验结果">
            <div role="status" aria-live="polite">
              {structuredErrors.length === 0 && !nameError ? (
                <div className="flex items-start gap-2 text-[12px] text-[var(--color-success)]">
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>可创建</span>
                </div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {nameError && (
                    <li className="flex items-start gap-2 p-2 rounded-md bg-[var(--color-danger-soft)] text-[12px] text-[var(--color-danger)]">
                      <XCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span>{nameError}</span>
                    </li>
                  )}
                  {structuredErrors.map((message, idx) => (
                    <li
                      key={idx}
                      className="flex items-start gap-2 p-2 rounded-md bg-[var(--color-warning-soft)] text-[12px] text-[var(--color-warning)]"
                    >
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span>{message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>

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

function nextClientName(instances: Instance[]): string {
  const numbers: number[] = [];
  for (const item of instances) {
    const match = /^client-(\d{1,6})$/.exec(item.name);
    if (match) numbers.push(Number(match[1]));
  }
  const next = numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
  return `client-${String(next).padStart(3, '0')}`;
}

function TabButton({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-2 -mb-px border-b-2 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] rounded-t-sm ${
        active
          ? 'border-[var(--color-accent)] text-[var(--color-fg)]'
          : 'border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
      }`}
    >
      {children}
    </button>
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

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="-mt-2 inline-flex items-start gap-1.5 text-[11px] text-[var(--color-danger)]">
      <XCircle size={11} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
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
