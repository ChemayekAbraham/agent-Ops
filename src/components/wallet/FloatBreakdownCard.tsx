import { useEffect, useMemo, useState, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowDownLeft, ArrowUpRight, CalendarIcon, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Wallet } from 'lucide-react';
import { CompactAmount } from '@/components/ui/CompactAmount';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { format, startOfDay, endOfDay, subDays } from 'date-fns';
import { applyCustomerWalletLedgerFilters, isCustomerWalletLedgerEntryVisible } from '@/lib/customerWalletHistory';

// Categories that move money into/out of the FLOAT bucket on the wallet leg.
// Kept narrow + explicit so we never miscount commission/withdrawable entries.
const FLOAT_IN_CATEGORIES = [
  'agent_float_deposit',
  'operational_float_deposit',
  'agent_float_topup',
  'float_received',
  'partner_float_transfer_in',
] as const;

const FLOAT_OUT_CATEGORIES = [
  'rent_payment_for_tenant',
  'agent_float_used_for_rent',
  'agent_float_payout',
  'float_withdrawal',
  'landlord_payout',
  'partner_float_transfer_out',
] as const;

const CATEGORY_LABEL: Record<string, string> = {
  agent_float_deposit: 'Deposit',
  operational_float_deposit: 'Deposit',
  agent_float_topup: 'Top-up',
  float_received: 'Received',
  partner_float_transfer_in: 'Transfer in',
  rent_payment_for_tenant: 'Rent paid',
  agent_float_used_for_rent: 'Rent paid',
  agent_float_payout: 'Payout',
  float_withdrawal: 'Withdrawal',
  landlord_payout: 'Landlord payout',
  partner_float_transfer_out: 'Transfer out',
};

interface Entry {
  id: string;
  transaction_date: string;
  category: string;
  direction: 'cash_in' | 'cash_out';
  amount: number;
  reference_id: string | null;
  description: string | null;
}

interface FloatBreakdownCardProps {
  floatBalance: number;
}

const ALL_CATS = [...FLOAT_IN_CATEGORIES, ...FLOAT_OUT_CATEGORIES];
const PAGE_SIZE = 50;

type RangePreset = 'all' | '7d' | '30d' | '90d' | 'custom';

const PRESET_LABEL: Record<RangePreset, string> = {
  all: 'All time',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  custom: 'Custom range',
};

function resolveRange(preset: RangePreset, customFrom?: Date, customTo?: Date): { from?: string; to?: string } {
  const now = new Date();
  if (preset === 'all') return {};
  if (preset === '7d') return { from: startOfDay(subDays(now, 6)).toISOString(), to: endOfDay(now).toISOString() };
  if (preset === '30d') return { from: startOfDay(subDays(now, 29)).toISOString(), to: endOfDay(now).toISOString() };
  if (preset === '90d') return { from: startOfDay(subDays(now, 89)).toISOString(), to: endOfDay(now).toISOString() };
  // custom
  return {
    from: customFrom ? startOfDay(customFrom).toISOString() : undefined,
    to: customTo ? endOfDay(customTo).toISOString() : undefined,
  };
}

function labelFor(cat: string) {
  return CATEGORY_LABEL[cat] ?? cat.replace(/_/g, ' ');
}

export function FloatBreakdownCard({ floatBalance }: FloatBreakdownCardProps) {
  const { user } = useAuth();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [cumulativeIn, setCumulativeIn] = useState(0);
  const [cumulativeOut, setCumulativeOut] = useState(0);
  const [seenIds, setSeenIds] = useState<Set<string>>(new Set());
  const [preset, setPreset] = useState<RangePreset>('all');
  const [customFrom, setCustomFrom] = useState<Date | undefined>();
  const [customTo, setCustomTo] = useState<Date | undefined>();

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const range = useMemo(
    () => resolveRange(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  const fetchPage = useCallback(async (pageIndex: number) => {
    if (!user?.id) return;
    setLoading(true);

    const from = pageIndex * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    let rowsQ = applyCustomerWalletLedgerFilters(supabase
      .from('general_ledger')
      .select('id, transaction_date, category, direction, amount, reference_id, description, classification, source_table')
      .eq('user_id', user.id)
      .eq('ledger_scope', 'wallet')
      .in('category', ALL_CATS));
    let countQ = applyCustomerWalletLedgerFilters(supabase
      .from('general_ledger')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('ledger_scope', 'wallet')
      .in('category', ALL_CATS));

    if (range.from) {
      rowsQ = rowsQ.gte('transaction_date', range.from);
      countQ = countQ.gte('transaction_date', range.from);
    }
    if (range.to) {
      rowsQ = rowsQ.lte('transaction_date', range.to);
      countQ = countQ.lte('transaction_date', range.to);
    }

    const [{ data, error }, { count, error: countError }] = await Promise.all([
      rowsQ.order('transaction_date', { ascending: false }).range(from, to),
      countQ,
    ]);

    if (error) {
      console.error('[FloatBreakdownCard] load error', error);
      setEntries([]);
    } else {
      setEntries(((data ?? []) as Entry[]).filter(isCustomerWalletLedgerEntryVisible));
    }

    if (countError) {
      console.error('[FloatBreakdownCard] count error', countError);
    } else {
      setTotalCount(count ?? 0);
    }

    setLoading(false);
  }, [user?.id, range.from, range.to]);

  useEffect(() => {
    if (!user?.id || !expanded) return;
    fetchPage(page);
  }, [user?.id, expanded, page, fetchPage]);

  // Reset pagination and cumulative reconciliation when the filter changes.
  useEffect(() => {
    setPage(0);
    setCumulativeIn(0);
    setCumulativeOut(0);
    setSeenIds(new Set());
  }, [range.from, range.to]);

  // Accumulate totals across all pages the user has visited so far.
  useEffect(() => {
    if (entries.length === 0) return;
    setSeenIds((prev) => {
      const next = new Set(prev);
      let addedIn = 0;
      let addedOut = 0;
      for (const e of entries) {
        if (!next.has(e.id)) {
          next.add(e.id);
          if (e.direction === 'cash_in') addedIn += Number(e.amount || 0);
          else addedOut += Number(e.amount || 0);
        }
      }
      if (addedIn > 0) setCumulativeIn((c) => c + addedIn);
      if (addedOut > 0) setCumulativeOut((c) => c + addedOut);
      return next;
    });
  }, [entries]);

  const totalIn = entries
    .filter((e) => e.direction === 'cash_in')
    .reduce((s, e) => s + Number(e.amount || 0), 0);
  const totalOut = entries
    .filter((e) => e.direction === 'cash_out')
    .reduce((s, e) => s + Number(e.amount || 0), 0);

  const netCumulative = cumulativeIn - cumulativeOut;
  const diff = netCumulative - floatBalance;
  const isReconciled = Math.abs(diff) < 1;
  const allReviewed = seenIds.size >= totalCount && totalCount > 0;

  const canGoPrev = page > 0;
  const canGoNext = page < totalPages - 1;

  return (
    <Card className="border-border/50 shadow-sm">
      <CardContent className="p-5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center gap-4 text-left"
          aria-expanded={expanded}
          aria-controls="float-breakdown-body"
        >
          <div className="h-11 w-11 rounded-full bg-muted flex items-center justify-center shrink-0">
            <Wallet className="h-5 w-5 text-foreground/70" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
              Wallet float balance
            </p>
            <p className="text-xl font-semibold text-foreground tabular-nums">
              {formatUGX(floatBalance)}
            </p>
          </div>
          {expanded ? (
            <ChevronUp className="h-5 w-5 text-muted-foreground/60" />
          ) : (
            <ChevronDown className="h-5 w-5 text-muted-foreground/60" />
          )}
        </button>

        {expanded && (
          <div id="float-breakdown-body" className="mt-5 space-y-4">
            {/* Date-range filter */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium text-muted-foreground">
                Activity
              </p>
              <Select value={preset} onValueChange={(v) => setPreset(v as RangePreset)}>
                <SelectTrigger className="h-8 w-[140px] text-xs border-border/60">
                  <SelectValue placeholder="Range" />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PRESET_LABEL) as RangePreset[]).map((k) => (
                    <SelectItem key={k} value={k} className="text-xs">
                      {PRESET_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {preset === 'custom' && (
                <>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className={cn(
                          'h-8 justify-start text-left text-xs font-normal',
                          !customFrom && 'text-muted-foreground',
                        )}
                      >
                        <CalendarIcon className="mr-1.5 h-3.5 w-3.5" />
                        {customFrom ? format(customFrom, 'MMM d, yyyy') : 'From'}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={customFrom}
                        onSelect={setCustomFrom}
                        disabled={(d) => d > new Date() || (customTo ? d > customTo : false)}
                        initialFocus
                        className={cn('p-3 pointer-events-auto')}
                      />
                    </PopoverContent>
                  </Popover>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className={cn(
                          'h-8 justify-start text-left text-xs font-normal',
                          !customTo && 'text-muted-foreground',
                        )}
                      >
                        <CalendarIcon className="mr-1.5 h-3.5 w-3.5" />
                        {customTo ? format(customTo, 'MMM d, yyyy') : 'To'}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={customTo}
                        onSelect={setCustomTo}
                        disabled={(d) => d > new Date() || (customFrom ? d < customFrom : false)}
                        initialFocus
                        className={cn('p-3 pointer-events-auto')}
                      />
                    </PopoverContent>
                  </Popover>
                  {(customFrom || customTo) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 text-xs text-muted-foreground"
                      onClick={() => {
                        setCustomFrom(undefined);
                        setCustomTo(undefined);
                      }}
                    >
                      Clear
                    </Button>
                  )}
                </>
              )}
            </div>

            <div className="grid grid-cols-2 divide-x divide-border/60 rounded-xl border border-border/60 bg-muted/30">
              <div className="px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Money in
                </p>
                <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400 tabular-nums mt-0.5">
                  {formatUGX(totalIn)}
                </p>
              </div>
              <div className="px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Money out
                </p>
                <p className="text-sm font-semibold text-rose-700 dark:text-rose-400 tabular-nums mt-0.5">
                  {formatUGX(totalOut)}
                </p>
              </div>
            </div>

            {loading ? (
              <p className="text-xs text-muted-foreground py-4 text-center">
                Loading entries…
              </p>
            ) : entries.length === 0 ? (
              <p className="text-xs text-muted-foreground py-6 text-center">
                No activity in this period.
              </p>
            ) : (
              <>
                <ul className="divide-y divide-border/50">
                  {entries.map((e) => {
                    const isIn = e.direction === 'cash_in';
                    return (
                      <li
                        key={e.id}
                        className="flex items-center gap-3 py-3"
                      >
                        <div
                          className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${
                            isIn ? 'bg-emerald-500/10' : 'bg-rose-500/10'
                          }`}
                        >
                          {isIn ? (
                            <ArrowDownLeft className="h-4 w-4 text-emerald-600" />
                          ) : (
                            <ArrowUpRight className="h-4 w-4 text-rose-600" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {labelFor(e.category)}
                          </p>
                          <p className="text-[11px] text-muted-foreground truncate">
                            {format(new Date(e.transaction_date), 'MMM d · h:mm a')}
                          </p>
                        </div>
                        <p
                          className={`text-sm font-semibold tabular-nums shrink-0 ${
                            isIn
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-rose-700 dark:text-rose-400'
                          }`}
                        >
                          {isIn ? '+' : '−'}
                          {formatUGX(Number(e.amount))}
                        </p>
                      </li>
                    );
                  })}
                </ul>

                {/* Pagination controls */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between pt-2 border-t border-border/50">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1 px-2"
                      disabled={!canGoPrev}
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Prev
                    </Button>
                    <span className="text-xs text-muted-foreground font-medium">
                      Page {page + 1} of {totalPages}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1 px-2"
                      disabled={!canGoNext}
                      onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    >
                      Next
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                )}

                {/* Reconciliation row */}
                <div
                  className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3 space-y-1.5"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-foreground">
                      Summary
                    </p>
                    <span
                      className={`text-[10px] font-medium ${
                        isReconciled
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-amber-700 dark:text-amber-400'
                      }`}
                    >
                      {isReconciled ? '✓ Matches' : 'Mismatch'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Net activity</span>
                    <span className="font-medium tabular-nums text-foreground">
                      {formatUGX(netCumulative)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Current balance</span>
                    <span className="font-medium tabular-nums text-foreground">
                      {formatUGX(floatBalance)}
                    </span>
                  </div>
                  {!isReconciled && (
                    <div className="flex items-center justify-between text-xs pt-1 border-t border-border/40">
                      <span className="text-muted-foreground">Difference</span>
                      <span
                        className={`font-semibold tabular-nums ${
                          diff > 0
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-rose-700 dark:text-rose-400'
                        }`}
                      >
                        {diff > 0 ? '+' : ''}
                        {formatUGX(diff)}
                      </span>
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground pt-1">
                    {seenIds.size.toLocaleString()} of {totalCount.toLocaleString()} entries reviewed
                  </p>
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default FloatBreakdownCard;