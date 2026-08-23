import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  ChevronRight,
  ChevronLeft,
  Loader2,
  ArrowLeft,
  ArrowDownLeft,
  ArrowUpRight,
  Landmark,
  Users,
  Briefcase,
  TrendingUp,
  Wallet,
  PiggyBank,
  Receipt,
  Banknote,
  CircleDollarSign,
  Layers,
  Box,
  CreditCard,
  Truck,
  Activity,
  type LucideIcon,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';

export interface CashSourceLine {
  category: string;
  label: string;
  value: number;
  count?: number;
  /** Underlying ledger categories that net into this source. */
  children?: { category: string; label: string; value: number; count?: number }[];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  totalCash: number;
  a1: number;
  a5: number;
  increases: CashSourceLine[];
  decreases: CashSourceLine[];
  /** Where the cash physically sits (position view — not added to source totals). */
  positions?: CashSourceLine[];
}

interface TxRow {
  id: string;
  transaction_date: string;
  reference: string;
  description: string;
  amount: number;
  direction: 'in' | 'out';
  status: string;
  linked_party: string;
  account_code: string;
}

const PAGE = 50;

const SOURCE_ICONS: Record<string, LucideIcon> = {
  partner_capital: Users,
  partner_capital_recorded: Users,
  investor_deposits: Users,
  agent_float: Briefcase,
  merchant_float: CreditCard,
  operational_float: Layers,
  rent_collections: Banknote,
  rent_payments: Banknote,
  wallet_fees: Receipt,
  platform_fees: Receipt,
  interest_income: TrendingUp,
  returns_accrual: PiggyBank,
  roi_accrual: PiggyBank,
  other_income: CircleDollarSign,
  treasury_topups: Wallet,
  cash_adjustments: Activity,
  withdrawals: ArrowUpRight,
  payouts: ArrowUpRight,
  roi_payouts: ArrowUpRight,
  partner_redemptions: ArrowUpRight,
  agent_commissions: ArrowUpRight,
  refunds: ArrowUpRight,
  operational_expenses: Box,
  merchant_settlements: Truck,
  treasury_platform_cash: Landmark,
  bank_cash: Banknote,
  default: Landmark,
};

function useSourceTransactions(category: string | null, page: number) {
  return useQuery({
    queryKey: ['cfo-cash-source-transactions', category, page],
    enabled: !!category,
    queryFn: async () => {
      // Recorded partner funding drills into the portfolio records themselves —
      // the same rows the Partnership Dashboard reports from.
      if (category === 'partner_capital_recorded') {
        const { data, count, error } = await supabase
          .from('investor_portfolios')
          .select(
            'id, portfolio_code, account_name, investment_amount, status, created_at, payment_method',
            { count: 'exact' }
          )
          .eq('status', 'active')
          .order('created_at', { ascending: false })
          .range(page * PAGE, page * PAGE + PAGE - 1);
        if (error) throw error;
        const rows: TxRow[] = ((data as any[]) || []).map((p) => ({
          id: p.id,
          transaction_date: p.created_at,
          reference: p.portfolio_code || '—',
          description: 'Recorded partner funding',
          amount: Number(p.investment_amount || 0),
          direction: 'in',
          status: p.status,
          linked_party: p.account_name || '—',
          account_code: p.payment_method || 'portfolio',
        }));
        return { rows, totalCount: Number(count ?? rows.length), netAmount: 0 };
      }

      const { data, error } = await supabase.rpc('get_treasury_cash_transactions' as any, {
        p_category: category,
        p_limit: PAGE,
        p_offset: page * PAGE,
      } as any);
      if (error) throw error;
      const res = data as any;
      return {
        rows: (res?.rows ?? []) as TxRow[],
        totalCount: Number(res?.total_count ?? 0),
        netAmount: Number(res?.net_amount ?? 0),
      };
    },
    staleTime: 120_000,
  });
}

function getSourceIcon(category: string) {
  return SOURCE_ICONS[category] ?? SOURCE_ICONS.default;
}

function formatPercent(n: number) {
  if (!Number.isFinite(n)) return '0.0%';
  return `${n.toFixed(1)}%`;
}

export function CashSourcesSheet({ open, onOpenChange, totalCash, a1, a5, increases, decreases, positions = [] }: Props) {
  const [selected, setSelected] = useState<CashSourceLine | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const { data, isLoading, error } = useSourceTransactions(selected?.category ?? null, page);

  const grossIn = useMemo(() => increases.reduce((s, i) => s + i.value, 0), [increases]);
  const grossOut = useMemo(() => decreases.reduce((s, i) => s + i.value, 0), [decreases]);

  const pick = (line: CashSourceLine) => {
    setSelected(line);
    setPage(0);
  };

  const openLine = (line: CashSourceLine) => {
    if (line.children && line.children.length > 1) {
      setExpanded((cur) => (cur === line.category ? null : line.category));
      return;
    }
    const only = line.children?.[0];
    pick(only ? { ...only, value: Math.abs(only.value) } : line);
  };

  const close = (o: boolean) => {
    if (!o) {
      setSelected(null);
      setExpanded(null);
      setPage(0);
    }
    onOpenChange(o);
  };

  const reconciliationGap = totalCash - (grossIn - grossOut);

  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent side="bottom" className="rounded-t-3xl max-h-[92vh] overflow-y-auto px-4 sm:px-6">
        <SheetHeader className="pb-4 pt-1">
          <SheetTitle className="text-base sm:text-lg flex items-center gap-3">
            {selected && (
              <button
                onClick={() => setSelected(null)}
                className="group inline-flex items-center justify-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm hover:border-primary/30 hover:bg-primary/5 hover:text-foreground active:scale-[0.98] transition-all"
                aria-label="Back to sources"
              >
                <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" />
                Back
              </button>
            )}
            <span className="truncate">
              {selected ? selected.label : 'Money We Have'}
            </span>
          </SheetTitle>
        </SheetHeader>

        {!selected && (
          <div className="space-y-6 pb-6">
            {/* Where the money sits — position cards (A1 split + in-transit) */}
            {positions.length > 0 && (
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="rounded-lg bg-primary/10 p-1.5">
                      <Landmark className="h-4 w-4 text-primary" />
                    </div>
                    <h3 className="text-sm font-semibold">Where The Money Sits</h3>
                  </div>
                  <span className="text-sm font-mono font-semibold">{formatUGX(a1 + a5)}</span>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {positions.map((line) => {
                    const Icon = getSourceIcon(line.category);
                    const pct = a1 + a5 > 0 ? (line.value / (a1 + a5)) * 100 : 0;
                    const canDrill = (line.children?.length ?? 0) > 0;
                    const isExpanded = expanded === line.category;
                    return (
                      <div
                        key={line.category}
                        className="rounded-2xl border border-border bg-card overflow-hidden shadow-sm"
                      >
                        <button
                          disabled={!canDrill}
                          onClick={() => canDrill && openLine(line)}
                          className={cn(
                            'w-full p-4 text-left transition-colors',
                            canDrill && 'hover:bg-muted/40'
                          )}
                        >
                        <div className="flex items-start justify-between gap-3">
                          <div className="rounded-xl bg-primary/10 p-2.5 text-primary">
                            <Icon className="h-5 w-5" />
                          </div>
                          {canDrill && (
                            <ChevronRight
                              className={cn(
                                'h-4 w-4 text-muted-foreground mt-2 transition-transform',
                                isExpanded && 'rotate-90'
                              )}
                            />
                          )}
                        </div>
                        <p className="mt-3 text-[11px] uppercase tracking-wider text-muted-foreground">
                          {line.label}
                        </p>
                        <p className="mt-1 font-mono text-lg font-bold">{formatUGX(line.value)}</p>
                        <div className="mt-2 flex items-center gap-2">
                          <Progress value={Math.min(100, Math.max(0, pct))} className="h-1.5 flex-1" />
                          <span className="text-[10px] font-medium text-muted-foreground w-9 text-right">
                            {formatPercent(pct)}
                          </span>
                        </div>
                        {line.count != null && (
                          <p className="mt-1.5 text-[11px] text-muted-foreground">
                            {line.count.toLocaleString()} entries
                          </p>
                        )}
                        </button>

                        {isExpanded && canDrill && (
                          <div className="border-t border-border bg-muted/20 divide-y divide-border">
                            {(line.children ?? []).map((c) => (
                              <button
                                key={c.category}
                                onClick={() => pick({ ...c, value: Math.abs(c.value) })}
                                className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-muted/40 transition-colors"
                              >
                                <span className="text-xs text-muted-foreground truncate">
                                  {c.label}
                                  {c.count != null ? ` (${c.count.toLocaleString()})` : ''}
                                </span>
                                <span
                                  className={cn(
                                    'font-mono text-xs font-semibold shrink-0',
                                    c.value < 0 ? 'text-destructive' : 'text-success'
                                  )}
                                >
                                  {c.value < 0 ? '−' : '+'}
                                  {formatUGX(Math.abs(c.value))}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Position view of the same ledger cash — shown alongside, never added to, the sources below.
                </p>
              </section>
            )}

            {/* Sources of money in */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="rounded-lg bg-success/10 p-1.5">
                    <ArrowDownLeft className="h-4 w-4 text-success" />
                  </div>
                  <h3 className="text-sm font-semibold">Sources of Money In</h3>
                </div>
                <span className="text-sm font-mono font-semibold text-success">{formatUGX(grossIn)}</span>
              </div>

              <div className="space-y-3">
                {increases.map((line) => {
                  const pct = grossIn > 0 ? (line.value / grossIn) * 100 : 0;
                  const pctOfTotal = totalCash > 0 ? (line.value / totalCash) * 100 : 0;
                  const Icon = getSourceIcon(line.category);
                  const hasChildren = (line.children?.length ?? 0) > 1;
                  const isExpanded = expanded === line.category;

                  return (
                    <div
                      key={line.category}
                      className="rounded-2xl border border-border bg-card overflow-hidden shadow-sm"
                    >
                      <button
                        onClick={() => openLine(line)}
                        className="w-full text-left p-4 hover:bg-muted/40 transition-colors"
                      >
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 rounded-xl bg-primary/10 p-2.5 text-primary shrink-0">
                            <Icon className="h-5 w-5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-sm font-semibold truncate">{line.label}</p>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className="font-mono text-sm font-bold text-success">
                                  {formatUGX(line.value)}
                                </span>
                                <ChevronRight
                                  className={cn(
                                    'h-4 w-4 text-muted-foreground transition-transform',
                                    hasChildren && isExpanded && 'rotate-90'
                                  )}
                                />
                              </div>
                            </div>
                            <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                              <span>{formatPercent(pct)} of money in</span>
                              <span className="text-border">|</span>
                              <span>{formatPercent(pctOfTotal)} of total</span>
                              {line.count != null && (
                                <>
                                  <span className="text-border">|</span>
                                  <span>{line.count.toLocaleString()} entries</span>
                                </>
                              )}
                            </div>
                            <div className="mt-3 flex items-center gap-2">
                              <Progress value={Math.min(100, pct)} className="h-1.5 flex-1" />
                              <span className="text-[10px] font-medium text-muted-foreground w-9 text-right">
                                {formatPercent(pct)}
                              </span>
                            </div>
                          </div>
                        </div>
                      </button>

                      {isExpanded && hasChildren && (
                        <div className="border-t border-border bg-muted/20 divide-y divide-border">
                          {(line.children ?? []).map((c) => (
                            <button
                              key={c.category}
                              onClick={() => pick({ ...c, value: Math.abs(c.value) })}
                              className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <div className="w-1.5 h-1.5 rounded-full bg-primary/70 shrink-0" />
                                <span className="text-xs text-muted-foreground truncate">
                                  {c.label}
                                  {c.count != null ? ` (${c.count.toLocaleString()})` : ''}
                                </span>
                              </div>
                              <span className="flex items-center gap-2 shrink-0">
                                <span className={cn('font-mono text-xs font-semibold', c.value < 0 ? 'text-destructive' : 'text-success')}>
                                  {c.value < 0 ? '−' : '+'}
                                  {formatUGX(Math.abs(c.value))}
                                </span>
                                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {increases.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-border p-6 text-center">
                    <p className="text-sm text-muted-foreground">No cash inflows recorded.</p>
                  </div>
                )}
              </div>
            </section>

            {/* Money out */}
            {decreases.length > 0 && (
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="rounded-lg bg-destructive/10 p-1.5">
                      <ArrowUpRight className="h-4 w-4 text-destructive" />
                    </div>
                    <h3 className="text-sm font-semibold">Money That Left Again</h3>
                  </div>
                  <span className="text-sm font-mono font-semibold text-destructive">−{formatUGX(grossOut)}</span>
                </div>

                <div className="space-y-2">
                  {decreases.map((line) => {
                    const Icon = getSourceIcon(line.category);
                    const hasChildren = (line.children?.length ?? 0) > 1;
                    const isExpanded = expanded === line.category;

                    return (
                      <div key={line.category} className="rounded-xl border border-border bg-card overflow-hidden">
                        <button
                          onClick={() => openLine(line)}
                          className="w-full flex items-center justify-between gap-3 p-3 hover:bg-muted/40 transition-colors"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="rounded-lg bg-destructive/10 p-2 text-destructive shrink-0">
                              <Icon className="h-4 w-4" />
                            </div>
                            <span className="text-sm text-muted-foreground truncate">
                              {line.label}
                              {line.count != null ? ` (${line.count.toLocaleString()})` : ''}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="font-mono text-sm font-semibold text-destructive">
                              −{formatUGX(line.value)}
                            </span>
                            <ChevronRight
                              className={cn(
                                'h-4 w-4 text-muted-foreground transition-transform',
                                hasChildren && isExpanded && 'rotate-90'
                              )}
                            />
                          </div>
                        </button>

                        {isExpanded && hasChildren && (
                          <div className="border-t border-border bg-muted/20 divide-y divide-border">
                            {(line.children ?? []).map((c) => (
                              <button
                                key={c.category}
                                onClick={() => pick({ ...c, value: Math.abs(c.value) })}
                                className="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-muted/40 transition-colors"
                              >
                                <span className="text-xs text-muted-foreground truncate pl-2">
                                  {c.label}
                                  {c.count != null ? ` (${c.count.toLocaleString()})` : ''}
                                </span>
                                <span className={cn('font-mono text-xs font-semibold', c.value < 0 ? 'text-destructive' : 'text-success')}>
                                  {c.value < 0 ? '−' : '+'}
                                  {formatUGX(Math.abs(c.value))}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            <Separator />

            {/* Summary footer */}
            <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Total Money In</span>
                <span className="font-mono font-medium">{formatUGX(grossIn)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Total Money Out</span>
                <span className="font-mono font-medium text-destructive">−{formatUGX(grossOut)}</span>
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <span className="text-base font-bold">Money We Have</span>
                <span className="text-xl font-bold font-mono">{formatUGX(grossIn - grossOut)}</span>
              </div>
              {Math.abs(reconciliationGap) > 1 && (
                <p className="text-[11px] text-warning bg-warning/10 rounded-lg px-3 py-2">
                  Reconciliation gap vs Balance Sheet cash: {formatUGX(reconciliationGap)}
                </p>
              )}
            </div>

            <p className="text-[11px] text-center text-muted-foreground">
              Tap any source amount to drill down into the underlying ledger entries.
            </p>
          </div>
        )}

        {selected && (
          <div className="space-y-4 pb-6">
            {/* Drill-down header card */}
            <div className="rounded-2xl border border-border bg-card p-4 flex items-center justify-between shadow-sm">
              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Net effect on cash</p>
                <p className="text-xl font-bold font-mono mt-0.5">{formatUGX(data?.netAmount ?? selected.value)}</p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold text-muted-foreground/30">
                  {data?.totalCount ?? selected.count ?? 0}
                </p>
                <p className="text-[11px] text-muted-foreground">transactions</p>
              </div>
            </div>

            {isLoading && (
              <div className="flex flex-col items-center justify-center py-12 gap-2">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <p className="text-xs text-muted-foreground">Loading transactions…</p>
              </div>
            )}

            {error && (
              <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4">
                <p className="text-sm text-destructive">{(error as any)?.message || 'Could not load transactions'}</p>
              </div>
            )}

            {!isLoading &&
              (data?.rows ?? []).map((row) => (
                <div
                  key={row.id}
                  className="rounded-2xl border border-border bg-card p-4 space-y-3 hover:shadow-sm transition-shadow"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1 min-w-0">
                      <p className="text-xs text-muted-foreground">
                        {new Date(row.transaction_date).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                      </p>
                      <p className="text-sm font-medium leading-snug">{row.description || '—'}</p>
                    </div>
                    <span
                      className={cn(
                        'font-mono text-base font-bold shrink-0',
                        row.direction === 'in' ? 'text-success' : 'text-destructive'
                      )}
                    >
                      {row.direction === 'in' ? '' : '−'}
                      {formatUGX(Math.abs(row.amount))}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-[10px] font-normal">
                      Ref: {row.reference ? row.reference.slice(0, 22) : row.id.slice(0, 8)}
                    </Badge>
                    <Badge variant="secondary" className="text-[10px] capitalize font-normal">
                      {row.status.replace(/_/g, ' ')}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] font-normal">
                      {row.account_code === 'A1' ? 'Bank & Cash' : 'In Transit'}
                    </Badge>
                    {row.linked_party && (
                      <span className="text-[11px] text-muted-foreground truncate max-w-[200px]">
                        {row.linked_party}
                      </span>
                    )}
                  </div>
                </div>
              ))}

            {!isLoading && (data?.rows.length ?? 0) === 0 && (
              <div className="rounded-2xl border border-dashed border-border p-8 text-center">
                <p className="text-sm text-muted-foreground">No transactions found for this source.</p>
              </div>
            )}

            {(data?.totalCount ?? 0) > PAGE && (
              <div className="flex items-center justify-between pt-2">
                <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <span className="text-xs text-muted-foreground">
                  Page {page + 1} of {Math.ceil((data?.totalCount ?? 1) / PAGE)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(page + 1) * PAGE >= (data?.totalCount ?? 0)}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

