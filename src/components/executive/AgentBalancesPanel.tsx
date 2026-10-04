import { useEffect, useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Wallet, ArrowUpFromLine, Banknote, CreditCard, Search, TrendingUp, ChevronLeft, ChevronRight, ChevronDown, ArrowRight } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { AgentDetailDialog } from './AgentDetailDialog';
import { useAgentCapacityMap } from '@/hooks/useAgentCapacityMap';
import { AgentCapacityBadge } from './AgentCapacityBadge';

type AgentBalanceRow = {
  user_id: string;
  full_name: string | null;
  phone: string | null;
  territory: string | null;
  withdrawable: number;
  float: number;
  advance: number;
  total: number;
};

type SortKey = 'total' | 'withdrawable' | 'float' | 'advance' | 'name';

const PAGE_SIZE = 50;

const fmt = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : Math.round(n).toLocaleString();

export function AgentBalancesPanel() {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('total');
  const [page, setPage] = useState(0);
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const [expandedCardIds, setExpandedCardIds] = useState<Set<string>>(new Set());

  const toggleCardExpanded = (id: string) => {
    setExpandedCardIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Reset page when sort changes
  useEffect(() => {
    setPage(0);
  }, [sortKey]);

  const { data: balancesData, isLoading, isFetching } = useQuery({
    queryKey: ['agent-ops-balances', search, sortKey, page],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('agent-ops-balances', {
        body: {
          search,
          sort: sortKey,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        },
      });
      if (error) throw error;
      return {
        rows: (data?.rows || []) as AgentBalanceRow[],
        totals: data?.totals || {
          withdrawable: 0, float: 0, advance: 0, total: 0,
          count: 0, withFloat: 0, withWithdrawable: 0, withAdvance: 0,
        },
        totalMatched: data?.totalMatched ?? 0,
      };
    },
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  const rows = balancesData?.rows || [];
  const visibleAgentIds = useMemo(() => rows.map(r => r.user_id), [rows]);
  const { data: capacityMap, isFetching: capacityFetching } = useAgentCapacityMap(visibleAgentIds);
  const totals = balancesData?.totals || {
    withdrawable: 0, float: 0, advance: 0, total: 0,
    count: 0, withFloat: 0, withWithdrawable: 0, withAdvance: 0,
  };
  const totalMatched = balancesData?.totalMatched ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalMatched / PAGE_SIZE));
  const showingFrom = totalMatched === 0 ? 0 : page * PAGE_SIZE + 1;
  const showingTo = Math.min(totalMatched, (page + 1) * PAGE_SIZE);

  return (
    <div className="space-y-3">
      {/* Aggregate breakdown — always reflects ALL agents, not the page */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <SummaryCard label="Total Held" value={fmt(totals.total)} sub={`${totals.count.toLocaleString()} agents`} icon={Wallet} tone="bg-primary/10 text-primary" />
        <SummaryCard label="Withdrawable" value={fmt(totals.withdrawable)} sub={`${totals.withWithdrawable.toLocaleString()} agents > 0`} icon={ArrowUpFromLine} tone="bg-emerald-500/10 text-emerald-600" />
        <SummaryCard label="Float (Ops)" value={fmt(totals.float)} sub={`${totals.withFloat.toLocaleString()} agents > 0`} icon={Banknote} tone="bg-blue-500/10 text-blue-600" />
        <SummaryCard label="Advance" value={fmt(totals.advance)} sub={`${totals.withAdvance.toLocaleString()} agents > 0`} icon={CreditCard} tone="bg-amber-500/10 text-amber-700" />
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search agent by name, phone, or territory…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex gap-1 overflow-x-auto">
          {(['total', 'withdrawable', 'float', 'advance', 'name'] as SortKey[]).map((k) => (
            <button
              key={k}
              onClick={() => setSortKey(k)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-semibold capitalize whitespace-nowrap transition-colors',
                sortKey === k
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80',
              )}
            >
              {k === 'name' ? 'A-Z' : k}
            </button>
          ))}
        </div>
      </div>

      {/* Table / list */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        {isLoading ? (
          <div className="p-3 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">No agents match your search.</div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-semibold">Agent</th>
                    <th className="text-right px-3 py-2.5 font-semibold">Withdrawable</th>
                    <th className="text-right px-3 py-2.5 font-semibold">Float</th>
                    <th className="text-right px-3 py-2.5 font-semibold">Advance</th>
                    <th className="text-right px-4 py-2.5 font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <tr key={r.user_id} onClick={() => setOpenAgentId(r.user_id)} className="hover:bg-muted/30 transition-colors cursor-pointer">
                      <td className="px-4 py-2.5">
                        <div className="font-medium hover:text-primary flex items-center gap-1.5 flex-wrap">
                          <span className={`${(() => {
                            const dr = capacityMap?.get(r.user_id)?.daily_rating;
                            return dr === 'Very Good' || dr === 'Good' ? 'text-emerald-700' : 'text-foreground';
                          })()}`}>{r.full_name || '—'}</span>
                          <AgentCapacityBadge
                            capacity={capacityMap?.get(r.user_id)}
                            loading={capacityFetching && !capacityMap}
                          />
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {r.phone || 'No phone'}
                          {r.territory ? ` · ${r.territory}` : ''}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700">{fmt(r.withdrawable)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-blue-700">{fmt(r.float)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-amber-700">{fmt(r.advance)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-bold">{fmt(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden divide-y divide-border">
              {rows.map((r) => {
                const isExpanded = expandedCardIds.has(r.user_id);
                return (
                  <div key={r.user_id} className="p-3 space-y-2 transition-colors">
                    <div
                      onClick={() => toggleCardExpanded(r.user_id)}
                      className="flex items-start justify-between gap-2 cursor-pointer active:opacity-75 select-none"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-sm truncate flex items-center gap-1.5 flex-wrap">
                          <span
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenAgentId(r.user_id);
                            }}
                            className={`truncate hover:underline ${(() => {
                              const dr = capacityMap?.get(r.user_id)?.daily_rating;
                              return dr === 'Very Good' || dr === 'Good' ? 'text-emerald-700' : '';
                            })()}`}
                          >
                            {r.full_name || '—'}
                          </span>
                          <div onClick={(e) => e.stopPropagation()}>
                            <AgentCapacityBadge
                              capacity={capacityMap?.get(r.user_id)}
                              loading={capacityFetching && !capacityMap}
                            />
                          </div>
                        </div>
                        <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                          {r.phone || 'No phone'}
                          {r.territory ? ` · ${r.territory}` : ''}
                        </div>
                      </div>
                      <div className="text-right shrink-0 flex items-center gap-2">
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Total</div>
                          <div className="text-sm font-bold tabular-nums">{fmt(r.total)}</div>
                        </div>
                        <ChevronDown
                          className={cn(
                            "h-4 w-4 text-muted-foreground transition-transform duration-200 mt-1",
                            isExpanded && "rotate-180"
                          )}
                        />
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="space-y-2 pt-1 border-t border-border/40 animate-in fade-in-50 duration-150">
                        <div className="grid grid-cols-3 gap-1.5">
                          <BucketChip label="Withdraw" value={fmt(r.withdrawable)} tone="bg-emerald-500/10 text-emerald-700" />
                          <BucketChip label="Float" value={fmt(r.float)} tone="bg-blue-500/10 text-blue-700" />
                          <BucketChip label="Advance" value={fmt(r.advance)} tone="bg-amber-500/10 text-amber-700" />
                        </div>
                        <div className="flex justify-end pt-0.5">
                          <button
                            type="button"
                            onClick={() => setOpenAgentId(r.user_id)}
                            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline px-1 py-0.5"
                          >
                            <span>View 360° Profile</span>
                            <ArrowRight className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Pagination */}
      {totalMatched > 0 && (
        <div className="flex items-center justify-between gap-2 px-1">
          <p className="text-[11px] text-muted-foreground">
            {showingFrom.toLocaleString()}–{showingTo.toLocaleString()} of {totalMatched.toLocaleString()}
            {isFetching && <span className="ml-2 italic opacity-70">updating…</span>}
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0 || isFetching}
              className="p-1.5 rounded-lg bg-muted text-muted-foreground hover:bg-muted/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-[11px] font-semibold tabular-nums px-2">
              {page + 1} / {totalPages.toLocaleString()}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1 || isFetching}
              className="p-1.5 rounded-lg bg-muted text-muted-foreground hover:bg-muted/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground flex items-center gap-1.5 px-1">
        <TrendingUp className="h-3 w-3" />
        Tap any agent to see full 360° profile. Totals reflect ALL agents, not just this page.
      </p>

      <AgentDetailDialog
        agentId={openAgentId}
        open={!!openAgentId}
        onOpenChange={(o) => !o && setOpenAgentId(null)}
      />
    </div>
  );
}

function SummaryCard({
  label, value, sub, icon: Icon, tone,
}: { label: string; value: string; sub: string; icon: any; tone: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-2 mb-1.5">
        <div className={cn('p-1.5 rounded-lg', tone)}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">{label}</span>
      </div>
      <div className="text-lg font-bold tabular-nums leading-tight">{value}</div>
      <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>
    </div>
  );
}

function BucketChip({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className={cn('rounded-lg px-2 py-1.5 text-center', tone)}>
      <div className="text-[9px] uppercase tracking-wider font-semibold opacity-80">{label}</div>
      <div className="text-xs font-bold tabular-nums">{value}</div>
    </div>
  );
}
