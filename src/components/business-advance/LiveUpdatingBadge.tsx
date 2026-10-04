import { Radio, RefreshCw, Loader2 } from 'lucide-react';
import type { RealtimeStatus } from '@/hooks/useBusinessAdvanceRealtime';
import { cn } from '@/lib/utils';

/**
 * Small inline indicator showing whether the tracker is receiving live
 * websocket updates, polling as a fallback, or still connecting.
 */
export function LiveUpdatingBadge({
  status,
  className,
}: {
  status: RealtimeStatus;
  className?: string;
}) {
  const map = {
    live: {
      Icon: Radio,
      label: 'Live updating',
      ring: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
      dot: 'bg-emerald-500',
      pulse: true,
    },
    polling: {
      Icon: RefreshCw,
      label: 'Auto-refreshing',
      ring: 'bg-amber-500/10 text-amber-700 border-amber-500/30',
      dot: 'bg-amber-500',
      pulse: false,
    },
    connecting: {
      Icon: Loader2,
      label: 'Connecting…',
      ring: 'bg-muted text-muted-foreground border-muted',
      dot: 'bg-muted-foreground/60',
      pulse: false,
    },
  } as const;

  const cfg = map[status];
  const { Icon } = cfg;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        cfg.ring,
        className,
      )}
      title={
        status === 'live'
          ? 'Connected to live updates'
          : status === 'polling'
          ? 'Live connection unavailable — refreshing in background'
          : 'Establishing live connection…'
      }
    >
      <span className="relative flex h-1.5 w-1.5">
        {cfg.pulse && (
          <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-75', cfg.dot)} />
        )}
        <span className={cn('relative inline-flex h-1.5 w-1.5 rounded-full', cfg.dot)} />
      </span>
      <Icon className={cn('h-3 w-3', status === 'connecting' && 'animate-spin')} />
      {cfg.label}
    </span>
  );
}

export default LiveUpdatingBadge;
