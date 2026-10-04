import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCreditAccessLimit, formatCreditAmount } from '@/hooks/useCreditAccessLimit';
import { calculateAccessFee, calculateRegistrationFee, calculateTotalPayable, calculateDailyPayment, REPAYMENT_PERIODS, formatUGX } from '@/lib/agentAdvanceCalculations';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Progress } from '@/components/ui/progress';
import { toast } from 'sonner';
import { Loader2, ArrowRight, Shield, Banknote, Calendar as CalendarIcon, FileText, Clock, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Briefcase } from 'lucide-react';
import { ChevronRight, ArrowLeft, History as HistoryIcon, Send, Filter, SlidersHorizontal, ArrowUp, ArrowDown, Activity, TrendingUp } from 'lucide-react';
import { Search, X } from 'lucide-react';
import { format, isWithinInterval, parseISO, startOfDay, endOfDay } from 'date-fns';
import { cn } from '@/lib/utils';
import { AdvanceTopupRequestPanel, useTopupEligibility } from '@/components/agent/AdvanceTopupRequestPanel';
import { useAgentAdvanceActivity } from '@/hooks/useAgentAdvanceActivity';
import { AdvanceActivityGateCard } from '@/components/agent/AdvanceActivityGateCard';

interface AgentAdvanceRequestFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const STATUS_CONFIG: Record<string, { label: string; icon: any; color: string }> = {
  pending: { label: 'Pending', icon: Clock, color: 'bg-orange-500' },
  agent_ops_approved: { label: 'Agent Ops ✓', icon: CheckCircle2, color: 'bg-blue-500' },
  tenant_ops_approved: { label: 'Tenant Ops ✓', icon: CheckCircle2, color: 'bg-indigo-500' },
  landlord_ops_approved: { label: 'Landlord Ops ✓', icon: CheckCircle2, color: 'bg-purple-500' },
  coo_approved: { label: 'COO Approved', icon: CheckCircle2, color: 'bg-emerald-500' },
  cfo_paid: { label: 'Paid', icon: CheckCircle2, color: 'bg-green-600' },
  rejected: { label: 'Rejected', icon: XCircle, color: 'bg-red-500' },
};

export function AgentAdvanceRequestForm({ open, onOpenChange }: AgentAdvanceRequestFormProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { limit, loading: limitLoading, refreshLimit } = useCreditAccessLimit(user?.id);
  // No field work recorded → no advance request (mirrors the DB trigger).
  const { activity, blocked: activityBlocked } = useAgentAdvanceActivity(user?.id);

  const [amount, setAmount] = useState('');
  const [cycleDays, setCycleDays] = useState<number>(30);
  const [reason, setReason] = useState('');
  const [allocOpen, setAllocOpen] = useState(false);
  const [view, setView] = useState<'menu' | 'history' | 'request' | 'topup'>('menu');
  // Post-submit confirmation shown inside the sheet (a toast alone is too easy to miss)
  const [submitted, setSubmitted] = useState<null | {
    principal: number;
    cycleDays: number;
    dailyPayment: number;
    totalPayable: number;
  }>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // History filters
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<'all' | 'repaid' | 'outstanding'>('all');
  const [amountMin, setAmountMin] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Sorting — persisted to localStorage across reloads
  const SORT_STORAGE_KEY = 'agent-advance-sort';
  const [sortBy, setSortBy] = useState<'date' | 'amount'>('date');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // Transaction-history filters (menu view)
  const [txSearch, setTxSearch] = useState('');
  const [txDateFrom, setTxDateFrom] = useState<Date | undefined>(undefined);
  const [txDateTo, setTxDateTo] = useState<Date | undefined>(undefined);
  const [txType, setTxType] = useState<'all' | 'in' | 'out'>('all');

  // Load persisted sort on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SORT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.sortBy === 'date' || parsed.sortBy === 'amount') {
          setSortBy(parsed.sortBy);
        }
        if (parsed.sortOrder === 'asc' || parsed.sortOrder === 'desc') {
          setSortOrder(parsed.sortOrder);
        }
      }
    } catch {
      // ignore corrupt storage
    }
  }, []);

  // Persist sort whenever it changes
  useEffect(() => {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify({ sortBy, sortOrder }));
  }, [sortBy, sortOrder]);

  // Always return to the menu when the sheet (re)opens.
  // NOTE: sort is NOT reset — it persists across sheet opens and reloads.
  useEffect(() => {
    if (open) {
      setView('menu');
      setSubmitted(null);
      setSubmitError(null);
      setDateFrom(undefined);
      setDateTo(undefined);
      setStatusFilter('all');
      setAmountMin('');
      setAmountMax('');
      setFiltersOpen(false);
    }
  }, [open]);

  // Always recompute the limit from latest data when the sheet opens so
  // recent allocations are reflected before the agent submits. The hero
  // card may already show a fresher value than the module cache.
  useEffect(() => {
    if (open) refreshLimit();
  }, [open, refreshLimit]);

  const principal = Math.max(0, parseInt(amount) || 0);

  // Tiered rate: 33% first advance, 28% on any advance after the agent has
  // FULLY REPAID at least one prior advance (status = 'completed').
  // Active / overdue / cancelled advances do NOT unlock the repeat rate.
  const { data: completedAdvanceCount = 0 } = useQuery({
    queryKey: ['my-completed-advance-count', user?.id],
    queryFn: async () => {
      if (!user?.id) return 0;
      const { count, error } = await supabase
        .from('agent_advances')
        .select('id', { count: 'exact', head: true })
        .eq('agent_id', user.id)
        .eq('status', 'completed');
      if (error) throw error;
      return count ?? 0;
    },
    enabled: !!user?.id && open,
  });
  const isRepeatBorrower = (completedAdvanceCount ?? 0) > 0;
  // Top-up eligibility — while an advance is running, the agent tops up
  // instead of taking a brand new advance.
  const { data: topupEligibility } = useTopupEligibility(user?.id, open);
  const hasActiveAdvance = !!topupEligibility?.has_active_advance;
  const monthlyRate = isRepeatBorrower ? 0.28 : 0.33;
  const accessFee = calculateAccessFee(principal, cycleDays, monthlyRate);
  const registrationFee = calculateRegistrationFee(principal);
  const totalPayable = calculateTotalPayable(principal, cycleDays, monthlyRate);
  const dailyPayment = calculateDailyPayment(principal, cycleDays, monthlyRate);
  const maxAmount = limit?.totalLimit || 0;
  const overLimit = principal > maxAmount;

  // Recent rent collections (each boosts the agent's advance limit by half
  // its amount, capped at 6M total — see recalculate_credit_limit).
  const ALLOC_MULTIPLIER = 0.5;
  const { data: recentAllocations = [] } = useQuery({
    queryKey: ['my-recent-allocations', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data, error } = await supabase
        .from('agent_collections')
        .select('id, amount, created_at, tenant_id, tenant:profiles!agent_collections_tenant_id_fkey(full_name)').is('reversed_at', null)
        .eq('agent_id', user.id)
        .order('created_at', { ascending: false })
        .limit(15);
      if (error) throw error;
      return data || [];
    },
    enabled: !!user?.id && open,
  });
  const allocBonus = limit?.bonusFromAgentAllocations || 0;
  const BASE_LIMIT = 20_000;
  const HARD_CAP = 9_000_000;

  // What actually raises an agent's advance limit, biggest driver first.
  // Sub-agents are ~70% of the limit; rent collection is significant; houses
  // listed and tenant rent requests each add on top.
  const breakdown = [
    { key: 'subagents', label: 'Active sub-agents', value: limit?.bonusFromSubagents || 0, source: 'biggest driver — +30,000 per active sub-agent (up to 3M)' },
    { key: 'collection', label: 'Rent you collect', value: allocBonus, source: '6% of the rent you collect (up to 2.4M)' },
    { key: 'rentRequests', label: 'Tenant rent requests', value: limit?.bonusFromRentHistory || 0, source: '+9,000 per rent request you raise (up to 1.5M)' },
    { key: 'promissory', label: 'Promissory notes', value: limit?.bonusFromPartnersOnboarded || 0, source: '+9,000 per activated note (up to 600K)' },
    { key: 'base', label: 'Starter base', value: BASE_LIMIT, source: 'every agent starts here' },
  ];
  const breakdownSum = breakdown.reduce((s, b) => s + b.value, 0);
  const isCapped = breakdownSum >= HARD_CAP;

  const { data: myRequests = [], isLoading: historyLoading } = useQuery({
    queryKey: ['my-advance-requests', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data, error } = await supabase
        .from('agent_advance_requests')
        .select('*')
        .eq('agent_id', user.id)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data || [];
    },
    enabled: !!user?.id,
  });

  // Every advance ever ISSUED to this agent, plus the day-by-day repayment
  // ledger so we can show exactly how each advance was paid back.
  const { data: issuedAdvances = [], isLoading: issuedLoading } = useQuery({
    queryKey: ['my-issued-advances-history', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data: advances, error } = await supabase
        .from('agent_advances')
        .select('id, principal, outstanding_balance, access_fee, registration_fee, cycle_days, status, issued_at, expires_at')
        .eq('agent_id', user.id)
        .order('issued_at', { ascending: false });
      if (error) throw error;
      const list = advances || [];
      if (list.length === 0) return [];
      const ids = list.map((a: any) => a.id);
      const { data: ledger } = await supabase
        .from('agent_advance_ledger')
        .select('advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance')
        .in('advance_id', ids)
        .order('date', { ascending: true });
      const byAdvance: Record<string, any[]> = {};
      (ledger || []).forEach((row: any) => {
        (byAdvance[row.advance_id] ||= []).push(row);
      });
      return list.map((a: any) => {
        const entries = byAdvance[a.id] || [];
        const totalRepaid = entries.reduce((s: number, e: any) => s + Number(e.amount_deducted || 0), 0);
        return { ...a, ledger: entries, totalRepaid };
      });
    },
    enabled: !!user?.id,
  });

  // Filtered & sorted advances for the history view
  const filteredAdvances = useMemo(() => {
    if (!issuedAdvances.length) return [];
    const filtered = issuedAdvances.filter((adv: any) => {
      const outstanding = Number(adv.outstanding_balance || 0);
      const isDone = adv.status === 'completed' || outstanding <= 0;
      const principal = Number(adv.principal || 0);
      const issuedDate = adv.issued_at ? parseISO(adv.issued_at) : null;

      // Status filter
      if (statusFilter === 'repaid' && !isDone) return false;
      if (statusFilter === 'outstanding' && isDone) return false;

      // Amount filter
      const min = amountMin ? parseInt(amountMin) : 0;
      const max = amountMax ? parseInt(amountMax) : Infinity;
      if (principal < min || principal > max) return false;

      // Date range filter
      if (dateFrom && issuedDate) {
        if (issuedDate < startOfDay(dateFrom)) return false;
      }
      if (dateTo && issuedDate) {
        if (issuedDate > endOfDay(dateTo)) return false;
      }

      return true;
    });

    return [...filtered].sort((a: any, b: any) => {
      const dir = sortOrder === 'asc' ? 1 : -1;
      if (sortBy === 'date') {
        const da = a.issued_at ? new Date(a.issued_at).getTime() : 0;
        const db = b.issued_at ? new Date(b.issued_at).getTime() : 0;
        return (da - db) * dir;
      }
      // amount
      const pa = Number(a.principal || 0);
      const pb = Number(b.principal || 0);
      return (pa - pb) * dir;
    });
  }, [issuedAdvances, statusFilter, amountMin, amountMax, dateFrom, dateTo, sortBy, sortOrder]);

  const activeFilterCount = [
    dateFrom || dateTo,
    statusFilter !== 'all',
    amountMin || amountMax,
  ].filter(Boolean).length;

  // ── Advance performance ────────────────────────────────────────────────
  // How every advance the agent has taken is actually performing: repayment
  // progress vs. the schedule, and whether each is on track, behind or done.
  const performance = useMemo(() => {
    let borrowed = 0;
    let repaid = 0;
    let outstanding = 0;
    let totalPayableAll = 0;
    let active = 0;
    let overdue = 0;
    let completed = 0;
    let behind = 0;

    const byId: Record<string, { progress: number; expectedPct: number; onTrack: boolean; isDone: boolean }> = {};

    for (const adv of issuedAdvances as any[]) {
      const principal = Number(adv.principal || 0);
      const totalPayable = principal + Number(adv.access_fee || 0) + Number(adv.registration_fee || 0);
      const paid = Number(adv.totalRepaid || 0);
      const out = Number(adv.outstanding_balance || 0);
      const isDone = adv.status === 'completed' || out <= 0;
      const progress = isDone ? 100 : (totalPayable > 0 ? Math.min(100, Math.round((paid / totalPayable) * 100)) : 0);

      // Expected progress purely from elapsed time within the term.
      const issued = adv.issued_at ? new Date(adv.issued_at).getTime() : null;
      const cycle = Math.max(1, Number(adv.cycle_days || 30));
      let expectedPct = 0;
      let onTrack = true;
      if (issued && !isDone) {
        const daysElapsed = Math.max(0, (Date.now() - issued) / 86_400_000);
        expectedPct = Math.min(100, Math.round((daysElapsed / cycle) * 100));
        onTrack = progress >= expectedPct - 10; // 10% grace before flagged "behind"
      }

      borrowed += principal;
      repaid += paid;
      totalPayableAll += totalPayable;
      if (isDone) {
        completed++;
      } else {
        outstanding += out;
        if (adv.status === 'overdue') overdue++;
        else active++;
        if (!onTrack) behind++;
      }

      byId[adv.id] = { progress, expectedPct, onTrack, isDone };
    }

    const overallPct = totalPayableAll > 0 ? Math.min(100, Math.round((repaid / totalPayableAll) * 100)) : 0;
    return { borrowed, repaid, outstanding, overallPct, active, overdue, completed, behind, byId, count: (issuedAdvances as any[]).length };
  }, [issuedAdvances]);

  // ── Full transaction history ────────────────────────────────────────────
  // Every cash-in (advance received) and cash-out (repayment deducted) line,
  // flattened from every advance's repayment ledger, newest first.
  const txHistory = useMemo(() => {
    const rows: {
      key: string;
      date: string;
      type: 'in' | 'out';
      label: string;
      amount: number;
      balance: number | null;
    }[] = [];
    for (const adv of issuedAdvances as any[]) {
      // Cash-in: the advance principal disbursed to the agent.
      if (adv.issued_at) {
        rows.push({
          key: `${adv.id}-issue`,
          date: adv.issued_at,
          type: 'in',
          label: 'Advance received',
          amount: Number(adv.principal || 0),
          balance: null,
        });
      }
      // Cash-out: each daily repayment deducted from the wallet.
      for (const e of (adv.ledger || []) as any[]) {
        const deducted = Number(e.amount_deducted || 0);
        if (deducted > 0) {
          rows.push({
            key: `${adv.id}-${e.date}`,
            date: e.date,
            type: 'out',
            label: 'Repayment deducted',
            amount: deducted,
            balance: e.closing_balance != null ? Number(e.closing_balance) : null,
          });
        }
      }
    }
    return rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [issuedAdvances]);

  // Apply search / date-range / type filters to the transaction history.
  const filteredTxHistory = useMemo(() => {
    const q = txSearch.trim().toLowerCase();
    return txHistory.filter((tx) => {
      if (txType !== 'all' && tx.type !== txType) return false;
      const d = new Date(tx.date);
      if (txDateFrom && d < startOfDay(txDateFrom)) return false;
      if (txDateTo && d > endOfDay(txDateTo)) return false;
      if (q) {
        const haystack = [
          tx.label,
          tx.type === 'in' ? 'received cash in' : 'repayment cash out',
          String(tx.amount),
          format(d, 'dd MMM yyyy'),
        ].join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [txHistory, txSearch, txDateFrom, txDateTo, txType]);

  const txFilterActive = !!(txSearch.trim() || txDateFrom || txDateTo || txType !== 'all');

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error('Not authenticated');
      if (principal <= 0) throw new Error('Amount must be greater than zero');
      const latestLimit = await refreshLimit();
      const latestMaxAmount = latestLimit?.totalLimit ?? maxAmount;
      if (principal > latestMaxAmount) throw new Error(`Amount exceeds your credit limit of ${formatUGX(latestMaxAmount)}`);
      if (reason.trim().length < 10) throw new Error('Reason must be at least 10 characters');

      // Check for existing pending requests
      const { data: existing } = await supabase
        .from('agent_advance_requests')
        .select('id')
        .eq('agent_id', user.id)
        .in('status', ['pending', 'agent_ops_approved', 'tenant_ops_approved', 'landlord_ops_approved', 'coo_approved'])
        .limit(1);
      if (existing && existing.length > 0) throw new Error('You already have a pending advance request');

      // Block new requests while any active/overdue advance is still outstanding
      const { data: activeAdvances } = await supabase
        .from('agent_advances')
        .select('id, outstanding_balance, status')
        .eq('agent_id', user.id)
        .in('status', ['active', 'overdue'])
        .gt('outstanding_balance', 0)
        .limit(1);
      if (activeAdvances && activeAdvances.length > 0) {
        throw new Error('You already have an ongoing advance. Repay it in full before requesting a new one.');
      }

      const { error } = await supabase.from('agent_advance_requests').insert({
        agent_id: user.id,
        principal,
        cycle_days: cycleDays,
        monthly_rate: monthlyRate,
        access_fee: accessFee,
        registration_fee: registrationFee,
        total_payable: totalPayable,
        daily_payment: dailyPayment,
        reason: reason.trim(),
        status: 'pending',
      });
      if (error) throw error;
    },
    onMutate: () => {
      setSubmitError(null);
    },
    onSuccess: () => {
      setSubmitted({ principal, cycleDays, dailyPayment, totalPayable });
      toast.success('Advance request submitted for review');
      setAmount('');
      setReason('');
      setCycleDays(30);
      queryClient.invalidateQueries({ queryKey: ['my-advance-requests'] });
    },
    onError: (err: Error) => {
      const raw = err.message || 'Request failed';
      const msg = raw
        .replace(/^.*DUPLICATE_ACCOUNT_BLOCKED:\s*/, '')
        .replace(/^.*ADVANCE_NO_ACTIVITY:\s*/, '');
      setSubmitError(msg);
      toast.error(msg, { duration: raw === msg ? 6000 : 12000 });
    },

  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="advance-request-sheet h-[92vh] overflow-y-auto rounded-t-2xl px-4 pb-6 pt-5">
        {/* Hero — clear, professional, minimalist value proposition */}
        <div className="mb-5 relative w-full overflow-hidden rounded-3xl border border-primary/30 bg-gradient-to-br from-card via-card to-primary/10 p-5 text-card-foreground shadow-lg ring-1 ring-primary/20">
          <div className="relative">
            <div className="flex items-center gap-2">
              <div className="rounded-full bg-primary/15 p-1.5 text-primary">
                <Briefcase className="h-4 w-4" strokeWidth={2.2} />
              </div>
              <span className="text-[10px] font-bold uppercase tracking-widest text-primary">Agent Advance</span>
            </div>
            <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">You can access now</p>
            <p className="mt-1 text-3xl font-black leading-none text-primary whitespace-pre-line">
              {formatCreditAmount(limit?.totalLimit || 20000)}
            </p>
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-bold text-primary">
              <TrendingUp className="h-3.5 w-3.5" strokeWidth={2.4} />
              Grow up to UGX 9,000,000 as you perform better
            </div>
            <p className="mt-2 text-[13px] font-medium text-foreground leading-snug">
              Cash straight to your wallet · repay over up to 12 months. Clear it early to unlock a bigger advance.
            </p>
          </div>
        </div>

        {/* Landing menu — two clear, simple choices */}
        {view === 'menu' && (
          <div className="space-y-3">
            {/* My advance snapshot — the agent's own current advance details,
                visible immediately when they open the advance page. */}
            {!issuedLoading && performance.count > 0 && (
              <div className="rounded-2xl border border-border/60 bg-card p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="rounded-xl bg-primary/10 p-2">
                      <Banknote className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-foreground leading-none">My advance</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">Your own advance details</p>
                    </div>
                  </div>
                  {performance.behind > 0 ? (
                    <Badge variant="destructive" className="gap-1 text-[10px]">
                      <AlertTriangle className="h-3 w-3" /> {performance.behind} behind
                    </Badge>
                  ) : performance.outstanding > 0 ? (
                    <Badge className="gap-1 text-[10px] bg-emerald-600">On track</Badge>
                  ) : (
                    <Badge variant="secondary" className="gap-1 text-[10px]">
                      <CheckCircle2 className="h-3 w-3" /> All repaid
                    </Badge>
                  )}
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-muted/40 py-2">
                    <p className="text-[9px] uppercase tracking-wider font-bold text-muted-foreground">Borrowed</p>
                    <p className="text-xs font-bold text-foreground tabular-nums mt-0.5">{formatUGX(performance.borrowed)}</p>
                  </div>
                  <div className="rounded-xl bg-muted/40 py-2">
                    <p className="text-[9px] uppercase tracking-wider font-bold text-muted-foreground">Repaid</p>
                    <p className="text-xs font-bold text-emerald-600 tabular-nums mt-0.5">{formatUGX(performance.repaid)}</p>
                  </div>
                  <div className="rounded-xl bg-muted/40 py-2">
                    <p className="text-[9px] uppercase tracking-wider font-bold text-muted-foreground">Outstanding</p>
                    <p className="text-xs font-bold text-amber-600 tabular-nums mt-0.5">{formatUGX(performance.outstanding)}</p>
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Repayment progress</span>
                  <span className="text-foreground tabular-nums">{performance.overallPct}%</span>
                </div>
                <Progress value={performance.overallPct} className="h-2 mt-1" />

                <div className="mt-2 flex items-center gap-3 text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500" /> {performance.active} repaying</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-500" /> {performance.overdue} overdue</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> {performance.completed} repaid</span>
                </div>

                <button
                  type="button"
                  onClick={() => setView('history')}
                  className="mt-3 w-full text-center text-[11px] font-semibold text-primary"
                >
                  See full breakdown →
                </button>
              </div>
            )}

            {/* Full transaction history — every cash-in / cash-out line */}
            {!issuedLoading && txHistory.length > 0 && (
              <div className="rounded-2xl border border-border/60 bg-card p-4">
                <div className="flex items-center gap-2 mb-3">
                  <div className="rounded-xl bg-primary/10 p-2">
                    <Activity className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-foreground leading-none">Transaction history</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Every advance received & repayment</p>
                  </div>
                </div>

                {/* Filters: search, type, date range */}
                <div className="space-y-2 mb-3">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={txSearch}
                      onChange={(e) => setTxSearch(e.target.value)}
                      placeholder="Search amount, date or type…"
                      className="h-9 pl-8 pr-8 text-xs"
                    />
                    {txSearch && (
                      <button
                        type="button"
                        onClick={() => setTxSearch('')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(['all', 'in', 'out'] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setTxType(t)}
                        className={cn(
                          'rounded-full px-3 py-1 text-[11px] font-semibold transition-colors',
                          txType === t ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                        )}
                      >
                        {t === 'all' ? 'All' : t === 'in' ? 'Cash in' : 'Cash out'}
                      </button>
                    ))}
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" size="sm" className={cn('h-7 gap-1 text-[11px] px-2', !txDateFrom && 'text-muted-foreground')}>
                          <CalendarIcon className="h-3 w-3" />
                          {txDateFrom ? format(txDateFrom, 'dd MMM') : 'From'}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar mode="single" selected={txDateFrom} onSelect={setTxDateFrom} initialFocus className="p-3 pointer-events-auto" />
                      </PopoverContent>
                    </Popover>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" size="sm" className={cn('h-7 gap-1 text-[11px] px-2', !txDateTo && 'text-muted-foreground')}>
                          <CalendarIcon className="h-3 w-3" />
                          {txDateTo ? format(txDateTo, 'dd MMM') : 'To'}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar mode="single" selected={txDateTo} onSelect={setTxDateTo} initialFocus className="p-3 pointer-events-auto" />
                      </PopoverContent>
                    </Popover>
                    {txFilterActive && (
                      <button
                        type="button"
                        onClick={() => { setTxSearch(''); setTxDateFrom(undefined); setTxDateTo(undefined); setTxType('all'); }}
                        className="flex items-center gap-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" /> Clear
                      </button>
                    )}
                  </div>
                  {txFilterActive && (
                    <p className="text-[10px] text-muted-foreground">
                      Showing {filteredTxHistory.length} of {txHistory.length} transactions
                    </p>
                  )}
                </div>

                {filteredTxHistory.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-4 text-center">No transactions match your filters.</p>
                ) : (
                <div className="divide-y divide-border/50">
                  {filteredTxHistory.map((tx) => (
                    <div key={tx.key} className="flex items-center gap-3 py-2.5">
                      <div className={cn(
                        'rounded-full p-1.5 shrink-0',
                        tx.type === 'in' ? 'bg-emerald-500/15' : 'bg-red-500/15',
                      )}>
                        {tx.type === 'in'
                          ? <ArrowDown className="h-3.5 w-3.5 text-emerald-600" />
                          : <ArrowUp className="h-3.5 w-3.5 text-red-500" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-foreground truncate">{tx.label}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {format(new Date(tx.date), 'dd MMM yyyy')}
                          {tx.balance != null && ` · Balance ${formatUGX(tx.balance)}`}
                        </p>
                      </div>
                      <p className={cn(
                        'text-xs font-bold tabular-nums shrink-0',
                        tx.type === 'in' ? 'text-emerald-600' : 'text-red-500',
                      )}>
                        {tx.type === 'in' ? '+' : '−'}{formatUGX(tx.amount)}
                      </p>
                    </div>
                  ))}
                </div>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => setView('history')}
              className="w-full flex items-center gap-4 rounded-2xl border border-border/60 bg-card p-4 text-left transition-all active:scale-[0.98] hover:border-primary/40"
            >
              <div className="rounded-2xl bg-primary/10 p-3 shrink-0">
                <HistoryIcon className="h-6 w-6 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-base font-bold text-foreground">How my advances are performing</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                  Track every advance you've taken — repayment progress, what's on track and what's behind.
                </p>
                <p className="text-[11px] font-semibold text-primary mt-1">
                  {issuedLoading ? 'Loading…' : `${issuedAdvances.length} advance${issuedAdvances.length === 1 ? '' : 's'} taken`}
                </p>
              </div>
              <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
            </button>

            {activityBlocked && !hasActiveAdvance ? (
              <AdvanceActivityGateCard activity={activity} />
            ) : (
            <button
              type="button"
              onClick={() => setView(hasActiveAdvance ? 'topup' : 'request')}
              className="w-full flex items-center gap-4 rounded-2xl border border-border/60 bg-card p-4 text-left transition-all active:scale-[0.98] hover:border-primary/40"
            >
              <div className="rounded-2xl bg-primary/10 p-3 shrink-0">
                <Send className="h-6 w-6 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-base font-bold text-foreground">
                  {hasActiveAdvance ? 'Request a top-up on your advance' : 'Request a new advance'}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                  {hasActiveAdvance
                    ? 'Add more funds to your running advance once you have repaid at least 30% — same rate, schedule extended.'
                    : 'Apply for funds and submit your request to the CFO for approval.'}
                </p>
                <p className="text-[11px] font-semibold text-primary mt-1">Submit to CFO →</p>
              </div>
              <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
            </button>
            )}
          </div>
        )}

        {view === 'topup' && (
          <AdvanceTopupRequestPanel onSubmitted={() => setView('menu')} />
        )}

        {/* Back to menu */}
        {view !== 'menu' && (
          <button
            type="button"
            onClick={() => setView('menu')}
            className="mb-3 flex items-center gap-1.5 text-xs font-bold text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
        )}

        {view === 'request' && activityBlocked && (
          <AdvanceActivityGateCard activity={activity} className="mb-4" />
        )}

        {view === 'request' && !activityBlocked && (
        <>

        {/* Credit limit indicator */}
        <div className="rounded-2xl bg-muted/50 p-3 mb-4">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-primary/15 p-2 shrink-0">
              <Shield className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Your Credit Limit</p>
              <p className="text-lg font-bold text-foreground whitespace-pre-line">
                {limitLoading ? '...' : formatCreditAmount(maxAmount)}
              </p>
              {allocBonus > 0 && (
                <p className="text-[10px] text-emerald-600 font-semibold mt-0.5">
                  +{formatUGX(allocBonus)} earned from rent you collected
                </p>
              )}
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              <button
                type="button"
                onClick={() => setAllocOpen(o => !o)}
                className="text-[10px] font-bold uppercase tracking-wider text-primary hover:underline"
              >
                {allocOpen ? 'Hide' : 'See how'}
              </button>
              <button
                type="button"
                onClick={() => refreshLimit()}
                className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1"
                title="Recalculate from latest data"
              >
                <RefreshCw className={cn('h-3 w-3', limitLoading && 'animate-spin')} /> Refresh
              </button>
            </div>
          </div>

          {allocOpen && (
            <div className="mt-3 pt-3 border-t border-dashed border-border space-y-2">
              {/* Full breakdown — must add up to the displayed credit limit */}
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                How your {formatUGX(maxAmount)} limit is built
              </p>
              <div className="space-y-1 rounded-xl bg-background/70 p-2.5">
                {breakdown.map(b => (
                  <div key={b.key} className="flex items-start justify-between gap-3 py-0.5">
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold text-foreground truncate">{b.label}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{b.source}</p>
                    </div>
                    <span className={cn(
                      'text-[11px] font-bold tabular-nums shrink-0',
                      b.value > 0 ? 'text-emerald-600' : 'text-muted-foreground',
                    )}>
                      {b.value > 0 ? '+' : ''}{formatUGX(b.value)}
                    </span>
                  </div>
                ))}
                <Separator className="my-1" />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-bold text-foreground">Total</span>
                  <span className="text-sm font-bold text-primary tabular-nums">
                    {formatUGX(Math.min(breakdownSum, HARD_CAP))}
                  </span>
                </div>
                {breakdownSum !== maxAmount && (
                  <p className="text-[10px] text-amber-600 mt-1">
                    Shown limit is {formatUGX(maxAmount)}. Tap Refresh to recompute — recent allocations may not be counted yet.
                  </p>
                )}
                {isCapped && (
                  <p className="text-[10px] text-muted-foreground mt-1">
                    You've hit the {formatUGX(HARD_CAP)} maximum credit limit.
                  </p>
                )}
              </div>

              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground pt-2">
                Recent rent collections
              </p>
              <p className="text-[10px] text-muted-foreground leading-snug">
                Each collection adds <span className="font-bold text-foreground">half the amount</span> to your limit. The biggest driver of your limit is your <span className="font-bold text-foreground">active sub-agents</span>.
              </p>
              {recentAllocations.length === 0 ? (
                <p className="text-[11px] text-muted-foreground text-center py-3">
                  No collections yet. Collect rent and recruit sub-agents to grow your limit.
                </p>
              ) : (
                <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                  {recentAllocations.map((a: any) => {
                    const added = Number(a.amount) * ALLOC_MULTIPLIER;
                    const tenantName = a.tenant?.full_name || 'Tenant';
                    return (
                      <div
                        key={a.id}
                        className="flex items-center justify-between gap-2 rounded-lg bg-background/70 px-2.5 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] font-semibold text-foreground truncate">
                            {tenantName}
                          </p>
                          <p className="text-[10px] text-muted-foreground">
                            {formatUGX(Number(a.amount))} · {format(new Date(a.created_at), 'MMM d')}
                          </p>
                        </div>
                        <span className="text-[11px] font-bold text-emerald-600 tabular-nums shrink-0">
                          +{formatUGX(added)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Submitted — clear confirmation of what happens next */}
        {submitted && (
          <div className="mb-4 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4 space-y-3">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-emerald-500/20 p-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-bold text-foreground">Request received</p>
                <p className="text-xs text-muted-foreground leading-snug">
                  We are reviewing your request for {formatUGX(submitted.principal)}. You will get an SMS as soon as it is approved.
                </p>
              </div>
            </div>
            <div className="space-y-1.5 rounded-xl bg-background/80 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Amount requested</span>
                <span className="text-sm font-bold text-foreground">{formatUGX(submitted.principal)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Repayment period</span>
                <span className="text-sm font-bold text-foreground">{submitted.cycleDays} days</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Daily repayment</span>
                <span className="text-sm font-bold text-primary">{formatUGX(submitted.dailyPayment)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Total to repay</span>
                <span className="text-sm font-bold text-foreground">{formatUGX(submitted.totalPayable)}</span>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground leading-snug">
              Reviewed by Agent Ops, then Operations, then Finance. Keep collecting rent while you wait — it strengthens your request.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                variant="outline"
                className="w-full rounded-full"
                onClick={() => { setSubmitted(null); setView('history'); }}
              >
                <HistoryIcon className="mr-2 h-4 w-4" /> Track my requests
              </Button>
              <Button className="w-full rounded-full" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </div>
          </div>
        )}

        {/* Form */}
        {!submitted && (
        <div className="rounded-2xl bg-muted/50 p-4 space-y-4 mb-4">

          {/* Amount */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Amount (UGX)</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground">UGX</span>
              <Input
                type="number"
                placeholder="0"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                min="1"
                max={maxAmount}
                className={cn("pl-12 bg-background border-0 rounded-xl h-12 text-base font-semibold", overLimit && "ring-2 ring-red-500")}
              />
            </div>
            {overLimit && (
              <p className="text-[10px] text-red-500 font-semibold flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> Exceeds credit limit
              </p>
            )}
          </div>

          {/* Repayment Period */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Repayment Period</label>
            <div className="grid grid-cols-5 gap-1.5">
              {REPAYMENT_PERIODS.map(d => (
                <button
                  key={d}
                  onClick={() => setCycleDays(d)}
                  className={cn(
                    "py-2.5 rounded-xl text-xs font-bold transition-all",
                    cycleDays === d
                      ? "bg-primary text-primary-foreground shadow-md"
                      : "bg-background text-muted-foreground hover:bg-muted"
                  )}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>

          {/* Reason */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Reason</label>
            <Textarea
              placeholder="Why do you need this advance? (min 10 characters)"
              value={reason}
              onChange={e => setReason(e.target.value)}
              maxLength={250}
              rows={3}
              className="bg-background border-0 rounded-xl text-sm"
            />
          </div>

          {/* Breakdown — agent sees only what they need to know */}
          {principal > 0 && (
            <div className="space-y-3 p-4 rounded-xl bg-background/80">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Repayment Period</span>
                <span className="text-sm font-bold text-foreground">{cycleDays} days</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  Access Fee Rate {isRepeatBorrower ? '(repeat)' : '(first advance)'}
                </span>
                <span className="text-sm font-bold text-foreground">
                  {Math.round(monthlyRate * 100)}% / month
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Daily Repayment</span>
                <span className="text-sm font-bold text-primary">{formatUGX(dailyPayment)}</span>
              </div>
              {!isRepeatBorrower && (
                <p className="text-[10px] text-muted-foreground leading-snug">
                  Fully repay this advance to unlock the 28% repeat-borrower rate on your next advance.
                </p>
              )}
            </div>
          )}

          {submitError && (
            <div className="flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
              <p className="text-xs font-medium leading-snug text-red-600">{submitError}</p>
            </div>
          )}

          {/* Submit */}
          <Button
            className="w-full gap-2 bg-gradient-to-r from-purple-600 via-purple-500 to-pink-500 text-white rounded-full py-6 text-base font-semibold shadow-lg hover:opacity-90"
            onClick={() => submitMutation.mutate()}
            disabled={submitMutation.isPending}
          >
            {submitMutation.isPending ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Sending your request…</>
            ) : (
              <>Submit Request <ArrowRight className="h-4 w-4" /></>
            )}
          </Button>
        </div>
        )}


        </>
        )}

        {view === 'history' && (
        <div className="space-y-5">
          {/* Performance overview — how the advances taken are performing */}
          {!issuedLoading && performance.count > 0 && (
            <div className="rounded-2xl bg-gradient-to-br from-primary/10 via-primary/5 to-transparent border border-primary/20 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="rounded-full bg-primary/15 p-1.5">
                    <Activity className="h-4 w-4 text-primary" />
                  </div>
                  <p className="text-sm font-bold text-foreground">Advance performance</p>
                </div>
                {performance.behind > 0 ? (
                  <Badge className="text-[10px] font-bold border-0 bg-red-500 text-white gap-1">
                    <AlertTriangle className="h-3 w-3" /> {performance.behind} behind
                  </Badge>
                ) : performance.outstanding > 0 ? (
                  <Badge className="text-[10px] font-bold border-0 bg-emerald-500 text-white gap-1">
                    <TrendingUp className="h-3 w-3" /> On track
                  </Badge>
                ) : (
                  <Badge className="text-[10px] font-bold border-0 bg-emerald-500 text-white gap-1">
                    <CheckCircle2 className="h-3 w-3" /> All repaid
                  </Badge>
                )}
              </div>

              {/* Overall repayment progress */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[11px] font-semibold">
                  <span className="text-muted-foreground">Overall repaid</span>
                  <span className="text-foreground tabular-nums">{performance.overallPct}%</span>
                </div>
                <Progress value={performance.overallPct} className="h-2" />
              </div>

              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-background/70 py-2">
                  <p className="text-[9px] uppercase tracking-wider font-bold text-muted-foreground">Borrowed</p>
                  <p className="text-xs font-bold text-foreground tabular-nums">{formatUGX(performance.borrowed)}</p>
                </div>
                <div className="rounded-xl bg-background/70 py-2">
                  <p className="text-[9px] uppercase tracking-wider font-bold text-muted-foreground">Repaid</p>
                  <p className="text-xs font-bold text-emerald-600 tabular-nums">{formatUGX(performance.repaid)}</p>
                </div>
                <div className="rounded-xl bg-background/70 py-2">
                  <p className="text-[9px] uppercase tracking-wider font-bold text-muted-foreground">Outstanding</p>
                  <p className="text-xs font-bold text-amber-600 tabular-nums">{formatUGX(performance.outstanding)}</p>
                </div>
              </div>

              <div className="flex items-center justify-center gap-4 text-[10px] font-semibold text-muted-foreground">
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500" /> {performance.active} repaying</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-500" /> {performance.overdue} overdue</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> {performance.completed} repaid</span>
              </div>
            </div>
          )}

          {/* Header with filter */}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Advances taken</h3>
              <p className="text-xs text-muted-foreground">
                {activeFilterCount > 0
                  ? `${filteredAdvances.length} of ${issuedAdvances.length} shown`
                  : `${issuedAdvances.length} advance${issuedAdvances.length === 1 ? '' : 's'}`}
              </p>
            </div>
            {issuedAdvances.length > 0 && (
              <button
                type="button"
                onClick={() => setFiltersOpen(o => !o)}
                className={cn(
                  "flex items-center gap-1.5 rounded-xl px-3 py-2 text-[11px] font-bold transition-all",
                  activeFilterCount > 0
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                )}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Filter
                {activeFilterCount > 0 && (
                  <span className="rounded-full bg-white/20 px-1.5 py-0 text-[9px] font-bold">{activeFilterCount}</span>
                )}
              </button>
            )}
          </div>

          {/* Sort by clickable column headers */}
          {issuedAdvances.length > 0 && (
            <div className="flex items-center gap-4 -mt-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Sort by</span>
              <button
                type="button"
                onClick={() => {
                  if (sortBy === 'date') {
                    setSortOrder(o => o === 'asc' ? 'desc' : 'asc');
                  } else {
                    setSortBy('date');
                    setSortOrder('desc');
                  }
                }}
                className={cn(
                  "flex items-center gap-1 text-[11px] font-bold transition-all",
                  sortBy === 'date' ? "text-primary" : "text-muted-foreground hover:text-foreground"
                )}
              >
                Date
                {sortBy === 'date' && (
                  sortOrder === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (sortBy === 'amount') {
                    setSortOrder(o => o === 'asc' ? 'desc' : 'asc');
                  } else {
                    setSortBy('amount');
                    setSortOrder('desc');
                  }
                }}
                className={cn(
                  "flex items-center gap-1 text-[11px] font-bold transition-all",
                  sortBy === 'amount' ? "text-primary" : "text-muted-foreground hover:text-foreground"
                )}
              >
                Amount
                {sortBy === 'amount' && (
                  sortOrder === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                )}
              </button>
            </div>
          )}

          {/* Filter panel */}
          {filtersOpen && issuedAdvances.length > 0 && (
            <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-4">
              {/* Status chips */}
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Status</label>
                <div className="flex gap-2">
                  {([
                    { key: 'all', label: 'All' },
                    { key: 'repaid', label: 'Fully repaid' },
                    { key: 'outstanding', label: 'Outstanding' },
                  ] as const).map(s => (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => setStatusFilter(s.key)}
                      className={cn(
                        "rounded-lg px-3 py-1.5 text-[11px] font-bold transition-all",
                        statusFilter === s.key
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "bg-muted/60 text-muted-foreground hover:bg-muted"
                      )}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Date range */}
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Date range</label>
                <div className="flex items-center gap-2">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className={cn(
                          "w-full justify-start text-left font-normal rounded-xl h-10 text-xs",
                          !dateFrom && "text-muted-foreground"
                        )}
                      >
                        <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                        {dateFrom ? format(dateFrom, 'MMM d, yyyy') : 'From'}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={dateFrom}
                        onSelect={setDateFrom}
                        initialFocus
                        className={cn("p-3 pointer-events-auto")}
                      />
                    </PopoverContent>
                  </Popover>
                  <span className="text-muted-foreground text-xs">to</span>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className={cn(
                          "w-full justify-start text-left font-normal rounded-xl h-10 text-xs",
                          !dateTo && "text-muted-foreground"
                        )}
                      >
                        <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                        {dateTo ? format(dateTo, 'MMM d, yyyy') : 'To'}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={dateTo}
                        onSelect={setDateTo}
                        initialFocus
                        className={cn("p-3 pointer-events-auto")}
                      />
                    </PopoverContent>
                  </Popover>
                </div>
              </div>

              {/* Amount range */}
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Amount (UGX)</label>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[10px] font-bold text-muted-foreground">MIN</span>
                    <Input
                      type="number"
                      placeholder="0"
                      value={amountMin}
                      onChange={e => setAmountMin(e.target.value)}
                      className="pl-10 bg-muted/40 border-0 rounded-xl h-10 text-xs font-semibold"
                    />
                  </div>
                  <span className="text-muted-foreground text-xs">–</span>
                  <div className="relative flex-1">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[10px] font-bold text-muted-foreground">MAX</span>
                    <Input
                      type="number"
                      placeholder="∞"
                      value={amountMax}
                      onChange={e => setAmountMax(e.target.value)}
                      className="pl-11 bg-muted/40 border-0 rounded-xl h-10 text-xs font-semibold"
                    />
                  </div>
                </div>
              </div>

              {/* Clear filters */}
              {activeFilterCount > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setDateFrom(undefined);
                    setDateTo(undefined);
                    setStatusFilter('all');
                    setAmountMin('');
                    setAmountMax('');
                  }}
                  className="text-[11px] font-bold text-primary hover:underline"
                >
                  Clear all filters
                </button>
              )}
            </div>
          )}

          {/* Results */}
          {issuedLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : issuedAdvances.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No advances taken yet</p>
          ) : filteredAdvances.length === 0 ? (
            <div className="text-center py-8 space-y-2">
              <Filter className="h-6 w-6 text-muted-foreground mx-auto" />
              <p className="text-sm text-muted-foreground">No advances match your filters</p>
              <button
                type="button"
                onClick={() => {
                  setDateFrom(undefined);
                  setDateTo(undefined);
                  setStatusFilter('all');
                  setAmountMin('');
                  setAmountMax('');
                }}
                className="text-[11px] font-bold text-primary hover:underline"
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredAdvances.map((adv: any) => {
                const repaidEntries = (adv.ledger || []).filter((e: any) => Number(e.amount_deducted || 0) > 0);
                const outstanding = Number(adv.outstanding_balance || 0);
                const isDone = adv.status === 'completed' || outstanding <= 0;
                const perf = performance.byId[adv.id];
                return (
                  <div key={adv.id} className="rounded-2xl border border-border/60 bg-card p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-base font-bold text-foreground tabular-nums">{formatUGX(Number(adv.principal))}</p>
                        <p className="text-[11px] text-muted-foreground">
                          Taken {format(new Date(adv.issued_at), 'MMM d, yyyy')} · {adv.cycle_days}d term
                        </p>
                      </div>
                      <Badge className={cn(
                        'text-[10px] font-bold border-0',
                        isDone ? 'bg-emerald-500 text-white' : adv.status === 'overdue' ? 'bg-red-500 text-white' : 'bg-amber-500 text-white',
                      )}>
                        {isDone ? 'Fully repaid' : adv.status === 'overdue' ? 'Overdue' : 'Repaying'}
                      </Badge>
                    </div>

                    {/* Repayment progress vs schedule */}
                    {perf && (
                      <div className="mt-3 space-y-1.5">
                        <div className="flex items-center justify-between text-[10px] font-semibold">
                          <span className="text-muted-foreground">{perf.progress}% repaid</span>
                          {!isDone && (
                            perf.onTrack ? (
                              <span className="flex items-center gap-1 text-emerald-600">
                                <TrendingUp className="h-3 w-3" /> On track
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 text-red-500">
                                <AlertTriangle className="h-3 w-3" /> Behind schedule
                              </span>
                            )
                          )}
                        </div>
                        <Progress
                          value={perf.progress}
                          className={cn('h-1.5', !isDone && !perf.onTrack && '[&>div]:bg-red-500')}
                        />
                        {!isDone && perf.expectedPct > 0 && (
                          <p className="text-[9px] text-muted-foreground">
                            Expected {perf.expectedPct}% by now based on the {adv.cycle_days}-day term
                          </p>
                        )}
                      </div>
                    )}

                    <div className="grid grid-cols-3 gap-2 mt-3 text-center">
                      <div className="rounded-xl bg-muted/40 py-2">
                        <p className="text-[9px] uppercase tracking-wider font-bold text-muted-foreground">Repaid</p>
                        <p className="text-xs font-bold text-emerald-600 tabular-nums">{formatUGX(adv.totalRepaid)}</p>
                      </div>
                      <div className="rounded-xl bg-muted/40 py-2">
                        <p className="text-[9px] uppercase tracking-wider font-bold text-muted-foreground">Outstanding</p>
                        <p className="text-xs font-bold tabular-nums">{formatUGX(outstanding)}</p>
                      </div>
                      <div className="rounded-xl bg-muted/40 py-2">
                        <p className="text-[9px] uppercase tracking-wider font-bold text-muted-foreground">Daily</p>
                        <p className="text-xs font-bold text-primary tabular-nums">
                          {formatUGX(Math.round((Number(adv.principal || 0) + Number(adv.access_fee || 0) + Number(adv.registration_fee || 0)) / Math.max(1, Number(adv.cycle_days || 30))))}
                        </p>
                      </div>
                    </div>

                    {repaidEntries.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-dashed border-border">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
                          Repayment breakdown
                        </p>
                        {/* Column headers so it reads at a glance */}
                        <div className="grid grid-cols-3 gap-2 px-1 pb-1.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                          <span>Date</span>
                          <span className="text-right">Paid</span>
                          <span className="text-right">Balance left</span>
                        </div>
                        <div className="space-y-0 max-h-60 overflow-y-auto pr-1">
                          {repaidEntries.map((e: any, i: number) => (
                            <div
                              key={i}
                              className="grid grid-cols-3 gap-2 items-center px-1 py-1.5 text-[11px] border-t border-border/40"
                            >
                              <span className="text-foreground font-medium">{format(new Date(e.date), 'MMM d, yyyy')}</span>
                              <span className="text-right font-semibold text-emerald-600 tabular-nums">− {formatUGX(Number(e.amount_deducted))}</span>
                              <span className="text-right font-semibold tabular-nums">{formatUGX(Number(e.closing_balance))}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Requests submitted to the CFO */}
          <div>
            <h3 className="text-sm font-semibold text-foreground mb-3">My advance requests</h3>
            {historyLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : myRequests.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No advance requests yet</p>
          ) : (
            <div className="space-y-2.5">
              {myRequests.map((req: any) => {
                const cfg = STATUS_CONFIG[req.status] || STATUS_CONFIG.pending;
                const StatusIcon = cfg.icon;
                return (
                  <div key={req.id} className="flex items-center gap-3 rounded-2xl bg-muted/40 p-3.5">
                    <div className={cn("rounded-full p-2 shrink-0", cfg.color)}>
                      <StatusIcon className="h-4 w-4 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-foreground">
                        {formatUGX(Number(req.principal))} × {req.cycle_days}d
                      </p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <Badge className="text-[9px] px-1.5 py-0 h-4 font-bold bg-muted text-muted-foreground border-0">
                          {cfg.label}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">
                          {format(new Date(req.created_at), 'MMM d, yyyy')}
                        </span>
                      </div>
                      {req.status === 'rejected' && (
                        <div className="mt-1.5 rounded-lg bg-red-50 border border-red-100 p-2">
                          <p className="text-[9px] font-bold uppercase tracking-wide text-red-600">Why it was rejected</p>
                          <p className="text-[11px] text-red-700 leading-snug mt-0.5">
                            {req.rejection_reason || 'No reason was provided. Please contact support for details.'}
                          </p>
                        </div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-primary">{req.cycle_days}d</p>
                      <p className="text-[10px] text-muted-foreground">term</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          </div>
        </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
