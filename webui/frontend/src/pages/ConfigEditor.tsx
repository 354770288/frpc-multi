import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  RotateCcw,
  Save,
  XCircle
} from 'lucide-react';
import { api } from '../lib/api';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Panel } from '../components/ui/Panel';
import { Textarea } from '../components/ui/Input';
import { ProxyList } from '../components/ProxyList';
import {
  parseProxies,
  rewriteProxies,
  splitTomlAtProxies,
  type ProxyDraft
} from '../lib/proxyToml';
import type { ToastKind, ValidationData } from '../lib/types';

type EditorMode = 'structured' | 'raw';

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
  const [restartAfterSave, setRestartAfterSave] = useState(true);
  const [mode, setMode] = useState<EditorMode>('structured');

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
        body: JSON.stringify({ configText, restartAfterSave })
      });
      setOriginalText(configText);
      toast('success', restartAfterSave ? '已保存并重启容器' : '已保存');
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
          checked={restartAfterSave}
          onChange={(event) => setRestartAfterSave(event.target.checked)}
          className="w-3.5 h-3.5 accent-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] rounded-sm"
        />
        保存后重启容器
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
        <TabButton active={mode === 'structured'} onClick={() => setMode('structured')}>
          代理（结构化）
        </TabButton>
        <TabButton active={mode === 'raw'} onClick={() => setMode('raw')}>
          原始 TOML
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

  function handleChange(next: ProxyDraft[]) {
    onChange(rewriteProxies(configText, next));
  }

  return (
    <div className="flex flex-col gap-3">
      <ProxyList proxies={drafts} onChange={handleChange} toast={toast} />
      <p className="text-[11px] text-[var(--color-fg-muted)]">
        提示：结构化编辑只处理常用字段（name / type / localIP / localPort / remotePort / subdomain / customDomains）。
        如使用更多 frpc 字段，请回到「原始 TOML」模式编辑——切换 tab 时本段会按当前结构化结果重写，自定义字段会丢失。
      </p>
    </div>
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
