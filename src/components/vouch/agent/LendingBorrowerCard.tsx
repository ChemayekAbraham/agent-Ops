import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Phone, MessageCircle, MessageSquare, HandCoins, Loader2, ChevronDown,
  CheckCircle2, FileText, Clock, AlertTriangle, CalendarClock, Repeat, PlusCircle, CalendarPlus, Check, Share2, ShieldAlert,
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { generateRepaymentHistoryPdf, filterPayments, PaymentStatusFilter } from '@/lib/lendingRepaymentPdf';
import { LendingLoan, outstandingOf, dueStateOf, normalizePhone, repaymentPlanOf, fundingSourceMeta } from './lendingHelpers';
import { toast } from 'sonner';
import PdfPagePreview from './PdfPagePreview';
import { supabase } from '@/integrations/supabase/client';
import { motion } from 'framer-motion';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface Props {
  loan: LendingLoan;
  /** Amount Welile vouches for this borrower (undefined while loading). */
  vouchLimit?: number;
  onRecordRepayment: (loan: LendingLoan, amount: number) => Promise<void>;
  onTopUpOrRenew?: (loan: LendingLoan, extra: number, newDue: string) => Promise<void>;
  onSetRecovery?: (loan: LendingLoan, on: boolean) => Promise<void>;
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

export default function LendingBorrowerCard({ loan, vouchLimit, onRecordRepayment, onTopUpOrRenew, onSetRecovery }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [customDue, setCustomDue] = useState('');
  const [mode, setMode] = useState<null | 'paid' | 'add' | 'time'>(null);
  const [payAmount, setPayAmount] = useState('');
  const [extra, setExtra] = useState('');
  const [days, setDays] = useState(30);
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfPreview, setPdfPreview] = useState<{ file: File; url: string } | null>(null);
  const closePreview = () => { setPdfPreview((p) => { if (p) URL.revokeObjectURL(p.url); return null; }); };
  useEffect(() => () => { if (pdfPreview) URL.revokeObjectURL(pdfPreview.url); }, [pdfPreview]);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [pdfFrom, setPdfFrom] = useState('');
  const [pdfTo, setPdfTo] = useState('');
  const [pdfStatus, setPdfStatus] = useState<PaymentStatusFilter>('all');
  const [history, setHistory] = useState<{ amount_ugx: number; created_at: string }[] | null>(null);

  const name = loan.borrower_display_name ?? loan.borrower_ai_id;
  const phone = normalizePhone(loan.borrower_phone);
  const funding = fundingSourceMeta((loan as any).funding_source);
  const outstanding = outstandingOf(loan);
  const plan = repaymentPlanOf(loan);
  const totalDue = loan.principal_ugx + (loan.principal_ugx * (Number(loan.interest_rate_pct) || 0)) / 100;
  const repaidPct = totalDue > 0 ? Math.min(100, Math.round((Number(loan.amount_repaid_ugx) / totalDue) * 100)) : 0;
  const isOpen = loan.status === 'active' || loan.status === 'partially_repaid';
  const due = dueStateOf(loan);
  const statusStyle = STATUS_STYLE[loan.status] ?? STATUS_STYLE.active;
  const dueStyle = DUE_STYLE[due];
  const accessed = isOpen ? Number(loan.principal_ugx) || 0 : 0;
  const PLAN_CAP = 5_000_000;
  const availableTopUp = vouchLimit === undefined ? null : Math.max(0, Math.min(vouchLimit - accessed, PLAN_CAP - accessed));
  const autoOn = !!loan.auto_deduct_enabled && isOpen;

  // New end date: count from today, or from the current end date if that is still ahead.
  const currentDue = loan.expected_repayment_date ? new Date(loan.expected_repayment_date) : null;
  const base = currentDue && currentDue.getTime() > Date.now() ? currentDue : new Date();
  const todayStr = new Date().toISOString().slice(0, 10);
  const newDue = customDue && customDue >= todayStr
    ? customDue
    : new Date(base.getTime() + days * 86400000).toISOString().slice(0, 10);
  const inRecovery = !!loan.recovery_started_at && isOpen;

  const toggleRecovery = async () => {
    if (!onSetRecovery) return;
    setSaving(true);
    try { await onSetRecovery(loan, !inRecovery); } finally { setSaving(false); }
  };
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

  const downloadPdf = async () => {
    setPdfBusy(true);
    try {
      const { data, error } = await (supabase
        .from('lending_audit_log' as any)
        .select('amount_ugx, created_at')
        .eq('entity_id', loan.id)
        .eq('action_type', 'repayment_recorded')
        .order('created_at', { ascending: true })
        .limit(500) as any);
      if (error) throw error;
      let agentName: string | null = null;
      let fundingBreakdown: { label: string; loans: number; totalDue: number; repaid: number; outstanding: number }[] | undefined;
      try {
        const { data: u } = await supabase.auth.getUser();
        if (u?.user) {
          const { data: pr } = await (supabase.from('profiles' as any).select('full_name').eq('id', u.user.id).maybeSingle() as any);
          agentName = pr?.full_name ?? null;
          const { data: bl } = await (supabase.from('lending_agent_loans' as any)
            .select('*').eq('lender_agent_id', u.user.id).eq('borrower_ai_id', loan.borrower_ai_id).limit(200) as any);
          const groups = new Map<string, { label: string; loans: number; totalDue: number; repaid: number; outstanding: number }>();
          for (const l of ((bl ?? [loan]) as LendingLoan[])) {
            const meta = fundingSourceMeta(l.funding_source);
            const g = groups.get(meta.label) ?? { label: meta.label, loans: 0, totalDue: 0, repaid: 0, outstanding: 0 };
            g.loans += 1;
            g.totalDue += l.principal_ugx + (l.principal_ugx * (Number(l.interest_rate_pct) || 0)) / 100;
            g.repaid += Number(l.amount_repaid_ugx) || 0;
            g.outstanding += outstandingOf(l);
            groups.set(meta.label, g);
          }
          fundingBreakdown = [...groups.values()];
        }
      } catch { /* optional */ }
      const blob = await generateRepaymentHistoryPdf({
        agentName,
        borrowerName: name,
        borrowerPhone: loan.borrower_phone,
        principal: loan.principal_ugx,
        ratePct: rate,
        totalDue,
        amountRepaid: Number(loan.amount_repaid_ugx) || 0,
        outstanding,
        takenOn: loan.created_at,
        dueDate: loan.expected_repayment_date,
        status: loan.status,
        fundingLabel: funding.label,
        fundingBreakdown,
        filterNote: (pdfFrom || pdfTo || pdfStatus !== 'all')
          ? [pdfFrom || pdfTo ? `${pdfFrom || 'start'} to ${pdfTo || 'today'}` : '', pdfStatus === 'on_time' ? 'on-time payments' : pdfStatus === 'late' ? 'late payments' : ''].filter(Boolean).join(', ')
          : null,
        payments: filterPayments(data ?? [], pdfFrom, pdfTo, pdfStatus, loan.expected_repayment_date),
      });
      const file = new File([blob], `repayment-history-${name.replace(/\W+/g, '-')}.pdf`, { type: 'application/pdf' });
      setPdfOpen(false);
      setPdfPreview({ file, url: URL.createObjectURL(file) });
    } catch {
      toast.error('Could not create the PDF. Try again.');
    } finally {
      setPdfBusy(false);
    }
  };

  const sharePreview = async () => {
    if (!pdfPreview) return;
    const { file, url } = pdfPreview;
    const nav: any = navigator;
    if (nav.canShare?.({ files: [file] })) {
      try { await nav.share({ files: [file], title: 'Repayment history' }); return; } catch (e: any) { if (e?.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = url; a.download = file.name; a.click();
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

  // Repayment history for this loan, labeled with the funding source the
  // money came from (repayments return to that same source).
  useEffect(() => {
    if (!expanded) { setHistory(null); return; }
    let cancelled = false;
    (async () => {
      const { data } = await (supabase
        .from('lending_audit_log' as any)
        .select('amount_ugx, created_at')
        .eq('entity_id', loan.id)
        .eq('action_type', 'repayment_recorded')
        .order('created_at', { ascending: false })
        .limit(50) as any);
      if (!cancelled) setHistory((data ?? []) as { amount_ugx: number; created_at: string }[]);
    })();
    return () => { cancelled = true; };
  }, [expanded, loan.id]);

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
              <Badge className={`${funding.cls} border-0 text-[9px] font-bold`}>{funding.label}</Badge>
              <Badge className={`${statusStyle.cls} border-0 text-[9px] font-bold`}>{statusStyle.label}</Badge>
              {inRecovery && <Badge className="bg-destructive/15 text-destructive border-0 text-[9px] font-bold">In recovery</Badge>}
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

          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-muted/50 px-2.5 py-1.5">
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-bold">Accessed</p>
              <p className="text-sm font-bold text-foreground">{formatUGX(accessed)}</p>
            </div>
            <div className="rounded-lg bg-primary/10 px-2.5 py-1.5">
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-bold">Available top-up</p>
              <p className="text-sm font-bold text-primary">{availableTopUp === null ? '…' : formatUGX(availableTopUp)}</p>
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

        {/* Quick top-up — one tap straight to the top-up form */}
        {isOpen && mode !== 'add' && (
          <div className="border-t border-border/60 px-3.5 py-2.5">
            <Button
              className="h-11 w-full gap-2 text-sm font-bold"
              onClick={() => { setExpanded(true); setMode('add'); }}
            >
              <PlusCircle className="h-4 w-4" /> Top up
              {availableTopUp !== null && availableTopUp > 0 && (
                <span className="text-[11px] font-semibold opacity-80">· up to {formatUGX(availableTopUp)}</span>
              )}
            </Button>
          </div>
        )}

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

            {/* Repayment history — each payment labeled with where the money goes */}
            {history !== null && (
              <div className="rounded-xl bg-background border p-3 space-y-1.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">
                  Repayment history · funded from {funding.label}
                </p>
                {history.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No payments recorded yet.</p>
                ) : (
                  history.map((r, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-muted-foreground">
                        {new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                      </span>
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className={`rounded px-1 py-0.5 text-[9px] font-bold whitespace-nowrap ${funding.cls}`}>{funding.label}</span>
                        <span className="font-semibold tabular-nums">{formatUGX(Number(r.amount_ugx))}</span>
                      </span>
                    </div>
                  ))
                )}
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

            <Button variant="outline" className="h-11 w-full gap-2 text-xs font-semibold" onClick={() => setPdfOpen(true)} disabled={pdfBusy}>
              {pdfBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4 text-primary" />}
              Repayment history PDF (share or save)
            </Button>

            {pdfOpen && (
              <div className="rounded-xl border bg-muted/30 p-3 space-y-3">
                <p className="text-xs font-semibold">PDF filters</p>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[10px] text-muted-foreground">From
                    <Input type="date" value={pdfFrom} max={pdfTo || undefined} onChange={(e) => setPdfFrom(e.target.value)} className="h-10 mt-1" />
                  </label>
                  <label className="text-[10px] text-muted-foreground">To
                    <Input type="date" value={pdfTo} min={pdfFrom || undefined} onChange={(e) => setPdfTo(e.target.value)} className="h-10 mt-1" />
                  </label>
                </div>
                <div className="flex gap-1.5">
                  {([['all', 'All payments'], ['on_time', 'On time'], ['late', 'Late']] as const).map(([k, l]) => (
                    <Button key={k} type="button" size="sm" variant={pdfStatus === k ? 'default' : 'outline'}
                      className="h-9 flex-1 text-xs" onClick={() => setPdfStatus(k)}>{l}</Button>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground">On time = paid on or before the loan's due date.</p>
                <div className="flex gap-2">
                  <Button variant="ghost" className="h-10 flex-1 text-xs" onClick={() => setPdfOpen(false)}>Cancel</Button>
                  <Button className="h-10 flex-1 text-xs gap-1.5" onClick={downloadPdf} disabled={pdfBusy}>
                    {pdfBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />} Preview PDF
                  </Button>
                </div>
              </div>
            )}

            <Dialog open={!!pdfPreview} onOpenChange={(o) => { if (!o) closePreview(); }}>
              <DialogContent className="max-w-2xl w-[calc(100vw-1rem)] h-[90vh] p-3 flex flex-col gap-2">
                <DialogHeader><DialogTitle className="text-sm">Preview: repayment history</DialogTitle></DialogHeader>
                {pdfPreview && (
                  <PdfPagePreview url={pdfPreview.url} />
                )}
                <div className="grid grid-cols-3 gap-2">
                  <Button variant="ghost" className="h-11 text-xs" onClick={closePreview}>Close</Button>
                  <Button variant="outline" className="h-11 text-xs" onClick={() => pdfPreview && window.open(pdfPreview.url, '_blank')}>Open full</Button>
                  <Button className="h-11 text-xs gap-1.5" onClick={sharePreview}><Share2 className="h-4 w-4" />Share / Save</Button>
                </div>
              </DialogContent>
            </Dialog>

            {isOpen && onSetRecovery && (inRecovery || due === 'overdue') && (
              <Button variant={inRecovery ? 'secondary' : 'destructive'} className="h-11 w-full gap-2 text-xs font-semibold"
                onClick={toggleRecovery} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
                {inRecovery ? 'Take out of recovery' : 'Mark as in recovery'}
              </Button>
            )}

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
                <DayPicker value={days} onChange={(d) => { setCustomDue(''); setDays(d); }} />
                <p className="text-sm font-bold pt-1">Or pick a new last day</p>
                <Input type="date" value={customDue} min={todayStr}
                  onChange={(e) => setCustomDue(e.target.value)} className="h-12 text-base font-bold" />
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
