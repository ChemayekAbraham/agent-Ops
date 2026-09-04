import { useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import {
  Loader2,
  ArrowDownLeft,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  CalendarIcon,
  Wallet,
  Receipt,
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import {
  format,
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  startOfQuarter,
  endOfQuarter,
  addDays,
  addMonths,
  addQuarters,
} from 'date-fns';

const PAGE_SIZE = 10;

type PeriodMode = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'custom';

interface CorrectionRow {
  id: string;
  operation: string;
  amount: number;
  evidence: string | null;
  reference_id: string | null;
  created_at: string;
  target_user_id: string;
  metadata: Record<string, unknown> | null;
  recipient?: { full_name: string | null; phone: string | null } | null;
}

function pageWindow(current: number, total: number): (number | 'gap')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | 'gap')[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) pages.push('gap');
  for (let p = start; p <= end; p++) pages.push(p);
  if (end < total - 1) pages.push('gap');
  pages.push(total);
  return pages;
}

export function GeneralPayoutPage() {
  const [mode, setMode] = useState<PeriodMode>('daily');
  const [anchor, setAnchor] = useState<Date>(new Date());
  const [customFrom, setCustomFrom] = useState<Date | undefined>(startOfMonth(new Date()));
  const [customTo, setCustomTo] = useState<Date | undefined>(new Date());

  const [page, setPage] = useState(1);
  const [nameFilter, setNameFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'credit' | 'debit'>('all');
  const [destinationFilter, setDestinationFilter] = useState<'all' | 'user' | 'operational_wallet'>('all');

  const range = useMemo(() => {
    switch (mode) {
      case 'daily':
        return { start: startOfDay(anchor), end: endOfDay(anchor), label: format(anchor, 'EEEE, dd MMM yyyy') };
      case 'weekly': {
        const s = startOfWeek(anchor, { weekStartsOn: 1 });
        const e = endOfWeek(anchor, { weekStartsOn: 1 });
        return { start: s, end: endOfDay(e), label: `${format(s, 'dd MMM')} – ${format(e, 'dd MMM yyyy')}` };
      }
      case 'monthly': {
        const s = startOfMonth(anchor);
        const e = endOfMonth(anchor);
        return { start: s, end: endOfDay(e), label: format(anchor, 'MMMM yyyy') };
      }
      case 'quarterly': {
        const s = startOfQuarter(anchor);
        const e = endOfQuarter(anchor);
        return {
          start: s,
          end: endOfDay(e),
          label: `Q${Math.floor(anchor.getMonth() / 3) + 1} ${format(anchor, 'yyyy')}`,
        };
      }
      case 'custom': {
        const s = customFrom ? startOfDay(customFrom) : startOfMonth(new Date());
        const e = customTo ? endOfDay(customTo) : endOfDay(new Date());
        return { start: s, end: e, label: `${format(s, 'dd MMM yyyy')} – ${format(e, 'dd MMM yyyy')}` };
      }
    }
  }, [mode, anchor, customFrom, customTo]);

  const shiftPeriod = (dir: -1 | 1) => {
    setPage(1);
    setAnchor((prev) => {
      if (mode === 'daily') return addDays(prev, dir);
      if (mode === 'weekly') return addDays(prev, dir * 7);
      if (mode === 'monthly') return addMonths(prev, dir);
      if (mode === 'quarterly') return addQuarters(prev, dir);
      return prev;
    });
  };

  const applyFilterChange = (fn: () => void) => {
    fn();
    setPage(1);
  };

  const baseKey = [
    range.start.toISOString(),
    range.end.toISOString(),
    nameFilter.trim(),
    categoryFilter.trim(),
    typeFilter,
    destinationFilter,
  ];

  const buildQuery = async (profileIds: string[] | null, forCount: boolean, from = 0) => {
    let query = supabase
      .from('platform_wallet_corrections')
      .select('id, operation, amount, evidence, reference_id, created_at, target_user_id, metadata', {
        count: 'exact',
      })
      .eq('tool', 'cfo_direct_credit')
      .gte('created_at', range.start.toISOString())
      .lte('created_at', range.end.toISOString());

    if (profileIds) query = query.in('target_user_id', profileIds);
    if (categoryFilter.trim()) {
      const term = `%${categoryFilter.trim()}%`;
      query = query.or(`metadata->>category_label.ilike.${term},evidence.ilike.${term}`);
    }
    if (typeFilter !== 'all') query = query.eq('operation', typeFilter);
    if (destinationFilter !== 'all') query = query.eq('metadata->>recipient_type', destinationFilter);

    if (forCount) return query.limit(5000);
    return query.order('created_at', { ascending: false }).range(from, from + PAGE_SIZE - 1);
  };

  const resolveProfileIds = async () => {
    if (!nameFilter.trim()) return null;
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id')
      .ilike('full_name', `%${nameFilter.trim()}%`)
      .limit(1000);
    if (error) throw error;
    return (profiles ?? []).map((p: any) => p.id);
  };

  /** Period summary: total amount and number of payouts for the selected period. */
  const summary = useQuery({
    queryKey: ['cfo-general-payout-summary', ...baseKey],
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const profileIds = await resolveProfileIds();
      if (profileIds && profileIds.length === 0) return { total: 0, count: 0 };
      const { data, error } = await buildQuery(profileIds, true);
      if (error) throw error;
      const rows = (data ?? []) as unknown as CorrectionRow[];
      return {
        total: rows.reduce((s, r) => s + Number(r.amount || 0), 0),
        count: rows.length,
      };
    },
  });

  const records = useQuery({
    queryKey: ['cfo-general-payout-rows', page, ...baseKey],
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const profileIds = await resolveProfileIds();
      if (profileIds && profileIds.length === 0) return { rows: [] as CorrectionRow[], total: 0 };
      const { data, error, count } = await buildQuery(profileIds, false, (page - 1) * PAGE_SIZE);
      if (error) throw error;
      const list = (data ?? []) as unknown as CorrectionRow[];
      const ids = Array.from(new Set(list.map((r) => r.target_user_id).filter(Boolean)));
      let names: Record<string, { full_name: string | null; phone: string | null }> = {};
      if (ids.length) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', ids);
        names = Object.fromEntries(
          (profiles ?? []).map((p: any) => [p.id, { full_name: p.full_name, phone: p.phone }]),
        );
      }
      return {
        rows: list.map((r) => ({ ...r, recipient: names[r.target_user_id] ?? null })),
        total: count ?? 0,
      };
    },
  });

  const total = records.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="space-y-5">
      {/* ── Period selector ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Wallet className="h-4 w-4 text-muted-foreground" />
            General Payout
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            All money sent out from this dashboard, for the period you choose.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {(['daily', 'weekly', 'monthly', 'quarterly', 'custom'] as PeriodMode[]).map((m) => (
              <Button
                key={m}
                size="sm"
                variant={mode === m ? 'default' : 'outline'}
                className="h-8 text-xs capitalize"
                onClick={() => {
                  setMode(m);
                  setPage(1);
                }}
              >
                {m}
              </Button>
            ))}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:flex-wrap">
            {mode !== 'custom' && (
              <>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => shiftPeriod(-1)}>
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <div className="min-w-[190px] rounded-md border border-border bg-muted/30 px-3 py-2 text-center text-sm font-semibold">
                    {range.label}
                  </div>
                  <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => shiftPeriod(1)}>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
                {mode === 'daily' && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className="h-9 justify-start text-xs font-normal">
                        <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                        Pick a date
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={anchor}
                        onSelect={(d) => {
                          if (d) {
                            setAnchor(d);
                            setPage(1);
                          }
                        }}
                        initialFocus
                        className={cn('p-3 pointer-events-auto')}
                      />
                    </PopoverContent>
                  </Popover>
                )}
              </>
            )}

            {mode === 'custom' && (
              <>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="h-9 justify-start text-xs font-normal sm:w-[230px]">
                      <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                      {customFrom && customTo
                        ? `${format(customFrom, 'dd MMM yyyy')} – ${format(customTo, 'dd MMM yyyy')}`
                        : 'Pick a date range'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="range"
                      selected={{ from: customFrom, to: customTo }}
                      onSelect={(r) => {
                        setCustomFrom(r?.from);
                        setCustomTo(r?.to ?? r?.from);
                        setPage(1);
                      }}
                      numberOfMonths={2}
                      initialFocus
                      className={cn('p-3 pointer-events-auto')}
                    />
                  </PopoverContent>
                </Popover>
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm font-semibold">
                  {range.label}
                </div>
              </>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
              <p className="text-xs text-muted-foreground">Total general payout amount</p>
              <p className="mt-1 text-2xl font-bold tracking-tight">
                {summary.isLoading ? '—' : formatUGX(summary.data?.total ?? 0)}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">{range.label}</p>
            </div>
            <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
              <p className="text-xs text-muted-foreground">Number of payouts</p>
              <p className="mt-1 text-2xl font-bold tracking-tight">
                {summary.isLoading ? '—' : (summary.data?.count ?? 0).toLocaleString()}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">In the selected period</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Records ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Receipt className="h-4 w-4 text-muted-foreground" />
            Payout records
            {records.isFetching && !records.isLoading && (
              <span className="text-xs font-normal text-muted-foreground">Updating…</span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="border-b border-border bg-muted/30 px-4 py-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">Recipient name</Label>
                <Input
                  placeholder="Search name…"
                  value={nameFilter}
                  onChange={(e) => applyFilterChange(() => setNameFilter(e.target.value))}
                  className="h-9 text-xs sm:w-[180px]"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">Category</Label>
                <Input
                  placeholder="Search category…"
                  value={categoryFilter}
                  onChange={(e) => applyFilterChange(() => setCategoryFilter(e.target.value))}
                  className="h-9 text-xs sm:w-[180px]"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">Type</Label>
                <Select
                  value={typeFilter}
                  onValueChange={(v) => applyFilterChange(() => setTypeFilter(v as typeof typeFilter))}
                >
                  <SelectTrigger className="h-9 text-xs sm:w-[150px]">
                    <SelectValue placeholder="All types" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    <SelectItem value="credit">Sent</SelectItem>
                    <SelectItem value="debit">Taken out</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">Destination</Label>
                <Select
                  value={destinationFilter}
                  onValueChange={(v) =>
                    applyFilterChange(() => setDestinationFilter(v as typeof destinationFilter))
                  }
                >
                  <SelectTrigger className="h-9 text-xs sm:w-[180px]">
                    <SelectValue placeholder="All destinations" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All destinations</SelectItem>
                    <SelectItem value="user">User wallet</SelectItem>
                    <SelectItem value="operational_wallet">Operational wallet</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 text-xs"
                onClick={() =>
                  applyFilterChange(() => {
                    setNameFilter('');
                    setCategoryFilter('');
                    setTypeFilter('all');
                    setDestinationFilter('all');
                  })
                }
              >
                Clear filters
              </Button>
            </div>
          </div>

          {records.isLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : records.error ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              Could not load payouts right now.
            </p>
          ) : total === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No payouts for this period.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/20 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2.5 font-semibold">Date</th>
                      <th className="px-4 py-2.5 font-semibold">Recipient</th>
                      <th className="px-4 py-2.5 font-semibold">Category / reason</th>
                      <th className="px-4 py-2.5 font-semibold">Destination</th>
                      <th className="px-4 py-2.5 font-semibold">Reference</th>
                      <th className="px-4 py-2.5 text-right font-semibold">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(records.data?.rows ?? []).map((r) => {
                      const meta = (r.metadata ?? {}) as Record<string, any>;
                      const isDebit = r.operation === 'debit';
                      return (
                        <tr key={r.id} className="border-b border-border/60 last:border-0">
                          <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                            {format(new Date(r.created_at), 'dd MMM yyyy, HH:mm')}
                          </td>
                          <td className="px-4 py-3">
                            <p className="font-medium">{r.recipient?.full_name || 'Unnamed'}</p>
                            {r.recipient?.phone && (
                              <p className="text-xs text-muted-foreground">{r.recipient.phone}</p>
                            )}
                          </td>
                          <td className="max-w-[260px] px-4 py-3">
                            <p className="truncate text-xs">
                              {meta.category_label || r.evidence || '—'}
                            </p>
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant="outline" className="text-[11px]">
                              {meta.recipient_type === 'operational_wallet'
                                ? 'Operational wallet'
                                : meta.recipient_type === 'user'
                                  ? 'User wallet'
                                  : '—'}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">
                            {r.reference_id || '—'}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right">
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 font-semibold',
                                isDebit ? 'text-destructive' : 'text-emerald-600',
                              )}
                            >
                              {isDebit ? (
                                <ArrowUpRight className="h-3.5 w-3.5" />
                              ) : (
                                <ArrowDownLeft className="h-3.5 w-3.5" />
                              )}
                              {formatUGX(Number(r.amount || 0))}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">
                  Showing {rangeStart}–{rangeEnd} of {total.toLocaleString()} payouts
                </p>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="mr-1 h-3.5 w-3.5" />
                    Previous
                  </Button>
                  {pageWindow(page, totalPages).map((p, i) =>
                    p === 'gap' ? (
                      <span key={`gap-${i}`} className="px-1 text-xs text-muted-foreground">
                        …
                      </span>
                    ) : (
                      <Button
                        key={p}
                        variant={p === page ? 'default' : 'outline'}
                        size="sm"
                        className="h-8 w-8 p-0 text-xs"
                        onClick={() => setPage(p)}
                      >
                        {p}
                      </Button>
                    ),
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Next
                    <ChevronRight className="ml-1 h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default GeneralPayoutPage;
