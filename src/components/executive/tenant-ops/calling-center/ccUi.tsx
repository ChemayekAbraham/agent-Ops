/**
 * Presentation-only building blocks shared by the Calling Center screens.
 *
 * Matches the rest of Tenant Ops: rounded-2xl surfaces, a soft primary-tinted
 * header band with an icon tile, and hover-lift list rows. No data, no logic.
 */
import type { ElementType, ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** Card row styling used by every Calling Center list item. */
export const CC_ROW =
  'rounded-xl border border-border bg-card p-3 shadow-sm transition-all hover:border-primary/40 hover:shadow-md';

/** Same as CC_ROW but for clickable rows. */
export const CC_ROW_BUTTON = cn(CC_ROW, 'w-full text-left active:scale-[0.995] touch-manipulation');

export function CCPanel({
  icon: Icon,
  title,
  subtitle,
  actions,
  children,
  className,
  contentClassName,
}: {
  icon: ElementType;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <Card className={cn('overflow-hidden rounded-2xl border-border shadow-sm', className)}>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 border-b border-border/70 bg-gradient-to-r from-primary/[0.07] via-primary/[0.02] to-transparent p-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="shrink-0 rounded-xl bg-primary/10 p-2">
            <Icon className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0">
            <CardTitle className="truncate text-sm font-bold leading-tight">{title}</CardTitle>
            {subtitle && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
      </CardHeader>
      <CardContent className={cn('space-y-3 p-3', contentClassName)}>{children}</CardContent>
    </Card>
  );
}

export function CCEmpty({ icon: Icon, title, hint }: { icon: ElementType; title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-8 text-center">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="mt-2.5 text-xs font-semibold text-foreground">{title}</p>
      {hint && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Soft framed block used inside the Calling Center dialogs. */
export function CCBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-xl border border-border/80 bg-muted/30 p-2.5', className)}>{children}</div>
  );
}

/** Dialog heading with the same icon tile as the panels. */
export function CCDialogHeading({ icon: Icon, title, hint }: { icon: ElementType; title: string; hint?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="shrink-0 rounded-xl bg-primary/10 p-2">
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-bold leading-tight">{title}</p>
        {hint && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}
