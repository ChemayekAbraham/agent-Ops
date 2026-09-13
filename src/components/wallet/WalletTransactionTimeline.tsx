import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { format, isToday, isYesterday } from 'date-fns';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Wallet,
  Calendar,
  Landmark,
  ArrowDownToLine,
  Send,
  Banknote,
  TrendingUp,
  RotateCcw,
  ShoppingBag,
  ChevronRight,
  FileDown,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { hapticTap } from '@/lib/haptics';
import { generateWalletStatementPdf } from '@/lib/walletStatementPdf';
import { UserAvatar } from '@/components/UserAvatar';

export interface TimelineTransaction {
  id: string;
  sender_id: string;
  recipient_id: string;
  amount: number;
  description: string | null;
  created_at: string;
  sender_name?: string;
  recipient_name?: string;
  sender_avatar_url?: string | null;
  recipient_avatar_url?: string | null;
  recipient_phone?: string;
}

export type TabValue = 'all' | 'in' | 'out';
type CategoryFilter = 'all' | string;

interface WalletTransactionTimelineProps {
  transactions: TimelineTransaction[];
  currentUserId: string;
  currentBalance: number;
  formatCurrency: (amount: number) => string;
  onSelectTransaction: (tx: TimelineTransaction) => void;
  onViewAll?: () => void;
  ownerName?: string;
  ownerPhone?: string | null;
  activeTab?: TabValue;
  onTabChange?: (tab: TabValue) => void;
  categoryFilter?: CategoryFilter;
  onCategoryChange?: (filter: CategoryFilter) => void;
}

interface CategoryMeta {
  label: string;
  icon: React.ElementType;
  colorClass: string;
}

function deriveCategory(description: string | null, isSent: boolean): CategoryMeta {
  const d = (description || '').toLowerCase();

  if (d.includes('deposit')) {
    return { label: 'Deposit', icon: Landmark, colorClass: 'text-primary bg-primary/10' };
  }
  if (d.includes('withdraw')) {
    return { label: 'Withdrawal', icon: ArrowDownToLine, colorClass: 'text-destructive bg-destructive/10' };
  }
  if (d.includes('rent') || d.includes('repayment')) {
    return { label: 'Rent', icon: Banknote, colorClass: 'text-primary bg-primary/10' };
  }
  if (d.includes('commission')) {
    return { label: 'Commission', icon: TrendingUp, colorClass: 'text-success bg-success/10' };
  }
  if (d.includes('refund')) {
    return { label: 'Refund', icon: RotateCcw, colorClass: 'text-warning bg-warning/10' };
  }
  if (d.includes('smartphone') || d.includes('spiro') || d.includes('bike') || d.includes('merchandise')) {
    return { label: 'Merchandise', icon: ShoppingBag, colorClass: 'text-primary bg-primary/10' };
  }
  if (d.includes('transfer')) {
    return isSent
      ? { label: 'Transfer Sent', icon: Send, colorClass: 'text-destructive bg-destructive/10' }
      : { label: 'Transfer Received', icon: ArrowDownLeft, colorClass: 'text-success bg-success/10' };
  }

  // If the description is meaningful, surface it as the category label.
  const cleanDesc = (description || '').trim();
  if (cleanDesc.length > 2 && !/^payment|transaction$/i.test(cleanDesc)) {
    return isSent
      ? { label: cleanDesc, icon: ArrowUpRight, colorClass: 'text-destructive bg-destructive/10' }
      : { label: cleanDesc, icon: ArrowDownLeft, colorClass: 'text-success bg-success/10' };
  }

  return isSent
    ? { label: 'Money Out', icon: ArrowUpRight, colorClass: 'text-destructive bg-destructive/10' }
    : { label: 'Money In', icon: ArrowDownLeft, colorClass: 'text-success bg-success/10' };
}

function getDateLabel(date: Date): string {
  if (isToday(date)) return 'Today';
  if (isYesterday(date)) return 'Yesterday';
  return format(date, 'EEE, MMM d, yyyy');
}

export function getCategoryLabel(tx: TimelineTransaction, currentUserId: string): string {
  const isSent = tx.sender_id === currentUserId;
  return deriveCategory(tx.description, isSent).label;
}

export function WalletTransactionTimeline({
  transactions,
  currentUserId,
  currentBalance,
  formatCurrency,
  onSelectTransaction,
  onViewAll,
  ownerName = 'Welile User',
  ownerPhone,
  activeTab: externalActiveTab,
  onTabChange,
  categoryFilter: externalCategoryFilter,
  onCategoryChange,
}: WalletTransactionTimelineProps) {
  const [internalActiveTab, setInternalActiveTab] = useState<TabValue>('all');
  const activeTab = externalActiveTab ?? internalActiveTab;
  const setActiveTab = onTabChange ?? setInternalActiveTab;
  const [internalCategoryFilter, setInternalCategoryFilter] = useState<CategoryFilter>('all');
  const categoryFilter = externalCategoryFilter ?? internalCategoryFilter;
  const setCategoryFilter = onCategoryChange ?? setInternalCategoryFilter;
  const [exporting, setExporting] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const txRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [visibleBalance, setVisibleBalance] = useState<number | null>(null);
  const [visibleTxId, setVisibleTxId] = useState<string | null>(null);

  const { runningBalances, groupedTransactions, filteredCount, filtered } = useMemo(() => {
    // Newest first — matches how people read their wallet activity.
    const sorted = [...transactions].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    // Running balance preview: anchor to the current balance and walk backwards.
    // The value shown for each transaction is the wallet balance *after* that
    // transaction occurred.
    const balances = new Map<string, number>();
    let runningBalance = currentBalance;
    for (const tx of sorted) {
      balances.set(tx.id, runningBalance);
      const isSent = tx.sender_id === currentUserId;
      const delta = isSent ? -tx.amount : tx.amount;
      runningBalance -= delta;
    }

    const filtered = sorted.filter((tx) => {
      const isSent = tx.sender_id === currentUserId;
      if (activeTab === 'in') return !isSent;
      if (activeTab === 'out') return isSent;
      return true;
    }).filter((tx) => {
      if (categoryFilter === 'all') return true;
      return getCategoryLabel(tx, currentUserId) === categoryFilter;
    });

    const grouped: Record<string, TimelineTransaction[]> = {};
    for (const tx of filtered) {
      const dateKey = format(new Date(tx.created_at), 'yyyy-MM-dd');
      if (!grouped[dateKey]) grouped[dateKey] = [];
      grouped[dateKey].push(tx);
    }

    return {
      runningBalances: balances,
      groupedTransactions: grouped,
      filteredCount: filtered.length,
      filtered,
    };
  }, [transactions, currentUserId, currentBalance, activeTab, categoryFilter]);

  const findScrollableParent = useCallback((el: HTMLElement | null): HTMLElement | null => {
    let node = el?.parentElement;
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node);
      const overflowY = style.overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }, []);

  const updateVisibleBalance = useCallback(() => {
    const container = containerRef.current;
    if (!container || filteredCount === 0) {
      setVisibleBalance(null);
      setVisibleTxId(null);
      return;
    }

    const scrollable = findScrollableParent(container);
    const viewportTop = scrollable ? scrollable.getBoundingClientRect().top : 0;
    const stickyOffset = 80; // room for sticky header + safe margin

    let bestId: string | null = null;
    let bestScore = Infinity;

    for (const tx of filtered) {
      const el = txRefs.current.get(tx.id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const top = rect.top - viewportTop;
      // Score: how close the item's top is to just below the sticky header.
      // Prefer the first item whose top is at or below the offset; otherwise
      // the last item still partially visible.
      const score = top >= stickyOffset ? top - stickyOffset : stickyOffset - top + 1000;
      if (score < bestScore) {
        bestScore = score;
        bestId = tx.id;
      }
    }

    if (bestId) {
      setVisibleBalance(runningBalances.get(bestId) ?? null);
      setVisibleTxId(bestId);
    } else {
      // If nothing is below the offset yet, anchor to the first transaction.
      const first = filtered[0];
      setVisibleBalance(runningBalances.get(first.id) ?? null);
      setVisibleTxId(first.id);
    }
  }, [filtered, filteredCount, runningBalances, findScrollableParent]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scrollable = findScrollableParent(container);
    const target = scrollable ?? window;

    updateVisibleBalance();
    target.addEventListener('scroll', updateVisibleBalance, { passive: true });
    window.addEventListener('resize', updateVisibleBalance, { passive: true });

    return () => {
      target.removeEventListener('scroll', updateVisibleBalance);
      window.removeEventListener('resize', updateVisibleBalance);
    };
  }, [updateVisibleBalance, findScrollableParent]);

  const handleExportPdf = async () => {
    if (exporting || filteredCount === 0) return;
    setExporting(true);
    try {
      const totalIn = filtered
        .filter((tx) => tx.sender_id !== currentUserId)
        .reduce((sum, tx) => sum + tx.amount, 0);
      const totalOut = filtered
        .filter((tx) => tx.sender_id === currentUserId)
        .reduce((sum, tx) => sum + tx.amount, 0);

      const entries = filtered.map((tx) => {
        const isSent = tx.sender_id === currentUserId;
        const category = deriveCategory(tx.description, isSent);
        const counterparty = isSent ? tx.recipient_name : tx.sender_name;
        return {
          transaction_date: tx.created_at,
          label: category.label,
          description: counterparty
            ? `${isSent ? 'To' : 'From'} ${counterparty}${tx.description ? ` — ${tx.description}` : ''}`
            : (tx.description || undefined),
          direction: (isSent ? 'cash_out' : 'cash_in') as 'cash_in' | 'cash_out',
          amount: tx.amount,
        };
      });

      const blob = await generateWalletStatementPdf({
        bucketTitle: 'Wallet Activity',
        bucketSubtitle: `${filteredCount} transaction${filteredCount === 1 ? '' : 's'}`,
        ownerName,
        ownerPhone,
        balance: currentBalance,
        totalIn,
        totalOut,
        entries,
        activeTab,
        categoryFilter,
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const dateStamp = new Date().toISOString().split('T')[0];
      a.download = `Welile_Wallet_${dateStamp}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to export wallet PDF:', e);
    } finally {
      setExporting(false);
    }
  };

  const dateEntries = useMemo(
    () =>
      Object.entries(groupedTransactions).sort(
        ([a], [b]) => new Date(b).getTime() - new Date(a).getTime()
      ),
    [groupedTransactions]
  );

  const emptyMessage =
    categoryFilter !== 'all'
      ? `No ${categoryFilter.toLowerCase()} transactions`
      : activeTab === 'all'
        ? 'No transactions yet'
        : activeTab === 'in'
          ? 'No cash in yet'
          : 'No cash out yet';

  return (
    <div ref={containerRef}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-bold text-foreground">Recent Transactions</h3>
        <div className="flex items-center gap-1">
          <Button
            variant="link"
            size="sm"
            disabled={filteredCount === 0 || exporting}
            onClick={() => {
              hapticTap();
              handleExportPdf();
            }}
            className="gap-1 h-auto p-0 text-xs text-primary font-semibold"
          >
            <FileDown className="h-3.5 w-3.5" />
            {exporting ? 'Exporting…' : 'Export PDF'}
          </Button>
          {onViewAll && (
            <Button
              variant="link"
              size="sm"
              onClick={() => {
                hapticTap();
                onViewAll();
              }}
              className="gap-1 h-auto p-0 text-xs text-primary font-semibold"
            >
              View All
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* All / Cash In / Cash Out filter */}
      <div className="flex items-center gap-1 mb-3 p-1 rounded-xl bg-muted/60">
        {([
          { value: 'all' as TabValue, label: 'All' },
          { value: 'in' as TabValue, label: 'Cash In' },
          { value: 'out' as TabValue, label: 'Cash Out' },
        ]).map((t) => (
          <button
            key={t.value}
            type="button"
            aria-pressed={activeTab === t.value}
            onClick={() => {
              hapticTap();
              setActiveTab(t.value);
            }}
            className={[
              'flex-1 h-8 rounded-lg text-xs font-semibold transition-colors',
              activeTab === t.value
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>


      {filteredCount === 0 ? (
        <Card className="border-border/50">
          <CardContent className="py-8 text-center text-muted-foreground">
            <Wallet className="h-10 w-10 mx-auto mb-2 opacity-30" />
            <p className="text-sm">{emptyMessage}</p>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-border/50 shadow-sm overflow-hidden">
          {/* Running balance is an internal accounting figure — not shown to users. */}
          <div className="divide-y divide-border/50">
            {dateEntries.map(([dateKey, dayTransactions], dayIndex) => {
              const date = new Date(dateKey);
              const dayInTotal = dayTransactions
                .filter((tx) => tx.sender_id !== currentUserId)
                .reduce((sum, tx) => sum + tx.amount, 0);
              const dayOutTotal = dayTransactions
                .filter((tx) => tx.sender_id === currentUserId)
                .reduce((sum, tx) => sum + tx.amount, 0);

              return (
                <div key={dateKey} className="p-4">
                  {/* Date header with daily totals */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                      <h4 className="text-xs font-semibold text-muted-foreground">
                        {getDateLabel(date)}
                      </h4>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] font-medium tabular-nums">
                      {dayInTotal > 0 && (
                        <span className="text-success">+{formatCurrency(dayInTotal)}</span>
                      )}
                      {dayOutTotal > 0 && (
                        <span className="text-destructive">-{formatCurrency(dayOutTotal)}</span>
                      )}
                    </div>
                  </div>

                  {/* Timeline items */}
                  <div className="relative pl-4">
                    {dayTransactions.map((tx, txIndex) => {
                      const isSent = tx.sender_id === currentUserId;
                      const category = deriveCategory(tx.description, isSent);
                      const Icon = category.icon;
                      const counterparty = isSent ? tx.recipient_name : tx.sender_name;
                      // Person-to-person transfer: lead with the other person's
                      // photo + name so the receiver sees WHO sent the item.
                      const isP2P = !!tx.sender_id && !!tx.recipient_id && !!counterparty;
                      const peerAvatar = isSent ? tx.recipient_avatar_url : tx.sender_avatar_url;
                      const isLast = txIndex === dayTransactions.length - 1;
...
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex items-start gap-3 min-w-0">
                                  {isP2P ? (
                                    <UserAvatar
                                      avatarUrl={peerAvatar ?? null}
                                      fullName={counterparty ?? ''}
                                      size="sm"
                                      className="h-9 w-9 shrink-0"
                                    />
                                  ) : (
                                    <div
                                      className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${category.colorClass}`}
                                    >
                                      <Icon className="h-4 w-4" />
                                    </div>
                                  )}
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <p className="text-sm font-semibold text-foreground">
                                        {isP2P ? `${isSent ? 'To' : 'From'} ${counterparty}` : category.label}
                                      </p>
                                      <Badge
                                        variant="secondary"
                                        className="text-[9px] px-1.5 py-0 h-4 font-medium"
                                      >
                                        {isSent ? 'Sent' : 'Received'}
                                      </Badge>
                                    </div>
                                    <p className="text-[11px] text-muted-foreground mt-0.5">
                                      {format(new Date(tx.created_at), 'h:mm a')}
                                      {' · '}{category.label}
                                    </p>
                                  </div>
                                </div>

                              <div className="text-right shrink-0">
                                <p
                                  className={`text-sm font-bold tabular-nums ${
                                    isSent ? 'text-destructive' : 'text-success'
                                  }`}
                                >
                                  {isSent ? '-' : '+'}
                                  {formatCurrency(tx.amount)}
                                </p>
                              </div>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
