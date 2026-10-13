import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useOverdueVettingAlert } from '@/hooks/useOverdueVettingAlert';
import { formatAge } from '@/lib/vettingOverdueCopy';
import { cn } from '@/lib/utils';

interface Props { onJumpToOldest: () => void }

/** Pinned bar at the top of the Service Centre queue. Uses the same server data as the dialog. */
export function OverdueVettingBanner({ onJumpToOldest }: Props) {
  const { data, dueSoonBanner, overdueCount } = useOverdueVettingAlert({ suppressed: true });
  const prev = useRef(overdueCount);
  const [cleared, setCleared] = useState(false);
  const [bump, setBump] = useState(0);

  useEffect(() => {
    if (prev.current > 0 && overdueCount === 0) {
      setCleared(true);
      const t = setTimeout(() => setCleared(false), 4000);
      prev.current = overdueCount;
      return () => clearTimeout(t);
    }
    if (prev.current !== overdueCount) setBump((n) => n + 1);
    prev.current = overdueCount;
  }, [overdueCount]);

  if (!data?.enabled) return null;

  const styles = (
    <style>{`
      @keyframes ovb-pop { 0% { transform: scale(1); } 40% { transform: scale(1.25); } 100% { transform: scale(1); } }
      @keyframes ovb-draw { from { stroke-dashoffset: 24; } to { stroke-dashoffset: 0; } }
      @keyframes ovb-collapse { 0%, 85% { opacity: 1; max-height: 64px; } 100% { opacity: 0; max-height: 0; } }
      .ovb-pop { animation: ovb-pop 320ms ease-out; display: inline-block; }
      .ovb-check { stroke-dasharray: 24; animation: ovb-draw 420ms ease-out both; }
      .ovb-clear { animation: ovb-collapse 4s ease-in forwards; overflow: hidden; }
      @media (prefers-reduced-motion: reduce) { .ovb-pop, .ovb-check, .ovb-clear { animation: none; } .ovb-check { stroke-dasharray: none; } }
    `}</style>
  );

  if (cleared) {
    return (
      <div role="status" className="ovb-clear flex items-center gap-2 rounded-xl border border-success/40 bg-success/10 px-3 py-2.5 text-sm font-medium text-success">
        {styles}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path className="ovb-check" d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
        Vetting queue clear. Thank you.
      </div>
    );
  }

  if (overdueCount > 0) {
    const escalated = (data.escalated_count ?? 0) > 0;
    return (
      <div role="status" className="flex flex-wrap items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
        {styles}
        {escalated ? <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> : <Clock className="h-4 w-4 shrink-0" aria-hidden />}
        <span className="flex-1 min-w-0">
          <span key={bump} className={cn('font-bold tabular-nums', bump > 0 && 'ovb-pop')}>{overdueCount}</span>{' '}
          overdue · oldest waiting {formatAge(data.oldest_age_hours)}
        </span>
        <Button size="sm" variant="destructive" onClick={onJumpToOldest} className="gap-1">
          Jump to oldest <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
    );
  }

  if (dueSoonBanner) {
    return (
      <div role="status" className="flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-foreground">
        <Clock className="h-4 w-4 shrink-0" aria-hidden />
        {dueSoonBanner}
      </div>
    );
  }
  return null;
}
