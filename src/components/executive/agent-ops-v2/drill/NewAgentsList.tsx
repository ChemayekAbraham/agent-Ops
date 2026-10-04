import { useEffect, useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/UserAvatar';
import { UserPlus, AlertCircle } from 'lucide-react';
import { formatDistanceToNow, subHours, subDays } from 'date-fns';
import { cn } from '@/lib/utils';
import type { DateRange } from '../AgentOpsHomeView';

const PAGE_SIZE = 25;

function getRangeStart(range: DateRange): Date {
  if (range === '24h') return subHours(new Date(), 24);
  if (range === '7d') return subDays(new Date(), 7);
  return subDays(new Date(), 30);
}

interface AgentRow {
  user_id: string;
  created_at: string;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
}

export function NewAgentsList({ range }: { range: DateRange }) {
  const rangeStart = useMemo(() => getRangeStart(range).toISOString(), [range]);
  const [page, setPage] = useState(0);
  const [liveRows, setLiveRows] = useState<AgentRow[]>([]);
  const [highlightIds, setHighlightIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setPage(0);
    setLiveRows([]);
  }, [range]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['agent-ops-drill', 'new-agents', range, page],
    queryFn: async () => {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const { data: roles, error } = await supabase
        .from('user_roles')
        .select('user_id, created_at')
        .eq('role', 'agent')
        .gte('created_at', rangeStart)
        .order('created_at', { ascending: false })
        .range(from, to);
      if (error) throw error;
      const ids = (roles ?? []).map((r) => r.user_id);
      if (ids.length === 0) return { rows: [] as AgentRow[], hasMore: false };
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone, avatar_url')
        .in('id', ids);
      const pmap = new Map((profiles ?? []).map((p: any) => [p.id, p]));
      const rows: AgentRow[] = (roles ?? []).map((r) => {
        const p = pmap.get(r.user_id);
        return {
          user_id: r.user_id,
          created_at: r.created_at,
          full_name: p?.full_name ?? null,
          phone: p?.phone ?? null,
          avatar_url: p?.avatar_url ?? null,
        };
      });
      return { rows, hasMore: rows.length === PAGE_SIZE };
    },
  });

  // Realtime: prepend new agent rows
  useEffect(() => {
    const channel = supabase
      .channel(`drill-new-agents-${range}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'user_roles', filter: 'role=eq.agent' },
        async (payload) => {
          const newRow = payload.new as { user_id: string; created_at: string };
          if (new Date(newRow.created_at) < new Date(rangeStart)) return;
          const { data: prof } = await supabase
            .from('profiles')
            .select('id, full_name, phone, avatar_url')
            .eq('id', newRow.user_id)
            .maybeSingle();
          const row: AgentRow = {
            user_id: newRow.user_id,
            created_at: newRow.created_at,
            full_name: (prof as any)?.full_name ?? null,
            phone: (prof as any)?.phone ?? null,
            avatar_url: (prof as any)?.avatar_url ?? null,
          };
          setLiveRows((prev) => [row, ...prev.filter((r) => r.user_id !== row.user_id)]);
          setHighlightIds((prev) => new Set(prev).add(row.user_id));
          setTimeout(() => {
            setHighlightIds((prev) => {
              const n = new Set(prev);
              n.delete(row.user_id);
              return n;
            });
          }, 1500);
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
      if (seen.has(r.user_id)) return false;
      seen.add(r.user_id);
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
        <p className="text-sm text-muted-foreground">Failed to load agents.</p>
        <Button size="sm" variant="outline" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  if (allRows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
        <UserPlus className="h-8 w-8 text-muted-foreground/60" />
        <p className="text-sm font-medium text-foreground">No new agents in this window yet.</p>
        <p className="text-xs text-muted-foreground">New entries appear here live.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 overflow-y-auto max-h-[50vh] pr-1">
      {allRows.map((r) => (
        <div
          key={r.user_id}
          className={cn(
            'flex items-center gap-3 p-2.5 rounded-xl border border-border/50 bg-card min-h-[44px] transition-colors',
            highlightIds.has(r.user_id) && 'bg-primary/10 border-primary/30',
          )}
        >
          <UserAvatar avatarUrl={r.avatar_url} fullName={r.full_name ?? undefined} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground truncate">
              {r.full_name || 'Unnamed agent'}
            </p>
            <p className="text-xs text-muted-foreground truncate">{r.phone || '—'}</p>
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