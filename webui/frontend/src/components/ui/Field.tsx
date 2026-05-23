import { Children, cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';

type FieldChildProps = {
  id?: string;
  'aria-describedby'?: string;
};

export function Field({
  label,
  hint,
  children
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const autoId = useId();
  const hintId = hint ? `${autoId}-hint` : undefined;
  const child = Children.only(children);
  const enhanced = isValidElement<FieldChildProps>(child)
    ? cloneElement(child as ReactElement<FieldChildProps>, {
        id: child.props.id ?? autoId,
        'aria-describedby': [child.props['aria-describedby'], hintId].filter(Boolean).join(' ') || undefined
      })
    : child;
  const fieldId = isValidElement<FieldChildProps>(child) ? (child.props.id ?? autoId) : autoId;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="text-[12px] font-medium text-[var(--color-fg)]">
        {label}
      </label>
      {enhanced}
      {hint && (
        <span id={hintId} className="text-[11px] text-[var(--color-fg-muted)]">
          {hint}
        </span>
      )}
    </div>
  );
}
