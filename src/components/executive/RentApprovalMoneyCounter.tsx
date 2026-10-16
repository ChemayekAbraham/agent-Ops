import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import {
  kampalaTodayYmd,
  kampalaOffsetYmd,
  kampalaYmd,
  kampalaLabel,
} from '@/lib/kampalaDays';
import {
  Banknote,
  Target,
  Pencil,
  Check,
  X,
  Layers,
  ArrowUpRight,
  Calendar,
  CalendarDays,
  History,
  AlertTriangle,
  AlertCircle,
  BarChart3,
  ChevronRight,
  RotateCcw,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export interface RentApprovalMoneyCounterProps {
  stage: string;
  reviewerAtColumn: string;
  reviewerColumn?: string;
  /** Sum of rent amounts of requests currently selected by checkboxes */
  selectedAmount?: number;
  /** Count of requests currently selected by checkboxes */
  selectedCount?: number;
  /** Total rent amount in the pending queue */
  queueTotalAmount?: number;
  /** Count of requests in the pending queue */
  queueCount?: number;
  className?: string;
}

const STORAGE_KEY = 'welile_rent_approval_daily_budget_ugx';
const DEFAULT_BUDGET = 30_000_000; // 30 Million UGX
const PRESETS = [10_000_000, 20_000_000, 30_000_000, 50_000_000];

type ViewMode = 'today' | 'yesterday' | '7days' | 'custom';

/** Convert a Kampala calendar date string YYYY-MM-DD into start and end UTC ISO timestamps */
function kampalaYmdToUtcRange(ymd: string): { startUtc: string; endUtc: string } {
  const [y, m, d] = ymd.split('-').map(Number);
  const startUtc = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 3 * 3600 * 1000).toISOString();
  const endUtc = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0) - 3 * 3600 * 1000).toISOString();
  return { startUtc, endUtc };
}

/** Convert a start and end Kampala date string into UTC ISO timestamps */
function kampalaRangeToUtc(startYmd: string, endYmd: string): { startUtc: string; endUtc: string } {
  const [sy, sm, sd] = startYmd.split('-').map(Number);
  const [ey, em, ed] = endYmd.split('-').map(Number);
  const startUtc = new Date(Date.UTC(sy, sm - 1, sd, 0, 0, 0) - 3 * 3600 * 1000).toISOString();
  const endUtc = new Date(Date.UTC(ey, em - 1, ed + 1, 0, 0, 0) - 3 * 3600 * 1000).toISOString();
  return { startUtc, endUtc };
}

function getStoredTargetForYmd(ymd: string, fallback: number): number {
  try {
    const saved = localStorage.getItem(`welile_approval_target_${ymd}`);
    if (saved) {
      const val = Number(saved);
      if (Number.isFinite(val) && val > 0) return val;
    }
  } catch {}
  return fallback;
}

function setStoredTargetForYmd(ymd: string, amount: number) {
  try {
    localStorage.setItem(`welile_approval_target_${ymd}`, String(amount));
  } catch {}
}

export function RentApprovalMoneyCounter({
  stage,
  reviewerAtColumn,
  reviewerColumn,
  selectedAmount = 0,
  selectedCount = 0,
  queueTotalAmount = 0,
  queueCount = 0,
  className,
}: RentApprovalMoneyCounterProps) {
  const { user } = useAuth();
  const todayYmd = useMemo(() => kampalaTodayYmd(), []);
  const yesterdayYmd = useMemo(() => kampalaOffsetYmd(-1), []);
  const rolling7DaysStartYmd = useMemo(() => kampalaOffsetYmd(-6), []);

  // View mode
  const [viewMode, setViewMode] = useState<ViewMode>('today');
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);

  // Custom filter state
  const [customStartYmd, setCustomStartYmd] = useState<string>(kampalaOffsetYmd(-7));
  const [customEndYmd, setCustomEndYmd] = useState<string>(todayYmd);

  // Daily budget target state with localStorage persistence
  const [dailyBudget, setDailyBudget] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const val = Number(saved);
        if (Number.isFinite(val) && val > 0) return val;
      }
    } catch {}
    return DEFAULT_BUDGET;
  });

  const [isEditingBudget, setIsEditingBudget] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState(String(dailyBudget));
  const [filterMyApprovals, setFilterMyApprovals] = useState(false);

  // Keep today's target archived
  useEffect(() => {
    setStoredTargetForYmd(todayYmd, dailyBudget);
  }, [dailyBudget, todayYmd]);

  // Sync draft when target changes externally
  useEffect(() => {
    setBudgetDraft(String(dailyBudget));
  }, [dailyBudget]);

  const saveBudget = (val: number) => {
    const positive = Math.max(100_000, Math.round(val || DEFAULT_BUDGET));
    setDailyBudget(positive);
    setStoredTargetForYmd(todayYmd, positive);
    try {
      localStorage.setItem(STORAGE_KEY, String(positive));
    } catch {}
    setIsEditingBudget(false);
  };

  // Determine query window based on view mode
  const queryWindow = useMemo(() => {
    if (viewMode === 'today') {
      return kampalaYmdToUtcRange(todayYmd);
    }
    if (viewMode === 'yesterday') {
      return kampalaYmdToUtcRange(yesterdayYmd);
    }
    if (viewMode === '7days') {
      return kampalaRangeToUtc(rolling7DaysStartYmd, todayYmd);
    }
    // Custom range or history panel open
    return kampalaRangeToUtc(customStartYmd, customEndYmd);
  }, [viewMode, todayYmd, yesterdayYmd, rolling7DaysStartYmd, customStartYmd, customEndYmd]);

  // Query rent requests approved in the selected window
  const { data: windowApprovalsData, isLoading } = useQuery({
    queryKey: [
      'rent-approval-counter-window',
      stage,
      reviewerAtColumn,
      queryWindow.startUtc,
      queryWindow.endUtc,
    ],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('rent_requests')
        .select(`id, rent_amount, status, ${reviewerAtColumn}, ${reviewerColumn || 'updated_at'}`)
        .gte(reviewerAtColumn, queryWindow.startUtc)
        .lt(reviewerAtColumn, queryWindow.endUtc)
        .neq('status', 'rejected')
        .neq('status', stage); // must have progressed past this pending stage

      if (error) {
        console.warn('Could not query approved rent:', error);
        return [];
      }
      return (data || []) as unknown as Array<
        { rent_amount: number | null } & Record<string, unknown>
      >;
    },
    refetchInterval: viewMode === 'today' ? 30_000 : false,
  });

  // Calculate aggregates and daily breakdown from queried rows
  const stats = useMemo(() => {
    const rows = windowApprovalsData || [];
    let totalAmount = 0;
    let totalCount = 0;
    let myAmount = 0;
    let myCount = 0;

    // Group by Kampala day
    const dayMap = new Map<string, { totalAmount: number; totalCount: number; myAmount: number; myCount: number }>();

    for (const r of rows) {
      const amt = Number(r.rent_amount || 0);
      totalAmount += amt;
      totalCount += 1;

      const isMine = !!(reviewerColumn && user?.id && (r as any)[reviewerColumn] === user.id);
      if (isMine) {
        myAmount += amt;
        myCount += 1;
      }

      const rawTs = (r as any)[reviewerAtColumn];
      const ymd = kampalaYmd(rawTs);
      if (ymd) {
        const cur = dayMap.get(ymd) || { totalAmount: 0, totalCount: 0, myAmount: 0, myCount: 0 };
        cur.totalAmount += amt;
        cur.totalCount += 1;
        if (isMine) {
          cur.myAmount += amt;
          cur.myCount += 1;
        }
        dayMap.set(ymd, cur);
      }
    }

    return { totalAmount, totalCount, myAmount, myCount, dayMap };
  }, [windowApprovalsData, reviewerAtColumn, reviewerColumn, user?.id]);

  // Rolling 7 days breakdown array
  const last7DaysBreakdown = useMemo(() => {
    const days: Array<{
      ymd: string;
      label: string;
      shortLabel: string;
      totalAmount: number;
      totalCount: number;
      target: number;
      isToday: boolean;
    }> = [];

    for (let offset = -6; offset <= 0; offset++) {
      const ymd = kampalaOffsetYmd(offset);
      const isToday = ymd === todayYmd;
      const dayData = stats.dayMap.get(ymd) || { totalAmount: 0, totalCount: 0, myAmount: 0, myCount: 0 };
      const target = getStoredTargetForYmd(ymd, dailyBudget);
      days.push({
        ymd,
        label: kampalaLabel(ymd),
        shortLabel: isToday ? 'Today' : kampalaLabel(ymd).split(',')[0],
        totalAmount: filterMyApprovals ? dayData.myAmount : dayData.totalAmount,
        totalCount: filterMyApprovals ? dayData.myCount : dayData.totalCount,
        target,
        isToday,
      });
    }

    return days;
  }, [stats.dayMap, todayYmd, dailyBudget, filterMyApprovals]);

  const activeDisplayAmount = filterMyApprovals ? stats.myAmount : stats.totalAmount;
  const activeDisplayCount = filterMyApprovals ? stats.myCount : stats.totalCount;

  // Today specific calculations
  const isTodayMode = viewMode === 'today';
  const effectiveTarget = viewMode === '7days' ? dailyBudget * 7 : dailyBudget;
  const projectedAmount = activeDisplayAmount + selectedAmount;
  const progressPct = effectiveTarget > 0 ? Math.min(100, Math.round((activeDisplayAmount / effectiveTarget) * 100)) : 0;
  const projectedProgressPct = effectiveTarget > 0 ? Math.min(100, Math.round((projectedAmount / effectiveTarget) * 100)) : 0;

  const isTargetMet = activeDisplayAmount >= effectiveTarget;
  const remaining = Math.max(0, effectiveTarget - activeDisplayAmount);
  const overage = Math.max(0, activeDisplayAmount - effectiveTarget);

  // Target Overage Warnings (Specifically for manager approving and exceeding target)
  const isCurrentlyOverTarget = isTodayMode && activeDisplayAmount > dailyBudget;
  const isProjectedOverTarget = isTodayMode && selectedCount > 0 && projectedAmount > dailyBudget;

  return (
    <Card
      className={cn(
        'relative overflow-hidden border border-border/80 bg-gradient-to-br from-card via-card/95 to-primary/5 shadow-xs transition-all',
        className
      )}
    >
      {/* Top highlight bar */}
      <div
        className={cn(
          'absolute top-0 left-0 right-0 h-1 bg-gradient-to-r transition-colors',
          isCurrentlyOverTarget
            ? 'from-amber-500 via-rose-500 to-amber-500'
            : isTargetMet
              ? 'from-emerald-500 via-teal-500 to-emerald-500'
              : 'from-emerald-500 via-primary to-indigo-500'
        )}
      />

      <CardContent className="p-3.5 sm:p-4 space-y-3">
        {/* Row 1: Header Title & Mode Switchers */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2.5">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'h-8 w-8 rounded-lg flex items-center justify-center shrink-0 border shadow-xs',
                isCurrentlyOverTarget
                  ? 'bg-amber-500/15 text-amber-600 border-amber-500/30'
                  : 'bg-emerald-500/15 text-emerald-600 border-emerald-500/25'
              )}
            >
              <Banknote className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-bold uppercase tracking-wider text-foreground">
                  {viewMode === 'today'
                    ? "Today's Approval Money Counter"
                    : viewMode === 'yesterday'
                      ? "Yesterday's Approval Record"
                      : viewMode === '7days'
                        ? '7-Day Cumulative Approvals'
                        : 'Custom Range Approvals'}
                </span>
                <Badge
                  variant="outline"
                  className={cn(
                    'text-[10px] font-semibold px-1.5 py-0 h-4 border',
                    isCurrentlyOverTarget
                      ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/40 animate-pulse'
                      : isTargetMet
                        ? 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30'
                        : 'bg-primary/10 text-primary border-primary/20'
                  )}
                >
                  {isCurrentlyOverTarget
                    ? `Over Target (+${formatUGX(overage)})`
                    : isTargetMet
                      ? 'Target Reached 🎯'
                      : `${progressPct}% of target`}
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {viewMode === 'today'
                  ? 'Live Kampala-day approved rent tracking against your payout budget.'
                  : viewMode === 'yesterday'
                    ? `Records for ${kampalaLabel(yesterdayYmd)}`
                    : viewMode === '7days'
                      ? `Rolling 7-day total (${kampalaLabel(rolling7DaysStartYmd)} – Today)`
                      : `Approvals from ${customStartYmd} to ${customEndYmd}`}
              </p>
            </div>
          </div>

          {/* Target Budget Editor & History Toggle */}
          <div className="flex items-center gap-2 flex-wrap self-start md:self-center">
            {/* View Mode Pills */}
            <div className="inline-flex rounded-lg border bg-muted/40 p-0.5 text-xs font-medium">
              <button
                type="button"
                onClick={() => {
                  setViewMode('today');
                  setShowHistoryPanel(false);
                }}
                className={cn(
                  'px-2.5 py-1 rounded-md transition-colors',
                  viewMode === 'today'
                    ? 'bg-background text-foreground shadow-2xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                Today
              </button>
              <button
                type="button"
                onClick={() => {
                  setViewMode('yesterday');
                  setShowHistoryPanel(false);
                }}
                className={cn(
                  'px-2.5 py-1 rounded-md transition-colors',
                  viewMode === 'yesterday'
                    ? 'bg-background text-foreground shadow-2xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                Yesterday
              </button>
              <button
                type="button"
                onClick={() => {
                  setViewMode('7days');
                  setShowHistoryPanel(false);
                }}
                className={cn(
                  'px-2.5 py-1 rounded-md transition-colors',
                  viewMode === '7days'
                    ? 'bg-background text-foreground shadow-2xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                7-Day Total
              </button>
              <button
                type="button"
                onClick={() => {
                  setViewMode('custom');
                  setShowHistoryPanel(true);
                }}
                className={cn(
                  'px-2 py-1 rounded-md transition-colors flex items-center gap-1',
                  viewMode === 'custom' || showHistoryPanel
                    ? 'bg-primary text-primary-foreground font-semibold shadow-2xs'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                title="View previous dates, history and custom range"
              >
                <CalendarDays className="h-3 w-3" />
                <span>History</span>
              </button>
            </div>

            {/* Daily Target Setting */}
            {isEditingBudget ? (
              <div className="flex items-center gap-1 bg-background p-1 rounded-md border shadow-xs">
                <span className="text-[11px] font-medium text-muted-foreground pl-1">UGX</span>
                <Input
                  type="number"
                  step={1_000_000}
                  min={100_000}
                  value={budgetDraft}
                  onChange={(e) => setBudgetDraft(e.target.value)}
                  className="h-7 w-28 text-xs font-semibold px-1.5 py-0"
                  autoFocus
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                  onClick={() => saveBudget(Number(budgetDraft))}
                >
                  <Check className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-muted-foreground hover:bg-muted"
                  onClick={() => setIsEditingBudget(false)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsEditingBudget(true)}
                className={cn(
                  'h-7 text-xs font-medium gap-1 px-2 border-border/80 bg-background/60',
                  isCurrentlyOverTarget && 'border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-300'
                )}
                title="Click to edit your daily approval target"
              >
                <Target className="h-3 w-3 text-muted-foreground" />
                <span>Target:</span>
                <strong className="text-foreground">{formatUGX(dailyBudget)}</strong>
                <Pencil className="h-2.5 w-2.5 text-muted-foreground ml-0.5" />
              </Button>
            )}
          </div>
        </div>

        {/* Quick Presets (when editing budget) */}
        {isEditingBudget && (
          <div className="flex flex-wrap items-center gap-1 pt-0.5 text-[11px] text-muted-foreground">
            <span className="text-[10px] uppercase font-semibold mr-1">Quick presets:</span>
            {PRESETS.map((amt) => (
              <button
                key={amt}
                type="button"
                onClick={() => saveBudget(amt)}
                className={cn(
                  'px-2 py-0.5 rounded text-[11px] font-medium border transition-colors',
                  dailyBudget === amt
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-muted/40 hover:bg-muted text-foreground border-border/60'
                )}
              >
                {amt / 1_000_000}M
              </button>
            ))}
          </div>
        )}

        {/* ⚠️ TARGET EXCEEDED NOTICES & ONE-CLICK TARGET ADJUSTMENT ⚠️ */}
        {isCurrentlyOverTarget && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-2.5 sm:p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs animate-in fade-in">
            <div className="flex items-start gap-2.5 min-w-0">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="font-bold text-amber-900 dark:text-amber-200">
                  Approvals Exceed Daily Target by {formatUGX(overage)}
                </p>
                <p className="text-[11px] text-amber-800/80 dark:text-amber-300/80">
                  Total approved today is <strong className="text-foreground">{formatUGX(activeDisplayAmount)}</strong> against your <strong className="text-foreground">{formatUGX(dailyBudget)}</strong> target. Adjust your target so your approvals fit within the budget.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              className="h-7 text-xs bg-amber-600 hover:bg-amber-700 text-white font-semibold shrink-0 gap-1 shadow-xs"
              onClick={() => saveBudget(activeDisplayAmount)}
            >
              <Pencil className="h-3 w-3" />
              Adjust Target to {formatUGX(activeDisplayAmount)}
            </Button>
          </div>
        )}

        {isProjectedOverTarget && !isCurrentlyOverTarget && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-2.5 sm:p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs animate-in fade-in">
            <div className="flex items-start gap-2.5 min-w-0">
              <AlertCircle className="h-4 w-4 text-rose-600 dark:text-rose-400 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="font-bold text-rose-900 dark:text-rose-200">
                  Selected Batch Exceeds Target by {formatUGX(projectedAmount - dailyBudget)}
                </p>
                <p className="text-[11px] text-rose-800/80 dark:text-rose-300/80">
                  Approving these {selectedCount} selected requests (+{formatUGX(selectedAmount)}) will bring today's total to <strong className="text-foreground">{formatUGX(projectedAmount)}</strong>. Please adjust your target to fit before proceeding.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              className="h-7 text-xs bg-rose-600 hover:bg-rose-700 text-white font-semibold shrink-0 gap-1 shadow-xs"
              onClick={() => saveBudget(projectedAmount)}
            >
              <Target className="h-3 w-3" />
              Adjust Target to Fit ({formatUGX(projectedAmount)})
            </Button>
          </div>
        )}

        {/* Key Metrics Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-0.5">
          {/* Tile 1: Total Approved in selected period */}
          <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-2.5 space-y-0.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 truncate">
                {viewMode === 'today'
                  ? filterMyApprovals ? 'My Approved Today' : 'Approved Today'
                  : viewMode === 'yesterday'
                    ? 'Approved Yesterday'
                    : viewMode === '7days'
                      ? '7-Day Approved Total'
                      : 'Range Total'}
              </span>
              <Badge
                variant="outline"
                className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 text-[9px] px-1 h-3.5 shrink-0"
              >
                {activeDisplayCount} req{activeDisplayCount === 1 ? '' : 's'}
              </Badge>
            </div>
            <p className="text-sm sm:text-base font-black text-emerald-600 dark:text-emerald-400 tabular-nums tracking-tight truncate">
              {isLoading ? '…' : formatUGX(activeDisplayAmount)}
            </p>
            {reviewerColumn && user?.id && (
              <button
                type="button"
                onClick={() => setFilterMyApprovals(!filterMyApprovals)}
                className="text-[10px] text-muted-foreground hover:text-foreground underline decoration-dotted block truncate"
              >
                {filterMyApprovals ? 'Show all team' : `Mine: ${formatUGX(stats.myAmount)}`}
              </button>
            )}
          </div>

          {/* Tile 2: Target / Remaining / Status */}
          <div className="rounded-xl border bg-muted/30 p-2.5 space-y-0.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
                {isTargetMet ? 'Target Status' : 'Remaining To Target'}
              </span>
              <Target className="h-3 w-3 text-muted-foreground shrink-0" />
            </div>
            <p
              className={cn(
                'text-sm sm:text-base font-bold tabular-nums tracking-tight truncate',
                isCurrentlyOverTarget
                  ? 'text-amber-600 dark:text-amber-400'
                  : isTargetMet
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-foreground'
              )}
            >
              {isCurrentlyOverTarget
                ? `Exceeded (+${formatUGX(overage)})`
                : isTargetMet
                  ? `Target met (+${formatUGX(overage)})`
                  : formatUGX(remaining)}
            </p>
            <p className="text-[10px] text-muted-foreground truncate">
              {formatUGX(effectiveTarget)} {viewMode === '7days' ? '7-day target' : 'daily target'}
            </p>
          </div>

          {/* Tile 3: Selected to Approve (Interactive in Today mode) OR Daily Average */}
          {isTodayMode ? (
            <div
              className={cn(
                'rounded-xl border p-2.5 space-y-0.5 transition-all',
                selectedCount > 0
                  ? 'border-primary/40 bg-primary/10 shadow-xs'
                  : 'border-border/60 bg-muted/20 opacity-75'
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-primary truncate">
                  Selected To Approve
                </span>
                {selectedCount > 0 && (
                  <Badge variant="primary" className="text-[9px] px-1 h-3.5 font-bold shrink-0">
                    {selectedCount} selected
                  </Badge>
                )}
              </div>
              <p className="text-sm sm:text-base font-bold text-primary tabular-nums tracking-tight truncate">
                {selectedCount > 0 ? `+${formatUGX(selectedAmount)}` : 'UGX 0'}
              </p>
              <p className="text-[10px] text-muted-foreground truncate">
                {selectedCount > 0
                  ? `Will total ${formatUGX(projectedAmount)}`
                  : 'Tick checkboxes to add'}
              </p>
            </div>
          ) : (
            <div className="rounded-xl border bg-muted/30 p-2.5 space-y-0.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
                  Daily Average
                </span>
                <TrendingUp className="h-3 w-3 text-muted-foreground shrink-0" />
              </div>
              <p className="text-sm sm:text-base font-bold text-foreground tabular-nums tracking-tight truncate">
                {formatUGX(Math.round(activeDisplayAmount / (viewMode === '7days' ? 7 : Math.max(1, stats.dayMap.size))))}
              </p>
              <p className="text-[10px] text-muted-foreground truncate">
                across {viewMode === '7days' ? 7 : Math.max(1, stats.dayMap.size)} recorded days
              </p>
            </div>
          )}

          {/* Tile 4: In Queue Now / Live Queue */}
          <div className="rounded-xl border bg-muted/30 p-2.5 space-y-0.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
                In Queue Now
              </span>
              <Layers className="h-3 w-3 text-muted-foreground shrink-0" />
            </div>
            <p className="text-sm sm:text-base font-bold text-foreground tabular-nums tracking-tight truncate">
              {formatUGX(queueTotalAmount)}
            </p>
            <p className="text-[10px] text-muted-foreground truncate">
              {queueCount} pending review
            </p>
          </div>
        </div>

        {/* Visual Progress Bar to Target */}
        <div className="space-y-1 pt-0.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground flex items-center gap-1 font-medium">
              Progress to {formatUGX(effectiveTarget)} target
              {isTodayMode && selectedCount > 0 && (
                <span className="text-primary font-semibold">
                  (projected: {projectedProgressPct}%)
                </span>
              )}
            </span>
            <span className="font-bold text-foreground tabular-nums">
              {formatUGX(activeDisplayAmount)} / {formatUGX(effectiveTarget)} ({progressPct}%)
            </span>
          </div>

          <div className="relative w-full h-2 rounded-full bg-secondary/60 overflow-hidden">
            {/* Projected bar with selection */}
            {isTodayMode && selectedCount > 0 && (
              <div
                className="absolute top-0 bottom-0 left-0 bg-primary/40 rounded-full transition-all duration-300"
                style={{ width: `${projectedProgressPct}%` }}
              />
            )}
            {/* Actual approved bar */}
            <div
              className={cn(
                'absolute top-0 bottom-0 left-0 rounded-full transition-all duration-300',
                isCurrentlyOverTarget
                  ? 'bg-amber-500'
                  : isTargetMet
                    ? 'bg-emerald-500'
                    : 'bg-primary'
              )}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        {/* 7-Day Day-by-Day Visual Bar Tracker */}
        {(viewMode === '7days' || showHistoryPanel) && (
          <div className="rounded-xl border bg-muted/20 p-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold flex items-center gap-1.5">
                <BarChart3 className="h-3.5 w-3.5 text-primary" />
                7-Day Rolling Approvals vs Daily Target
              </span>
              <span className="text-[11px] text-muted-foreground font-medium">
                Target: {formatUGX(dailyBudget)}/day
              </span>
            </div>

            <div className="grid grid-cols-7 gap-1.5">
              {last7DaysBreakdown.map((d) => {
                const dayPct = d.target > 0 ? Math.min(100, Math.round((d.totalAmount / d.target) * 100)) : 0;
                const isOver = d.totalAmount > d.target;
                const hasApprovals = d.totalAmount > 0;

                return (
                  <div
                    key={d.ymd}
                    className={cn(
                      'rounded-lg border p-1.5 flex flex-col justify-between text-center transition-all',
                      d.isToday
                        ? 'border-primary/50 bg-primary/5 shadow-2xs ring-1 ring-primary/20'
                        : 'border-border/60 bg-card/60'
                    )}
                  >
                    <div>
                      <p className="text-[10px] font-bold text-foreground truncate">{d.shortLabel}</p>
                      <p className="text-[9px] text-muted-foreground">{d.ymd.split('-').slice(1).join('/')}</p>
                    </div>

                    <div className="py-1">
                      <p
                        className={cn(
                          'text-[10px] sm:text-[11px] font-black tabular-nums tracking-tight',
                          hasApprovals ? (isOver ? 'text-amber-600' : 'text-emerald-600') : 'text-muted-foreground'
                        )}
                        title={`${d.label}: ${formatUGX(d.totalAmount)} (${d.totalCount} reqs)`}
                      >
                        {d.totalAmount >= 1_000_000
                          ? `${(d.totalAmount / 1_000_000).toFixed(1)}M`
                          : d.totalAmount > 0
                            ? `${Math.round(d.totalAmount / 1000)}k`
                            : '0'}
                      </p>
                      <p className="text-[8px] text-muted-foreground">
                        {d.totalCount} req{d.totalCount === 1 ? '' : 's'}
                      </p>
                    </div>

                    <div className="w-full bg-secondary/80 h-1.5 rounded-full overflow-hidden">
                      <div
                        className={cn(
                          'h-full rounded-full',
                          isOver ? 'bg-amber-500' : hasApprovals ? 'bg-emerald-500' : 'bg-transparent'
                        )}
                        style={{ width: `${dayPct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* History & Custom Date Range Filter Panel */}
        {showHistoryPanel && (
          <div className="rounded-xl border border-primary/25 bg-primary/5 p-3 space-y-3 animate-in fade-in">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border/60 pb-2">
              <div className="flex items-center gap-1.5">
                <History className="h-4 w-4 text-primary" />
                <span className="text-xs font-bold text-foreground">
                  Custom Date Filter &amp; Previous Approval Archive
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground self-start sm:self-center"
                onClick={() => {
                  setShowHistoryPanel(false);
                  if (viewMode === 'custom') setViewMode('today');
                }}
              >
                Close Archive
              </Button>
            </div>

            {/* Custom Range Selector Inputs */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-medium text-muted-foreground shrink-0">From:</span>
                <Input
                  type="date"
                  value={customStartYmd}
                  max={todayYmd}
                  onChange={(e) => {
                    setCustomStartYmd(e.target.value);
                    setViewMode('custom');
                  }}
                  className="h-7 text-xs px-2 bg-background w-36"
                />
              </div>

              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-medium text-muted-foreground shrink-0">To:</span>
                <Input
                  type="date"
                  value={customEndYmd}
                  max={todayYmd}
                  onChange={(e) => {
                    setCustomEndYmd(e.target.value);
                    setViewMode('custom');
                  }}
                  className="h-7 text-xs px-2 bg-background w-36"
                />
              </div>

              <div className="flex items-center gap-1 sm:ml-auto">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs px-2 bg-background gap-1"
                  onClick={() => {
                    setCustomStartYmd(kampalaOffsetYmd(-30));
                    setCustomEndYmd(todayYmd);
                    setViewMode('custom');
                  }}
                >
                  Last 30 Days
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs px-2 bg-background gap-1"
                  onClick={() => {
                    setCustomStartYmd(kampalaOffsetYmd(-7));
                    setCustomEndYmd(todayYmd);
                    setViewMode('custom');
                  }}
                >
                  Reset Range
                </Button>
              </div>
            </div>

            {/* Summary Banner for selected custom period */}
            <div className="rounded-lg bg-background p-2.5 border border-border flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
              <div>
                <span className="text-muted-foreground">Total Approved in Range: </span>
                <strong className="text-emerald-600 text-sm font-bold tabular-nums">
                  {formatUGX(activeDisplayAmount)}
                </strong>
                <span className="text-muted-foreground ml-2">({activeDisplayCount} requests across {stats.dayMap.size} active days)</span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-6 text-[11px] font-medium"
                onClick={() => {
                  setViewMode('today');
                  setShowHistoryPanel(false);
                }}
              >
                Back to Today's Live Counter
              </Button>
            </div>
          </div>
        )}

        {/* Selected Batch Context Banner (when checkboxes are ticked) */}
        {isTodayMode && selectedCount > 0 && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 p-2 rounded-lg bg-primary/5 border border-primary/20 text-xs">
            <div className="flex items-center gap-2">
              <ArrowUpRight className="h-3.5 w-3.5 text-primary shrink-0" />
              <span>
                You have selected <strong className="font-semibold">{selectedCount}</strong> request{selectedCount === 1 ? '' : 's'} totalling{' '}
                <strong className="text-primary font-bold">{formatUGX(selectedAmount)}</strong>.
              </span>
            </div>
            <span className="text-[11px] font-medium text-muted-foreground">
              Approving these will reach <strong className="text-foreground">{formatUGX(projectedAmount)}</strong> ({projectedProgressPct}% of your target).
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
