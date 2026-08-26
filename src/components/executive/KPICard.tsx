import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface KPICardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  trend?: { value: number; label: string };
  color?: string;
  loading?: boolean;
  subtitle?: string;
  onClick?: () => void;
}

export function KPICard({ title, value, icon: Icon, trend, color = 'bg-primary/10 text-primary', loading, subtitle, onClick }: KPICardProps) {
  const interactive = typeof onClick === 'function';
  const Comp = interactive ? 'button' : 'div';
  return (
    <Comp
      {...(interactive ? { onClick, type: 'button' as const } : {})}
      className={cn(
        'rounded-2xl border border-border bg-card p-3 sm:p-4 flex flex-col gap-2 min-w-0 w-full text-left',
        interactive && 'cursor-pointer transition-colors hover:bg-muted/40 hover:border-primary/40 active:scale-[0.98] touch-manipulation',
      )}
    >
      <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
        <div className={cn('p-1.5 sm:p-2 rounded-xl shrink-0', color)}>
          <Icon className="h-4 w-4 sm:h-5 sm:w-5" />
        </div>
        <p className="min-w-0 text-xs font-medium text-muted-foreground leading-tight break-words hyphens-none line-clamp-2">{title}</p>
      </div>
      <div className="min-w-0">
        {loading ? (
          <div className="h-9 w-28 bg-muted animate-pulse rounded mt-0.5" />
        ) : (
          <p className="text-xl sm:text-2xl font-bold tracking-tight leading-tight break-words tabular-nums">{value}</p>

        )}
        {trend && (
          <p className={cn('text-xs mt-1.5 font-medium', trend.value >= 0 ? 'text-green-600' : 'text-red-500')}>
            {trend.value >= 0 ? '↑' : '↓'} {Math.abs(trend.value)}% {trend.label}
          </p>
        )}
        {subtitle && <p className="text-xs text-muted-foreground mt-1.5 leading-snug break-normal">{subtitle}</p>}
      </div>
    </Comp>
  );
}
