import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { formatUGX } from '@/lib/rentCalculations';
import {
  Banknote,
  Target,
  TrendingUp,
  CheckCircle2,
  Pencil,
  Check,
  X,
  Sparkles,
  Layers,
  ArrowUpRight,
  ShieldCheck,
  RotateCcw,
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

/**
 * Returns midnight Kampala time (EAT, UTC+3) as an ISO UTC string.
 */
function getKampalaTodayStartUtc(): string {
  const now = new Date();
  const kampalaNow = new Date(now.getTime() + 3 * 3600 * 1000);
  const midnightUtc = new Date(
    Date.UTC(kampalaNow.getUTCFullYear(), kampalaNow.getUTCMonth(), kampalaNow.getUTCDate(), 0, 0, 0) -
      3 * 3600 * 1000
  );
  return midnightUtc.toISOString();
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

  // Daily budget target state with localStorage persistence
  const [dailyBudget, setDailyBudget] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const val = Number(saved);
        if (Number.isFinite(val) && val > 0) return val;
      }
    } catch {
      // localStorage may fail in private mode
    }
    return DEFAULT_BUDGET;
  });

  const [isEditingBudget, setIsEditingBudget] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState(String(dailyBudget));
  const [filterMyApprovals, setFilterMyApprovals] = useState(false);

  // Sync draft when target changes externally
  useEffect(() => {
    setBudgetDraft(String(dailyBudget));
  }, [dailyBudget]);

  const saveBudget = (val: number) => {
    const positive = Math.max(1_000_000, Math.round(val || DEFAULT_BUDGET));
    setDailyBudget(positive);
    try {
      localStorage.setItem(STORAGE_KEY, String(positive));
    } catch {
      // ignore
    }
    setIsEditingBudget(false);
  };

  const todayStartUtc = useMemo(() => getKampalaTodayStartUtc(), []);

  // Query rent requests approved today at this stage
  const { data: approvalStats, isLoading } = useQuery({
    queryKey: ['rent-approval-counter-today', stage, reviewerAtColumn, todayStartUtc],
    queryFn: async () => {
      // Select rent requests approved at or past this stage today
      const { data, error } = await supabase
        .from('rent_requests')
        .select(`id, rent_amount, status, ${reviewerAtColumn}, ${reviewerColumn || 'updated_at'}`)
        .gte(reviewerAtColumn, todayStartUtc)
        .neq('status', 'rejected')
        .neq('status', stage); // must have progressed past the current pending stage

      if (error) {
        console.warn('Could not query today approved rent:', error);
        return { totalAmount: 0, totalCount: 0, myAmount: 0, myCount: 0 };
      }

      const rows = data || [];
      let totalAmount = 0;
      let totalCount = 0;
      let myAmount = 0;
      let myCount = 0;

      for (const r of rows) {
        const amt = Number(r.rent_amount || 0);
        totalAmount += amt;
        totalCount += 1;

        if (reviewerColumn && user?.id && (r as any)[reviewerColumn] === user.id) {
          myAmount += amt;
          myCount += 1;
        }
      }

      return { totalAmount, totalCount, myAmount, myCount };
    },
    refetchInterval: 30_000,
  });

  const totalApproved = approvalStats?.totalAmount ?? 0;
  const totalCount = approvalStats?.totalCount ?? 0;
  const myApproved = approvalStats?.myAmount ?? 0;
  const myCount = approvalStats?.myCount ?? 0;

  const currentDisplayAmount = filterMyApprovals ? myApproved : totalApproved;
  const currentDisplayCount = filterMyApprovals ? myCount : totalCount;

  const projectedAmount = currentDisplayAmount + selectedAmount;
  const progressPct = dailyBudget > 0 ? Math.min(100, Math.round((currentDisplayAmount / dailyBudget) * 100)) : 0;
  const projectedProgressPct = dailyBudget > 0 ? Math.min(100, Math.round((projectedAmount / dailyBudget) * 100)) : 0;

  const remaining = Math.max(0, dailyBudget - currentDisplayAmount);
  const isTargetMet = currentDisplayAmount >= dailyBudget;
  const overage = Math.max(0, currentDisplayAmount - dailyBudget);

  return (
    <Card
      className={cn(
        'relative overflow-hidden border border-border/80 bg-gradient-to-br from-card via-card/95 to-primary/5 shadow-xs transition-all',
        className
      )}
    >
      {/* Top subtle highlight band */}
      <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-500 via-primary to-indigo-500 opacity-80" />

      <CardContent className="p-3.5 sm:p-4 space-y-3">
        {/* Header row: Title & Daily Budget Target controls */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-emerald-500/15 text-emerald-600 flex items-center justify-center shrink-0 border border-emerald-500/25 shadow-xs">
              <Banknote className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-foreground">
                  Today's Approval Money Counter
                </span>
                <Badge
                  variant="outline"
                  className={cn(
                    'text-[10px] font-semibold px-1.5 py-0 h-4 border',
                    isTargetMet
                      ? 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30'
                      : 'bg-primary/10 text-primary border-primary/20'
                  )}
                >
                  {isTargetMet ? 'Target Reached 🎯' : `${progressPct}% of target`}
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Live Kampala-day approved rent tracking against your payout budget.
              </p>
            </div>
          </div>

          {/* Target Budget Editor */}
          <div className="flex items-center gap-1.5 self-start sm:self-center shrink-0">
            {isEditingBudget ? (
              <div className="flex items-center gap-1 bg-background/90 p-1 rounded-md border shadow-xs">
                <span className="text-[11px] font-medium text-muted-foreground pl-1">UGX</span>
                <Input
                  type="number"
                  step={1_000_000}
                  min={1_000_000}
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
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsEditingBudget(true)}
                  className="h-7 text-xs font-medium gap-1 px-2 border-border/80 hover:border-primary/40 bg-background/60"
                  title="Click to change your daily approval/payout budget"
                >
                  <Target className="h-3 w-3 text-muted-foreground" />
                  <span>Target:</span>
                  <strong className="text-foreground">{formatUGX(dailyBudget)}</strong>
                  <Pencil className="h-2.5 w-2.5 text-muted-foreground ml-0.5" />
                </Button>
              </div>
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

        {/* Key Metrics Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-0.5">
          {/* Tile 1: Total Approved Today */}
          <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-2.5 space-y-0.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                {filterMyApprovals ? 'My Approvals Today' : 'Approved Today'}
              </span>
              <Badge
                variant="outline"
                className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 text-[9px] px-1 h-3.5"
              >
                {currentDisplayCount} req{currentDisplayCount === 1 ? '' : 's'}
              </Badge>
            </div>
            <p className="text-sm sm:text-base font-black text-emerald-600 dark:text-emerald-400 truncate">
              {isLoading ? '…' : formatUGX(currentDisplayAmount)}
            </p>
            {reviewerColumn && user?.id && (
              <button
                type="button"
                onClick={() => setFilterMyApprovals(!filterMyApprovals)}
                className="text-[10px] text-muted-foreground hover:text-foreground underline decoration-dotted block"
              >
                {filterMyApprovals ? 'Show all team' : `Mine: ${formatUGX(myApproved)}`}
              </button>
            )}
          </div>

          {/* Tile 2: Remaining to Target / Status */}
          <div className="rounded-xl border bg-muted/30 p-2.5 space-y-0.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {isTargetMet ? 'Budget Status' : 'Remaining To Target'}
              </span>
              <Target className="h-3 w-3 text-muted-foreground" />
            </div>
            <p
              className={cn(
                'text-sm sm:text-base font-bold truncate',
                isTargetMet ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground'
              )}
            >
              {isTargetMet ? `Target met (+${formatUGX(overage)})` : formatUGX(remaining)}
            </p>
            <p className="text-[10px] text-muted-foreground truncate">
              {isTargetMet ? '100% of daily target reached' : `${formatUGX(dailyBudget)} target`}
            </p>
          </div>

          {/* Tile 3: Selected to Approve (Interactive) */}
          <div
            className={cn(
              'rounded-xl border p-2.5 space-y-0.5 transition-all',
              selectedCount > 0
                ? 'border-primary/40 bg-primary/10 shadow-xs'
                : 'border-border/60 bg-muted/20 opacity-75'
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                Selected To Approve
              </span>
              {selectedCount > 0 && (
                <Badge variant="primary" className="text-[9px] px-1 h-3.5 font-bold">
                  {selectedCount} selected
                </Badge>
              )}
            </div>
            <p className="text-sm sm:text-base font-bold text-primary truncate">
              {selectedCount > 0 ? `+${formatUGX(selectedAmount)}` : 'UGX 0'}
            </p>
            <p className="text-[10px] text-muted-foreground truncate">
              {selectedCount > 0
                ? `Will total ${formatUGX(projectedAmount)}`
                : 'Tick checkboxes to add'}
            </p>
          </div>

          {/* Tile 4: Pending In Queue */}
          <div className="rounded-xl border bg-muted/30 p-2.5 space-y-0.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                In Queue Now
              </span>
              <Layers className="h-3 w-3 text-muted-foreground" />
            </div>
            <p className="text-sm sm:text-base font-bold text-foreground truncate">
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
              Progress to {formatUGX(dailyBudget)} target
              {selectedCount > 0 && (
                <span className="text-primary font-semibold">
                  (projected: {projectedProgressPct}%)
                </span>
              )}
            </span>
            <span className="font-bold text-foreground">
              {formatUGX(currentDisplayAmount)} / {formatUGX(dailyBudget)} ({progressPct}%)
            </span>
          </div>

          <div className="relative w-full h-2 rounded-full bg-secondary/60 overflow-hidden">
            {/* Projected bar with selection */}
            {selectedCount > 0 && (
              <div
                className="absolute top-0 bottom-0 left-0 bg-primary/40 rounded-full transition-all duration-300"
                style={{ width: `${projectedProgressPct}%` }}
              />
            )}
            {/* Actual approved bar */}
            <div
              className={cn(
                'absolute top-0 bottom-0 left-0 rounded-full transition-all duration-300',
                isTargetMet ? 'bg-emerald-500' : 'bg-primary'
              )}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        {/* Selected Batch Context Banner */}
        {selectedCount > 0 && (
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
