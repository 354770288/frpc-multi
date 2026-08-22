import { X } from 'lucide-react';
import { Button } from './ui/button';

/** 项目通用的手写模态弹窗容器（风格见 NodeParts.ConfirmNodeAction）。 */
export function Overlay({ title, children, onClose, wide }: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 py-6"
      role="presentation"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div
        role="dialog" aria-modal="true"
        className={`flex max-h-[85vh] w-full ${wide ? 'max-w-[640px]' : 'max-w-[480px]'} flex-col overflow-hidden rounded-xl border bg-card shadow-xl`}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b bg-muted/50 px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="关闭" className="rounded p-0.5 text-muted-foreground hover:text-foreground"><X size={14} /></button>
        </div>
        <div className="overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

/** 轻量确认弹窗。 */
export function ConfirmOverlay({ title, description, confirmLabel, variant, onCancel, onConfirm, children }: {
  title: string;
  description: string;
  confirmLabel: string;
  variant?: 'default' | 'destructive';
  onCancel: () => void;
  onConfirm: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 py-6"
      role="presentation"
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
    >
      <div role="dialog" aria-modal="true" className="w-full max-w-[420px] overflow-hidden rounded-xl border bg-card shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b bg-muted/50 px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button type="button" onClick={onCancel} aria-label="关闭" className="rounded p-0.5 text-muted-foreground hover:text-foreground"><X size={14} /></button>
        </div>
        <div className="p-4 text-xs leading-5 text-muted-foreground">
          {description}
          {children}
        </div>
        <div className="flex justify-end gap-2 border-t bg-muted/50 px-4 py-3">
          <Button variant="outline" onClick={onCancel}>取消</Button>
          <Button variant={variant} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}
