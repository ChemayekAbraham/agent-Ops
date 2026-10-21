import { useState, type MouseEvent } from 'react';
import { AlertTriangle, ChevronDown, Clock, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRentRequestTimingHistory } from '@/hooks/useRentRequestTiming';
import { QUALITY_LABEL, deskLabel, formatElapsed, formatKampala, timingRow, type RentTiming, type TimingCell } from '@/lib/rentTiming';
import { cn } from '@/lib/utils';

// The compact three-cell timing row of a rent review card (docs/RENT_TIMING_UI_CONTRACT.md). Every string comes from the server's answer through
// timingRow / formatElapsed / formatKampala; nothing here measures time, and nothing is coloured as late or overdue.

interface Props {
  requestId: string;
  timing: RentTiming | undefined;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** true on a desk's own review cards: the first cell reads "On your desk" */
  ownDesk?: boolean;
  className?: string;
}

function Tag({ q }: { q: TimingCell['quality'] }) {
  if (q === 'confirmed') return null;
  return <span className="mt-0.5 inline-block rounded-full bg-muted px-1.5 text-xs text-muted-foreground" data-testid="timing-quality-tag">{QUALITY_LABEL[q]}</span>;
}

function Cell({ cell, prominent, testId }: { cell: TimingCell; prominent?: boolean; testId: string }) {
  return (
    <div className="min-w-0 px-2 py-1.5" data-testid={testId}>
      <p className="break-words text-xs leading-tight text-muted-foreground">{cell.label}</p>
      <p className={cn('tabular-nums leading-tight text-foreground', prominent ? 'text-base font-bold' : 'text-sm font-semibold')}>{cell.value}</p>
      <Tag q={cell.quality} />
    </div>
  );
}

export function RentTimingRow({ requestId, timing, loading, error, onRetry, ownDesk, className }: Props) {
  const [open, setOpen] = useState(false);
  const stop = (e: MouseEvent) => e.stopPropagation();

  if (loading) {
    return (
      <div className={cn('mt-2 grid grid-cols-3 gap-2', className)} data-testid="timing-loading" aria-busy="true" aria-label="Loading timing">
        {[0, 1, 2].map((i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-muted/50" />)}
      </div>
    );
  }
  if (error) {
    return (
      <div role="alert" onClick={stop} className={cn('mt-2 flex items-center justify-between gap-2 rounded-lg border border-border/60 px-2 py-1', className)} data-testid="timing-error">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><AlertTriangle className="h-3.5 w-3.5 shrink-0" />Timing could not be loaded.</p>
        {onRetry && (
          <Button type="button" variant="outline" size="sm" className="min-h-11 shrink-0 text-xs" onClick={(e) => { stop(e); onRetry(); }}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />Retry
          </Button>
        )}
      </div>
    );
  }

  const row = timingRow(timing, { ownDesk });
  return (
    <div className={cn('mt-2 rounded-lg border border-border/60 bg-muted/20', className)} onClick={stop} data-testid="rent-timing">
      <div className="flex items-stretch">
        <div className="grid min-w-0 flex-1 grid-cols-3 divide-x divide-border/50">
          <Cell cell={row.current} prominent testId="timing-current" />
          <Cell cell={row.previous} testId="timing-previous" />
          <Cell cell={row.total} testId="timing-total" />
        </div>
        <button
          type="button"
          onClick={(e) => { stop(e); setOpen((o) => !o); }}
          aria-expanded={open}
          aria-label={open ? 'Hide the journey of this request' : 'Show the journey of this request'}
          className="flex min-h-11 min-w-11 shrink-0 flex-col items-center justify-center gap-0.5 rounded-r-lg text-muted-foreground hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="timing-toggle"
        >
          <Clock className="h-4 w-4" />
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
        </button>
      </div>
      {row.note && <p className="border-t border-border/50 px-2 py-1 text-xs text-muted-foreground" data-testid="timing-note">{row.note}</p>}
      {open && <Journey requestId={requestId} />}
    </div>
  );
}

function Journey({ requestId }: { requestId: string }) {
  const h = useRentRequestTimingHistory(requestId, true);
  const visits = h.data?.visits ?? [];
  return (
    <div className="border-t border-border/50 px-2 py-2" data-testid="timing-journey">
      {h.isLoading ? (
        <div className="space-y-1.5" aria-busy="true" data-testid="timing-journey-loading">{[0, 1, 2].map((i) => <div key={i} className="h-8 animate-pulse rounded bg-muted/50" />)}</div>
      ) : h.error ? (
        <div role="alert" className="flex items-center justify-between gap-2" data-testid="timing-journey-error">
          <p className="text-xs text-muted-foreground">The journey could not be loaded.</p>
          <Button type="button" variant="outline" size="sm" className="min-h-11 text-xs" onClick={h.refetch}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Retry</Button>
        </div>
      ) : visits.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="timing-journey-empty">No visits are recorded for this request.</p>
      ) : (
        <ol className="space-y-1.5">
          {visits.map((v, i) => (
            <li key={`${v.desk}-${v.start}-${i}`} className="flex items-baseline justify-between gap-2 text-xs" data-testid="timing-visit">
              <span className="min-w-0 text-foreground">
                <span className="font-semibold">{deskLabel(v.desk)}</span>
                <span className="block text-muted-foreground">{formatKampala(v.start)}{v.quality !== 'confirmed' ? ` · ${QUALITY_LABEL[v.quality]}` : ''}</span>
              </span>
              <span className="shrink-0 font-semibold tabular-nums text-foreground">{formatElapsed(v.seconds)}</span>
            </li>
          ))}
        </ol>
      )}
      {(h.data?.skipped_desks?.length ?? 0) > 0 && (
        <p className="mt-1.5 text-xs text-muted-foreground" data-testid="timing-skipped">Not visited: {h.data?.skipped_desks.map(deskLabel).join(', ')}</p>
      )}
    </div>
  );
}
