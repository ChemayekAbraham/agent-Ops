import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Calendar, Clock, TrendingUp, CheckCircle2,
  AlertCircle, Wallet, CircleDollarSign, Loader2,
  CalendarDays, Shield, Banknote,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useTenantRentPlan, usePayRentFromWallet } from '@/hooks/useTenantRentPlan';


/* ── Helpers ─────────────────────────────────────────────── */

const formatUGX = (n: number) =>
  `UGX ${n.toLocaleString('en-UG', { maximumFractionDigits: 0 })}`;

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-UG', { day: 'numeric', month: 'short', year: 'numeric' });

const daysRemaining = (end: string) => {
  const diff = new Date(end).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / 86400000));
};

/* ── Shape used by this page ─────────────────────────────── */

interface RentPlanData {
  id: string;
  status: 'repaying' | 'completed' | 'paused' | 'defaulted' | string;
  totalAmount: number;
  amountRepaid: number;
  dailyAmount: number;
  termDays: number;
  termStart: string;
  termEnd: string;
  obligationEnd: string;
  daysElapsed: number;
  behaviourScore: number;
  houseName: string;
  agentName: string;
  dueNow: number;
  /** Recent repayment events */
  recentPayments: { date: string; amount: number; method: string }[];
}


/* ── Circular Progress Ring ──────────────────────────────── */

function ProgressRing({ pct, size = 120, strokeWidth = 8 }: { pct: number; size?: number; strokeWidth?: number }) {
  const r = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (pct / 100) * circumference;
  return (
    <svg width={size} height={size} className="transform -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke="currentColor" className="text-muted/30" strokeWidth={strokeWidth} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke="currentColor" className="text-primary" strokeWidth={strokeWidth}
        strokeDasharray={circumference} strokeDashoffset={offset}
        strokeLinecap="round" style={{ transition: 'stroke-dashoffset 1s ease-out' }} />
    </svg>
  );
}

/* ── Main Page ──────────────────────────────────────────── */

export default function TenantRentPlan() {
  const navigate = useNavigate();
  const [showRepayForm, setShowRepayForm] = useState(false);
  const [repayAmount, setRepayAmount] = useState('');

  const { data, isLoading, isError, refetch } = useTenantRentPlan();
  const payRent = usePayRentFromWallet();

  const walletBalance = data?.walletBalance ?? 0;

  const plan: RentPlanData | null = useMemo(() => {
    const p = data?.plan;
    if (!p) return null;
    return {
      id: p.id,
      status: p.status,
      totalAmount: p.total_amount,
      amountRepaid: p.amount_repaid,
      dailyAmount: p.daily_amount,
      termDays: p.term_days,
      termStart: p.term_start,
      termEnd: p.term_end,
      obligationEnd: p.obligation_end,
      daysElapsed: p.days_elapsed,
      behaviourScore: p.behaviour_score,
      houseName: p.house_name,
      agentName: p.agent_name,
      dueNow: p.due_now,
      recentPayments: data?.recentPayments ?? [],
    };
  }, [data]);

  const balance = useMemo(
    () => (plan ? Math.max(0, plan.totalAmount - plan.amountRepaid) : 0),
    [plan],
  );
  const pctPaid = useMemo(
    () => (plan && plan.totalAmount > 0 ? Math.round((plan.amountRepaid / plan.totalAmount) * 100) : 0),
    [plan],
  );
  const remaining = useMemo(
    () => (plan ? daysRemaining(plan.obligationEnd) : 0),
    [plan],
  );

  const amountValue = Number(repayAmount) || 0;
  const amountError = useMemo(() => {
    if (!plan || amountValue <= 0) return '';
    if (amountValue > balance) return `More than your balance of ${formatUGX(balance)}.`;
    if (amountValue > walletBalance) return `Your wallet has ${formatUGX(walletBalance)}. Add money first.`;
    return '';
  }, [amountValue, balance, walletBalance, plan]);

  const handleConfirmPayment = async () => {
    if (amountValue <= 0 || amountError) return;
    try {
      const result = await payRent.mutateAsync(amountValue);
      toast.success(
        `Paid ${formatUGX(result.amount_paid)} — balance now ${formatUGX(result.remaining_balance)}`,
        { description: `Reference ${result.reference}` },
      );
      setShowRepayForm(false);
      setRepayAmount('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Payment failed');
    }
  };

  const scoreLabel = useMemo(() => {
    if (!plan) return '';
    if (plan.behaviourScore >= 80) return 'Excellent';
    if (plan.behaviourScore >= 60) return 'Good';
    if (plan.behaviourScore >= 40) return 'Fair';
    return 'Building';
  }, [plan]);

  const statusConfig = useMemo(() => {
    if (!plan) return { label: '', color: '', icon: AlertCircle };
    switch (plan.status) {
      case 'repaying': return { label: 'Active', color: 'text-primary bg-primary/10', icon: Clock };
      case 'completed': return { label: 'Completed', color: 'text-success bg-success/10', icon: CheckCircle2 };
      case 'paused': return { label: 'Paused', color: 'text-warning bg-warning/10', icon: AlertCircle };
      case 'defaulted': return { label: 'Overdue', color: 'text-destructive bg-destructive/10', icon: AlertCircle };
      default: return { label: 'Active', color: 'text-primary bg-primary/10', icon: Clock };
    }
  }, [plan]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Loading your Rent Plan…</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 gap-3">
        <p className="text-muted-foreground text-center">We could not load your Rent Plan just now.</p>
        <Button variant="outline" onClick={() => void refetch()}>Try again</Button>
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4">
        <p className="text-muted-foreground">No active Rent Plan found.</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate('/dashboard')}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back to Dashboard
        </Button>
      </div>
    );
  }



  return (
    <div className="min-h-screen bg-background pb-24">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-background/95 backdrop-blur-md border-b border-border">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => navigate('/dashboard')}
            className="flex items-center gap-1 text-sm font-semibold text-foreground rounded-lg px-2 py-1 -ml-2 hover:bg-accent/50 active:scale-95 transition-all"
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
          <h1 className="text-base font-bold">Your Rent Plan</h1>
        </div>
      </div>

      <main className="max-w-2xl mx-auto px-4 space-y-5 mt-5">
        {/* ── Hero card: progress ring + key numbers ── */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="rounded-xl border border-border p-5"
        >
          <div className="flex items-center gap-2 mb-4">
            <span className={`text-xs font-bold px-2.5 py-1 rounded-full inline-flex items-center gap-1 ${statusConfig.color}`}>
              <statusConfig.icon className="h-3 w-3" />
              {statusConfig.label}
            </span>
            <span className="text-xs text-muted-foreground ml-auto">{plan.houseName}</span>
          </div>

          <div className="flex items-center gap-6">
            {/* Progress ring */}
            <div className="relative flex-shrink-0">
              <ProgressRing pct={pctPaid} />
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl font-bold">{pctPaid}%</span>
                <span className="text-[10px] text-muted-foreground">paid</span>
              </div>
            </div>

            {/* Key metrics */}
            <div className="flex-1 space-y-2.5">
              <div>
                <p className="text-[11px] text-muted-foreground">Total Rent Plan</p>
                <p className="text-lg font-bold">{formatUGX(plan.totalAmount)}</p>
              </div>
              <div className="flex gap-4">
                <div>
                  <p className="text-[11px] text-muted-foreground">Paid</p>
                  <p className="text-sm font-semibold text-success">{formatUGX(plan.amountRepaid)}</p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">Balance</p>
                  <p className="text-sm font-semibold text-destructive">{formatUGX(balance)}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Progress bar */}
          <div className="mt-4">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1">
              <span>Repayment Progress</span>
              <span>{formatUGX(plan.amountRepaid)} / {formatUGX(plan.totalAmount)}</span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${pctPaid}%` }}
                transition={{ duration: 1, ease: 'easeOut' }}
                className="h-full rounded-full bg-primary"
              />
            </div>
          </div>
        </motion.div>

        {/* ── Stats grid ── */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05, duration: 0.4 }}
          className="grid grid-cols-2 gap-3"
        >
          <div className="rounded-xl border border-border p-4 space-y-1">
            <div className="flex items-center gap-2">
              <Banknote className="h-4 w-4 text-primary" />
              <span className="text-[11px] text-muted-foreground font-medium">Daily Rate</span>
            </div>
            <p className="text-lg font-bold">{formatUGX(plan.dailyAmount)}</p>
            <p className="text-[11px] text-muted-foreground">per day</p>
          </div>
          <div className="rounded-xl border border-border p-4 space-y-1">
            <div className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-primary" />
              <span className="text-[11px] text-muted-foreground font-medium">Days Left</span>
            </div>
            <p className="text-lg font-bold">{remaining}</p>
            <p className="text-[11px] text-muted-foreground">of {plan.termDays} days</p>
          </div>
          <div className="rounded-xl border border-border p-4 space-y-1">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-primary" />
              <span className="text-[11px] text-muted-foreground font-medium">Plan Period</span>
            </div>
            <p className="text-sm font-semibold">{formatDate(plan.termStart)}</p>
            <p className="text-[11px] text-muted-foreground">to {formatDate(plan.termEnd)}</p>
          </div>
          <div className="rounded-xl border border-border p-4 space-y-1">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              <span className="text-[11px] text-muted-foreground font-medium">Behaviour</span>
            </div>
            <p className="text-lg font-bold">{plan.behaviourScore}<span className="text-xs text-muted-foreground font-normal">/100</span></p>
            <p className="text-[11px] text-muted-foreground">{scoreLabel}</p>
          </div>
        </motion.div>

        {/* ── Make a Repayment CTA ── */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.4 }}
          className="rounded-xl border-2 border-primary/30 bg-primary/5 p-5 space-y-3"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="font-semibold text-base">Make a Repayment</p>
              <p className="text-sm text-muted-foreground">Next due: {formatUGX(plan.dueNow || plan.dailyAmount)} today</p>
              <p className="text-[11px] text-muted-foreground">Wallet: {formatUGX(walletBalance)}</p>
            </div>
            <CircleDollarSign className="h-8 w-8 text-primary" />
          </div>

          {!showRepayForm ? (
            <Button
              className="w-full gap-2 font-bold"
              onClick={() => setShowRepayForm(true)}
            >
              <Wallet className="h-4 w-4" />
              Pay Now
            </Button>
          ) : (
            <div className="space-y-3">
              {/* Quick amount chips */}
              <div className="flex flex-wrap gap-2">
                {[
                  Math.min(plan.dailyAmount || balance, balance),
                  Math.min((plan.dailyAmount || balance) * 2, balance),
                  Math.min((plan.dailyAmount || balance) * 7, balance),
                  balance,
                ].map((amt, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setRepayAmount(String(amt))}
                    className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                      String(amt) === repayAmount
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background text-foreground border-border hover:bg-muted'
                    }`}
                  >
                    {i === 0 ? '1 day' : i === 1 ? '2 days' : i === 2 ? '1 week' : 'Full balance'}
                    <span className="ml-1 opacity-70">{formatUGX(amt)}</span>
                  </button>
                ))}
              </div>

              {/* Custom amount */}
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">UGX</span>
                <input
                  type="number"
                  value={repayAmount}
                  onChange={(e) => setRepayAmount(e.target.value)}
                  placeholder="Enter amount"
                  className="w-full rounded-xl border border-border bg-background px-3 pl-12 py-3 text-sm font-semibold tabular-nums focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>

              {amountError && (
                <p className="text-xs font-medium text-destructive">{amountError}</p>
              )}

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  disabled={payRent.isPending}
                  onClick={() => { setShowRepayForm(false); setRepayAmount(''); }}
                >
                  Cancel
                </Button>
                <Button
                  className="flex-1 gap-2 font-bold"
                  disabled={amountValue <= 0 || !!amountError || payRent.isPending}
                  onClick={() => void handleConfirmPayment()}
                >
                  {payRent.isPending
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Wallet className="h-4 w-4" />}
                  {payRent.isPending ? 'Paying…' : 'Confirm Payment'}
                </Button>
              </div>
            </div>
          )}
        </motion.div>

        {/* ── Plan Details ── */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.4 }}
        >
          <h2 className="font-semibold text-base mb-3">Plan Details</h2>
          <div className="rounded-xl border border-border divide-y divide-border">
            <DetailRow label="House" value={plan.houseName} />
            <DetailRow label="Agent" value={plan.agentName} />
            <DetailRow label="Rent Plan Amount" value={formatUGX(plan.totalAmount)} />
            <DetailRow label="Daily Repayment" value={formatUGX(plan.dailyAmount)} />
            <DetailRow label="Term" value={`${plan.termDays} days`} />
            <DetailRow label="Start Date" value={formatDate(plan.termStart)} />
            <DetailRow label="End Date" value={formatDate(plan.termEnd)} />
            <DetailRow label="Obligation End" value={formatDate(plan.obligationEnd)} />
          </div>
        </motion.div>

        {/* ── Recent Payments Timeline ── */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.4 }}
        >
          <h2 className="font-semibold text-base mb-3">Recent Payments</h2>
          {plan.recentPayments.length > 0 ? (
            <div className="space-y-0">
              {plan.recentPayments.map((p, i) => (
                <div key={i} className="flex items-center gap-3 py-3 border-b border-border/50 last:border-b-0">
                  <div className="w-8 h-8 rounded-full bg-success/10 flex items-center justify-center shrink-0">
                    <CheckCircle2 className="h-4 w-4 text-success" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{formatUGX(p.amount)}</p>
                    <p className="text-[11px] text-muted-foreground">{p.method}</p>
                  </div>
                  <span className="text-xs text-muted-foreground">{formatDate(p.date)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-4 text-center">No payments recorded yet.</p>
          )}
        </motion.div>

        {/* ── Info notice ── */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25, duration: 0.4 }}
          className="rounded-xl bg-muted/50 border border-border/50 p-4 flex items-start gap-3"
        >
          <Shield className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium">How Rent Plans work</p>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Welile pays your landlord up front. You repay daily over your agreed term.
              Paying on time improves your behaviour score, unlocking higher rent limits.
              Contact your agent if you need to adjust your plan.
            </p>
          </div>
        </motion.div>
      </main>

      {/* ── Sticky bottom bar ── */}
      <div className="fixed bottom-0 left-0 right-0 bg-background/95 backdrop-blur-md border-t border-border z-40">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-[11px] text-muted-foreground font-medium">Balance Due</p>
            <p className="text-lg font-bold text-destructive leading-tight">{formatUGX(balance)}</p>
          </div>
          <Button
            className="gap-2 font-bold"
            onClick={() => {
              setShowRepayForm(true);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            <Wallet className="h-4 w-4" />
            Pay Now
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────── */

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-right">{value}</span>
    </div>
  );
}
