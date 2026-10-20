import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
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
  Search,
  Copy,
  CheckCheck,
  Building,
  Phone,
  User,
  ExternalLink,
  Clock,
  CheckCircle2,
  Inbox,
  ArrowRight,
  SlidersHorizontal,
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
  /** Optional array of all items in the current queue */
  queueRequests?: any[];
  /** Optional array of currently selected items */
  selectedRequests?: any[];
  /** Optional callback when a request is clicked in any breakdown modal */
  onRequestClick?: (request: any) => void;
  className?: string;
}

const STORAGE_KEY = 'welile_rent_approval_daily_budget_ugx';
const DEFAULT_BUDGET = 30_000_000; // 30 Million UGX
const PRESETS = [10_000_000, 20_000_000, 30_000_000, 50_000_000];

type ViewMode = 'today' | 'yesterday' | '7days' | 'custom';
type ModalType = 'approved' | 'target' | 'selected' | 'queue' | null;

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

function formatKampalaDateTime(dateStr?: string | null): string {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return String(dateStr);
    return (
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Africa/Kampala',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      }).format(d) + ' EAT'
    );
  } catch {
    return String(dateStr);
  }
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
  queueRequests = [],
  selectedRequests = [],
  onRequestClick,
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

  // Drilldown modal window state
  const [activeModal, setActiveModal] = useState<ModalType>(null);
  const [modalSearch, setModalSearch] = useState('');
  const [modalReviewerFilter, setModalReviewerFilter] = useState<'all' | 'mine' | 'others'>('all');

  // Load specific target for viewed Kampala day if available
  useEffect(() => {
    const activeTargetYmd =
      viewMode === 'today' ? todayYmd : viewMode === 'yesterday' ? yesterdayYmd : null;
    if (activeTargetYmd) {
      const dayTarget = getStoredTargetForYmd(activeTargetYmd, dailyBudget);
      if (dayTarget !== dailyBudget) {
        setDailyBudget(dayTarget);
        setBudgetDraft(String(dayTarget));
      }
    }
  }, [viewMode, todayYmd, yesterdayYmd]);

  const saveBudget = (amount: number) => {
    if (!Number.isFinite(amount) || amount <= 0) return;
    setDailyBudget(amount);
    setIsEditingBudget(false);
    try {
      localStorage.setItem(STORAGE_KEY, String(amount));
      const activeTargetYmd =
        viewMode === 'today' ? todayYmd : viewMode === 'yesterday' ? yesterdayYmd : null;
      if (activeTargetYmd) {
        setStoredTargetForYmd(activeTargetYmd, amount);
      }
      toast.success(`Target set to ${formatUGX(amount)}`);
    } catch {}
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
    return kampalaRangeToUtc(customStartYmd, customEndYmd);
  }, [viewMode, todayYmd, yesterdayYmd, rolling7DaysStartYmd, customStartYmd, customEndYmd]);

  // Query rent requests approved in the selected window with profiles & landlords
  const { data: windowApprovalsData, isLoading: isLoadingApprovals } = useQuery({
    queryKey: [
      'rent-approval-counter-window-v2',
      stage,
      reviewerAtColumn,
      reviewerColumn,
      queryWindow.startUtc,
      queryWindow.endUtc,
    ],
    queryFn: async () => {
      let query = supabase
        .from('rent_requests')
        .select(`
          id,
          rent_amount,
          status,
          registration_type,
          created_at,
          duration_days,
          daily_repayment,
          tenant_id,
          landlord_id,
          agent_id,
          ${reviewerAtColumn},
          ${reviewerColumn || 'updated_at'}
        `)
        .gte(reviewerAtColumn, queryWindow.startUtc)
        .lt(reviewerAtColumn, queryWindow.endUtc)
        .neq('status', 'rejected')
        .neq('status', 'cancelled')
        .neq('status', stage); // must have progressed past this pending stage

      // Option A: Strict stage approvals — exclude auto-activated arrears and require reviewer
      query = query.or('registration_type.is.null,registration_type.neq.outstanding_balance');
      if (reviewerColumn) {
        query = query.not(reviewerColumn, 'is', null);
      }

      const { data, error } = await query;

      if (error) {
        console.warn('Could not query approved rent:', error);
        return [];
      }

      let rows = (data || []).filter((r: any) => {
        // Enforce strict stage review: must have reviewer and cannot be outstanding balance
        if (reviewerColumn && !r[reviewerColumn]) return false;
        if (r.registration_type === 'outstanding_balance') return false;
        return true;
      });
      if (rows.length === 0) return [];

      const tenantIds = Array.from(new Set(rows.map((r: any) => r.tenant_id).filter(Boolean)));
      const landlordIds = Array.from(new Set(rows.map((r: any) => r.landlord_id).filter(Boolean)));

      const [profilesRes, landlordsRes] = await Promise.all([
        tenantIds.length > 0
          ? supabase.from('profiles').select('id, full_name, phone').in('id', tenantIds)
          : Promise.resolve({ data: [] }),
        landlordIds.length > 0
          ? supabase.from('landlords').select('id, name, phone, property_address').in('id', landlordIds)
          : Promise.resolve({ data: [] }),
      ]);

      const profileMap = new Map((profilesRes.data || []).map((p: any) => [p.id, p]));
      const landlordMap = new Map((landlordsRes.data || []).map((l: any) => [l.id, l]));

      return rows.map((r: any) => ({
        ...r,
        tenant_name: profileMap.get(r.tenant_id)?.full_name || 'Tenant',
        tenant_phone: profileMap.get(r.tenant_id)?.phone || '',
        landlord_name: landlordMap.get(r.landlord_id)?.name || '',
        property_address: landlordMap.get(r.landlord_id)?.property_address || '',
      }));
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
        shortLabel: offset === 0 ? 'Today' : offset === -1 ? 'Yest.' : kampalaLabel(ymd).split(' ')[0],
        totalAmount: dayData.totalAmount,
        totalCount: dayData.totalCount,
        target,
        isToday,
      });
    }

    return days;
  }, [stats.dayMap, todayYmd, dailyBudget]);

  // Normalized items for drilldown modal
  const approvedModalItems = useMemo(() => {
    return (windowApprovalsData || []).map((r: any) => {
      const reviewedAt = (r as any)[reviewerAtColumn] || r.reviewed_at || r.created_at;
      const reviewerId = reviewerColumn ? (r as any)[reviewerColumn] : r.reviewer_id;
      const isMine = !!(reviewerColumn && user?.id && reviewerId === user.id);
      return {
        id: r.id,
        rent_amount: Number(r.rent_amount || 0),
        status: r.status,
        created_at: r.created_at,
        reviewed_at: reviewedAt,
        reviewer_id: reviewerId,
        tenant_name: r.tenant_name || 'Tenant',
        tenant_phone: r.tenant_phone || '',
        landlord_name: r.landlord_name || '',
        property_address: r.property_address || '',
        daily_repayment: Number(r.daily_repayment || 0),
        duration_days: Number(r.duration_days || 0),
        is_mine: isMine,
        raw: r,
      };
    });
  }, [windowApprovalsData, reviewerAtColumn, reviewerColumn, user?.id]);

  const queueModalItems = useMemo(() => {
    return (queueRequests || []).map((r: any) => ({
      id: r.id,
      rent_amount: Number(r.rent_amount || 0),
      status: r.status,
      created_at: r.created_at,
      reviewed_at: null,
      tenant_name: r.tenant?.full_name || r.tenant_name || 'Tenant',
      tenant_phone: r.tenant?.phone || r.tenant_phone || '',
      landlord_name: r.landlord?.name || r.landlord_name || '',
      property_address: r.landlord?.property_address || '',
      daily_repayment: Number(r.daily_repayment || 0),
      duration_days: Number(r.duration_days || 0),
      is_mine: false,
      raw: r,
    }));
  }, [queueRequests]);

  const selectedModalItems = useMemo(() => {
    return (selectedRequests || []).map((r: any) => ({
      id: r.id,
      rent_amount: Number(r.rent_amount || 0),
      status: r.status,
      created_at: r.created_at,
      reviewed_at: null,
      tenant_name: r.tenant?.full_name || r.tenant_name || 'Tenant',
      tenant_phone: r.tenant?.phone || r.tenant_phone || '',
      landlord_name: r.landlord?.name || r.landlord_name || '',
      property_address: r.landlord?.property_address || '',
      daily_repayment: Number(r.daily_repayment || 0),
      duration_days: Number(r.duration_days || 0),
      is_mine: false,
      raw: r,
    }));
  }, [selectedRequests]);

  // Filtered modal items based on search and reviewer filter
  const modalFilteredItems = useMemo(() => {
    let source: any[] = [];
    if (activeModal === 'approved' || activeModal === 'target') source = approvedModalItems;
    else if (activeModal === 'queue') source = queueModalItems;
    else if (activeModal === 'selected') source = selectedModalItems;

    return source.filter((item) => {
      if (activeModal === 'approved' || activeModal === 'target') {
        if (modalReviewerFilter === 'mine' && !item.is_mine) return false;
        if (modalReviewerFilter === 'others' && item.is_mine) return false;
      }
      if (!modalSearch.trim()) return true;
      const q = modalSearch.toLowerCase().trim();
      return (
        item.tenant_name.toLowerCase().includes(q) ||
        item.tenant_phone.toLowerCase().includes(q) ||
        item.landlord_name.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q) ||
        String(item.rent_amount).includes(q)
      );
    });
  }, [
    activeModal,
    approvedModalItems,
    queueModalItems,
    selectedModalItems,
    modalSearch,
    modalReviewerFilter,
  ]);

  const modalFilteredSum = useMemo(() => {
    return modalFilteredItems.reduce((acc, curr) => acc + (curr.rent_amount || 0), 0);
  }, [modalFilteredItems]);

  // Active view amounts
  const activeDisplayAmount = filterMyApprovals ? stats.myAmount : stats.totalAmount;
  const activeDisplayCount = filterMyApprovals ? stats.myCount : stats.totalCount;

  // Multi-day target logic
  const effectiveTarget = viewMode === '7days' ? dailyBudget * 7 : dailyBudget;

  // Target comparison math
  const remaining = Math.max(0, effectiveTarget - activeDisplayAmount);
  const isTargetMet = activeDisplayAmount >= effectiveTarget;
  const overage = Math.max(0, activeDisplayAmount - effectiveTarget);
  const isCurrentlyOverTarget = activeDisplayAmount > effectiveTarget;

  // Projected totals when checkboxes are ticked
  const projectedAmount = activeDisplayAmount + selectedAmount;
  const isProjectedOverTarget = projectedAmount > effectiveTarget;

  // Progress percentage
  const progressPct =
    effectiveTarget > 0 ? Math.min(100, Math.round((activeDisplayAmount / effectiveTarget) * 100)) : 0;
  const projectedProgressPct =
    effectiveTarget > 0 ? Math.min(100, Math.round((projectedAmount / effectiveTarget) * 100)) : 0;

  const isTodayMode = viewMode === 'today';

  const viewModeLabel =
    viewMode === 'today'
      ? 'Today'
      : viewMode === 'yesterday'
      ? 'Yesterday'
      : viewMode === '7days'
      ? 'Last 7 Days'
      : 'Custom Range';

  const handleCopySummary = () => {
    let text = '';
    if (activeModal === 'approved') {
      text = `Approved ${viewModeLabel}: ${modalFilteredItems.length} requests totalling ${formatUGX(
        modalFilteredSum
      )}`;
    } else if (activeModal === 'queue') {
      text = `In Queue: ${modalFilteredItems.length} pending requests totalling ${formatUGX(
        modalFilteredSum
      )}`;
    } else if (activeModal === 'selected') {
      text = `Selected to Approve: ${modalFilteredItems.length} requests totalling ${formatUGX(
        modalFilteredSum
      )}`;
    } else if (activeModal === 'target') {
      text = `Daily Target: ${formatUGX(effectiveTarget)} | Approved: ${formatUGX(
        activeDisplayAmount
      )} | Remaining: ${formatUGX(remaining)}`;
    }
    navigator.clipboard?.writeText(text);
    toast.success('Summary copied to clipboard');
  };

  return (
    <Card className={cn('border border-border/80 shadow-xs overflow-hidden', className)}>
      <CardContent className="p-3 sm:p-4 space-y-3">
        {/* Header Bar: Title, View Mode Switcher & Target Adjuster */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 shrink-0">
              <Banknote className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <h3 className="text-xs sm:text-sm font-bold tracking-tight text-foreground uppercase">
                  {isTodayMode ? "Today's Approval Money Counter" : `${viewModeLabel} Approval Counter`}
                </h3>
                <Badge
                  variant="outline"
                  className={cn(
                    'text-[10px] font-semibold px-1.5 py-0 h-4 border-emerald-500/30 bg-emerald-500/10 text-emerald-600',
                    isCurrentlyOverTarget && 'border-amber-500/40 bg-amber-500/10 text-amber-600'
                  )}
                >
                  {isCurrentlyOverTarget ? 'Target Exceeded' : `${progressPct}% of target`}
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Live Kampala-day approved rent tracking against your payout budget. Click the approved card to inspect requests.
              </p>
            </div>
          </div>

          {/* Quick Date Switcher & Target Widget */}
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            <div className="flex items-center p-0.5 rounded-lg bg-muted/60 border border-border/60 text-xs">
              <button
                type="button"
                onClick={() => {
                  setViewMode('today');
                  setShowHistoryPanel(false);
                }}
                className={cn(
                  'px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors',
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
                  'px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors',
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
                  'px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors',
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
                  setShowHistoryPanel(!showHistoryPanel);
                  if (!showHistoryPanel) setViewMode('custom');
                }}
                className={cn(
                  'px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors flex items-center gap-1',
                  showHistoryPanel || viewMode === 'custom'
                    ? 'bg-background text-foreground shadow-2xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                )}
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
                  isCurrentlyOverTarget &&
                    'border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-300'
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
                  Approvals Exceed Target by {formatUGX(overage)}
                </p>
                <p className="text-[11px] text-amber-800/80 dark:text-amber-300/80">
                  Total approved is <strong className="text-foreground">{formatUGX(activeDisplayAmount)}</strong>{' '}
                  against your <strong className="text-foreground">{formatUGX(effectiveTarget)}</strong> target.
                  Adjust your target so your approvals fit within the budget.
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
                  Selected Batch Exceeds Target by {formatUGX(projectedAmount - effectiveTarget)}
                </p>
                <p className="text-[11px] text-rose-800/80 dark:text-rose-300/80">
                  Approving these {selectedCount} selected requests (+{formatUGX(selectedAmount)}) will bring the
                  total to <strong className="text-foreground">{formatUGX(projectedAmount)}</strong>. Please
                  adjust your target to fit before proceeding.
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

        {/* Key Metrics Grid - CLICKABLE CARDS */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-0.5">
          {/* Card 1: Total Approved in selected period */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => {
              setActiveModal('approved');
              setModalSearch('');
              setModalReviewerFilter('all');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                setActiveModal('approved');
                setModalSearch('');
              }
            }}
            className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10 hover:border-emerald-500/60 p-2.5 space-y-0.5 cursor-pointer transition-all duration-150 active:scale-[0.99] group shadow-2xs relative"
            title="Click to view requests summing to this total"
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 truncate">
                {viewMode === 'today'
                  ? filterMyApprovals
                    ? 'My Approved Today'
                    : 'Approved Today'
                  : viewMode === 'yesterday'
                  ? 'Approved Yesterday'
                  : viewMode === '7days'
                  ? '7-Day Approved Total'
                  : 'Range Total'}
              </span>
              <div className="flex items-center gap-1">
                <Badge
                  variant="outline"
                  className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 text-[9px] px-1 h-3.5 shrink-0"
                >
                  {activeDisplayCount} req{activeDisplayCount === 1 ? '' : 's'}
                </Badge>
                <ExternalLink className="h-2.5 w-2.5 text-emerald-600 opacity-50 group-hover:opacity-100 transition-opacity" />
              </div>
            </div>
            <p className="text-sm sm:text-base font-black text-emerald-600 dark:text-emerald-400 tabular-nums tracking-tight truncate">
              {isLoadingApprovals ? '…' : formatUGX(activeDisplayAmount)}
            </p>
            <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-0.5">
              {reviewerColumn && user?.id ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFilterMyApprovals(!filterMyApprovals);
                  }}
                  className="text-[10px] text-muted-foreground hover:text-foreground underline decoration-dotted block truncate"
                >
                  {filterMyApprovals ? 'Show all team' : `Mine: ${formatUGX(stats.myAmount)}`}
                </button>
              ) : (
                <span className="truncate">Click to view list</span>
              )}
              <span className="text-[9px] font-medium text-emerald-600 opacity-0 group-hover:opacity-100 transition-opacity">
                Inspect ↗
              </span>
            </div>
          </div>

          {/* Card 2: Target / Remaining / Status (Static info) */}
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

          {/* Card 3: Selected to Approve (in Today mode) OR Daily Average (Static info) */}
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
                    {selectedCount} sel.
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
                {formatUGX(
                  Math.round(
                    activeDisplayAmount / (viewMode === '7days' ? 7 : Math.max(1, stats.dayMap.size))
                  )
                )}
              </p>
              <p className="text-[10px] text-muted-foreground truncate">
                across {viewMode === '7days' ? 7 : Math.max(1, stats.dayMap.size)} recorded days
              </p>
            </div>
          )}

          {/* Card 4: In Queue Now / Live Queue (Static info) */}
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
                <span className="text-primary font-semibold">(projected: {projectedProgressPct}%)</span>
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
                'absolute top-0 bottom-0 left-0 rounded-full transition-all duration-500',
                isCurrentlyOverTarget ? 'bg-amber-500' : isTargetMet ? 'bg-emerald-500' : 'bg-primary'
              )}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        {/* 7-DAY CUMULATIVE ROLLING BREAKDOWN CHART */}
        {viewMode === '7days' && (
          <div className="rounded-xl border border-border/80 bg-muted/20 p-3 space-y-3 animate-in fade-in duration-200">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <BarChart3 className="h-4 w-4 text-primary" />
                <h4 className="text-xs font-bold text-foreground">7-Day Cumulative Trend & Day Breakdown</h4>
              </div>
              <Badge variant="secondary" className="text-[10px] font-semibold">
                Kampala Days
              </Badge>
            </div>

            {/* Daily Bar Chart */}
            <div className="grid grid-cols-7 gap-1.5 pt-1">
              {last7DaysBreakdown.map((day) => {
                const maxInWindow = Math.max(
                  1,
                  ...last7DaysBreakdown.map((d) => d.totalAmount),
                  dailyBudget
                );
                const barHeightPct = Math.min(100, Math.round((day.totalAmount / maxInWindow) * 100));
                const targetMet = day.totalAmount >= day.target;

                return (
                  <div
                    key={day.ymd}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setCustomStartYmd(day.ymd);
                      setCustomEndYmd(day.ymd);
                      setViewMode('custom');
                    }}
                    className={cn(
                      'flex flex-col items-center gap-1 p-1.5 rounded-lg border transition-all cursor-pointer hover:border-primary/50 hover:bg-background/80',
                      day.isToday ? 'border-primary/40 bg-primary/5' : 'border-border/60 bg-background/50'
                    )}
                    title={`${day.label}: ${formatUGX(day.totalAmount)} (${day.totalCount} reqs). Click to view.`}
                  >
                    <span className="text-[10px] font-medium text-muted-foreground truncate">
                      {day.shortLabel}
                    </span>

                    {/* Mini bar container */}
                    <div className="w-full h-12 bg-muted/40 rounded flex flex-col justify-end p-0.5 overflow-hidden">
                      <div
                        className={cn(
                          'w-full rounded-xs transition-all duration-300',
                          targetMet
                            ? 'bg-emerald-500'
                            : day.totalAmount > 0
                            ? 'bg-primary'
                            : 'bg-transparent'
                        )}
                        style={{ height: `${Math.max(day.totalAmount > 0 ? 8 : 0, barHeightPct)}%` }}
                      />
                    </div>

                    <span className="text-[10px] font-bold tabular-nums text-foreground truncate">
                      {day.totalAmount > 0 ? `${Math.round(day.totalAmount / 1_000_000)}M` : '0'}
                    </span>
                    <span className="text-[9px] text-muted-foreground">
                      {day.totalCount} {day.totalCount === 1 ? 'req' : 'reqs'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* CUSTOM RANGE & HISTORY ARCHIVE PANEL */}
        {showHistoryPanel && (
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 space-y-3 animate-in fade-in duration-200">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-primary" />
                <div>
                  <h4 className="text-xs font-bold text-foreground">Custom Date Filter & Approval History</h4>
                  <p className="text-[11px] text-muted-foreground">
                    Inspect previous dates, check amounts approved by managers, and filter custom date ranges.
                  </p>
                </div>
              </div>

              {/* Date pickers */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <div className="flex items-center gap-1 text-xs">
                  <span className="text-[11px] text-muted-foreground font-medium">From:</span>
                  <Input
                    type="date"
                    value={customStartYmd}
                    max={customEndYmd}
                    onChange={(e) => {
                      setCustomStartYmd(e.target.value);
                      setViewMode('custom');
                    }}
                    className="h-7 text-xs px-2 w-32 bg-background font-medium"
                  />
                </div>
                <div className="flex items-center gap-1 text-xs">
                  <span className="text-[11px] text-muted-foreground font-medium">To:</span>
                  <Input
                    type="date"
                    value={customEndYmd}
                    min={customStartYmd}
                    max={todayYmd}
                    onChange={(e) => {
                      setCustomEndYmd(e.target.value);
                      setViewMode('custom');
                    }}
                    className="h-7 text-xs px-2 w-32 bg-background font-medium"
                  />
                </div>
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
                <span className="text-muted-foreground ml-2">
                  ({activeDisplayCount} requests across {stats.dayMap.size} active days)
                </span>
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
                You have selected <strong className="font-semibold">{selectedCount}</strong> request
                {selectedCount === 1 ? '' : 's'} totalling{' '}
                <strong className="text-primary font-bold">{formatUGX(selectedAmount)}</strong>.
              </span>
            </div>
            <span className="text-[11px] font-medium text-muted-foreground">
              Approving these will reach <strong className="text-foreground">{formatUGX(projectedAmount)}</strong> (
              {projectedProgressPct}% of your target).
            </span>
          </div>
        )}
      </CardContent>

      {/* =========================================================================
          DRILLDOWN MODAL WINDOW — LISTING REQUESTS SUMMING TO TOTALS
          ========================================================================= */}
      <Dialog open={!!activeModal} onOpenChange={(open) => !open && setActiveModal(null)}>
        <DialogContent className="max-w-2xl sm:max-w-3xl max-h-[88vh] flex flex-col p-0 gap-0 overflow-hidden border-border bg-card shadow-2xl">
          {/* Header */}
          <DialogHeader className="p-4 pb-3 pr-14 sm:pr-16 border-b border-border/80 bg-muted/20">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div className="flex items-center gap-2.5 min-w-0">
                <div
                  className={cn(
                    'flex h-9 w-9 items-center justify-center rounded-xl shrink-0',
                    activeModal === 'approved' && 'bg-emerald-500/10 text-emerald-600',
                    activeModal === 'target' && 'bg-amber-500/10 text-amber-600',
                    activeModal === 'selected' && 'bg-primary/10 text-primary',
                    activeModal === 'queue' && 'bg-blue-500/10 text-blue-600'
                  )}
                >
                  {activeModal === 'approved' && <CheckCircle2 className="h-5 w-5" />}
                  {activeModal === 'target' && <Target className="h-5 w-5" />}
                  {activeModal === 'selected' && <Layers className="h-5 w-5" />}
                  {activeModal === 'queue' && <Clock className="h-5 w-5" />}
                </div>
                <div className="min-w-0">
                  <DialogTitle className="text-base font-bold text-foreground truncate">
                    Approved Requests — {viewModeLabel}
                  </DialogTitle>
                  <DialogDescription className="text-xs text-muted-foreground truncate">
                    Individual approved rent requests summing to {formatUGX(activeDisplayAmount)}.
                  </DialogDescription>
                </div>
              </div>

              {/* Total Badge with clean spacing */}
              <div className="text-left sm:text-right shrink-0">
                <span className="text-[10px] text-muted-foreground block font-semibold uppercase tracking-wider">Sum Total</span>
                <span className="text-sm sm:text-base font-black text-emerald-600 dark:text-emerald-400 tabular-nums tracking-tight">
                  {formatUGX(modalFilteredSum)}
                </span>
              </div>
            </div>

            {/* Search Bar & Reviewer Filter Pills */}
            <div className="flex flex-col sm:flex-row items-center gap-2 pt-2">
              <div className="relative flex-1 w-full">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder="Search by tenant name, phone, landlord or ID..."
                  value={modalSearch}
                  onChange={(e) => setModalSearch(e.target.value)}
                  className="h-8 pl-8 text-xs bg-background"
                />
              </div>

              {(activeModal === 'approved' || activeModal === 'target') && reviewerColumn && user?.id && (
                <div className="flex items-center gap-1 bg-background p-0.5 rounded-lg border text-xs shrink-0 self-start sm:self-auto">
                  <button
                    type="button"
                    onClick={() => setModalReviewerFilter('all')}
                    className={cn(
                      'px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors',
                      modalReviewerFilter === 'all'
                        ? 'bg-muted text-foreground font-semibold'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    All ({approvedModalItems.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setModalReviewerFilter('mine')}
                    className={cn(
                      'px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors',
                      modalReviewerFilter === 'mine'
                        ? 'bg-muted text-foreground font-semibold'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    Mine ({stats.myCount})
                  </button>
                  <button
                    type="button"
                    onClick={() => setModalReviewerFilter('others')}
                    className={cn(
                      'px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors',
                      modalReviewerFilter === 'others'
                        ? 'bg-muted text-foreground font-semibold'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    Team ({Math.max(0, stats.totalCount - stats.myCount)})
                  </button>
                </div>
              )}
            </div>
          </DialogHeader>

          {/* List Area */}
          <ScrollArea className="flex-1 max-h-[55vh] p-3 sm:p-4">
            {isLoadingApprovals && (activeModal === 'approved' || activeModal === 'target') ? (
              <div className="p-8 text-center text-xs text-muted-foreground space-y-2">
                <div className="h-6 w-6 rounded-full border-2 border-primary border-t-transparent animate-spin mx-auto" />
                <p>Loading approved requests...</p>
              </div>
            ) : modalFilteredItems.length === 0 ? (
              <div className="p-8 text-center text-xs text-muted-foreground space-y-2">
                <Inbox className="h-8 w-8 text-muted-foreground/60 mx-auto" />
                <p className="font-semibold text-foreground">No requests found</p>
                <p className="text-[11px]">
                  {modalSearch.trim()
                    ? `No requests match "${modalSearch}". Try clearing your search.`
                    : activeModal === 'selected'
                    ? 'No requests are currently selected. Tick checkboxes in the queue list below to select requests.'
                    : 'No requests recorded for this selection.'}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {modalFilteredItems.map((item, idx) => (
                  <div
                    key={item.id || idx}
                    onClick={() => {
                      if (onRequestClick && item.raw) {
                        onRequestClick(item.raw);
                        setActiveModal(null);
                      }
                    }}
                    className={cn(
                      'rounded-xl border border-border/80 p-3 bg-card hover:bg-muted/40 transition-all duration-150 space-y-2 text-xs',
                      onRequestClick && 'cursor-pointer hover:border-primary/50 active:scale-[0.995]'
                    )}
                  >
                    {/* Top Row: Tenant Name & Phone on Left, Rent Amount on Right */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-bold text-foreground text-sm flex items-center gap-1.5 truncate">
                            <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            {item.tenant_name}
                          </span>
                          {item.tenant_phone && (
                            <span className="text-[11px] text-muted-foreground font-mono">
                              {item.tenant_phone}
                            </span>
                          )}
                          {item.is_mine && (
                            <Badge
                              variant="outline"
                              className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 text-[9px] px-1 h-3.5"
                            >
                              Approved by You
                            </Badge>
                          )}
                        </div>
                      </div>

                      {/* Prominent Amount on Top Right */}
                      <div className="text-right shrink-0">
                        <span className="text-sm sm:text-base font-black text-emerald-600 dark:text-emerald-400 tabular-nums tracking-tight block">
                          {formatUGX(item.rent_amount)}
                        </span>
                      </div>
                    </div>

                    {/* Middle Row: Landlord & Property Address */}
                    {item.landlord_name && (
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground truncate">
                        <Building className="h-3 w-3 shrink-0 text-muted-foreground/80" />
                        <span className="truncate">
                          <strong className="text-foreground/85 font-medium">{item.landlord_name}</strong>
                          {item.property_address ? ` · ${item.property_address}` : ''}
                        </span>
                      </div>
                    )}

                    {/* Bottom Row: Terms, Kampala Timestamp & Action */}
                    <div className="flex items-center justify-between text-[10px] sm:text-[11px] text-muted-foreground pt-1.5 border-t border-border/50 gap-2">
                      <div className="flex items-center gap-2.5 flex-wrap min-w-0">
                        {item.daily_repayment > 0 && (
                          <span className="font-medium text-foreground/75 truncate">
                            {formatUGX(item.daily_repayment)}/day · {item.duration_days || 30}d
                          </span>
                        )}
                        {(item.reviewed_at || item.created_at) && (
                          <span className="flex items-center gap-1 truncate text-muted-foreground/80">
                            <Clock className="h-3 w-3 shrink-0" />
                            {formatKampalaDateTime(item.reviewed_at || item.created_at)}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-mono text-[9px] text-muted-foreground/70">
                          #{item.id.slice(0, 8)}
                        </span>
                        {onRequestClick && (
                          <span className="text-[10px] text-primary font-semibold flex items-center gap-0.5">
                            Inspect <ArrowRight className="h-2.5 w-2.5" />
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>

          {/* Footer Summary */}
          <div className="p-3 px-4 border-t border-border/80 bg-muted/30 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground truncate">
              Showing <strong className="text-foreground">{modalFilteredItems.length}</strong> request
              {modalFilteredItems.length === 1 ? '' : 's'} · Sum:{' '}
              <strong className="text-emerald-600 font-bold tabular-nums">
                {formatUGX(modalFilteredSum)}
              </strong>
            </span>
            <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2.5 text-xs gap-1.5 bg-background shadow-2xs"
                onClick={handleCopySummary}
              >
                <Copy className="h-3.5 w-3.5" />
                <span>Copy Summary</span>
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-8 px-3 text-xs font-semibold"
                onClick={() => setActiveModal(null)}
              >
                Close
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
