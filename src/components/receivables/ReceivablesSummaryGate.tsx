import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/rentCalculations';
import { useReceivablesTotal } from '@/hooks/useReceivables';

/**
 * The one figure a dashboard opens on.
 *
 * Agent, Tenant and Landlord Operations start here: a single Total receivable
 * read from `get_receivables_total` — the same authoritative number the CFO
 * dashboard shows — with the rest of the dashboard behind a button.
 *
 * Two rules are load-bearing:
 *  - a figure this account may not read says "Unavailable", never 0, and opens
 *    the whole dashboard so nothing hides behind a number the reader cannot see;
 *  - a link that names something specific arrives already open.
 */

const EAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Kampala',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** '22 Oct 2026, 18:03' in East Africa Time. */
export function formatAsAtEAT(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return EAT.format(d);
}

export interface ReceivablesSummaryGateProps {
  children: ReactNode;
  /** Open from the start — e.g. a deep link that names a specific destination. */
  startOpen?: boolean;
  /** Reports open/closed so a screen can hide its own extra chrome while closed. */
  onVisibilityChange?: (open: boolean) => void;
  className?: string;
}

export function ReceivablesSummaryGate({
  children,
  startOpen = false,
  onVisibilityChange,
  className,
}: ReceivablesSummaryGateProps) {
  const { data, isError, isFetching, refetch } = useReceivablesTotal();
  const [showAll, setShowAll] = useState(startOpen);

  // Nothing may hide behind a figure this account is not allowed to read.
  useEffect(() => {
    if (isError) setShowAll(true);
  }, [isError]);

  useEffect(() => {
    onVisibilityChange?.(showAll);
  }, [showAll, onVisibilityChange]);

  const asAt = formatAsAtEAT(data?.as_at);

  return (
    <div className={className}>
      <section className="rounded-2xl border border-border/70 bg-card shadow-sm p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Total receivable
            </p>
            <p className="mt-1 text-3xl sm:text-4xl font-bold tabular-nums break-words">
              {isError ? 'Unavailable' : data ? formatUGX(Number(data.total ?? 0)) : 'Loading…'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {isError
                ? "This figure isn't available for your account — the full dashboard is open below."
                : data
                  ? `${Number(data.item_count ?? 0).toLocaleString()} open items${
                      asAt ? ` · As at ${asAt} EAT` : ''
                    }`
                  : 'Reading the receivables register…'}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => setShowAll((v) => !v)}
              aria-expanded={showAll}
            >
              {showAll ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              {showAll ? 'Hide all dashboard' : 'Show all dashboard'}
            </Button>
          </div>
        </div>
      </section>

      {/* While closed the dashboard is not mounted at all, so its chunk and its
          own queries never load — that is what keeps the first view light. */}
      {showAll && <div className="mt-4">{children}</div>}
    </div>
  );
}
