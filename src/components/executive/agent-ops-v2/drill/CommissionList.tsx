import { useEffect, useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Banknote, AlertCircle, ChevronDown, ChevronRight, User } from 'lucide-react';
import { formatDistanceToNow, subHours, subDays } from 'date-fns';
import { cn } from '@/lib/utils';
import type { DateRange } from '../AgentOpsHomeView';

const PAGE_SIZE = 500; // aggregate-per-agent — pull a wider window

const COMMISSION_LEDGER_CATEGORIES = [
  'agent_commission_earned',
  'agent_commission',
  'agent_bonus',
  'agent_investment_commission',
  'proxy_investment_commission',
  'partner_commission',
];

const COMMISSION_CREDIT_DIRECTIONS = ['cash_in', 'credit'];

function getRangeStart(range: DateRange): Date {
  if (range === '24h') return subHours(new Date(), 24);
  if (range === '7d') return subDays(new Date(), 7);
  return subDays(new Date(), 30);
}

interface EarningRow {
  id: string;
  created_at: string;
  amount: number;
  earning_type: string | null;
  description: string | null;
  agent_id: string;
  agent_name: string | null;
}

interface AgentGroup {
  agent_id: string;
  agent_name: string;
  total: number;
  count: number;
  lastAt: string;
  rows: EarningRow[];
}

interface CommissionLedgerRow {
  id: string;
  created_at: string | null;
  transaction_date?: string | null;
  amount?: number | string | null;
  category?: string | null;
  source_table?: string | null;
  description?: string | null;
  user_id?: string | null;
  ledger_scope?: string | null;
  direction?: string | null;
}

interface ProfileNameRow {
  id: string;
  full_name: string | null;
}

export function CommissionList({ range }: { range: DateRange }) {
  const rangeStart = useMemo(() => getRangeStart(range).toISOString(), [range]);
  const [liveRows, setLiveRows] = useState<EarningRow[]>([]);
  const [highlightIds, setHighlightIds] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    setLiveRows([]);
    setExpanded(new Set());
  }, [range]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['agent-ops-drill', 'commission', 'by-agent', range],
    queryFn: async () => {
      // Source of truth = wallet-scoped general ledger commission credits.
      // Accrual/cache tables can lag the actual wallet earnings route.
      const { data: earnings, error } = await supabase
        .from('general_ledger')
        .select('id, created_at, transaction_date, amount, category, source_table, description, user_id')
        .eq('ledger_scope', 'wallet')
        .in('category', COMMISSION_LEDGER_CATEGORIES)
        .in('direction', COMMISSION_CREDIT_DIRECTIONS)
        .gte('created_at', rangeStart)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE);
      if (error) throw error;
      const ledgerRows = (earnings ?? []) as CommissionLedgerRow[];
      const ids = Array.from(new Set(ledgerRows.map((e) => e.user_id).filter(Boolean))) as string[];
      const nameMap = new Map<string, string>();
      if (ids.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', ids);
        ((profs ?? []) as ProfileNameRow[]).forEach((p) => nameMap.set(p.id, p.full_name ?? 'Unknown agent'));
      }
      const rows: EarningRow[] = ledgerRows.map((e) => ({
        id: e.id,
        created_at: e.transaction_date || e.created_at,
        amount: Number(e.amount ?? 0),
        earning_type: e.category || e.source_table || null,
        description: e.description,
        agent_id: e.user_id,
        agent_name: e.user_id ? nameMap.get(e.user_id) ?? null : null,
      }));
      return { rows, hasMore: rows.length === PAGE_SIZE };
    },
  });

  useEffect(() => {
    const channel = supabase
      .channel(`drill-commission-${range}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'general_ledger' },
        async (payload) => {
          const e = payload.new as CommissionLedgerRow;
          if (e.ledger_scope !== 'wallet') return;
          if (!COMMISSION_LEDGER_CATEGORIES.includes(e.category)) return;
          if (!COMMISSION_CREDIT_DIRECTIONS.includes(e.direction)) return;
          if (new Date(e.created_at) < new Date(rangeStart)) return;
          let agentName: string | null = null;
          if (e.user_id) {
            const { data: p } = await supabase
              .from('profiles')
              .select('full_name')
              .eq('id', e.user_id)
              .maybeSingle();
            agentName = (p as ProfileNameRow | null)?.full_name ?? null;
          }
          const row: EarningRow = {
            id: e.id,
            created_at: e.transaction_date || e.created_at,
            amount: Number(e.amount ?? 0),
            earning_type: e.category || e.source_table || null,
            description: e.description,
            agent_id: e.user_id,
            agent_name: agentName,
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

  const groups = useMemo<AgentGroup[]>(() => {
    const map = new Map<string, AgentGroup>();
    for (const r of allRows) {
      const key = r.agent_id || 'unknown';
      const g = map.get(key);
      if (g) {
        g.total += r.amount;
        g.count += 1;
        if (r.created_at > g.lastAt) g.lastAt = r.created_at;
        g.rows.push(r);
      } else {
        map.set(key, {
          agent_id: key,
          agent_name: r.agent_name || 'Unknown agent',
          total: r.amount,
          count: 1,
          lastAt: r.created_at,
          rows: [r],
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [allRows]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  if (isLoading) {
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
        <p className="text-sm text-muted-foreground">Failed to load earnings.</p>
        <Button size="sm" variant="outline" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  if (allRows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
        <Banknote className="h-8 w-8 text-muted-foreground/60" />
        <p className="text-sm font-medium text-foreground">No commission in this window yet.</p>
        <p className="text-xs text-muted-foreground">New entries appear here live.</p>
      </div>
    );
  }

  const totalSum = groups.reduce((s, g) => s + g.total, 0);
  const rangeLabel = range === '24h' ? 'last 24 hours' : range === '7d' ? 'last 7 days' : 'last 30 days';

  return (
    <div className="space-y-2 overflow-y-auto max-h-[50vh] pr-1">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground px-1">
        <span>
          {groups.length} agent{groups.length === 1 ? '' : 's'} · {allRows.length} entr{allRows.length === 1 ? 'y' : 'ies'} · {rangeLabel}
        </span>
        <span className="font-semibold text-foreground tabular-nums">
          UGX {totalSum.toLocaleString()}
        </span>
      </div>
      {groups.map((g) => {
        const isOpen = expanded.has(g.agent_id);
        const hasLiveHighlight = g.rows.some((r) => highlightIds.has(r.id));
        return (
          <div
            key={g.agent_id}
            className={cn(
              'rounded-xl border border-border/50 bg-card transition-colors',
              hasLiveHighlight && 'bg-emerald-500/10 border-emerald-500/30',
            )}
          >
            <button
              type="button"
              onClick={() => toggle(g.agent_id)}
              className="w-full flex items-center gap-3 p-2.5 min-h-[48px] text-left"
            >
              {isOpen ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              )}
              <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                <User className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground truncate">{g.agent_name}</p>
                <p className="text-[11px] text-muted-foreground truncate">
                  {g.count} payout{g.count === 1 ? '' : 's'} · last {formatDistanceToNow(new Date(g.lastAt), { addSuffix: true })}
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-semibold text-foreground tabular-nums">
                  UGX {g.total.toLocaleString()}
                </p>
                <p className="text-[10px] text-muted-foreground">earned · {rangeLabel}</p>
              </div>
            </button>
            {isOpen && (
              <div className="border-t border-border/50 px-2.5 py-2 space-y-1.5">
                {g.rows.map((r) => (
                  <div
                    key={r.id}
                    className={cn(
                      'flex items-center gap-2 py-1.5 px-2 rounded-lg',
                      highlightIds.has(r.id) && 'bg-emerald-500/10',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] text-foreground truncate capitalize">
                        {r.earning_type?.replace(/_/g, ' ') || r.description || 'Earning'}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                      </p>
                    </div>
                    <p className="text-[11px] font-semibold text-foreground tabular-nums shrink-0">
                      UGX {r.amount.toLocaleString()}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {data?.hasMore && (
        <p className="text-[10px] text-muted-foreground text-center pt-1">
          Showing top {PAGE_SIZE} entries in window.
        </p>
      )}
    </div>
  );
}