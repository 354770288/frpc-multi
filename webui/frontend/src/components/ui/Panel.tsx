import type { ReactNode } from 'react';

export function Panel({
  title,
  actions,
  children,
  className = '',
  bodyClassName = ''
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden ${className}`}
    >
      {(title || actions) && (
        <header className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-border)]">
          {title && (
            <h3 className="text-[13px] font-semibold text-[var(--color-fg)]">{title}</h3>
          )}
          {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={`p-4 ${bodyClassName}`}>{children}</div>
    </section>
  );
}
