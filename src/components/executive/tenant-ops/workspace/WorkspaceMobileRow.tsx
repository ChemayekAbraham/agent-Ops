import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface WorkspaceMobileField {
  label: string;
  value: ReactNode;
  /** Span both columns — use for a longer value (e.g. a note/reason). */
  full?: boolean;
}

/**
 * Shared mobile card-row renderer for the Tenant Operations Workspace tabs —
 * the dl/dt/dd card idiom already used by the Calling Hub's responsive table
 * (src/components/ops/calling/CallingHubTable.tsx), extracted so any dense
 * workspace table can offer the same desktop-table + mobile-card pattern.
 *
 * Usage: render this list inside `<div className="space-y-2 lg:hidden">`,
 * alongside the real `<Table>` inside `<div className="hidden lg:block">`.
 */
export function WorkspaceMobileRow({
  title,
  badge,
  fields,
  onClick,
  actions,
  className,
}: {
  title: ReactNode;
  badge?: ReactNode;
  fields: WorkspaceMobileField[];
  onClick?: () => void;
  actions?: ReactNode;
  className?: string;
}) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      {...(onClick ? { onClick, type: 'button' as const } : {})}
      className={cn(
        'w-full rounded-xl border border-border/60 bg-card p-3 text-left shadow-sm transition-all',
        onClick && 'hover:border-primary/40 hover:shadow-md active:scale-[0.99] touch-manipulation',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-semibold leading-tight">{title}</p>
        {badge}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
        {fields.map((f, i) => (
          <div key={i} className={cn('min-w-0', f.full && 'col-span-2')}>
            <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{f.label}</dt>
            <dd className="break-words text-xs">{f.value}</dd>
          </div>
        ))}
      </dl>
      {actions && <div className="mt-3 flex flex-col gap-2">{actions}</div>}
    </Comp>
  );
}
