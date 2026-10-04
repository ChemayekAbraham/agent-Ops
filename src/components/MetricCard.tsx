import { cn } from '@/lib/utils';
import { LucideIcon } from 'lucide-react';

interface MetricCardProps {
  label: string;
  value: string | number;
  icon: LucideIcon;
  trend?: 'up' | 'down' | 'neutral';
  trendValue?: string;
  className?: string;
  variant?: 'default' | 'primary' | 'success' | 'warning' | 'destructive';
  compact?: boolean;
}

export function MetricCard({ 
  label, 
  value, 
  icon: Icon, 
  trend = 'neutral', 
  trendValue,
  className,
  variant = 'default',
  compact = false
}: MetricCardProps) {
  const formatValue = (val: string | number) => {
    if (typeof val === 'number') {
      // Shorter format for large numbers on mobile
      if (val >= 1000000) {
        return `${(val / 1000000).toFixed(1)}M`;
      }
      if (val >= 10000) {
        return `${(val / 1000).toFixed(0)}K`;
      }
      return new Intl.NumberFormat('en-UG', {
        style: 'currency',
        currency: 'UGX',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(val);
    }
    return val;
  };

  const iconColors = {
    default: 'bg-muted text-foreground',
    primary: 'bg-primary/10 text-primary',
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    destructive: 'bg-destructive/10 text-destructive',
  };

  if (compact) {
    return (
      <div className={cn(
        "flex items-center gap-3 rounded-2xl border border-border/60 bg-card p-3.5 min-h-[68px] active:scale-[0.98] transition-all duration-150 shadow-sm hover:shadow-md",
        className
      )}>
        <div className={cn("p-2.5 rounded-xl shrink-0", iconColors[variant])}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-lg font-bold tracking-tight tabular-nums truncate">
            {formatValue(value)}
          </p>
          <p className="text-[11px] font-medium text-muted-foreground truncate uppercase tracking-wider">
            {label}
          </p>
        </div>
        {trend !== 'neutral' && trendValue && (
          <div className={cn(
            "text-xs font-bold px-2 py-1 rounded-lg shrink-0",
            trend === 'up' ? "text-success bg-success/10" : "text-destructive bg-destructive/10"
          )}>
            {trend === 'up' ? '↑' : '↓'}{trendValue}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={cn(
      "rounded-2xl border border-border/60 bg-card p-4 transition-all duration-200 min-h-[110px] active:scale-[0.98] hover:shadow-md shadow-sm",
      className
    )}>
      <div className="flex items-start justify-between mb-3">
        <div className={cn("p-2.5 rounded-xl", iconColors[variant])}>
          <Icon className="h-5 w-5" />
        </div>
        {trend !== 'neutral' && trendValue && (
          <div className={cn(
            "flex items-center gap-0.5 text-xs font-bold px-2.5 py-1 rounded-lg",
            trend === 'up' ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"
          )}>
            <span>{trend === 'up' ? '↑' : '↓'}</span>
            <span>{trendValue}</span>
          </div>
        )}
      </div>
      
      <div className="space-y-1">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
          {label}
        </p>
        <p className="text-2xl font-bold tracking-tight tabular-nums">
          {formatValue(value)}
        </p>
      </div>
    </div>
  );
}