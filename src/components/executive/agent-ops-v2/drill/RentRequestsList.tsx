import { useEffect, useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { FileText, AlertCircle } from 'lucide-react';
import { formatDistanceToNow, subHours, subDays } from 'date-fns';
import { cn } from '@/lib/utils';
import type { DateRange } from '../AgentOpsHomeView';

const PAGE_SIZE = 25;

function getRangeStart(range: DateRange): Date {
  if (range === '24h') return subHours(new Date(), 24);
  if (range === '7d') return subDays(new Date(), 7);
  return subDays(new Date(), 30);
}

interface RequestRow {
  id: string;
  created_at: string;
  amount: number;
  status: string | null;
  tenant_id: string | null;
  tenant_name: string | null;
}

const STATUS_TONE: Record<string, string> = {
  pending: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30',
  approved: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
  rejected: 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30',
  paid: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
  disbursed: 'bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30',
};

export function RentRequestsList({ range }: { range: DateRange }) {
  const rangeStart = useMemo(() => getRangeStart(range).toISOString(), [range]);
  const [page, setPage] = useState(0);
  const [liveRows, setLiveRows] = useState<RequestRow[]>([]);
  const [highlightIds, setHighlightIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setPage(0);
    setLiveRows([]);
  }, [range]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['agent-ops-drill', 'rent-requests', range, page],
    queryFn: async () => {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const { data: reqs, error } = await supabase
        .from('rent_requests')
        .select('id, created_at, amount, status, tenant_id')
        .gte('created_at', rangeStart)
        .order('created_at', { ascending: false })
        .range(from, to);
      if (error) throw error;
      const ids = (reqs ?? []).map((r: any) => r.tenant_id).filter(Boolean);
      const profMap = new Map<string, string>();
      if (ids.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', ids);
        (profs ?? []).forEach((p: any) => profMap.set(p.id, p.full_name));
      }
      const rows: RequestRow[] = (reqs ?? []).map((r: any) => ({
        id: r.id,
        created_at: r.created_at,
        amount: Number(r.amount ?? 0),
        status: r.status,
        tenant_id: r.tenant_id,
        tenant_name: r.tenant_id ? profMap.get(r.tenant_id) ?? null : null,
      }));
      return { rows, hasMore: rows.length === PAGE_SIZE };
    },
  });

  useEffect(() => {
    const channel = supabase
      .channel(`drill-rent-requests-${range}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'rent_requests' },
        async (payload) => {
          const r = payload.new as any;
          if (new Date(r.created_at) < new Date(rangeStart)) return;
          let tenantName: string | null = null;
          if (r.tenant_id) {
            const { data: p } = await supabase
              .from('profiles')
              .select('full_name')
              .eq('id', r.tenant_id)
              .maybeSingle();
            tenantName = (p as any)?.full_name ?? null;
          }
          const row: RequestRow = {
            id: r.id,
            created_at: r.created_at,
            amount: Number(r.amount ?? 0),
            status: r.status,
            tenant_id: r.tenant_id,
            tenant_name: tenantName,
          };
          setLiveRows((prev) => [row, ...prev.filter((x) => x.id !== row.id)]);
          setHighlightIds((prev) => new Set(prev).add(row.id));
          setTimeout(() => {
            setHighlightIds((prev) => {
              const n = new Set(prev);
              n.delete(row.id);
              return n;
            });
          }, 1500);
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rent_requests' },
        (payload) => {
          const r = payload.new as any;
          setLiveRows((prev) =>
            prev.map((x) =>
              x.id === r.id ? { ...x, status: r.status, amount: Number(r.amount ?? x.amount) } : x,
            ),
          );
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [range, rangeStart]);

  const allRows = useMemo(() => {
    const seen = new Set<string>();
    return [...liveRows, ...(data?.rows ?? [])].filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
  }, [liveRows, data?.rows]);

  if (isLoading && page === 0) {
    return (
      <div className="space-y-2 overflow-y-auto h-full pr-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-2 text-center">
        <AlertCircle className="h-6 w-6 text-destructive" />
        <p className="text-sm text-muted-foreground">Failed to load requests.</p>
        <Button size="sm" variant="outline" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  if (allRows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
        <FileText className="h-8 w-8 text-muted-foreground/60" />
        <p className="text-sm font-medium text-foreground">No rent requests in this window yet.</p>
        <p className="text-xs text-muted-foreground">New entries appear here live.</p>
      </div>
    );
  }

  const totalSum = allRows.reduce((s, r) => s + r.amount, 0);

  return (
    <div className="space-y-2 overflow-y-auto max-h-[50vh] pr-1">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground px-1">
        <span>{allRows.length} request{allRows.length === 1 ? '' : 's'}</span>
        <span className="font-semibold text-foreground tabular-nums">
          UGX {totalSum.toLocaleString()}
        </span>
      </div>
      {allRows.map((r) => (
        <div
          key={r.id}
          className={cn(
            'flex items-center gap-3 p-2.5 rounded-xl border border-border/50 bg-card min-h-[44px] transition-colors',
            highlightIds.has(r.id) && 'bg-primary/10 border-primary/30',
          )}
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground truncate">
              {r.tenant_name || 'Unknown tenant'}
            </p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-xs font-semibold text-foreground tabular-nums">
                UGX {r.amount.toLocaleString()}
              </span>
              {r.status && (
                <Badge
                  variant="outline"
                  className={cn('h-4 px-1.5 text-[9px] capitalize', STATUS_TONE[r.status] ?? '')}
                >
                  {r.status.replace(/_/g, ' ')}
                </Badge>
              )}
            </div>
          </div>
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
            {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
          </span>
        </div>
      ))}
      {data?.hasMore && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={() => setPage((p) => p + 1)}
        >
          Load more
        </Button>
      )}
    </div>
  );
}