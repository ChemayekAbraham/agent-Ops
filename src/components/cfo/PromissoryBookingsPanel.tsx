import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import { AlertTriangle, CalendarClock, CheckCircle2, RotateCcw } from 'lucide-react';

type Filter = 'live' | 'lapsed' | 'released' | 'funded' | 'all';

interface BookingRow {
  intent_id: string;
  note_id: string;
  partner_name: string | null;
  agent_name: string | null;
  tenant_name: string | null;
  booked_amount: number;
  note_amount: number;
  status: string;
  booked_at: string;
  reserved_until: string;
  warned_at: string | null;
  released_at: string | null;
  release_reason: string | null;
  days_left: number;
  is_live: boolean;
  is_lapsed: boolean;
  rent_request_status: string | null;
}

interface Kpi {
  live_count: number;
  live_amount: number;
  warned_count: number;
  lapsed_count: number;
  released_count: number;
  released_amount: number;
  funded_count: number;
  funded_amount: number;
}

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'live', label: 'Live bookings' },
  { key: 'lapsed', label: 'Lapsed' },
  { key: 'released', label: 'Released' },
  { key: 'funded', label: 'Funded' },
  { key: 'all', label: 'All' },
];

const dateLabel = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

/**
 * CFO register of tenant rent plans booked on partner promissory notes.
 * No money moves at booking — this is the memo register that explains why a plan
 * is missing from the company landlord-float queue, plus its 7-day countdown.
 * One RPC round trip carries KPIs + the page (no N+1).
 */
export function PromissoryBookingsPanel() {
  const [filter, setFilter] = useState<Filter>('live');

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['cfo-promissory-bookings', filter],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('cfo_promissory_bookings_report' as any, {
        p_limit: 200,
        p_offset: 0,
        p_filter: filter,
      });
      if (error) throw error;
      return data as unknown as { kpi: Kpi; rows: BookingRow[]; total: number };
    },
    staleTime: 60_000,
  });

  const kpi = data?.kpi;
  const rows = useMemo(() => data?.rows ?? [], [data]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4 text-primary" />
            Partner promissory bookings (7-day hold)
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Tenant plans booked on a partner promissory note. Company float cannot fund these while the hold is live.
            Unfunded bookings are warned 4 days out and auto-released on day 7.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isRefetching}>
          <RotateCcw className={`h-3.5 w-3.5 ${isRefetching ? 'animate-spin' : ''}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Kpicard label="Held now" value={kpi ? `${kpi.live_count}` : '—'} sub={kpi ? formatUGX(kpi.live_amount) : ''} />
          <Kpicard label="Warned (4-day)" value={kpi ? `${kpi.warned_count}` : '—'} sub="partner notified" />
          <Kpicard
            label="Funded"
            value={kpi ? `${kpi.funded_count}` : '—'}
            sub={kpi ? formatUGX(kpi.funded_amount) : ''}
          />
          <Kpicard
            label="Released back"
            value={kpi ? `${kpi.released_count}` : '—'}
            sub={kpi ? formatUGX(kpi.released_amount) : ''}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <Button
              key={f.key}
              size="sm"
              variant={filter === f.key ? 'default' : 'outline'}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </Button>
          ))}
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No bookings in this view.</p>
        ) : (
          <div className="divide-y rounded-lg border">
            {rows.map((r) => (
              <div key={r.intent_id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold">{r.tenant_name || 'Tenant'}</span>
                    <StatusBadge row={r} />
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    Booked by {r.partner_name || 'Partner'} · agent {r.agent_name || '—'} · {dateLabel(r.booked_at)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold">{formatUGX(r.booked_amount)}</p>
                  <p className="text-xs text-muted-foreground">
                    {r.status === 'reserved'
                      ? `releases ${dateLabel(r.reserved_until)}${r.is_live ? ` · ${r.days_left}d left` : ''}`
                      : r.status === 'released'
                        ? `released ${dateLabel(r.released_at)}`
                        : 'partner capital deployed'}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Kpicard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-lg font-bold leading-tight">{value}</p>
      {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function StatusBadge({ row }: { row: BookingRow }) {
  if (row.status === 'funded') {
    return (
      <Badge variant="outline" className="border-emerald-500/40 text-emerald-600">
        <CheckCircle2 className="mr-1 h-3 w-3" /> FUNDED
      </Badge>
    );
  }
  if (row.status === 'released') {
    return <Badge variant="secondary">RELEASED</Badge>;
  }
  if (row.is_lapsed) {
    return (
      <Badge variant="outline" className="border-amber-500/40 text-amber-600">
        <AlertTriangle className="mr-1 h-3 w-3" /> LAPSED
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-violet-500/40 text-violet-600">
      {row.warned_at ? 'WARNED' : 'HELD'} · {row.days_left}d
    </Badge>
  );
}

export default PromissoryBookingsPanel;
