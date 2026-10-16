import { useState, type DragEvent, type ReactNode } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Download, GripVertical, Info, Loader2, RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { CARD_TITLES, metricsErrorMessage, metricsStamp, type CardId } from '@/lib/agentMetrics';

// Shared pieces of the Metrics tab cards. Every figure is shown exactly as the server returned it. Semantic tokens only.

import { num } from './metricsFormat';

/** What the tab hands each card so it can be moved: its place, the buttons and the desktop drag handle. */
export interface CardControls {
  index: number;
  count: number;
  onUp: () => void;
  onDown: () => void;
  dragging: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}

export interface CardFetchState {
  error: unknown;
  isLoading: boolean;
  isFetching: boolean;
  updatedAt: number;
  refetch: () => void;
}

interface ShellProps {
  id: CardId;
  controls: CardControls;
  state: CardFetchState;
  basis: string;
  /** true once the server has answered but has nothing to show for these dates */
  empty?: boolean;
  emptyText?: string;
  onCsv?: () => void;
  csvLabel?: string;
  skeleton?: ReactNode;
  children: ReactNode;
}

export function CardShell({ id, controls, state, basis, empty, emptyText, onCsv, csvLabel, skeleton, children }: ShellProps) {
  const [open, setOpen] = useState(true);
  const title = CARD_TITLES[id];
  const failed = !!state.error && !state.isFetching;
  return (
    <Card
      data-testid={`metrics-card-${id}`}
      onDragOver={controls.onDragOver}
      onDrop={controls.onDrop}
      className={cn('overflow-hidden', controls.dragging && 'opacity-60 ring-2 ring-primary/40')}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-1 border-b border-border bg-muted/30 px-2 py-1">
          <span
            draggable
            onDragStart={controls.onDragStart}
            onDragEnd={controls.onDragEnd}
            className="hidden h-11 w-8 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing md:flex"
            aria-hidden="true"
            data-testid={`metrics-drag-${id}`}
          >
            <GripVertical className="h-4 w-4" />
          </span>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`${open ? 'Collapse' : 'Expand'} ${title}`}
            >
              <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')} />
              <span className="truncate text-sm font-bold text-foreground">{title}</span>
              {state.isFetching && !state.isLoading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Updating" />}
            </button>
          </CollapsibleTrigger>
          {onCsv && (
            <Button type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0" onClick={onCsv} aria-label={csvLabel ?? `Download CSV: ${title}`}>
              <Download className="h-4 w-4" />
            </Button>
          )}
          <Button type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0" onClick={controls.onUp} disabled={controls.index === 0} aria-label={`Move ${title} up`}>
            <ChevronUp className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0" onClick={controls.onDown} disabled={controls.index === controls.count - 1} aria-label={`Move ${title} down`}>
            <ChevronDown className="h-4 w-4" />
          </Button>
        </div>
        <CollapsibleContent>
          <div className="space-y-3 p-3">
            {state.isLoading ? (
              skeleton ?? <CardSkeleton />
            ) : failed ? (
              <CardError error={state.error} onRetry={state.refetch} />
            ) : empty ? (
              <p className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground" data-testid={`metrics-empty-${id}`}>
                {emptyText ?? 'Nothing recorded for these dates.'}
              </p>
            ) : (
              children
            )}
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid={`metrics-basis-${id}`}>
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                {basis}
                {state.updatedAt > 0 && <> As at {metricsStamp(state.updatedAt)}.</>}
              </span>
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

export function CardSkeleton({ tiles = 4 }: { tiles?: number }) {
  return (
    <div className="grid grid-cols-2 gap-2" data-testid="metrics-skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: tiles }, (_, i) => <Skeleton key={i} className="h-[72px] rounded-xl" />)}
    </div>
  );
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2" data-testid="metrics-skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
    </div>
  );
}

export function CardError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3" data-testid="metrics-error">
      <p className="flex items-start gap-2 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{metricsErrorMessage(error)}</p>
      <Button type="button" variant="outline" className="min-h-11 self-start" onClick={onRetry}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>
    </div>
  );
}

export function Stat({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId?: string }) {
  return (
    <div className="flex min-h-[72px] flex-col justify-between gap-1 rounded-xl border border-border bg-card p-3" data-testid={testId ?? 'metrics-stat'}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-lg font-bold leading-tight tabular-nums text-foreground">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-2 md:grid-cols-3">{children}</div>;
}
