import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import type { Toast } from '../lib/types';

export function ToastStack({ toasts, onClose }: { toasts: Toast[]; onClose: (id: number) => void }) {
  return (
    <div className="toast-stack">
      {toasts.map((t) => {
        const Icon = t.kind === 'success' ? CheckCircle2 : t.kind === 'error' ? XCircle : Info;
        return (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <Icon size={16} />
            <span>{t.text}</span>
            <button onClick={() => onClose(t.id)} title="关闭">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
