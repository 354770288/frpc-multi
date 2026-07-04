import type { ReactNode } from 'react';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from './card';

export function Panel({
  title,
  actions,
  children,
  className = '',
  bodyClassName = '',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={`gap-0 overflow-hidden ${className}`}>
      {(title || actions) && (
        <CardHeader className="flex-row items-center gap-3 border-b px-4 py-3">
          {title && (
            <CardTitle className="text-sm">{title}</CardTitle>
          )}
          {actions && <CardAction className="ml-auto flex items-center gap-2">{actions}</CardAction>}
        </CardHeader>
      )}
      <CardContent className={`p-4 ${bodyClassName}`}>{children}</CardContent>
    </Card>
  );
}
