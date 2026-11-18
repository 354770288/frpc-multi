import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

export function PageShell({
  children,
  className,
  maxWidth = '7xl',
}: {
  children: ReactNode;
  className?: string;
  maxWidth?: '3xl' | '5xl' | '6xl' | '7xl' | 'full';
}) {
  const widthClass = {
    '3xl': 'max-w-3xl',
    '5xl': 'max-w-5xl',
    '6xl': 'max-w-6xl',
    '7xl': 'max-w-7xl',
    full: 'max-w-none',
  }[maxWidth];

  return (
    <div className={cn('mx-auto w-full space-y-5 px-4 py-6 sm:px-6', widthClass, className)}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  badge,
  back,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  back?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between', className)}>
      <div className="min-w-0 space-y-1">
        {back && <div className="mb-1.5">{back}</div>}
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
          {badge}
        </div>
        {description && (
          <div className="text-sm text-muted-foreground">{description}</div>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}
