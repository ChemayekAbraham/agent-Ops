import { useState, useEffect, useRef, useMemo } from 'react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Banknote, ShieldCheck, Search, Loader2, AlertCircle, Plus,
  CheckCircle2, FileText, Wallet, TrendingUp, Info, Megaphone, Inbox, Trash2, X, Check,
  ScrollText, Users, SearchX,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useMyTrustScore } from '@/hooks/useMyTrustScore';
import { useAgentBalances } from '@/hooks/useAgentBalances';
import { useLendingAgentAgreement } from '@/hooks/useLendingAgentAgreement';
import { useTrustProfile } from '@/hooks/useTrustProfile';
import LendingAgentAgreementModal from '@/components/vouch/agent/LendingAgentAgreementModal';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { generateWelileAiId } from '@/lib/welileAiId';
import { logLendingAudit } from '@/lib/lendingAudit';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import LendingStatCards from './LendingStatCards';
import LendingBorrowerCard from './LendingBorrowerCard';
import {
  LendingLoan, computeStats, matchesFilter, matchesSearch, dueStateOf,
  StatusFilter,
  RepaymentFrequency, REPAYMENT_FREQUENCIES, buildSchedule,
} from './lendingHelpers';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Tab = 'borrowers' | 'requests' | 'offers' | 'activity';

const PLATFORM_FEE_PCT = 0.01; // 1% per Lending Agent Agreement §4.3

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'due_today', label: 'Due today' },
  { key: 'active', label: 'Active' },
  { key: 'repaid', label: 'Repaid' },
];

export default function LendingAgentPortal({ open, onOpenChange }: Props) {
  const { user } = useAuth();
  const { snapshot, loading: trustLoading } = useMyTrustScore();
  const { withdrawableBalance, commissionBalance, refetch: refetchBalances } = useAgentBalances();
  const { isAccepted, acceptAgreement, isLoading: agreementLoading } = useLendingAgentAgreement();

  const [showAgreement, setShowAgreement] = useState(false);
  const [loans, setLoans] = useState<LendingLoan[]>([]);
  const [loansLoading, setLoansLoading] = useState(false);

  const [tab, setTab] = useState<Tab>('borrowers');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  // Borrower lookup
  const [aiIdInput, setAiIdInput] = useState('');
  const [activeAiId, setActiveAiId] = useState<string | null>(null);
  const { profile: borrower, loading: borrowerLoading, error: borrowerError } =
    useTrustProfile(activeAiId ?? undefined, { publicMode: true });

  // Loan form
  const [showLoanForm, setShowLoanForm] = useState(false);
  const [principal, setPrincipal] = useState('');
  const [interestRate, setInterestRate] = useState('10');
  const [dueDate, setDueDate] = useState('');
  const [purpose, setPurpose] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Auto-deduction schedule
  const [autoDeduct, setAutoDeduct] = useState(true);
  const [frequency, setFrequency] = useState<RepaymentFrequency>('monthly');

  // Loan offers (published to all users) + incoming requests
  const [offers, setOffers] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [auditLog, setAuditLog] = useState<any[]>([]);
  const [myName, setMyName] = useState<string | null>(null);
  const [showOfferForm, setShowOfferForm] = useState(false);
  const [savingOffer, setSavingOffer] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [offerForm, setOfferForm] = useState({
    title: 'Quick Cash Loan',
    description: '',
    min_amount: '50000',
    max_amount: '500000',
    interest_rate: '10',
    min_duration: '7',
    max_duration: '30',
  });
  const myAiId = user ? generateWelileAiId(user.id) : null;
  const borrowerInputRef = useRef<HTMLInputElement>(null);

  const trustScore = snapshot?.score ?? 0;
  const lendablePool = withdrawableBalance + commissionBalance;

  const reloadLoans = async () => {
    if (!user) return;
    const { data } = await (supabase
      .from('lending_agent_loans' as any)
      .select('*')
      .eq('lender_agent_id', user.id)
      .order('created_at', { ascending: false })
      .limit(500) as any);
    if (data) setLoans(data as LendingLoan[]);
  };

  // Load my disbursed loans when sheet opens
  useEffect(() => {
    if (!open || !user) return;
    setLoansLoading(true);
    (async () => {
      await reloadLoans();
      setLoansLoading(false);

      const { data: offerData } = await (supabase
        .from('lending_agent_offers' as any)
        .select('*')
        .eq('lender_agent_id', user.id)
        .order('created_at', { ascending: false }) as any);
      if (offerData) setOffers(offerData);

      const { data: reqData } = await (supabase
        .from('lending_loan_requests' as any)
        .select('*')
        .eq('lender_agent_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50) as any);
      if (reqData) setRequests(reqData);

      const { data: auditData } = await (supabase
        .from('lending_audit_log' as any)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(60) as any);
      if (auditData) setAuditLog(auditData);

      const { data: prof } = await (supabase
        .from('profiles')
        .select('full_name')
        .eq('id', user.id)
        .maybeSingle() as any);
      setMyName(prof?.full_name ?? null);
    })();
  }, [open, user]);

  const reloadRequests = async () => {
    if (!user) return;
    const { data } = await (supabase
      .from('lending_loan_requests' as any)
      .select('*')
      .eq('lender_agent_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50) as any);
    if (data) setRequests(data);
    const { data: auditData } = await (supabase
      .from('lending_audit_log' as any)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(60) as any);
    if (auditData) setAuditLog(auditData);
  };

  const handleRecordRepayment = async (loan: LendingLoan, amount: number) => {
    if (!user) return;
    const newRepaid = (Number(loan.amount_repaid_ugx) || 0) + amount;
    const totalDue = loan.principal_ugx + (loan.principal_ugx * (Number(loan.interest_rate_pct) || 0)) / 100;
    const fullyRepaid = newRepaid >= Math.floor(totalDue);
    const newStatus = fullyRepaid ? 'repaid' : 'partially_repaid';
    const { error } = await (supabase.from('lending_agent_loans' as any)
      .update({
        amount_repaid_ugx: newRepaid,
        last_repayment_at: new Date().toISOString(),
        status: newStatus,
        closed_at: fullyRepaid ? new Date().toISOString() : null,
      })
      .eq('id', loan.id) as any);
    if (error) { toast.error('Could not record repayment: ' + error.message); return; }
    toast.success(fullyRepaid
      ? `${loan.borrower_display_name ?? loan.borrower_ai_id} fully repaid 🎉`
      : `Recorded ${formatUGX(amount)} from ${loan.borrower_display_name ?? loan.borrower_ai_id}`);
    await logLendingAudit({
      actorId: user.id, actorDisplayName: myName, actionType: 'repayment_recorded',
      entityType: 'loan', entityId: loan.id,
      lenderAgentId: user.id, amountUgx: amount,
      newStatus, details: { total_repaid_ugx: newRepaid },
    });
    await reloadLoans();
    await reloadRequests();
  };

  const handleCreateOffer = async () => {
    if (!user) return;
    const min = Number(offerForm.min_amount);
    const max = Number(offerForm.max_amount);
    if (!offerForm.title.trim()) { toast.error('Enter a title'); return; }
    if (!min || !max || min > max) { toast.error('Check the amount range'); return; }
    setSavingOffer(true);
    const { error } = await (supabase.from('lending_agent_offers' as any).insert({
      lender_agent_id: user.id,
      lender_display_name: myName,
      lender_ai_id: myAiId,
      title: offerForm.title.trim(),
      description: offerForm.description.trim() || null,
      min_amount_ugx: min,
      max_amount_ugx: max,
      interest_rate_pct: Number(offerForm.interest_rate) || 0,
      min_duration_days: Number(offerForm.min_duration) || 1,
      max_duration_days: Number(offerForm.max_duration) || 30,
      active: true,
    }) as any);
    setSavingOffer(false);
    if (error) { toast.error('Could not publish offer: ' + error.message); return; }
    toast.success('Loan offer published — any user can now request it');
    setShowOfferForm(false);
    const { data } = await (supabase
      .from('lending_agent_offers' as any)
      .select('*')
      .eq('lender_agent_id', user.id)
      .order('created_at', { ascending: false }) as any);
    if (data) setOffers(data);
    const created = (data ?? [])[0];
    await logLendingAudit({
      actorId: user.id,
      actorDisplayName: myName,
      actionType: 'offer_created',
      entityType: 'offer',
      entityId: created?.id ?? null,
      lenderAgentId: user.id,
      amountUgx: max,
      details: { title: offerForm.title.trim(), min_amount_ugx: min, max_amount_ugx: max, interest_rate_pct: Number(offerForm.interest_rate) || 0 },
    });
  };

  const toggleOffer = async (id: string, active: boolean) => {
    await (supabase.from('lending_agent_offers' as any).update({ active }).eq('id', id) as any);
    setOffers((prev) => prev.map((o) => (o.id === id ? { ...o, active } : o)));
    if (user) {
      await logLendingAudit({
        actorId: user.id,
        actorDisplayName: myName,
        actionType: active ? 'offer_activated' : 'offer_deactivated',
        entityType: 'offer',
        entityId: id,
        lenderAgentId: user.id,
        oldStatus: active ? 'inactive' : 'active',
        newStatus: active ? 'active' : 'inactive',
      });
    }
  };

  const deleteOffer = async (id: string) => {
    await (supabase.from('lending_agent_offers' as any).delete().eq('id', id) as any);
    setOffers((prev) => prev.filter((o) => o.id !== id));
    toast.success('Offer removed');
    if (user) {
      await logLendingAudit({
        actorId: user.id,
        actorDisplayName: myName,
        actionType: 'offer_deleted',
        entityType: 'offer',
        entityId: id,
        lenderAgentId: user.id,
      });
    }
  };

  const handleApproveRequest = async (req: any) => {
    if (!user) return;
    const principalNum = Number(req.requested_amount_ugx);
    const fee = Math.round(principalNum * PLATFORM_FEE_PCT);
    if (principalNum + fee > lendablePool) {
      toast.error(`Insufficient wallet balance. Need ${formatUGX(principalNum + fee)} (loan + 1% fee).`);
      return;
    }
    setDecidingId(req.id);
    const ratePct = req.interest_rate_pct ?? 0;
    const totalOwed = principalNum + (principalNum * ratePct) / 100;
    const durationDays = Number(req.requested_duration_days) || 30;
    const dueStr = new Date(Date.now() + durationDays * 86400000).toISOString().slice(0, 10);
    const reqFreq: RepaymentFrequency = durationDays <= 1 ? 'once' : 'monthly';
    const reqSchedule = buildSchedule(totalOwed, reqFreq, new Date(), dueStr);
    const { data: loanRow, error } = await (supabase.from('lending_agent_loans' as any).insert({
      lender_agent_id: user.id,
      borrower_user_id: req.borrower_user_id,
      borrower_ai_id: req.borrower_ai_id,
      borrower_display_name: req.borrower_display_name,
      borrower_phone: req.borrower_phone,
      principal_ugx: principalNum,
      interest_rate_pct: req.interest_rate_pct ?? 0,
      expected_repayment_date: dueStr,
      loan_purpose: req.purpose ?? null,
      platform_fee_ugx: fee,
      lender_trust_score_at_record: trustScore,
      status: 'active',
      repayment_frequency: reqFreq,
      auto_deduct_enabled: true,
      installment_ugx: reqSchedule.installment,
      next_deduction_date: reqSchedule.firstDate,
      auto_deduct_started_at: new Date().toISOString(),
    }).select('id').single() as any);
    if (error) {
      setDecidingId(null);
      toast.error('Could not disburse: ' + error.message);
      return;
    }
    await (supabase.from('lending_loan_requests' as any)
      .update({ status: 'approved', decided_at: new Date().toISOString(), loan_id: loanRow?.id ?? null })
      .eq('id', req.id) as any);
    setDecidingId(null);
    toast.success(`Loan to ${req.borrower_display_name ?? req.borrower_ai_id} approved & recorded`);
    await logLendingAudit({
      actorId: user.id, actorDisplayName: myName, actionType: 'request_approved',
      entityType: 'request', entityId: req.id,
      borrowerUserId: req.borrower_user_id, lenderAgentId: user.id,
      amountUgx: principalNum, feeUgx: fee, oldStatus: 'pending', newStatus: 'approved',
      details: { loan_id: loanRow?.id ?? null, borrower_ai_id: req.borrower_ai_id },
    });
    await logLendingAudit({
      actorId: user.id, actorDisplayName: myName, actionType: 'loan_disbursed',
      entityType: 'loan', entityId: loanRow?.id ?? null,
      borrowerUserId: req.borrower_user_id, lenderAgentId: user.id,
      amountUgx: principalNum, feeUgx: fee, newStatus: 'active',
      details: { interest_rate_pct: req.interest_rate_pct ?? 0, request_id: req.id },
    });
    await logLendingAudit({
      actorId: user.id, actorDisplayName: myName, actionType: 'fee_deducted',
      entityType: 'loan', entityId: loanRow?.id ?? null,
      borrowerUserId: req.borrower_user_id, lenderAgentId: user.id,
      feeUgx: fee, details: { platform_fee_pct: PLATFORM_FEE_PCT, principal_ugx: principalNum },
    });
    await reloadRequests();
    refetchBalances();
    await reloadLoans();
  };

  const handleDeclineRequest = async (req: any) => {
    setDecidingId(req.id);
    await (supabase.from('lending_loan_requests' as any)
      .update({ status: 'declined', decided_at: new Date().toISOString() })
      .eq('id', req.id) as any);
    setDecidingId(null);
    toast.success('Request declined');
    if (user) {
      await logLendingAudit({
        actorId: user.id, actorDisplayName: myName, actionType: 'request_declined',
        entityType: 'request', entityId: req.id,
        borrowerUserId: req.borrower_user_id, lenderAgentId: user.id,
        amountUgx: Number(req.requested_amount_ugx), oldStatus: 'pending', newStatus: 'declined',
      });
    }
    await reloadRequests();
  };

  const handleLookup = () => {
    const cleaned = aiIdInput.trim().toUpperCase();
    if (!cleaned) { toast.error('Enter a borrower AI ID'); return; }
    setActiveAiId(cleaned);
    setShowLoanForm(false);
    setPrincipal(''); setInterestRate('10'); setDueDate(''); setPurpose('');
  };

  const handleAccept = async () => {
    const ok = await acceptAgreement(trustScore);
    if (ok) {
      toast.success('Agreement signed — you are now a Welile Lending Agent');
      setShowAgreement(false);
    }
    return ok;
  };

  const handleDisburse = async () => {
    if (!user || !borrower) return;
    const principalNum = Number(principal);
    if (!principalNum || principalNum <= 0) { toast.error('Enter a valid amount'); return; }
    const fee = Math.round(principalNum * PLATFORM_FEE_PCT);
    const totalDeduction = principalNum + fee;
    if (totalDeduction > lendablePool) {
      toast.error(`Insufficient wallet balance. Need ${formatUGX(totalDeduction)} (loan + 1% fee).`);
      return;
    }

    setSubmitting(true);
    const ratePct = interestRate ? Number(interestRate) : 0;
    const totalOwed = principalNum + (principalNum * ratePct) / 100;
    const schedule = autoDeduct
      ? buildSchedule(totalOwed, frequency, new Date(), dueDate || null)
      : null;
    const { error } = await (supabase.from('lending_agent_loans' as any).insert({
      lender_agent_id: user.id,
      borrower_user_id: borrower.user_id,
      borrower_ai_id: borrower.ai_id,
      borrower_display_name: borrower.identity?.full_name ?? null,
      borrower_phone: borrower.identity?.phone ?? null,
      principal_ugx: principalNum,
      interest_rate_pct: interestRate ? Number(interestRate) : 0,
      expected_repayment_date: dueDate || null,
      loan_purpose: purpose.trim() || null,
      platform_fee_ugx: fee,
      lender_trust_score_at_record: trustScore,
      borrower_trust_score_at_record: borrower.trust.score,
      borrower_trust_tier_at_record: borrower.trust.tier,
      status: 'active',
      repayment_frequency: autoDeduct ? frequency : 'once',
      auto_deduct_enabled: autoDeduct,
      installment_ugx: schedule?.installment ?? 0,
      next_deduction_date: schedule?.firstDate ?? null,
      auto_deduct_started_at: autoDeduct ? new Date().toISOString() : null,
    }) as any);
    setSubmitting(false);

    if (error) {
      console.error('[LendingAgentPortal] disburse error', error);
      toast.error('Could not record loan: ' + error.message);
      return;
    }

    toast.success(
      autoDeduct
        ? `Loan recorded. Auto-deduction set ${frequency.replace('_', ' ')} (~${formatUGX(schedule?.installment ?? 0)}/cycle).`
        : `Loan to ${borrower.identity?.full_name ?? borrower.ai_id} recorded.`,
    );
    await reloadLoans();
    refetchBalances();
    setShowLoanForm(false);
    setPrincipal(''); setDueDate(''); setPurpose('');
    setAutoDeduct(true); setFrequency('monthly');
    setActiveAiId(null); setAiIdInput('');
    setTab('borrowers');
  };

  const stats = useMemo(() => computeStats(loans), [loans]);

  const filteredLoans = useMemo(() => {
    const list = loans.filter((l) => matchesFilter(l, statusFilter) && matchesSearch(l, search));
    // Sort: overdue first, then due today, then soonest due, then newest.
    const rank = (l: LendingLoan) => {
      const ds = dueStateOf(l);
      if (ds === 'overdue') return 0;
      if (ds === 'due_today') return 1;
      if (ds === 'due_soon') return 2;
      if (l.status === 'active' || l.status === 'partially_repaid') return 3;
      return 4;
    };
    return [...list].sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [loans, statusFilter, search]);

  const pendingCount = requests.filter((r) => r.status === 'pending').length;
  const activeOffers = offers.filter((o) => o.active).length;

  const goToNewLoan = () => {
    setTab('offers');
    setActiveAiId(null);
    setShowLoanForm(false);
    setAiIdInput('');
    setTimeout(() => {
      borrowerInputRef.current?.focus();
      borrowerInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
  };

  const TABS: { key: Tab; label: string; Icon: typeof Users; badge?: number }[] = [
    { key: 'borrowers', label: 'Borrowers', Icon: Users },
    { key: 'requests', label: 'Requests', Icon: Inbox, badge: pendingCount },
    { key: 'offers', label: 'Offers', Icon: Megaphone, badge: activeOffers },
    { key: 'activity', label: 'Activity', Icon: ScrollText },
  ];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[96vh] overflow-y-auto rounded-t-3xl p-0">
        {/* Sticky header */}
        <div className="sticky top-0 z-20 bg-background/95 backdrop-blur-md border-b border-border/60 px-4 pt-4 pb-3">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2.5">
              <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-emerald-500 to-primary flex items-center justify-center shadow-sm">
                <Banknote className="h-5 w-5 text-white" />
              </div>
              <div>
                <p className="text-base font-bold text-foreground tracking-tight leading-none">Lending Agent</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">Manage your borrowers</p>
              </div>
            </div>
            <Badge variant="outline" className="text-[10px] font-bold">Score {trustScore}</Badge>
          </div>

          {/* Material-style segmented tabs */}
          <div className="grid grid-cols-4 gap-1 rounded-2xl bg-muted/60 p-1">
            {TABS.map(({ key, label, Icon, badge }) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`relative flex flex-col items-center gap-0.5 rounded-xl py-2 text-[10px] font-semibold transition-colors ${
                  tab === key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
                {badge != null && badge > 0 && (
                  <span className="absolute top-0.5 right-2 min-w-[15px] h-[15px] px-1 rounded-full bg-primary text-primary-foreground text-[8px] font-bold flex items-center justify-center">
                    {badge}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="px-4 pb-10 pt-4">
          {trustLoading || agreementLoading ? (
            <Skeleton className="h-40 w-full rounded-2xl" />
          ) : (
            <>
              {/* Principal protection guarantee — always visible & prominent.
                  Borrowers never see this; it is for the Lending Agent only. */}
              <div className="mb-4 rounded-2xl border border-emerald-500/40 bg-gradient-to-br from-emerald-500/15 to-emerald-500/5 p-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <div className="h-9 w-9 shrink-0 rounded-xl bg-emerald-500/20 flex items-center justify-center">
                    <ShieldCheck className="h-5 w-5 text-emerald-600" />
                  </div>
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-extrabold text-foreground leading-tight">Your principal is protected</p>
                      <Badge className="bg-emerald-600 text-white text-[9px] font-bold px-1.5 py-0.5">100%</Badge>
                    </div>
                    <p className="text-[12px] text-foreground/80 leading-relaxed">
                      <span className="font-bold">Welile Technologies pays you 100% of the principal</span> if a borrower
                      defaults — whether they paid <span className="font-bold">nothing</span> or only{' '}
                      <span className="font-bold">part</span> of the loan. You only risk the interest, not your money.
                    </p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Applies only to loans recorded inside Welile. Interest is not guaranteed.
                    </p>
                  </div>
                </div>
              </div>

              {/* Non-blocking agreement reminder */}
              {!isAccepted && (
                <Card className="border-amber-500/30 bg-amber-500/5 mb-4">
                  <CardContent className="p-3 flex items-start gap-3">
                    <ShieldCheck className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                    <div className="space-y-1.5 flex-1">
                      <p className="text-xs font-bold">Lending Agent terms</p>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        Welile takes a <span className="font-bold text-foreground">1% platform fee</span> per loan and <span className="font-bold text-emerald-700">guarantees 100% of your principal</span> if a borrower defaults (pays nothing or only part). Read &amp; sign the updated terms to understand your protection.
                      </p>
                      <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setShowAgreement(true)}>
                        <FileText className="h-3.5 w-3.5 mr-1" />
                        Read &amp; Sign
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* ===== BORROWERS TAB ===== */}
              {tab === 'borrowers' && (
                <>
                  <LendingStatCards stats={stats} onJump={(f) => setStatusFilter(f)} />

                  {/* Search */}
                  <div className="relative mb-3">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search name, AI ID or phone"
                      className="h-11 pl-9 pr-9 text-sm rounded-2xl"
                    />
                    {search && (
                      <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  {/* Filter chips */}
                  <div className="flex gap-2 overflow-x-auto pb-2 mb-3 -mx-1 px-1 scrollbar-none">
                    {FILTERS.map((f) => {
                      const active = statusFilter === f.key;
                      const count =
                        f.key === 'overdue' ? stats.overdueCount :
                        f.key === 'due_today' ? stats.dueTodayCount :
                        f.key === 'active' ? stats.activeCount :
                        f.key === 'repaid' ? stats.repaidCount : loans.length;
                      return (
                        <button
                          key={f.key}
                          onClick={() => setStatusFilter(f.key)}
                          className={`shrink-0 inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                            active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {f.label}
                          <span className={`text-[10px] ${active ? 'opacity-90' : 'opacity-70'}`}>{count}</span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Loan list */}
                  {loansLoading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-24 w-full rounded-xl" />
                      <Skeleton className="h-24 w-full rounded-xl" />
                    </div>
                  ) : filteredLoans.length === 0 ? (
                    <Card className="border-dashed">
                      <CardContent className="p-8 text-center">
                        {loans.length === 0 ? (
                          <>
                            <TrendingUp className="h-7 w-7 text-muted-foreground mx-auto mb-2" />
                            <p className="text-sm font-semibold mb-1">No loans yet</p>
                            <p className="text-xs text-muted-foreground mb-4">Disburse your first loan to start building your book.</p>
                            <Button size="sm" onClick={goToNewLoan}>
                              <Plus className="h-4 w-4 mr-1.5" /> New Loan
                            </Button>
                          </>
                        ) : (
                          <>
                            <SearchX className="h-7 w-7 text-muted-foreground mx-auto mb-2" />
                            <p className="text-xs text-muted-foreground">No borrowers match this filter.</p>
                          </>
                        )}
                      </CardContent>
                    </Card>
                  ) : (
                    <div className="space-y-2.5">
                      {filteredLoans.map((loan) => (
                        <LendingBorrowerCard key={loan.id} loan={loan} onRecordRepayment={handleRecordRepayment} />
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* ===== REQUESTS TAB ===== */}
              {tab === 'requests' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between mb-1">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                      <Inbox className="h-3.5 w-3.5" /> Loan Requests
                    </Label>
                    <Badge variant="outline" className="text-[10px]">{pendingCount} pending</Badge>
                  </div>
                  {requests.length === 0 ? (
                    <Card className="border-dashed">
                      <CardContent className="p-8 text-center">
                        <Inbox className="h-7 w-7 text-muted-foreground mx-auto mb-2" />
                        <p className="text-xs text-muted-foreground">No loan requests yet. Publish an offer so users can request loans.</p>
                      </CardContent>
                    </Card>
                  ) : (
                    requests.map((req) => {
                      const statusColor =
                        req.status === 'approved' ? 'bg-emerald-500/15 text-emerald-700' :
                        req.status === 'declined' ? 'bg-destructive/15 text-destructive' :
                        'bg-amber-500/15 text-amber-700';
                      return (
                        <Card key={req.id} className="border-border/60">
                          <CardContent className="p-3.5">
                            <div className="flex items-center justify-between mb-1">
                              <p className="text-sm font-bold truncate">{req.borrower_display_name ?? req.borrower_ai_id ?? 'User'}</p>
                              <Badge className={`${statusColor} border-0 text-[9px] font-bold capitalize`}>{req.status}</Badge>
                            </div>
                            <p className="text-[11px] text-muted-foreground">
                              {formatUGX(req.requested_amount_ugx)}{req.requested_duration_days ? ` · ${req.requested_duration_days} days` : ''}{req.interest_rate_pct != null ? ` · ${req.interest_rate_pct}%` : ''}
                            </p>
                            {req.purpose && <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">{req.purpose}</p>}
                            {req.status === 'pending' && (
                              <div className="flex gap-2 mt-2.5">
                                <Button size="sm" variant="outline" className="flex-1 h-9 text-[11px]" disabled={decidingId === req.id} onClick={() => handleDeclineRequest(req)}>
                                  <X className="h-3 w-3 mr-1" /> Decline
                                </Button>
                                <Button size="sm" className="flex-1 h-9 text-[11px]" disabled={decidingId === req.id} onClick={() => handleApproveRequest(req)}>
                                  {decidingId === req.id ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Check className="h-3 w-3 mr-1" />}
                                  Approve &amp; Disburse
                                </Button>
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      );
                    })
                  )}
                </div>
              )}

              {/* ===== OFFERS TAB (offers + borrower lookup + new loan) ===== */}
              {tab === 'offers' && (
                <>
                  {/* Lendable pool */}
                  <Card className="border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-primary/5 mb-4">
                    <CardContent className="p-4">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-1">Lendable Pool</p>
                      <p className="text-2xl font-bold text-emerald-600">{formatUGX(lendablePool)}</p>
                      <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
                        <span><Wallet className="h-3 w-3 inline mr-1" />Withdrawable: {formatUGX(withdrawableBalance)}</span>
                        <span>· Commission: {formatUGX(commissionBalance)}</span>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Borrower lookup */}
                  <div className="space-y-2 mb-4">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                      Create a loan — lookup borrower by AI ID
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        ref={borrowerInputRef}
                        value={aiIdInput}
                        onChange={(e) => setAiIdInput(e.target.value.toUpperCase())}
                        placeholder="WEL-XXXXXX"
                        className="h-11 text-sm font-mono rounded-2xl"
                        onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
                      />
                      <Button onClick={handleLookup} disabled={borrowerLoading} className="h-11 rounded-2xl">
                        {borrowerLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>

                  {activeAiId && borrowerLoading && <Skeleton className="h-40 w-full rounded-xl mb-4" />}
                  {borrowerError && (
                    <Card className="border-destructive/30 bg-destructive/5 mb-4">
                      <CardContent className="p-3 flex items-center gap-2">
                        <AlertCircle className="h-4 w-4 text-destructive" />
                        <p className="text-xs">{borrowerError}</p>
                      </CardContent>
                    </Card>
                  )}
                  {borrower && !borrowerLoading && (
                    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mb-4">
                      <Card className="border-primary/20">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm flex items-center gap-2">
                            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                            {borrower.identity?.full_name ?? borrower.ai_id}
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="pt-0 space-y-3">
                          <div className="grid grid-cols-3 gap-2 text-center">
                            <div className="rounded-lg bg-muted/40 p-2">
                              <p className="text-[9px] uppercase text-muted-foreground">Score</p>
                              <p className="text-base font-bold">{borrower.trust.score}</p>
                            </div>
                            <div className="rounded-lg bg-muted/40 p-2">
                              <p className="text-[9px] uppercase text-muted-foreground">Tier</p>
                              <p className="text-xs font-bold capitalize">{borrower.trust.tier}</p>
                            </div>
                            <div className="rounded-lg bg-muted/40 p-2">
                              <p className="text-[9px] uppercase text-muted-foreground">Cash flow / mo</p>
                              <p className="text-xs font-bold">{formatUGX(borrower.cash_flow_capacity?.monthly_avg ?? 0)}</p>
                            </div>
                          </div>

                          <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 p-2.5 flex items-start gap-2">
                            <ShieldCheck className="h-3.5 w-3.5 text-emerald-700 shrink-0 mt-0.5" />
                            <p className="text-[10px] leading-relaxed">
                              <span className="font-bold">Your principal is protected.</span> Welile pays you 100% of the principal if this borrower defaults (pays nothing or only part). Interest is not guaranteed — decide using their score, cash flow, and history.
                            </p>
                          </div>

                          {!showLoanForm ? (
                            <Button size="sm" className="w-full" onClick={() => setShowLoanForm(true)}>
                              <Plus className="h-4 w-4 mr-1.5" />
                              Disburse Loan
                            </Button>
                          ) : (
                            <div className="space-y-2 p-3 rounded-lg bg-background border">
                              <div>
                                <Label className="text-xs">Principal (UGX) *</Label>
                                <Input type="number" value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="500000" className="h-9 text-sm" />
                                {principal && Number(principal) > 0 && (
                                  <p className="text-[10px] text-muted-foreground mt-1">
                                    + 1% fee ({formatUGX(Math.round(Number(principal) * PLATFORM_FEE_PCT))}) = total deduction {formatUGX(Number(principal) + Math.round(Number(principal) * PLATFORM_FEE_PCT))}
                                  </p>
                                )}
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                <div>
                                  <Label className="text-xs">Interest % (per cycle)</Label>
                                  <Input type="number" value={interestRate} onChange={(e) => setInterestRate(e.target.value)} min={0} className="h-9 text-sm" />
                                  <p className="text-[9px] text-muted-foreground mt-0.5">Any rate allowed</p>
                                </div>
                                <div>
                                  <Label className="text-xs">Due date</Label>
                                  <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="h-9 text-sm" />
                                </div>
                              </div>
                              <div>
                                <Label className="text-xs">Loan purpose</Label>
                                <Textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} placeholder="e.g. school fees, business stock" className="text-sm resize-none" />
                              </div>
                              {/* Auto-deduction schedule */}
                              <div className="rounded-lg border bg-muted/30 p-2.5 space-y-2">
                                <div className="flex items-center justify-between">
                                  <div>
                                    <Label className="text-xs font-semibold">Auto-deduct repayments</Label>
                                    <p className="text-[9px] text-muted-foreground">Pull installments straight from the borrower's wallet into yours.</p>
                                  </div>
                                  <Switch checked={autoDeduct} onCheckedChange={setAutoDeduct} />
                                </div>
                                {autoDeduct && (
                                  <>
                                    <div>
                                      <Label className="text-xs">Repayment schedule</Label>
                                      <Select value={frequency} onValueChange={(v) => setFrequency(v as RepaymentFrequency)}>
                                        <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                          {REPAYMENT_FREQUENCIES.map((f) => (
                                            <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                    {principal && Number(principal) > 0 && (() => {
                                      const ratePct = interestRate ? Number(interestRate) : 0;
                                      const totalOwed = Number(principal) + (Number(principal) * ratePct) / 100;
                                      const sched = buildSchedule(totalOwed, frequency, new Date(), dueDate || null);
                                      return (
                                        <p className="text-[10px] text-muted-foreground leading-relaxed">
                                          {frequency === 'once'
                                            ? `One lump-sum pull of ${formatUGX(sched.installment)} on ${sched.firstDate}.`
                                            : `${sched.periods} installments of ~${formatUGX(sched.installment)} each. First on ${sched.firstDate}. Partial amounts are taken when the wallet is short and retried next cycle.`}
                                        </p>
                                      );
                                    })()}
                                  </>
                                )}
                              </div>
                              <div className="flex gap-2 pt-1">
                                <Button size="sm" variant="outline" className="flex-1" onClick={() => setShowLoanForm(false)}>Cancel</Button>
                                <Button size="sm" className="flex-1" onClick={handleDisburse} disabled={submitting}>
                                  {submitting && <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />}
                                  Confirm &amp; Record
                                </Button>
                              </div>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    </motion.div>
                  )}

                  {/* My published offers */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                        <Megaphone className="h-3.5 w-3.5" /> My Loan Offers
                      </Label>
                      <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setShowOfferForm((v) => !v)}>
                        <Plus className="h-3 w-3 mr-1" /> New Offer
                      </Button>
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      Published offers are visible to <span className="font-semibold">any user</span>, who can then request a loan from you.
                    </p>

                    {showOfferForm && (
                      <Card className="border-primary/30">
                        <CardContent className="p-3 space-y-2">
                          <div>
                            <Label className="text-xs">Title *</Label>
                            <Input value={offerForm.title} onChange={(e) => setOfferForm({ ...offerForm, title: e.target.value })} className="h-9 text-sm" />
                          </div>
                          <div>
                            <Label className="text-xs">Description</Label>
                            <Textarea value={offerForm.description} onChange={(e) => setOfferForm({ ...offerForm, description: e.target.value })} rows={2} className="text-sm resize-none" placeholder="Who is this for, terms, etc." />
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <Label className="text-xs">Min amount (UGX)</Label>
                              <Input type="number" value={offerForm.min_amount} onChange={(e) => setOfferForm({ ...offerForm, min_amount: e.target.value })} className="h-9 text-sm" />
                            </div>
                            <div>
                              <Label className="text-xs">Max amount (UGX)</Label>
                              <Input type="number" value={offerForm.max_amount} onChange={(e) => setOfferForm({ ...offerForm, max_amount: e.target.value })} className="h-9 text-sm" />
                            </div>
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            <div>
                              <Label className="text-xs">Interest %</Label>
                              <Input type="number" value={offerForm.interest_rate} onChange={(e) => setOfferForm({ ...offerForm, interest_rate: e.target.value })} min={0} className="h-9 text-sm" />
                            </div>
                            <div>
                              <Label className="text-xs">Min days</Label>
                              <Input type="number" value={offerForm.min_duration} onChange={(e) => setOfferForm({ ...offerForm, min_duration: e.target.value })} min={1} className="h-9 text-sm" />
                            </div>
                            <div>
                              <Label className="text-xs">Max days</Label>
                              <Input type="number" value={offerForm.max_duration} onChange={(e) => setOfferForm({ ...offerForm, max_duration: e.target.value })} min={1} className="h-9 text-sm" />
                            </div>
                          </div>
                          <Button size="sm" className="w-full" onClick={handleCreateOffer} disabled={savingOffer}>
                            {savingOffer && <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />}
                            Publish Offer
                          </Button>
                        </CardContent>
                      </Card>
                    )}

                    {offers.length === 0 && !showOfferForm ? (
                      <Card className="border-dashed">
                        <CardContent className="p-4 text-center">
                          <p className="text-xs text-muted-foreground">No offers yet. Publish one so users can request loans from you.</p>
                        </CardContent>
                      </Card>
                    ) : (
                      <div className="space-y-2">
                        {offers.map((offer) => (
                          <Card key={offer.id} className="border-border/60">
                            <CardContent className="p-3">
                              <div className="flex items-center justify-between mb-1">
                                <p className="text-sm font-bold truncate">{offer.title}</p>
                                <div className="flex items-center gap-2">
                                  <Switch checked={offer.active} onCheckedChange={(c) => toggleOffer(offer.id, c)} />
                                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => deleteOffer(offer.id)}>
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              </div>
                              <p className="text-[11px] text-muted-foreground">
                                {formatUGX(offer.min_amount_ugx)} – {formatUGX(offer.max_amount_ugx)} · {offer.interest_rate_pct}% · {offer.min_duration_days}-{offer.max_duration_days} days
                              </p>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* ===== ACTIVITY TAB ===== */}
              {tab === 'activity' && (
                <div className="space-y-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <ScrollText className="h-3.5 w-3.5" /> Activity Log
                  </Label>
                  {auditLog.length === 0 ? (
                    <Card className="border-dashed">
                      <CardContent className="p-8 text-center">
                        <ScrollText className="h-7 w-7 text-muted-foreground mx-auto mb-2" />
                        <p className="text-xs text-muted-foreground">No activity recorded yet.</p>
                      </CardContent>
                    </Card>
                  ) : (
                    <div className="space-y-1.5">
                      {auditLog.map((a) => {
                        const label = (a.action_type as string).replace(/_/g, ' ');
                        return (
                          <div key={a.id} className="flex items-start justify-between gap-2 rounded-xl border border-border/50 px-3 py-2.5">
                            <div className="min-w-0">
                              <p className="text-[11px] font-semibold capitalize text-foreground">{label}</p>
                              <p className="text-[10px] text-muted-foreground truncate">
                                {a.actor_display_name ?? 'User'}
                                {a.amount_ugx != null ? ` · ${formatUGX(Number(a.amount_ugx))}` : ''}
                                {a.fee_ugx != null ? ` · fee ${formatUGX(Number(a.fee_ugx))}` : ''}
                                {a.old_status && a.new_status ? ` · ${a.old_status} → ${a.new_status}` : ''}
                              </p>
                            </div>
                            <span className="text-[9px] text-muted-foreground whitespace-nowrap shrink-0">
                              {new Date(a.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Floating New Loan button (borrowers tab) */}
        {tab === 'borrowers' && !loansLoading && (
          <button
            onClick={goToNewLoan}
            className="fixed bottom-6 right-5 z-30 h-14 px-5 rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/30 flex items-center gap-2 font-semibold text-sm active:scale-95 transition-transform"
          >
            <Plus className="h-5 w-5" /> New Loan
          </button>
        )}

        <LendingAgentAgreementModal
          isOpen={showAgreement}
          onClose={() => setShowAgreement(false)}
          onAccept={handleAccept}
        />
      </SheetContent>
    </Sheet>
  );
}
