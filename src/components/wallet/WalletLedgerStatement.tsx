import { useState, useEffect, useMemo, useRef } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  Calendar,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import {
  useWalletTransactions,
  type WalletTxDirection,
} from '@/hooks/wallet/useWalletTransactions';
import type { WalletTxRow } from '@/hooks/wallet/useWalletBalance';
import { formatUGX } from '@/lib/rentCalculations';
import { format, parseISO, isToday, isYesterday } from 'date-fns';
import { cn } from '@/lib/utils';
import { LedgerEntryDetailDrawer } from './LedgerEntryDetailDrawer';

type LedgerEntry = WalletTxRow;

type FilterKey = 'all' | 'in' | 'out' | 'pending' | 'completed';

const CATEGORY_LABELS: Record<string, string> = {
  tenant_access_fee: 'Access Fees',
  tenant_request_fee: 'Request Fees',
  rent_repayment: 'Rent Repayment',
  supporter_facilitation_capital: 'Supporter Capital',
  agent_remittance: 'Agent Remittance',
  platform_service_income: 'Service Income',
  deposit: 'Wallet Deposit',
  referral_bonus: 'Referral Bonus',
  agent_commission: 'Agent Commission',
  agent_commission_earned: 'Commission Earned',
  first_transaction_bonus: 'First Transaction Bonus',
  opening_balance: 'Opening Balance',
  rent_facilitation_payout: 'Rent Facilitation',
  supporter_platform_rewards: 'Platform Rewards',
  agent_commission_payout: 'Commission Payout',
  transaction_platform_expenses: 'Platform Expenses',
  operational_expenses: 'Operating Expenses',
  withdrawal: 'Wallet Withdrawal',
  wallet_withdrawal: 'Wallet Withdrawal',
  transfer_out: 'Wallet Transfer',
  transfer_in: 'Wallet Transfer',
  wallet_transfer: 'Wallet Transfer',
};

function labelFor(category: string): string {
  return (
    CATEGORY_LABELS[category] ||
    category.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function dayLabel(iso: string): string {
  const d = parseISO(iso);
  if (isToday(d)) return 'TODAY';
  if (isYesterday(d)) return 'YESTERDAY';
  return format(d, 'EEE, d MMM yyyy').toUpperCase();
}

/** Direction-driven visual: In (green), Out (destructive), Transfer (primary). */
function visualFor(entry: LedgerEntry) {
  const isIn = entry.direction === 'cash_in';
  const isTransfer = /transfer/.test(entry.category);
  if (isTransfer) {
    return {
      Icon: ArrowLeftRight,
      accent: 'border-l-primary',
      iconWrap: 'bg-primary/10 text-primary',
      amount: isIn ? 'text-success' : 'text-foreground',
    };
  }
  return isIn
    ? {
        Icon: ArrowDownLeft,
        accent: 'border-l-success',
        iconWrap: 'bg-success/10 text-success',
        amount: 'text-success',
      }
    : {
        Icon: ArrowUpRight,
        accent: 'border-l-transparent',
        iconWrap: 'bg-muted text-muted-foreground',
        amount: 'text-foreground',
      };
}

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'in', label: 'Money In' },
  { key: 'out', label: 'Money Out' },
  { key: 'pending', label: 'Pending' },
  { key: 'completed', label: 'Completed' },
];

const PAGE_SIZE = 20;

export function WalletLedgerStatement() {
  const { user } = useAuth();
  const [filter, setFilter] = useState<FilterKey>('all');
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  // Accumulate every page loaded so far — server-paginated "Load more".
  const [accumulated, setAccumulated] = useState<LedgerEntry[]>([]);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Map UI filter → hook direction.
  const direction: WalletTxDirection =
    filter === 'in' ? 'in' : filter === 'out' ? 'out' : 'all';

  const {
    rows,
    page,
    hasNext,
    isLoading: loading,
    isFetching,
    next,
    setDirection,
    error,
    refetch,
  } = useWalletTransactions(user?.id, { pageSize: PAGE_SIZE, direction });

  // Push each newly-loaded page into the accumulated view. Reset ONLY when
  // the filter actually changes — not on every render/mount, which would
  // blank the list and race the initial page-0 fetch (causing a stuck
  // spinner when the data has already arrived).
  const prevDirectionRef = useRef<WalletTxDirection>(direction);
  useEffect(() => {
    if (prevDirectionRef.current !== direction) {
      prevDirectionRef.current = direction;
      setDirection(direction);
      setAccumulated([]);
    }
  }, [direction, setDirection]);

  useEffect(() => {
    if (!rows.length) return;
    setAccumulated((prev) => {
      // Page 0 replaces (fresh filter/refetch); later pages append with de-dup.
      if (page === 0) return rows;
      const seen = new Set(prev.map((r) => r.id));
      return [...prev, ...rows.filter((r) => !seen.has(r.id))];
    });
  }, [rows, page]);

  const filteredEntries = useMemo(() => {
    if (filter === 'pending') return [] as LedgerEntry[];
    return accumulated;
  }, [accumulated, filter]);

  const visibleEntries = filteredEntries;
  const hasMore = hasNext && filter !== 'pending';

  // Infinite scroll — auto-load the next server page as the sentinel enters view.
  useEffect(() => {
    if (loading || isFetching || !hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (obs) => {
        if (obs[0]?.isIntersecting) next();
      },
      { rootMargin: '240px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, isFetching, hasMore, next]);

  // Group the visible slice by calendar day, preserving newest-first order.
  const dayGroups = useMemo(() => {
    const groups: { key: string; label: string; rows: LedgerEntry[] }[] = [];
    for (const entry of visibleEntries) {
      const key = format(parseISO(entry.transaction_date), 'yyyy-MM-dd');
      const last = groups[groups.length - 1];
      if (last && last.key === key) {
        last.rows.push(entry);
      } else {
        groups.push({ key, label: dayLabel(entry.transaction_date), rows: [entry] });
      }
    }
    return groups;
  }, [visibleEntries]);

  return (
    <>
      <Card className="border-border/50 rounded-2xl">
        <CardContent className="p-4">
          {/* Header + quick filters */}
          <div className="mb-4">
            <h3 className="text-sm font-bold text-muted-foreground uppercase tracking-widest">
              Wallet Statement
            </h3>
          </div>

          <div className="mb-4" role="tablist" aria-label="Filter transactions">
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5 sm:gap-2">
              {FILTERS.map((f) => {
                const active = filter === f.key;
                return (
                  <button
                    key={f.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setFilter(f.key)}
                    className={cn(
                      'flex h-9 w-full min-w-0 items-center justify-center rounded-full border px-2 text-center text-[11px] font-semibold leading-none transition-colors sm:px-3 sm:text-xs',
                      active
                        ? 'border-foreground bg-foreground text-background shadow-sm'
                        : 'border-border bg-card text-muted-foreground hover:bg-muted/40',
                    )}
                  >
                    <span className="block w-full truncate">{f.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {error ? (
            <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
              <p className="text-sm font-semibold text-destructive">
                Couldn't load your wallet statement
              </p>
              <p className="text-xs text-muted-foreground max-w-xs">
                {(error as Error)?.message || 'Please check your connection and try again.'}
              </p>
              <Button size="sm" variant="outline" onClick={() => refetch()}>
                Retry
              </Button>
            </div>
          ) : (loading || isFetching) && accumulated.length === 0 && !!user?.id ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : filteredEntries.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              <Calendar className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm font-semibold">
                {filter === 'pending'
                  ? 'No pending transactions'
                  : 'No wallet activity yet'}
              </p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                {filter === 'pending'
                  ? 'All your wallet transactions are completed.'
                  : 'Your wallet activity will appear here.'}
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {dayGroups.map((group) => (
                <section key={group.key} aria-labelledby={`day-${group.key}`}>
                  <h4
                    id={`day-${group.key}`}
                    className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground"
                  >
                    {group.label}
                  </h4>
                  <ul className="space-y-2.5 list-none p-0 m-0">
                    {group.rows.map((entry) => {
                      const { Icon, accent, iconWrap, amount } = visualFor(entry);
                      const isIn = entry.direction === 'cash_in';
                      // All ledger-posted rows are completed today. When a
                      // pending source is wired in, swap in that status.
                      const status: 'completed' | 'pending' | 'failed' = 'completed';
                      const statusPill =
                        status === 'completed'
                          ? 'bg-success/10 text-success'
                          : status === 'pending'
                            ? 'bg-warning/15 text-warning'
                            : 'bg-destructive/10 text-destructive';
                      const statusLabel =
                        status === 'completed' && isIn ? 'Successful' : 'Completed';

                      return (
                        <li key={entry.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedEntryId(entry.id);
                              setDetailOpen(true);
                            }}
                            className={cn(
                              'flex w-full items-center gap-3 rounded-2xl border border-border/60 border-l-4 bg-card p-3.5 text-left shadow-sm transition-transform hover:shadow-md active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                              accent,
                            )}
                          >
                            <div
                              className={cn(
                                'h-11 w-11 shrink-0 rounded-full flex items-center justify-center',
                                iconWrap,
                              )}
                              aria-hidden="true"
                            >
                              <Icon className="h-5 w-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-bold text-foreground">
                                {labelFor(entry.category)}
                              </p>
                              <p className="mt-0.5 text-[11px] text-muted-foreground">
                                {format(parseISO(entry.transaction_date), 'd MMM yyyy')}
                                <span className="mx-1.5 text-muted-foreground/60">|</span>
                                {format(parseISO(entry.transaction_date), 'HH:mm')}
                              </p>
                            </div>
                            <div className="shrink-0 text-right">
                              <p
                                className={cn(
                                  'text-sm font-extrabold tabular-nums',
                                  amount,
                                )}
                              >
                                {isIn ? '+' : '-'}
                                {formatUGX(Number(entry.amount))}
                              </p>
                              <span
                                className={cn(
                                  'mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                                  statusPill,
                                )}
                              >
                                {statusLabel}
                              </span>
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}

              {/* Infinite scroll footer */}
              {hasMore ? (
                <div
                  ref={sentinelRef}
                  role="status"
                  aria-live="polite"
                  className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground"
                >
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  <span>Loading more transactions…</span>
                </div>
              ) : (
                filteredEntries.length > PAGE_SIZE && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="py-6 text-center text-[11px] text-muted-foreground"
                  >
                    <span className="font-semibold">You've reached the end</span>
                    <span className="block text-muted-foreground/70">
                      All {filteredEntries.length} transactions loaded
                    </span>
                  </div>
                )
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <LedgerEntryDetailDrawer
        entryId={selectedEntryId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />
    </>
  );
}
