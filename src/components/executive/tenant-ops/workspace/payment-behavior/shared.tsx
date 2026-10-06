import type { ReactNode } from 'react';
import { AlertTriangle, FlaskConical, Info, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** Marks a figure as read straight from recorded data. */
export function ObservedBadge({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success', className)}>
      <ShieldCheck className="h-3 w-3" /> Observed
    </span>
  );
}

/** Marks a figure as an estimate or prediction, not a recorded fact. */
export function EstimateBadge({ className, label = 'Estimate' }: { className?: string; label?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning', className)}>
      <FlaskConical className="h-3 w-3" /> {label}
    </span>
  );
}

export function SectionCard({
  title, description, badge, actions, children, className,
}: {
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('min-w-0 border-border/60 shadow-sm', className)}>
      <CardHeader className="space-y-1 px-3 pb-2 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-semibold">{title}{badge}</CardTitle>
            {description && <CardDescription className="mt-1 text-xs">{description}</CardDescription>}
          </div>
          {actions}
        </div>
      </CardHeader>
      <CardContent className="min-w-0 px-3 pb-4 sm:px-5">{children}</CardContent>
    </Card>
  );
}

export function StatTile({
  label, value, sub, tone = 'default', loading,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'default' | 'primary' | 'success' | 'warning' | 'destructive';
  loading?: boolean;
}) {
  const toneBar = { default: 'bg-border', primary: 'bg-primary', success: 'bg-success', warning: 'bg-warning', destructive: 'bg-destructive' }[tone];
  return (
    <div className="relative min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card p-3 shadow-sm">
      <span className={cn('absolute inset-y-0 left-0 w-1', toneBar)} aria-hidden />
      <p className="pl-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      {loading ? (
        <Skeleton className="ml-1 mt-1.5 h-7 w-24" />
      ) : (
        <p className="mt-1 whitespace-nowrap pl-1 text-base font-bold leading-tight tabular-nums sm:text-xl">{value}</p>
      )}
      {sub && <div className="mt-1 break-words pl-1 text-[11px] leading-snug text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function Callout({
  tone = 'info', title, children, className,
}: { tone?: 'info' | 'warning' | 'destructive'; title?: string; children: ReactNode; className?: string }) {
  const Icon = tone === 'info' ? Info : AlertTriangle;
  const cls = {
    info: 'border-info/30 bg-info/5 text-foreground',
    warning: 'border-warning/40 bg-warning/10 text-foreground',
    destructive: 'border-destructive/30 bg-destructive/5 text-foreground',
  }[tone];
  const iconCls = { info: 'text-info', warning: 'text-warning', destructive: 'text-destructive' }[tone];
  return (
    <div role={tone === 'info' ? 'note' : 'alert'} className={cn('flex gap-2.5 rounded-xl border p-3 text-xs leading-relaxed', cls, className)}>
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', iconCls)} />
      <div className="min-w-0">
        {title && <p className="mb-0.5 font-semibold">{title}</p>}
        <div className="text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

export function ChartSkeleton({ h = 220 }: { h?: number }) {
  return <Skeleton className="w-full" style={{ height: h }} />;
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** A horizontal bar whose length is a percentage already computed by the server. */
export function PctBar({ value, color, label }: { value: number | null | undefined; color: string; label?: string }) {
  const v = Math.max(0, Math.min(100, Number(value ?? 0)));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={label}>
      <div className="h-full rounded-full" style={{ width: `${v}%`, background: color }} />
    </div>
  );
}

export const ChartTooltipBox = ({ children }: { children: ReactNode }) => (
  <div className="rounded-lg border border-border bg-popover p-2.5 text-xs shadow-md">{children}</div>
);

export const CHART_GRID = 'hsl(var(--border) / 0.4)';
export const CHART_TICK = { fontSize: 10, fill: 'hsl(var(--muted-foreground))' };
