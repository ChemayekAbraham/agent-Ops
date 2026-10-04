import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import {
  Search, User, Mail, Calendar, RefreshCw, Wallet, Clock, CheckCircle2,
  XCircle, Loader2, Hash, MessageSquare, Inbox, ChevronDown, ChevronUp, CalendarClock,
} from 'lucide-react';
import { format, differenceInCalendarDays, addMonths } from 'date-fns';
import { cn } from '@/lib/utils';

type Req = {
  id: string;
  portfolio_id: string;
  portfolio_code: string;
  portfolio_name: string;
  portfolio_value: number;
  maturity_date: string | null;
  partner_id: string;
  partner_name: string;
  partner_email: string;
  request_type: 'RENEWAL_REQUEST' | 'REDEMPTION_REQUEST';
  status: 'pending' | 'processing' | 'completed' | 'cancelled';
  message: string | null;
  currency: string;
  created_at: string;
  redemption_scope?: 'full' | 'partial' | null;
  redemption_amount?: number | null;
  remaining_principal?: number | null;
  processing_note?: string | null;
  portfolio?: {
    duration_months: number | null;
    payout_day: number | null;
    maturity_date: string | null;
    next_roi_date: string | null;
    roi_percentage: number | null;
    investment_amount?: number | null;
    status?: string | null;
  } | null;
};

type ScheduledRenewal = {
  id: string;
  portfolio_code: string;
  account_name: string | null;
  investment_amount: number;
  pending_renewal_effective_date: string;
  investor: { full_name: string | null; email: string | null } | null;
};

const STATUS_CONFIG: Record<string, { icon: any; color: string; label: string }> = {
  pending: { icon: Clock, color: 'bg-amber-100 text-amber-700 border-amber-200', label: 'Pending' },
  processing: { icon: Loader2, color: 'bg-blue-100 text-blue-700 border-blue-200', label: 'Processing' },
  completed: { icon: CheckCircle2, color: 'bg-emerald-100 text-emerald-700 border-emerald-200', label: 'Completed' },
  cancelled: { icon: XCircle, color: 'bg-muted text-muted-foreground border-border', label: 'Declined' },
};

/**
 * Compute the preview of what a renewal approval will produce, mirroring the
 * `apply_portfolio_renewal` SQL function so Ops sees the SAME dates the RPC
 * would write. Two branches:
 *  - "renew_now"  when maturity_date is today or past → new_start = today
 *  - "schedule"   when maturity_date is in the future → new_start = maturity
 */
function computeRenewalPreview(req: Req): {
  mode: 'renew_now' | 'schedule';
  effectiveDate: Date;
  newMaturityDate: Date;
  newNextRoiDate: Date;
  durationMonths: number;
  daysRemaining: number;
} | null {
  const p = req.portfolio;
  if (!p) return null;
  const maturityStr = p.maturity_date || req.maturity_date;
  if (!maturityStr) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const matDate = new Date(`${maturityStr}T00:00:00`);
  const daysRemaining = differenceInCalendarDays(matDate, today);
  const durationMonths = p.duration_months ?? 12;

  const effectiveDate = daysRemaining <= 0 ? today : matDate;
  const newMaturityDate = addMonths(effectiveDate, durationMonths);

  // next_roi_date = 1 month after new_start, snapped to payout_day when set.
  let newNextRoiDate = addMonths(effectiveDate, 1);
  if (p.payout_day) {
    const d = new Date(newNextRoiDate.getFullYear(), newNextRoiDate.getMonth(), p.payout_day);
    newNextRoiDate = d;
  }

  return {
    mode: daysRemaining <= 0 ? 'renew_now' : 'schedule',
    effectiveDate,
    newMaturityDate,
    newNextRoiDate,
    durationMonths,
    daysRemaining,
  };
}

export function MaturityRequestsQueue() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'queue' | 'scheduled'>('queue');
  const [statusFilter, setStatusFilter] = useState<string>('pending');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Redemption processing form state, keyed by request id.
  const [redScope, setRedScope] = useState<Record<string, 'full' | 'partial'>>({});
  const [redAmount, setRedAmount] = useState<Record<string, string>>({});
  const [redNote, setRedNote] = useState<Record<string, string>>({});

  const { data: requests = [], isLoading, refetch } = useQuery({
    queryKey: ['maturity-requests-queue'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('portfolio_action_requests')
        .select(
          `*, portfolio:investor_portfolios!portfolio_action_requests_portfolio_id_fkey(
            duration_months, payout_day, maturity_date, next_roi_date, roi_percentage,
            investment_amount, status
          )`,
        )
        .order('created_at', { ascending: false })
        .limit(300);
      if (error) throw error;
      return (data || []) as Req[];
    },
    staleTime: 30000,
  });

  const { data: scheduled = [], isLoading: loadingScheduled } = useQuery({
    queryKey: ['scheduled-portfolio-renewals'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('investor_portfolios')
        .select(
          'id, portfolio_code, account_name, investment_amount, pending_renewal_effective_date, investor:profiles!investor_portfolios_investor_id_fkey(full_name, email)'
        )
        .not('pending_renewal_effective_date', 'is', null)
        .order('pending_renewal_effective_date', { ascending: true })
        .limit(300);
      if (error) throw error;
      return (data || []) as unknown as ScheduledRenewal[];
    },
    staleTime: 30000,
  });

  // Build a quick lookup of scheduled renewals by portfolio_id so we can badge
  // requests that have already been queued (no N+1).
  const scheduledByPortfolio = new Map(scheduled.map(s => [s.id, s]));

  const fmtAmount = (n: number, cur: string) =>
    `${cur || 'UGX'} ${new Intl.NumberFormat('en-UG').format(Math.round(n || 0))}`;

  const filtered = requests.filter(r => {
    const matchesSearch = !search ||
      r.partner_name?.toLowerCase().includes(search.toLowerCase()) ||
      r.partner_email?.toLowerCase().includes(search.toLowerCase()) ||
      r.portfolio_code?.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === 'all' || r.status === statusFilter;
    const matchesType = typeFilter === 'all' || r.request_type === typeFilter;
    return matchesSearch && matchesStatus && matchesType;
  });

  const pendingCount = requests.filter(r => r.status === 'pending').length;
  const renewals = requests.filter(r => r.status === 'pending' && r.request_type === 'RENEWAL_REQUEST').length;
  const redemptions = requests.filter(r => r.status === 'pending' && r.request_type === 'REDEMPTION_REQUEST').length;

  const updateStatus = async (req: Req, status: Req['status'], label: string) => {
    setBusyId(req.id);

    // Renewal approvals go through the edge function which decides whether to
    // renew now (matured) or schedule the renewal for the maturity date, and
    // sends the partner the matching email.
    if (status === 'completed' && req.request_type === 'RENEWAL_REQUEST') {
      const { data, error } = await supabase.functions.invoke('process-portfolio-renewal', {
        body: { request_id: req.id },
      });
      setBusyId(null);
      if (error) {
        toast({ title: 'Renewal failed', description: error.message, variant: 'destructive' });
        return;
      }
      const mode = (data as any)?.mode;
      toast({
        title: mode === 'renewed_now' ? 'Portfolio renewed' : 'Renewal scheduled',
        description:
          mode === 'renewed_now'
            ? `${req.portfolio_code} — partner notified.`
            : `${req.portfolio_code} — will renew automatically on ${
                (data as any)?.effective_date
                  ? format(new Date((data as any).effective_date), 'd MMM yyyy')
                  : 'maturity date'
              }.`,
      });
      queryClient.invalidateQueries({ queryKey: ['maturity-requests-queue'] });
      queryClient.invalidateQueries({ queryKey: ['scheduled-portfolio-renewals'] });
      return;
    }

    const { error } = await supabase
      .from('portfolio_action_requests')
      .update({ status })
      .eq('id', req.id);
    setBusyId(null);
    if (error) {
      toast({ title: 'Update failed', description: error.message, variant: 'destructive' });
      return;
    }
    toast({ title: `Request ${label}`, description: `${req.portfolio_code} — ${req.partner_name}` });
    queryClient.invalidateQueries({ queryKey: ['maturity-requests-queue'] });
  };

  /**
   * Process a capital redemption. Partner Ops chooses whether the whole
   * principal is redeemed or only part of it. For a part redemption the
   * released amount is deducted and the portfolio continues on the
   * principal that stays invested.
   */
  const processRedemption = async (req: Req) => {
    const scope = redScope[req.id] || 'full';
    const principal = Number(req.portfolio?.investment_amount ?? req.portfolio_value ?? 0);
    const amount = scope === 'partial' ? Math.round(Number(redAmount[req.id] || 0)) : principal;
    const note = (redNote[req.id] || '').trim();

    if (scope === 'partial') {
      if (!(amount > 0)) {
        toast({ title: 'Enter the amount to redeem', variant: 'destructive' });
        return;
      }
      if (amount > principal) {
        toast({
          title: 'Amount exceeds principal',
          description: `Portfolio principal is ${fmtAmount(principal, req.currency)}.`,
          variant: 'destructive',
        });
        return;
      }
    }
    const remaining = principal - amount;

    const confirmMsg =
      `Process redemption for ${req.portfolio_code}?\n\n` +
      `• Principal before redemption: ${fmtAmount(principal, req.currency)}\n` +
      `• Amount to be redeemed: ${fmtAmount(amount, req.currency)}\n` +
      (remaining > 0
        ? `• Principal that will stay invested: ${fmtAmount(remaining, req.currency)}\n\n` +
          `The portfolio will continue on ${fmtAmount(remaining, req.currency)} and the partner will be notified.`
        : `• Principal remaining: ${fmtAmount(0, req.currency)}\n\n` +
          `The full principal is redeemed and the portfolio will be closed. The partner will be notified.`);
    if (!window.confirm(confirmMsg)) return;

    setBusyId(req.id);
    const { data, error } = await supabase.functions.invoke('process-portfolio-redemption', {
      body: { request_id: req.id, scope, amount, note: note || null },
    });
    setBusyId(null);
    if (error) {
      toast({ title: 'Redemption failed', description: error.message, variant: 'destructive' });
      return;
    }
    const r = (data as any)?.redemption;
    toast({
      title: r?.scope === 'full' ? 'Redemption processed in full' : 'Part redemption processed',
      description:
        r?.scope === 'full'
          ? `${req.portfolio_code} — portfolio closed, partner notified.`
          : `${req.portfolio_code} — ${fmtAmount(Number(r?.remaining_principal || 0), req.currency)} stays invested. Partner notified.`,
    });
    queryClient.invalidateQueries({ queryKey: ['maturity-requests-queue'] });
  };

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-2">
        <Card><CardContent className="p-3">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Pending</p>
          <p className="text-xl font-bold">{pendingCount}</p>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Renewals</p>
          <p className="text-xl font-bold text-emerald-600">{renewals}</p>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Redemptions</p>
          <p className="text-xl font-bold text-amber-600">{redemptions}</p>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Scheduled</p>
          <p className="text-xl font-bold text-purple-600">{scheduled.length}</p>
        </CardContent></Card>
      </div>

      {/* Tabs */}
      <div className="flex gap-1.5 border-b border-border">
        <button
          onClick={() => setTab('queue')}
          className={cn(
            'px-3 py-2 text-xs font-semibold border-b-2 -mb-px transition-colors',
            tab === 'queue' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          Requests Inbox
        </button>
        <button
          onClick={() => setTab('scheduled')}
          className={cn(
            'px-3 py-2 text-xs font-semibold border-b-2 -mb-px transition-colors flex items-center gap-1.5',
            tab === 'scheduled' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          <CalendarClock className="h-3.5 w-3.5" />
          Pending Renewals
          {scheduled.length > 0 && (
            <Badge variant="outline" className="ml-1 h-4 px-1.5 text-[10px] bg-purple-100 text-purple-700 border-purple-200">
              {scheduled.length}
            </Badge>
          )}
        </button>
      </div>

      {tab === 'scheduled' ? (
        loadingScheduled ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : scheduled.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
            <CalendarClock className="h-8 w-8 opacity-40" />
            <p className="text-sm">No portfolios are queued for auto-renewal.</p>
            <p className="text-[11px]">Approved renewals for portfolios not yet at maturity appear here and auto-renew at midnight EAT on their maturity date.</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {scheduled.map(s => {
              const eff = new Date(s.pending_renewal_effective_date);
              const days = differenceInCalendarDays(eff, new Date());
              return (
                <Card key={s.id} className="overflow-hidden">
                  <CardContent className="p-3.5 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate">{s.investor?.full_name || 'Partner'}</p>
                        <p className="text-[11px] text-muted-foreground truncate">{s.investor?.email || '—'}</p>
                      </div>
                      <p className="text-sm font-bold shrink-0">
                        {fmtAmount(s.investment_amount, 'UGX')}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      <Badge variant="outline" className="bg-purple-100 text-purple-700 border-purple-200">
                        <CalendarClock className="h-3 w-3 mr-1" />
                        Auto-renews {format(eff, 'd MMM yyyy')}
                      </Badge>
                      <Badge variant="outline" className={cn(
                        days <= 0 ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
                                  : 'bg-muted text-muted-foreground border-border',
                      )}>
                        {days <= 0 ? 'Due now — awaiting cron' : `in ${days} day${days === 1 ? '' : 's'}`}
                      </Badge>
                      <span className="text-muted-foreground flex items-center gap-1">
                        <Hash className="h-3 w-3" />{s.portfolio_code}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )
      ) : (
      <>
      {/* Controls */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search partner, email or portfolio code…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-9 text-sm"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-1.5">
        {[
          { k: 'pending', l: 'Pending' },
          { k: 'processing', l: 'Processing' },
          { k: 'completed', l: 'Completed' },
          { k: 'cancelled', l: 'Declined' },
          { k: 'all', l: 'All' },
        ].map(f => (
          <button
            key={f.k}
            onClick={() => setStatusFilter(f.k)}
            className={cn(
              'px-3 py-1 rounded-full text-xs font-medium transition-all',
              statusFilter === f.k ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-muted'
            )}
          >
            {f.l}
          </button>
        ))}
        <span className="mx-1 w-px bg-border" />
        {[
          { k: 'all', l: 'All types' },
          { k: 'RENEWAL_REQUEST', l: 'Renewals' },
          { k: 'REDEMPTION_REQUEST', l: 'Redemptions' },
        ].map(f => (
          <button
            key={f.k}
            onClick={() => setTypeFilter(f.k)}
            className={cn(
              'px-3 py-1 rounded-full text-xs font-medium transition-all',
              typeFilter === f.k ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-muted'
            )}
          >
            {f.l}
          </button>
        ))}
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
          <Inbox className="h-8 w-8 opacity-40" />
          <p className="text-sm">No maturity requests in this view.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {filtered.map(req => {
            const sc = STATUS_CONFIG[req.status] || STATUS_CONFIG.pending;
            const SIcon = sc.icon;
            const isRenewal = req.request_type === 'RENEWAL_REQUEST';
            const busy = busyId === req.id;
            const sched = scheduledByPortfolio.get(req.portfolio_id);
            return (
              <Card key={req.id} className="overflow-hidden">
                <CardContent className="p-3.5 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge
                          variant="outline"
                          className={cn('text-[10px]', isRenewal
                            ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
                            : 'bg-amber-100 text-amber-700 border-amber-200')}
                        >
                          {isRenewal ? <RefreshCw className="h-3 w-3 mr-1" /> : <Wallet className="h-3 w-3 mr-1" />}
                          {isRenewal ? 'Renewal' : 'Redemption'}
                        </Badge>
                        <Badge variant="outline" className={cn('text-[10px]', sc.color)}>
                          <SIcon className={cn('h-3 w-3 mr-1', req.status === 'processing' && 'animate-spin')} />
                          {sc.label}
                        </Badge>
                        {sched && (
                          <Badge variant="outline" className="text-[10px] bg-purple-100 text-purple-700 border-purple-200">
                            <CalendarClock className="h-3 w-3 mr-1" />
                            Auto-renews {format(new Date(sched.pending_renewal_effective_date), 'd MMM yyyy')}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1.5 text-sm font-semibold truncate flex items-center gap-1.5">
                        <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        {req.partner_name || 'Partner'}
                      </p>
                    </div>
                    <p className="text-sm font-bold shrink-0">{fmtAmount(req.portfolio_value, req.currency)}</p>
                  </div>

                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1.5 truncate"><Hash className="h-3 w-3 shrink-0" />{req.portfolio_code}</span>
                    <span className="flex items-center gap-1.5 truncate"><Mail className="h-3 w-3 shrink-0" />{req.partner_email || '—'}</span>
                    <span className="flex items-center gap-1.5">
                      <Calendar className="h-3 w-3 shrink-0" />
                      Matures {req.maturity_date ? format(new Date(req.maturity_date), 'd MMM yyyy') : '—'}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Clock className="h-3 w-3 shrink-0" />
                      Sent {format(new Date(req.created_at), 'd MMM, HH:mm')}
                    </span>
                  </div>

                  {req.message && (
                    <button
                      type="button"
                      onClick={() => setExpandedId(expandedId === req.id ? null : req.id)}
                      className="w-full text-left text-xs bg-muted/40 hover:bg-muted/60 transition-colors rounded-md p-2 flex gap-1.5"
                      aria-expanded={expandedId === req.id}
                    >
                      <MessageSquare className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
                      <span className="flex-1 min-w-0">
                        <span className={cn('whitespace-pre-wrap block', expandedId !== req.id && 'line-clamp-2')}>
                          {req.message}
                        </span>
                        <span className="mt-1 inline-flex items-center gap-0.5 text-[10px] font-medium text-primary">
                          {expandedId === req.id ? (
                            <>Show less <ChevronUp className="h-3 w-3" /></>
                          ) : (
                            <>Read full message <ChevronDown className="h-3 w-3" /></>
                          )}
                        </span>
                      </span>
                    </button>
                  )}

                  {/* Renewal preview panel — shows Ops the exact dates the
                      approval will produce BEFORE they click. Only renders
                      for pending / processing renewal requests. */}
                  {isRenewal &&
                    (req.status === 'pending' || req.status === 'processing') &&
                    !sched && (() => {
                      const preview = computeRenewalPreview(req);
                      if (!preview) return null;
                      const isNow = preview.mode === 'renew_now';
                      return (
                        <div
                          className={cn(
                            'rounded-md border p-2.5 space-y-2',
                            isNow
                              ? 'bg-emerald-50/60 border-emerald-200'
                              : 'bg-purple-50/60 border-purple-200',
                          )}
                        >
                          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide">
                            {isNow ? (
                              <>
                                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                                <span className="text-emerald-700">Renewal preview — will apply immediately</span>
                              </>
                            ) : (
                              <>
                                <CalendarClock className="h-3.5 w-3.5 text-purple-600" />
                                <span className="text-purple-700">
                                  Renewal preview — auto-applies in {preview.daysRemaining} day
                                  {preview.daysRemaining === 1 ? '' : 's'}
                                </span>
                              </>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                            <div>
                              <p className="text-muted-foreground">Effective from</p>
                              <p className="font-semibold">{format(preview.effectiveDate, 'd MMM yyyy')}</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">New term</p>
                              <p className="font-semibold">{preview.durationMonths} months</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">New maturity date</p>
                              <p className="font-semibold">{format(preview.newMaturityDate, 'd MMM yyyy')}</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">Next returns payout</p>
                              <p className="font-semibold">{format(preview.newNextRoiDate, 'd MMM yyyy')}</p>
                            </div>
                          </div>
                          {!isNow && (
                            <p className="text-[10px] text-purple-700/80 leading-snug">
                              Portfolio stays on its current cycle until{' '}
                              {format(preview.effectiveDate, 'd MMM yyyy')}. Partner receives a
                              "Renewal Scheduled" email now, and a "Renewed" email once the cron runs at
                              midnight EAT on that date.
                            </p>
                          )}
                        </div>
                      );
                    })()}

                  {/* Completed redemption summary — what the partner keeps */}
                  {!isRenewal && req.status === 'completed' && req.redemption_scope && (
                    <div className="rounded-md border border-amber-200 bg-amber-50/60 p-2.5 space-y-1 dark:bg-amber-950/20 dark:border-amber-900">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                        {req.redemption_scope === 'full' ? 'Redeemed in full' : 'Part redemption processed'}
                      </p>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                        <div>
                          <p className="text-muted-foreground">Amount redeemed</p>
                          <p className="font-semibold dark:text-white">{fmtAmount(Number(req.redemption_amount || 0), req.currency)}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Principal that stays invested</p>
                          <p className="font-semibold dark:text-white">{fmtAmount(Number(req.remaining_principal || 0), req.currency)}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Redemption processing form — Partner Ops decides whether the
                      whole principal is redeemed or only part of it. */}
                  {!isRenewal && req.status === 'processing' && (() => {
                    const principal = Number(req.portfolio?.investment_amount ?? req.portfolio_value ?? 0);
                    const scope = redScope[req.id] || 'full';
                    const typed = Math.round(Number(redAmount[req.id] || 0));
                    const amount = scope === 'partial' ? typed : principal;
                    const remaining = Math.max(principal - (amount || 0), 0);
                    const invalid =
                      scope === 'partial' && (!(amount > 0) || amount > principal);
                    return (
                      <div className="rounded-md border border-amber-200 bg-amber-50/50 p-2.5 space-y-2.5 dark:bg-amber-950/20 dark:border-amber-900">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                          Redemption processing
                        </p>
                        <div className="flex gap-1.5">
                          {[
                            { k: 'full' as const, l: 'Redeem full principal' },
                            { k: 'partial' as const, l: 'Redeem part of principal' },
                          ].map(o => (
                            <button
                              key={o.k}
                              type="button"
                              onClick={() => setRedScope(s => ({ ...s, [req.id]: o.k }))}
                              className={cn(
                                'px-2.5 py-1 rounded-full text-[11px] font-medium transition-all border',
                                scope === o.k
                                  ? 'bg-amber-600 text-white border-amber-600'
                                  : 'bg-background text-muted-foreground border-border hover:bg-muted',
                              )}
                            >
                              {o.l}
                            </button>
                          ))}
                        </div>

                        {scope === 'partial' && (
                          <Input
                            type="number"
                            min={1}
                            max={principal}
                            inputMode="numeric"
                            placeholder={`Amount to redeem (max ${fmtAmount(principal, req.currency)})`}
                            value={redAmount[req.id] || ''}
                            onChange={(e) => setRedAmount(s => ({ ...s, [req.id]: e.target.value }))}
                            className="h-8 text-xs"
                          />
                        )}

                        <Input
                          placeholder="Processing note (optional)"
                          value={redNote[req.id] || ''}
                          onChange={(e) => setRedNote(s => ({ ...s, [req.id]: e.target.value }))}
                          className="h-8 text-xs"
                        />

                        <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-[11px]">
                          <div>
                            <p className="text-muted-foreground">Principal now</p>
                            <p className="font-semibold dark:text-white">{fmtAmount(principal, req.currency)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">To be redeemed</p>
                            <p className="font-semibold text-amber-700 dark:text-amber-300">
                              {invalid ? '—' : fmtAmount(amount, req.currency)}
                            </p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">Stays invested</p>
                            <p className="font-semibold dark:text-white">
                              {invalid ? '—' : fmtAmount(remaining, req.currency)}
                            </p>
                          </div>
                        </div>

                        <p className="text-[10px] leading-snug text-amber-700/80 dark:text-amber-300/80">
                          {invalid
                            ? `Enter an amount between ${fmtAmount(1, req.currency)} and ${fmtAmount(principal, req.currency)}.`
                            : remaining > 0
                              ? `Once submitted, this portfolio will continue on a principal of ${fmtAmount(remaining, req.currency)} and all future returns are calculated on that amount.`
                              : 'Once submitted, the full principal is redeemed and this portfolio will be closed.'}
                        </p>

                        <Button
                          size="sm"
                          className="h-8 text-xs gap-1.5 bg-amber-600 hover:bg-amber-700 text-white"
                          disabled={busy || invalid}
                          onClick={() => processRedemption(req)}
                        >
                          <Wallet className="h-3.5 w-3.5" />
                          {remaining > 0 && !invalid ? 'Submit part redemption' : 'Submit full redemption'}
                        </Button>
                      </div>
                    );
                  })()}

                  {req.status !== 'completed' && req.status !== 'cancelled' && (
                    <div className="flex flex-wrap gap-2 pt-0.5">
                      {req.status === 'pending' && (
                        <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" disabled={busy}
                          onClick={() => updateStatus(req, 'processing', 'marked processing')}>
                          <Loader2 className="h-3.5 w-3.5" /> Start processing
                        </Button>
                      )}
                      {isRenewal && (() => {
                        const preview = isRenewal ? computeRenewalPreview(req) : null;
                        const daysLabel = preview
                          ? preview.mode === 'renew_now'
                            ? 'applies today'
                            : `applies in ${preview.daysRemaining} day${preview.daysRemaining === 1 ? '' : 's'}`
                          : '';
                        const handleApprove = () => {
                          if (preview) {
                            const msg =
                              preview.mode === 'renew_now'
                                ? `Approve renewal now for ${req.portfolio_code}?\n\n` +
                                  `• New maturity: ${format(preview.newMaturityDate, 'd MMM yyyy')}\n` +
                                  `• Next returns: ${format(preview.newNextRoiDate, 'd MMM yyyy')}\n` +
                                  `• Term: ${preview.durationMonths} months\n\n` +
                                  `Partner will be notified immediately.`
                                : `Schedule renewal for ${req.portfolio_code}?\n\n` +
                                  `• Auto-applies in ${preview.daysRemaining} day${preview.daysRemaining === 1 ? '' : 's'} ` +
                                  `(${format(preview.effectiveDate, 'd MMM yyyy')})\n` +
                                  `• New maturity: ${format(preview.newMaturityDate, 'd MMM yyyy')}\n` +
                                  `• Next returns: ${format(preview.newNextRoiDate, 'd MMM yyyy')}\n` +
                                  `• Term: ${preview.durationMonths} months\n\n` +
                                  `Partner will receive a "Renewal Scheduled" email now and a "Renewed" email on the effective date.`;
                            if (!window.confirm(msg)) return;
                          }
                          updateStatus(req, 'completed', 'completed');
                        };
                        return (
                          <Button
                            size="sm"
                            className="h-8 text-xs gap-1.5"
                            disabled={busy}
                            onClick={handleApprove}
                            title={preview ? daysLabel : undefined}
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            {isRenewal ? 'Approve renewal' : 'Mark completed'}
                            {preview && (
                              <span className="ml-1 text-[10px] opacity-90">· {daysLabel}</span>
                            )}
                          </Button>
                        );
                      })()}
                      <Button size="sm" variant="ghost" className="h-8 text-xs gap-1.5 text-destructive hover:text-destructive" disabled={busy}
                        onClick={() => updateStatus(req, 'cancelled', 'declined')}>
                        <XCircle className="h-3.5 w-3.5" /> Decline
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      </>
      )}
    </div>
  );
}