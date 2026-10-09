import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Phone, MessageCircle, MessageSquare, HandCoins, Loader2, ChevronDown,
  CheckCircle2, Clock, AlertTriangle, CalendarClock, Repeat, PlusCircle, CalendarPlus, Check, Share2,
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { LendingLoan, outstandingOf, dueStateOf, normalizePhone, repaymentPlanOf } from './lendingHelpers';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { motion } from 'framer-motion';

interface Props {
  loan: LendingLoan;
  onRecordRepayment: (loan: LendingLoan, amount: number) => Promise<void>;
  onTopUpOrRenew?: (loan: LendingLoan, extra: number, newDue: string) => Promise<void>;
}

const DAY_CHOICES = [7, 14, 30, 60];

function DayPicker({ value, onChange }: { value: number; onChange: (d: number) => void }) {
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {DAY_CHOICES.map((d) => (
        <Button key={d} variant={value === d ? 'default' : 'outline'} className="h-12 flex-col gap-0 text-sm font-bold leading-tight"
          onClick={() => onChange(d)}>
          {d}<span className="text-[10px] font-medium">days</span>
        </Button>
      ))}
    </div>
  );
}

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'bg-primary/15 text-primary' },
  partially_repaid: { label: 'Part-paid', cls: 'bg-amber-500/15 text-amber-700' },
  repaid: { label: 'Repaid', cls: 'bg-emerald-500/15 text-emerald-700' },
  defaulted: { label: 'Defaulted', cls: 'bg-destructive/15 text-destructive' },
};

const DUE_STYLE: Record<string, { label: string; cls: string; Icon: typeof Clock }> = {
  overdue: { label: 'Overdue', cls: 'bg-destructive/15 text-destructive', Icon: AlertTriangle },
  due_today: { label: 'Due today', cls: 'bg-amber-500/20 text-amber-700', Icon: Clock },
  due_soon: { label: 'Due soon', cls: 'bg-amber-500/10 text-amber-600', Icon: CalendarClock },
};

export default function LendingBorrowerCard({ loan, onRecordRepayment, onTopUpOrRenew }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<null | 'paid' | 'add' | 'time'>(null);
  const [payAmount, setPayAmount] = useState('');
  const [extra, setExtra] = useState('');
  const [days, setDays] = useState(30);
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);

  const name = loan.borrower_display_name ?? loan.borrower_ai_id;
  const phone = normalizePhone(loan.borrower_phone);
  const outstanding = outstandingOf(loan);
  const plan = repaymentPlanOf(loan);
  const totalDue = loan.principal_ugx + (loan.principal_ugx * (Number(loan.interest_rate_pct) || 0)) / 100;
  const repaidPct = totalDue > 0 ? Math.min(100, Math.round((Number(loan.amount_repaid_ugx) / totalDue) * 100)) : 0;
  const isOpen = loan.status === 'active' || loan.status === 'partially_repaid';
  const due = dueStateOf(loan);
  const statusStyle = STATUS_STYLE[loan.status] ?? STATUS_STYLE.active;
  const dueStyle = DUE_STYLE[due];
  const autoOn = !!loan.auto_deduct_enabled && isOpen;

  // New end date: count from today, or from the current end date if that is still ahead.
  const currentDue = loan.expected_repayment_date ? new Date(loan.expected_repayment_date) : null;
  const base = currentDue && currentDue.getTime() > Date.now() ? currentDue : new Date();
  const newDue = new Date(base.getTime() + days * 86400000).toISOString().slice(0, 10);
  const extraNum = Number(extra) || 0;
  const rate = Number(loan.interest_rate_pct) || 0;
  const previewBalance = Math.round(outstanding + extraNum * (1 + rate / 100));

  const submitTopUp = async (amount: number) => {
    if (!onTopUpOrRenew) return;
    setSaving(true);
    try {
      await onTopUpOrRenew(loan, amount, newDue);
      setExtra('');
      setMode(null);
    } finally {
      setSaving(false);
    }
  };

  const contact = (kind: 'call' | 'wa' | 'sms') => {
    if (!phone) { toast.error('No phone number on file for this borrower'); return; }
    const msg = encodeURIComponent(
      `Hello ${name}, this is a reminder about your Welile loan. Outstanding balance: ${formatUGX(outstanding)}.`,
    );
    const url =
      kind === 'call' ? `tel:+${phone}` :
      kind === 'wa' ? `https://wa.me/${phone}?text=${msg}` :
      `sms:+${phone}?body=${msg}`;
    window.open(url, kind === 'wa' ? '_blank' : '_self');
  };

  const shareHistory = async () => {
    if (!phone) { toast.error('No phone number on file for this borrower'); return; }
    setSharing(true);
    try {
      const { data, error } = await (supabase
        .from('lending_audit_log' as any)
        .select('amount_ugx, created_at')
        .eq('entity_id', loan.id)
        .eq('action_type', 'repayment_recorded')
        .order('created_at', { ascending: true })
        .limit(200) as any);
      if (error) throw error;
      const rows: { amount_ugx: number; created_at: string }[] = data ?? [];
      const fmt = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Kampala' });
      const paid = rows.reduce((a, r) => a + Number(r.amount_ugx || 0), 0);
      const lines = [
        `Hello ${name}, here is your Welile loan repayment history:`,
        '',
        `Loan: ${formatUGX(loan.principal_ugx)} @ ${rate}% = ${formatUGX(totalDue)}`,
        `Taken on: ${fmt(loan.created_at)}`,
        '',
        rows.length ? 'Payments:' : 'No payments recorded yet.',
        ...rows.map((r, i) => `${i + 1}. ${fmt(r.created_at)} - ${formatUGX(Number(r.amount_ugx))}`),
        '',
        `Total paid: ${formatUGX(Math.max(paid, Number(loan.amount_repaid_ugx) || 0))}`,
        `Still owed: ${formatUGX(outstanding)}`,
        loan.expected_repayment_date ? `Due date: ${fmt(loan.expected_repayment_date)}` : '',
      ].filter((l, i, a) => !(l === '' && a[i - 1] === ''));
      window.open(`https://wa.me/${phone}?text=${encodeURIComponent(lines.join('\n'))}`, '_blank');
    } catch {
      toast.error('Could not load repayment history. Try again.');
    } finally {
      setSharing(false);
    }
  };

  const submitPayment = async () => {
    const amt = Number(payAmount);
    if (!amt || amt <= 0) { toast.error('Enter a valid amount'); return; }
    setSaving(true);
    try {
      await onRecordRepayment(loan, amt);
      setPayAmount('');
      setMode(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="border-border/60 overflow-hidden">
      <CardContent className="p-0">
        {/* Tap row */}
        <button
          className="w-full text-left p-3.5 active:bg-muted/40 transition-colors"
          onClick={() => setExpanded((v) => !v)}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="h-9 w-9 rounded-full bg-gradient-to-br from-primary/20 to-emerald-500/20 flex items-center justify-center shrink-0 text-xs font-bold text-foreground">
                {name.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">{name}</p>
                <p className="text-[11px] text-muted-foreground font-mono truncate">{loan.borrower_ai_id}</p>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              <Badge className={`${statusStyle.cls} border-0 text-[9px] font-bold`}>{statusStyle.label}</Badge>
              {dueStyle && (
                <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-bold ${dueStyle.cls}`}>
                  <dueStyle.Icon className="h-2.5 w-2.5" />{dueStyle.label}
                </span>
              )}
            </div>
          </div>

          <div className="mt-2.5 flex items-end justify-between gap-2">
            <div>
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-bold">Outstanding</p>
              <p className="text-base font-bold text-foreground leading-none">{formatUGX(outstanding)}</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] text-muted-foreground">
                {formatUGX(loan.principal_ugx)} @ {loan.interest_rate_pct ?? 0}%
              </p>
              {loan.expected_repayment_date && (
                <p className="text-[10px] text-muted-foreground">
                  Due {new Date(loan.expected_repayment_date).toLocaleDateString()}
                </p>
              )}
            </div>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <Progress value={repaidPct} className="h-1.5 flex-1" />
            <span className="text-[9px] text-muted-foreground font-semibold tabular-nums">{repaidPct}%</span>
            <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </div>

          {/* Repayment plan — visible at a glance without expanding */}
          {plan && (
            <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-lg bg-muted/50 px-2.5 py-1.5 text-[10px] font-semibold text-muted-foreground">
              <span className="inline-flex items-center gap-1 text-primary">
                <Repeat className="h-3 w-3" /> {plan.frequencyLabel}
              </span>
              {plan.frequency !== 'once' && (
                <span>· {formatUGX(plan.installment)} each</span>
              )}
              <span>
                · {plan.remainingCount} {plan.remainingCount === 1 ? 'payment' : 'payments'} left
              </span>
              {plan.nextDueDate && (
                <span className={plan.nextDueInPast ? 'text-destructive' : ''}>
                  · Next {new Date(plan.nextDueDate).toLocaleDateString()}
                </span>
              )}
            </div>
          )}

          {!expanded && (
            <p className="mt-2 text-center text-xs font-semibold text-primary">Tap to pay, add money or give more time</p>
          )}
          {autoOn && plan && (
            <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[9px] font-semibold text-primary">
              <Repeat className="h-2.5 w-2.5" />
              Money is taken automatically {plan.nextDueDate ? `· next ${new Date(plan.nextDueDate).toLocaleDateString()}` : ''}
            </div>
          )}
        </button>

        {/* Expanded actions — big picture buttons, few words */}
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="border-t border-border/60 bg-muted/20 px-3.5 py-3 space-y-3"
          >
            {/* Plan at a glance — three big tiles */}
            {plan && (
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-xl bg-background border p-2.5 text-center">
                  <p className="text-[9px] uppercase tracking-wide text-muted-foreground font-bold">Left to pay</p>
                  <p className="text-sm font-bold text-foreground leading-tight mt-0.5">{formatUGX(outstanding)}</p>
                </div>
                <div className="rounded-xl bg-background border p-2.5 text-center">
                  <p className="text-[9px] uppercase tracking-wide text-muted-foreground font-bold">Payments left</p>
                  <p className="text-sm font-bold text-foreground leading-tight mt-0.5">{plan.remainingCount}</p>
                </div>
                <div className="rounded-xl bg-background border p-2.5 text-center">
                  <p className="text-[9px] uppercase tracking-wide text-muted-foreground font-bold">Next payment</p>
                  <p className={`text-sm font-bold leading-tight mt-0.5 ${plan.nextDueInPast ? 'text-destructive' : 'text-foreground'}`}>
                    {plan.nextDueDate ? new Date(plan.nextDueDate).toLocaleDateString() : '—'}
                  </p>
                </div>
              </div>
            )}

            <div className="grid grid-cols-3 gap-2">
              <Button variant="outline" className="h-16 flex-col gap-1 text-xs font-semibold" onClick={() => contact('call')}>
                <Phone className="h-6 w-6 text-primary" /> Call
              </Button>
              <Button variant="outline" className="h-16 flex-col gap-1 text-xs font-semibold" onClick={() => contact('wa')}>
                <MessageCircle className="h-6 w-6 text-primary" /> WhatsApp
              </Button>
              <Button variant="outline" className="h-16 flex-col gap-1 text-xs font-semibold" onClick={() => contact('sms')}>
                <MessageSquare className="h-6 w-6 text-primary" /> SMS
              </Button>
            </div>

            <Button variant="outline" className="h-11 w-full gap-2 text-xs font-semibold" onClick={shareHistory} disabled={sharing}>
              {sharing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4 text-primary" />}
              Share repayment history on WhatsApp
            </Button>

            <div className="grid grid-cols-3 gap-2">
              {isOpen && (
                <Button
                  variant={mode === 'paid' ? 'default' : 'secondary'}
                  className="h-20 flex-col gap-1 text-xs font-bold"
                  onClick={() => setMode(mode === 'paid' ? null : 'paid')}
                >
                  <HandCoins className="h-7 w-7" /> Got paid
                </Button>
              )}
              <Button
                variant={mode === 'add' ? 'default' : 'secondary'}
                className={`h-20 flex-col gap-1 text-xs font-bold ${isOpen ? '' : 'col-span-2'}`}
                onClick={() => setMode(mode === 'add' ? null : 'add')}
              >
                <PlusCircle className="h-7 w-7" /> {isOpen ? 'Add money' : 'Lend again'}
              </Button>
              <Button
                variant={mode === 'time' ? 'default' : 'secondary'}
                className="h-20 flex-col gap-1 text-xs font-bold"
                onClick={() => setMode(mode === 'time' ? null : 'time')}
              >
                <CalendarPlus className="h-7 w-7" /> More time
              </Button>
            </div>

            {mode === 'paid' && isOpen && (
              <div className="space-y-2 rounded-xl bg-background border p-3">
                <p className="text-sm font-bold">How much did they pay?</p>
                <Input
                  type="number" inputMode="numeric" value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  placeholder="UGX" className="h-12 text-lg font-bold"
                />
                <div className="grid grid-cols-3 gap-1.5">
                  {[0.25, 0.5, 1].map((frac) => (
                    <Button key={frac} variant="outline" className="h-10 text-xs font-semibold"
                      onClick={() => setPayAmount(String(Math.round(outstanding * frac)))}>
                      {frac === 1 ? 'All' : `${frac * 100}%`}
                    </Button>
                  ))}
                </div>
                <Button className="h-12 w-full text-base font-bold" onClick={submitPayment} disabled={saving}>
                  {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <><Check className="h-5 w-5 mr-1" /> Save</>}
                </Button>
              </div>
            )}

            {mode === 'add' && (
              <div className="space-y-2 rounded-xl bg-background border p-3">
                <p className="text-sm font-bold">How much more to give?</p>
                <Input
                  type="number" inputMode="numeric" value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                  placeholder="UGX" className="h-12 text-lg font-bold"
                />
                <div className="grid grid-cols-3 gap-1.5">
                  {[50000, 100000, 200000].map((v) => (
                    <Button key={v} variant="outline" className="h-10 text-xs font-semibold" onClick={() => setExtra(String(v))}>
                      {v / 1000}K
                    </Button>
                  ))}
                </div>
                <p className="text-sm font-bold pt-1">Pay back in</p>
                <DayPicker value={days} onChange={setDays} />
                {extraNum > 0 && (
                  <div className="rounded-lg bg-primary/10 p-2.5 text-center">
                    <p className="text-[11px] text-muted-foreground">New total to pay back</p>
                    <p className="text-xl font-bold text-primary">{formatUGX(previewBalance)}</p>
                    <p className="text-[11px] text-muted-foreground">by {new Date(newDue).toLocaleDateString()}</p>
                  </div>
                )}
                <Button className="h-12 w-full text-base font-bold" onClick={() => submitTopUp(extraNum)} disabled={saving || extraNum <= 0}>
                  {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <><Check className="h-5 w-5 mr-1" /> Give money</>}
                </Button>
              </div>
            )}

            {mode === 'time' && (
              <div className="space-y-2 rounded-xl bg-background border p-3">
                <p className="text-sm font-bold">Give how many more days?</p>
                <DayPicker value={days} onChange={setDays} />
                <div className="rounded-lg bg-primary/10 p-2.5 text-center">
                  <p className="text-[11px] text-muted-foreground">New last day</p>
                  <p className="text-xl font-bold text-primary">{new Date(newDue).toLocaleDateString()}</p>
                </div>
                <Button className="h-12 w-full text-base font-bold" onClick={() => submitTopUp(0)} disabled={saving}>
                  {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <><Check className="h-5 w-5 mr-1" /> Save</>}
                </Button>
              </div>
            )}

            {!isOpen && mode === null && (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4 text-primary" /> Fully paid. Tap "Lend again" to give more.
              </p>
            )}
          </motion.div>
        )}
      </CardContent>
    </Card>
  );
}
