import { useEffect, useState } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import { api } from '../lib/api';
import type { ToastKind, ValidationData } from '../lib/types';

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
        // 校验失败不致命
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
    if (!window.confirm('确认将编辑器内容覆盖为默认 frpc 配置？该操作仅修改编辑器，未保存前不会写入磁盘。')) return;
    try {
      const data = await api<{ configText: string }>(`/api/config/default?name=${encodeURIComponent(name)}`);
      setConfigText(data.configText);
      toast('info', '已载入默认配置，请确认后点击保存');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '载入默认配置失败');
    }
  }

  if (!name)
    return (
      <main className="content">
        <h2>请选择需要编辑的实例</h2>
      </main>
    );

  const errors = validation?.errors || [];
  const warnings = validation?.warnings || [];
  const summary = validation?.summary;

  return (
    <main className="content">
      <h2>
        编辑配置：{name} / frpc.toml{' '}
        <span>{validating ? '校验中…' : dirty ? '未保存' : '已同步'}</span>
      </h2>
      <section className="editor-layout">
        <div className="panel editor-panel">
          <div className="panel-head">
            <h3>配置内容</h3>
            <div className="row-actions">
              <label className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={recreateAfterSave}
                  onChange={(event) => setRecreateAfterSave(event.target.checked)}
                  style={{ width: 'auto' }}
                />
                保存后重新创建容器
              </label>
              <button onClick={reset} disabled={saving}>
                <RotateCcw size={16} />重置为默认
              </button>
              <button
                className="primary"
                onClick={save}
                disabled={!dirty || saving || !!errors.length}
              >
                <Save size={16} />
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
          <textarea
            value={configText}
            onChange={(event) => setConfigText(event.target.value)}
            spellCheck={false}
          />
        </div>
        <aside className="side-stack">
          <div className={errors.length ? 'panel' : 'panel success-panel'}>
            <h3>校验结果</h3>
            {!validation ? (
              <p className="muted">等待校验…</p>
            ) : errors.length === 0 ? (
              <p className="check ok">配置合法，可保存</p>
            ) : (
              errors.map((item, index) => (
                <p key={`err-${index}`} className="login-error" style={{ marginTop: 6 }}>
                  {item}
                </p>
              ))
            )}
            {warnings.map((item, index) => (
              <p key={`warn-${index}`} className="check" style={{ color: '#a96400' }}>
                ⚠ {item}
              </p>
            ))}
          </div>
          {summary && (
            <div className="panel">
              <h3>配置摘要</h3>
              <div className="summary-table">
                <span>服务端</span>
                <strong>{summary.serverAddr || '--'}</strong>
                <span>端口</span>
                <strong>{summary.serverPort ?? '--'}</strong>
                <span>认证方式</span>
                <strong>{summary.authMethod || '--'}</strong>
                <span>代理数量</span>
                <strong>{summary.proxyCount}</strong>
              </div>
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}
