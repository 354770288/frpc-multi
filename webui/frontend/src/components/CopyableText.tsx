import { useState, type MouseEvent } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../lib/utils';

export function CopyableText({
  value,
  display,
  label,
  mono = true,
  alwaysShowIcon = false,
  toastMessage,
  className,
  textClassName,
}: {
  value: string;
  display?: string;
  label?: string;
  mono?: boolean;
  alwaysShowIcon?: boolean;
  toastMessage?: string;
  className?: string;
  textClassName?: string;
}) {
  const [copied, setCopied] = useState(false);

  if (!value) {
    return <span className={cn('text-muted-foreground', textClassName)}>—</span>;
  }

  async function handleCopy(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    event.preventDefault();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (toastMessage) toast.success(toastMessage);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('复制失败，请手动复制');
    }
  }

  return (
    <span className={cn('group/copy inline-flex max-w-full items-center gap-1 align-middle', className)}>
      <span className={cn('min-w-0 truncate', mono && 'font-mono', textClassName)} title={value}>
        {display ?? value}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={`复制 ${label || value}`}
        title={`复制 ${value}`}
        className={cn(
          'inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-all hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          alwaysShowIcon || copied ? 'opacity-100' : 'opacity-0 group-hover/copy:opacity-100',
          copied && 'text-emerald-600 dark:text-emerald-400',
        )}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
    </span>
  );
}
