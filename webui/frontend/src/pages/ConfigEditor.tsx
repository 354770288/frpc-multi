import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  XCircle
} from 'lucide-react';
import { api } from '../lib/api';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Panel } from '../components/ui/Panel';
import { Input, Textarea } from '../components/ui/Input';
import {
  PROXY_TYPES,
  createEmptyProxy,
  parseProxies,
  rewriteProxies,
  splitTomlAtProxies,
  validateProxy,
  type ProxyDraft
} from '../lib/proxyToml';
import type { ToastKind, ValidationData } from '../lib/types';

type EditorMode = 'raw' | 'structured';

export function ConfigEditor({
  name,
  toast
}: {
  name: string;
  toast: (kind: ToastKind, text: string) => void;
}) {
  const [configText, setConfigText] = useState('');
  const [originalText, setOriginalText] = useState('');
  const [validation, setValidation] = useState<ValidationData | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recreateAfterSave, setRecreateAfterSave] = useState(false);
  const [mode, setMode] = useState<EditorMode>('raw');

  useEffect(() => {
    if (!name) return;
    api<{ configText: string; validation: ValidationData }>(`/api/instances/${name}/config`)
      .then((data) => {
        setConfigText(data.configText);
        setOriginalText(data.configText);
        setValidation(data.validation);
      })
      .catch(() => {
        setConfigText('');
        setOriginalText('');
        setValidation(null);
      });
  }, [name]);

  useEffect(() => {
    if (!name) return;
    if (configText === originalText && validation) return;
    const handle = window.setTimeout(async () => {
      setValidating(true);
      try {
        const result = await api<ValidationData>(`/api/instances/${name}/config/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: configText
        });
        setValidation(result);
      } catch {
        // ignore — keep last validation
      } finally {
        setValidating(false);
      }
    }, 500);
    return () => window.clearTimeout(handle);
  }, [name, configText, originalText]);

  const dirty = configText !== originalText;

  async function save() {
    setSaving(true);
    try {
      await api<{ validation: ValidationData }>(`/api/instances/${name}/config`, {
        method: 'PUT',
        body: JSON.stringify({ configText, recreateAfterSave })
      });
      setOriginalText(configText);
      toast('success', recreateAfterSave ? '已保存并重新创建容器' : '已保存');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    try {
      const data = await api<{ configText: string }>(
        `/api/config/default?name=${encodeURIComponent(name)}`
      );
      setConfigText(data.configText);
      toast('info', '已载入默认配置，未保存前不会写入磁盘');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '载入默认配置失败');
    }
  }

  if (!name)
    return (
      <main className="px-6 py-6">
        <h2 className="text-[18px] font-semibold text-[var(--color-fg)]">请选择需要编辑的实例</h2>
      </main>
    );

  const errors = validation?.errors || [];
  const warnings = validation?.warnings || [];
  const summary = validation?.summary;

  let stateBadge: { tone: 'success' | 'warning' | 'danger' | 'muted'; label: string };
  if (validating) stateBadge = { tone: 'muted', label: '校验中…' };
  else if (errors.length) stateBadge = { tone: 'danger', label: `${errors.length} 个错误` };
  else if (dirty) stateBadge = { tone: 'warning', label: '未保存' };
  else stateBadge = { tone: 'success', label: '已同步' };

  const headerActions = (
    <>
      <label className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-fg-muted)] cursor-pointer select-none">
        <input
          type="checkbox"
          checked={recreateAfterSave}
          onChange={(event) => setRecreateAfterSave(event.target.checked)}
          className="w-3.5 h-3.5 accent-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] rounded-sm"
        />
        保存后重新创建容器
      </label>
      <Button onClick={reset} disabled={saving}>
        <RotateCcw size={13} />
        重置为默认
      </Button>
      <Button variant="primary" onClick={save} disabled={!dirty || saving || !!errors.length}>
        <Save size={13} />
        {saving ? '保存中…' : '保存'}
      </Button>
    </>
  );

  return (
    <main className="px-6 py-6 max-w-[1600px]">
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <h2 className="text-[18px] font-semibold tracking-tight text-[var(--color-fg)]">
          编辑配置
        </h2>
        <span className="text-[12px] text-[var(--color-fg-muted)] font-mono">
          {name} / frpc.toml
        </span>
        <Badge tone={stateBadge.tone}>{stateBadge.label}</Badge>
      </div>

      <div className="mb-4 flex items-center gap-1 border-b border-[var(--color-border)]">
        <TabButton active={mode === 'raw'} onClick={() => setMode('raw')}>
          原始 TOML
        </TabButton>
        <TabButton active={mode === 'structured'} onClick={() => setMode('structured')}>
          代理（结构化）
        </TabButton>
        <span className="ml-auto text-[11px] text-[var(--color-fg-muted)] pb-2">
          {mode === 'structured'
            ? '结构化编辑只影响 [[proxies]] 段，其他部分请用 TOML 模式'
            : '完整文本模式，适合高级用户'}
        </span>
      </div>

      <section className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-4">
        {mode === 'raw' ? (
          <Panel title="配置内容" actions={headerActions}>
            <Textarea
              value={configText}
              onChange={(event) => setConfigText(event.target.value)}
              spellCheck={false}
              className="min-h-[520px]"
            />
          </Panel>
        ) : (
          <Panel title="代理列表" actions={headerActions}>
            <StructuredProxyEditor
              configText={configText}
              onChange={setConfigText}
              toast={toast}
            />
          </Panel>
        )}

        <aside className="flex flex-col gap-4">
          <Panel title="校验结果">
            <div role="status" aria-live="polite">
              {!validation ? (
                <p className="text-[12px] text-[var(--color-fg-muted)]">等待校验…</p>
              ) : errors.length === 0 && warnings.length === 0 ? (
                <div className="flex items-start gap-2 text-[12px] text-[var(--color-success)]">
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>配置合法，可保存</span>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {errors.map((item, index) => (
                    <div
                      key={`err-${index}`}
                      className="flex items-start gap-2 p-2 rounded-md bg-[var(--color-danger-soft)] text-[12px] text-[var(--color-danger)]"
                    >
                      <XCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span>{item}</span>
                    </div>
                  ))}
                  {warnings.map((item, index) => (
                    <div
                      key={`warn-${index}`}
                      className="flex items-start gap-2 p-2 rounded-md bg-[var(--color-warning-soft)] text-[12px] text-[var(--color-warning)]"
                    >
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Panel>

          {summary && (
            <Panel title="配置摘要">
              <dl className="grid grid-cols-1 gap-3 text-[12px]">
                <SummaryItem label="服务端" value={summary.serverAddr} mono />
                <SummaryItem label="端口" value={summary.serverPort} mono />
                <SummaryItem label="认证方式" value={summary.authMethod} />
                <SummaryItem label="代理数量" value={summary.proxyCount} />
              </dl>
            </Panel>
          )}
        </aside>
      </section>
    </main>
  );
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

function StructuredProxyEditor({
  configText,
  onChange,
  toast
}: {
  configText: string;
  onChange: (next: string) => void;
  toast: (kind: ToastKind, text: string) => void;
}) {
  const drafts = useMemo(() => {
    const { proxiesBody } = splitTomlAtProxies(configText);
    return parseProxies(proxiesBody);
  }, [configText]);

  const [expanded, setExpanded] = useState<number | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);

  function commit(next: ProxyDraft[]) {
    onChange(rewriteProxies(configText, next));
  }

  function update(index: number, patch: Partial<ProxyDraft>) {
    const next = drafts.map((draft, i) => (i === index ? { ...draft, ...patch } : draft));
    commit(next);
  }

  function addProxy() {
    const next = [...drafts, createEmptyProxy()];
    commit(next);
    setExpanded(next.length - 1);
  }

  function removeProxy(index: number) {
    const next = drafts.filter((_, i) => i !== index);
    commit(next);
    setExpanded((current) => (current === index ? null : current));
    setConfirmingDelete(null);
    toast('info', '已删除该代理，未保存前不会写入磁盘');
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="text-[12px] text-[var(--color-fg-muted)]">
          共 {drafts.length} 条代理
        </div>
        <Button variant="primary" size="sm" onClick={addProxy}>
          <Plus size={12} />
          新增代理
        </Button>
      </div>

      <div className="rounded-md border border-[var(--color-border)] overflow-hidden">
        {drafts.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-[var(--color-fg-muted)]">
            还没有代理。点击「新增代理」开始配置。
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {drafts.map((draft, index) => (
              <li key={index}>
                <ProxyRow
                  draft={draft}
                  expanded={expanded === index}
                  confirmingDelete={confirmingDelete === index}
                  validationErrors={validateProxy(draft, drafts)}
                  onToggle={() =>
                    setExpanded((current) => (current === index ? null : index))
                  }
                  onChange={(patch) => update(index, patch)}
                  onAskDelete={() => setConfirmingDelete(index)}
                  onCancelDelete={() => setConfirmingDelete(null)}
                  onConfirmDelete={() => removeProxy(index)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-[11px] text-[var(--color-fg-muted)]">
        提示：结构化编辑只处理常用字段（name / type / localIP / localPort / remotePort / subdomain / customDomains）。
        如使用更多 frpc 字段，请回到「原始 TOML」模式编辑——切换 tab 时本段会按当前结构化结果重写，自定义字段会丢失。
      </p>
    </div>
  );
}

function ProxyRow({
  draft,
  expanded,
  confirmingDelete,
  validationErrors,
  onToggle,
  onChange,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete
}: {
  draft: ProxyDraft;
  expanded: boolean;
  confirmingDelete: boolean;
  validationErrors: string[];
  onToggle: () => void;
  onChange: (patch: Partial<ProxyDraft>) => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const summary = [
    draft.localIP || '—',
    draft.localPort ? `:${draft.localPort}` : '',
    draft.remotePort ? ` → :${draft.remotePort}` : '',
    draft.subdomain ? ` · ${draft.subdomain}` : ''
  ].join('');
  const invalid = validationErrors.length > 0;

  return (
    <div>
      <div
        className="flex items-center gap-3 px-3 py-2.5 hover:bg-[var(--color-surface-muted)] cursor-pointer"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        }}
      >
        <span className="text-[var(--color-fg-muted)] shrink-0">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="text-[13px] font-medium text-[var(--color-fg)] min-w-[120px]">
          {draft.name || <span className="text-[var(--color-fg-subtle)] italic">未命名</span>}
        </span>
        <span className="inline-flex items-center h-5 px-1.5 rounded bg-[var(--color-surface-muted)] border border-[var(--color-border)] text-[11px] font-mono text-[var(--color-fg-muted)]">
          {draft.type || '—'}
        </span>
        <span className="text-[11px] font-mono text-[var(--color-fg-muted)] truncate">
          {summary}
        </span>
        {invalid && (
          <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-danger)] ml-auto">
            <AlertTriangle size={12} />
            {validationErrors.length} 个问题
          </span>
        )}
      </div>
      {expanded && (
        <div className="px-3 py-3 bg-[var(--color-surface-muted)] border-t border-[var(--color-border)]">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormRow label="代理名">
              <Input
                value={draft.name}
                onChange={(event) => onChange({ name: event.target.value })}
                placeholder="ssh"
              />
            </FormRow>
            <FormRow label="类型">
              <select
                value={draft.type}
                onChange={(event) => onChange({ type: event.target.value })}
                className="w-full h-9 px-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/15"
              >
                {PROXY_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </FormRow>
            <FormRow label="本地 IP">
              <Input
                value={draft.localIP}
                onChange={(event) => onChange({ localIP: event.target.value })}
                placeholder="127.0.0.1 或 host.docker.internal"
              />
            </FormRow>
            <FormRow label="本地端口">
              <Input
                value={draft.localPort}
                onChange={(event) => onChange({ localPort: event.target.value })}
                inputMode="numeric"
                placeholder="22"
              />
            </FormRow>
            <FormRow
              label="远端端口"
              hint={draft.type === 'tcp' || draft.type === 'udp' ? '必填' : 'http/https 可不填'}
            >
              <Input
                value={draft.remotePort}
                onChange={(event) => onChange({ remotePort: event.target.value })}
                inputMode="numeric"
                placeholder="6001"
              />
            </FormRow>
            <FormRow label="子域名 (http/https)">
              <Input
                value={draft.subdomain}
                onChange={(event) => onChange({ subdomain: event.target.value })}
                placeholder="nas"
              />
            </FormRow>
            <FormRow label="自定义域名（逗号分隔）" full>
              <Input
                value={draft.customDomains}
                onChange={(event) => onChange({ customDomains: event.target.value })}
                placeholder="nas.example.com, files.example.com"
              />
            </FormRow>
          </div>
          {validationErrors.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1">
              {validationErrors.map((message, idx) => (
                <li
                  key={idx}
                  className="text-[11px] text-[var(--color-danger)] flex items-start gap-1.5"
                >
                  <XCircle size={11} className="mt-0.5 shrink-0" />
                  {message}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex justify-end gap-2">
            {confirmingDelete ? (
              <>
                <Button size="sm" onClick={onCancelDelete}>
                  取消
                </Button>
                <Button size="sm" variant="danger" onClick={onConfirmDelete}>
                  <Trash2 size={12} />
                  确认删除
                </Button>
              </>
            ) : (
              <Button size="sm" variant="danger" onClick={onAskDelete}>
                <Trash2 size={12} />
                删除该代理
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FormRow({
  label,
  hint,
  full,
  children
}: {
  label: string;
  hint?: string;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1 ${full ? 'sm:col-span-2' : ''}`}>
      <span className="text-[11px] font-medium text-[var(--color-fg-muted)]">
        {label}
        {hint && <span className="ml-1.5 text-[10px] text-[var(--color-fg-subtle)]">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function SummaryItem({
  label,
  value,
  mono = false
}: {
  label: string;
  value?: string | number | null;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[var(--color-fg-muted)]">{label}</dt>
      <dd
        className={`text-[var(--color-fg)] font-medium ${mono ? 'font-mono tabular-nums' : ''}`}
      >
        {value ?? '—'}
      </dd>
    </div>
  );
}
