import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Shared empty/error-state card for the Tenant Operations Workspace tabs —
 * the icon-in-circle + dashed border idiom already used by the Calling
 * Center's `CCEmpty` (src/components/executive/tenant-ops/calling-center/ccUi.tsx),
 * extracted so all four workspace tabs render it identically instead of each
 * tab's own plain muted-text line.
 */
export function WorkspaceEmptyState({
  icon: Icon,
  title,
  hint,
  tone = 'muted',
  className,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  /** 'muted' for a plain empty state, 'destructive' for an error/denied state. */
  tone?: 'muted' | 'destructive';
  className?: string;
}) {
  const destructive = tone === 'destructive';
  return (
    <div
      className={cn(
        'rounded-xl border border-dashed px-4 py-8 text-center',
        destructive ? 'border-destructive/30 bg-destructive/5' : 'border-border bg-muted/20',
        className,
      )}
    >
      <div
        className={cn(
          'mx-auto flex h-10 w-10 items-center justify-center rounded-full',
          destructive ? 'bg-destructive/10' : 'bg-muted',
        )}
      >
        <Icon className={cn('h-5 w-5', destructive ? 'text-destructive' : 'text-muted-foreground')} />
      </div>
      <p className={cn('mt-2 text-xs font-semibold', destructive ? 'text-destructive' : 'text-foreground')}>
        {title}
      </p>
      {hint && (
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
