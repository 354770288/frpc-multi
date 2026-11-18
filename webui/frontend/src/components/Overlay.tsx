import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog';

/** Shared compatibility wrapper: the underlying primitive owns focus and Escape handling. */
export function Overlay({ title, description, footer, children, onClose, wide }: {
  title: string;
  description?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent
      className={`${wide ? 'sm:max-w-[760px]' : 'sm:max-w-[520px]'} max-h-[85vh] overflow-y-auto`}
      onInteractOutside={(event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest('[data-slot="alert-dialog-content"], [data-slot="alert-dialog-overlay"], [data-sonner-toaster]')) {
          event.preventDefault();
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      {children}
      {footer && <DialogFooter>{footer}</DialogFooter>}
    </DialogContent>
  </Dialog>;
}

export function ConfirmOverlay({ title, description, confirmLabel, variant, onCancel, onConfirm, children, confirmDisabled, keepOpenOnConfirm }: {
  title: string;
  description: string;
  confirmLabel: string;
  variant?: 'default' | 'destructive';
  onCancel: () => void;
  onConfirm: () => void;
  children?: ReactNode;
  confirmDisabled?: boolean;
  keepOpenOnConfirm?: boolean;
}) {
  return <AlertDialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>{description}</AlertDialogDescription></AlertDialogHeader>
      {children}
      <AlertDialogFooter><AlertDialogCancel onClick={onCancel}>取消</AlertDialogCancel><AlertDialogAction variant={variant} disabled={confirmDisabled} onClick={(event) => { if (keepOpenOnConfirm) event.preventDefault(); onConfirm(); }}>{confirmLabel}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
