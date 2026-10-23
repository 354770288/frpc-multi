import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog';

/** Shared compatibility wrapper: the underlying primitive owns focus and Escape handling. */
export function Overlay({ title, children, onClose, wide }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return <Dialog open onOpenChange={(open)=>{if(!open)onClose();}}>
    <DialogContent className={`${wide ? 'sm:max-w-[760px]' : 'sm:max-w-[520px]'} max-h-[85vh] overflow-y-auto`}>
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      {children}
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
  return <AlertDialog open onOpenChange={(open)=>{if(!open)onCancel();}}>
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>{description}</AlertDialogDescription></AlertDialogHeader>
      {children}
      <AlertDialogFooter><AlertDialogCancel onClick={onCancel}>取消</AlertDialogCancel><AlertDialogAction variant={variant} disabled={confirmDisabled} onClick={(event) => { if (keepOpenOnConfirm) event.preventDefault(); onConfirm(); }}>{confirmLabel}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
