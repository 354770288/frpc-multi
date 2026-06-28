import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"
import type { InstanceTone } from "@/lib/format"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-3xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
        success:
          "bg-[var(--color-success-soft)] text-[var(--color-success)]",
        warning:
          "bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
        muted:
          "bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const TONE_VARIANT: Record<InstanceTone, VariantProps<typeof badgeVariants>["variant"]> = {
  success: "success",
  warning: "warning",
  danger: "destructive",
  muted: "muted",
}

function Badge({
  className,
  variant,
  tone,
  dot = false,
  asChild = false,
  children,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean
    tone?: InstanceTone
    dot?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "span"
  const resolved = variant ?? (tone ? TONE_VARIANT[tone] : "default")

  return (
    <Comp
      data-slot="badge"
      data-variant={resolved}
      className={cn(badgeVariants({ variant: resolved }), className)}
      {...props}
    >
      {dot && <span className="inline-block h-1.5 w-1.5 rounded-full bg-current opacity-60" />}
      {children}
    </Comp>
  )
}

export { Badge, badgeVariants }
