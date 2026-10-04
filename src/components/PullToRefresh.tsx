import { ReactNode } from 'react';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import { cn } from '@/lib/utils';
import { RefreshCw, ArrowDown } from 'lucide-react';

interface PullToRefreshProps {
  children: ReactNode;
  onRefresh: () => Promise<void>;
  className?: string;
  disabled?: boolean;
}

export function PullToRefresh({
  children,
  onRefresh,
  className,
  disabled = false,
}: PullToRefreshProps) {
  const {
    pullDistance,
    isRefreshing,
    canRefresh,
    handlers,
    progress,
  } = usePullToRefresh({
    onRefresh,
    threshold: 300,
    maxPull: 360,
  });

  if (disabled) {
    return <div className={className} data-pull-to-refresh="disabled">{children}</div>;
  }

  return (
    <div
      {...handlers}
      data-pull-to-refresh="active"
      className={cn('relative', className)}
      style={{ touchAction: 'pan-y pinch-zoom' }}
    >
      {/* Pull indicator */}
      <div
        className={cn(
          'absolute left-0 right-0 flex items-center justify-center transition-all duration-200 z-10 pointer-events-none',
          pullDistance > 0 || isRefreshing ? 'opacity-100' : 'opacity-0'
        )}
        style={{
          top: 0,
          height: `${Math.max(pullDistance, isRefreshing ? 48 : 0)}px`,
          transform: `translateY(${isRefreshing ? 0 : -10}px)`,
        }}
      >
        <div
          className={cn(
            'flex items-center justify-center w-10 h-10 rounded-full bg-background border border-border shadow-lg transition-all duration-200',
            canRefresh && !isRefreshing && 'bg-primary border-primary',
            isRefreshing && 'bg-primary border-primary'
          )}
          style={{
            transform: `rotate(${progress * 3.6}deg)`,
          }}
        >
          {isRefreshing ? (
            <RefreshCw className="h-5 w-5 text-primary-foreground animate-spin" />
          ) : canRefresh ? (
            <RefreshCw className="h-5 w-5 text-primary-foreground" />
          ) : (
            <ArrowDown 
              className={cn(
                'h-5 w-5 text-muted-foreground transition-transform duration-200',
                progress > 50 && 'text-primary'
              )}
              style={{
                transform: `rotate(${Math.min(progress * 1.8, 180)}deg)`,
              }}
            />
          )}
        </div>
      </div>

      {/* Content */}
      <div
        className="transition-transform duration-200"
        style={{
          // Do not apply translateY(0px): even a no-op transform creates a
          // containing block that breaks fixed-position public pages such as
          // /funder-onboarding, making them render as a blank zero-height area.
          transform: pullDistance > 0 ? `translateY(${pullDistance}px)` : undefined,
        }}
      >
        {children}
      </div>

      {/* Pull hint text */}
      {pullDistance > 20 && !isRefreshing && (
        <div 
          className="absolute top-2 left-0 right-0 text-center text-xs text-muted-foreground font-medium pointer-events-none"
          style={{ opacity: Math.min(pullDistance / 60, 1) }}
        >
          {canRefresh ? 'Release to refresh' : 'Pull to refresh'}
        </div>
      )}
    </div>
  );
}
