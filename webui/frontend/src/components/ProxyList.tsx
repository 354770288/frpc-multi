import { useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  XCircle
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { PROXY_TYPES, createEmptyProxy, validateProxy, type ProxyDraft } from '../lib/proxyToml';
import type { ToastKind } from '../lib/types';

export function ProxyList({
  proxies,
  onChange,
  toast,
  emptyHint
}: {
  proxies: ProxyDraft[];
  onChange: (next: ProxyDraft[]) => void;
  toast?: (kind: ToastKind, text: string) => void;
  emptyHint?: string;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);

  function update(index: number, patch: Partial<ProxyDraft>) {
    onChange(proxies.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  }

  function addProxy() {
    const next = [...proxies, createEmptyProxy()];
    onChange(next);
    setExpanded(next.length - 1);
  }

  function removeProxy(index: number) {
    onChange(proxies.filter((_, i) => i !== index));
    setExpanded((current) => (current === index ? null : current));
    setConfirmingDelete(null);
    toast?.('info', '已删除该代理，未保存前不会写入磁盘');
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="text-[12px] text-[var(--color-fg-muted)]">
          共 {proxies.length} 条代理
        </div>
        <Button variant="default" size="sm" onClick={addProxy}>
          <Plus size={12} />
          新增代理
        </Button>
      </div>

      <div className="rounded-md border border-[var(--color-border)] overflow-hidden">
        {proxies.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-[var(--color-fg-muted)]">
            {emptyHint || '还没有代理。点击「新增代理」开始配置。'}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {proxies.map((draft, index) => (
              <li key={index}>
                <ProxyRow
                  draft={draft}
                  expanded={expanded === index}
                  confirmingDelete={confirmingDelete === index}
                  validationErrors={validateProxy(draft, proxies)}
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
                <Button size="sm" variant="destructive" onClick={onConfirmDelete}>
                  <Trash2 size={12} />
                  确认删除
                </Button>
              </>
            ) : (
              <Button size="sm" variant="destructive" onClick={onAskDelete}>
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
