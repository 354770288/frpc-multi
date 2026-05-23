import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import type { Toast } from '../lib/types';

const ACCENT: Record<Toast['kind'], string> = {
  success: 'border-l-[var(--color-success)]',
  error: 'border-l-[var(--color-danger)]',
  info: 'border-l-[var(--color-accent)]'
};

const ICON_COLOR: Record<Toast['kind'], string> = {
  success: 'text-[var(--color-success)]',
  error: 'text-[var(--color-danger)]',
  info: 'text-[var(--color-accent)]'
};

export function ToastStack({
  toasts,
  onClose
}: {
  toasts: Toast[];
  onClose: (id: number) => void;
}) {
  return (
    <div className="fixed top-4 right-4 z-[1000] flex flex-col gap-2 max-w-[380px]">
      {toasts.map((t) => {
        const Icon = t.kind === 'success' ? CheckCircle2 : t.kind === 'error' ? XCircle : Info;
        return (
          <div
            key={t.id}
            className={`flex items-start gap-2.5 pl-3 pr-2 py-2.5 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] border-l-[3px] ${ACCENT[t.kind]} shadow-md`}
          >
            <Icon size={14} className={`mt-0.5 shrink-0 ${ICON_COLOR[t.kind]}`} />
            <span className="flex-1 text-[12px] text-[var(--color-fg)] leading-relaxed">
              {t.text}
            </span>
            <button
              onClick={() => onClose(t.id)}
              title="关闭"
              className="grid place-items-center w-5 h-5 rounded text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] transition-colors"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
