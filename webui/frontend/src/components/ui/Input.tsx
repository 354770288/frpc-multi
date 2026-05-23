import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

const INPUT_BASE =
  'w-full h-9 px-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[13px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/15 disabled:opacity-60';

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${INPUT_BASE} ${className}`} {...rest} />;
}

const TEXTAREA_BASE =
  'w-full px-3 py-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] font-mono text-[12px] leading-[1.6] text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/15 disabled:opacity-60 resize-y';

export function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${TEXTAREA_BASE} ${className}`} {...rest} />;
}
