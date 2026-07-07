import type { ReactNode } from 'react';

export function EmptyState({
  title,
  text,
  actions
}: {
  title: string;
  text?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-input bg-muted p-6 text-center">
      <div className="text-[13px] font-semibold text-foreground">{title}</div>
      {text && (
        <p className="mx-auto mt-1.5 max-w-[360px] text-[12px] leading-5 text-muted-foreground">
          {text}
        </p>
      )}
      {actions && <div className="mt-3 flex justify-center">{actions}</div>}
    </div>
  );
}
