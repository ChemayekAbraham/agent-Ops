import { useState } from 'react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Search, Loader2, ArrowLeft, Check, User, Banknote, CalendarClock,
  ShieldCheck, PartyPopper, Phone, X,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';
import { RepaymentFrequency, buildSchedule } from './lendingHelpers';

type Person = { user_id: string; full_name: string | null; phone: string | null; city: string | null };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lendablePool: number;
  onDone: () => void;
}

const PLATFORM_FEE_PCT = 0.01;

const AMOUNTS = [50000, 100000, 200000, 500000, 1000000];
const RATES = [0, 5, 10, 15, 20];
const PLANS: { freq: RepaymentFrequency; days: number; label: string; sub: string }[] = [
  { freq: 'daily', days: 30, label: 'Every day', sub: 'Small bit daily for 1 month' },
  { freq: 'weekly', days: 28, label: 'Every week', sub: 'Once a week for 4 weeks' },
  { freq: 'monthly', days: 30, label: 'Every month', sub: 'Once a month' },
  { freq: 'once', days: 30, label: 'All at once', sub: 'Full amount in 1 month' },
];

function addDays(days: number): string {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Guided, low-literacy-friendly flow: find person -> money -> plan -> send. */
export default function GiveLoanWizard({ open, onOpenChange, lendablePool, onDone }: Props) {
  const [step, setStep] = useState(1);
  const [phone, setPhone] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<Person[]>([]);
  const [person, setPerson] = useState<Person | null>(null);
  const [amount, setAmount] = useState<number>(0);
  const [rate, setRate] = useState<number>(10);
  const [planIdx, setPlanIdx] = useState<number>(2);
  const [sending, setSending] = useState(false);
  const [sentAmount, setSentAmount] = useState(0);

  const plan = PLANS[planIdx];
  const fee = Math.round(amount * PLATFORM_FEE_PCT);
  const totalOwed = amount + (amount * rate) / 100;
  const sched = buildSchedule(totalOwed, plan.freq, new Date(), addDays(plan.days));

  const reset = () => {
    setStep(1); setPhone(''); setResults([]); setPerson(null);
    setAmount(0); setRate(10); setPlanIdx(2); setSending(false); setSentAmount(0);
  };

  const close = (v: boolean) => { onOpenChange(v); if (!v) reset(); };

  const doSearch = async () => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 9) { toast.error('Type the full phone number'); return; }
    setSearching(true);
    const { data, error } = await (supabase.rpc('lending_find_user_by_phone' as any, { p_phone: phone }) as any);
    setSearching(false);
    if (error) {
      toast.error(error.message?.includes('lending_agreement_required')
        ? 'Sign the Lending Agent Agreement first'
        : 'Search failed');
      return;
    }
    const rows = (data ?? []) as Person[];
    setResults(rows);
    if (rows.length === 0) { toast.error('Nobody found on that number'); return; }
    if (rows.length === 1) { setPerson(rows[0]); setStep(2); }
  };

  const send = async () => {
    if (!person || !amount) return;
    if (amount + fee > lendablePool) {
      toast.error(`Not enough money in your wallet. You need ${formatUGX(amount + fee)}`);
      return;
    }
    setSending(true);
    const { data, error } = await supabase.functions.invoke('lending-disburse-loan', {
      body: {
        borrower_user_id: person.user_id,
        borrower_ai_id: null,
        principal_ugx: amount,
        interest_rate_pct: rate,
        expected_repayment_date: addDays(plan.days),
        loan_purpose: null,
        repayment_frequency: plan.freq,
        auto_deduct_enabled: plan.freq !== 'once',
      },
    });
    setSending(false);
    const failure = (error as any) || (data as any)?.error;
    if (failure) {
      let msg = (data as any)?.error ?? (error as any)?.message ?? 'Sending failed';
      if (error && (error as any).context?.text) {
        try { msg = JSON.parse(await (error as any).context.text())?.error ?? msg; } catch { /* keep msg */ }
      }
      toast.error(msg);
      return;
    }
    setSentAmount(amount);
    setStep(5);
    onDone();
  };

  const STEP_LABELS = ['Find the person', 'Choose the money', 'Profit & payback', 'Check & send'];

  const StepDots = () => (
    <div className="flex items-center gap-1.5">
      {[1, 2, 3, 4].map((s) => (
        <span
          key={s}
          className={`h-1.5 rounded-full transition-all ${
            step >= s ? 'w-6 bg-primary' : 'w-3 bg-muted'
          }`}
        />
      ))}
    </div>
  );

  const Chip = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button
      onClick={onClick}
      className={`rounded-2xl border-2 px-4 py-3 text-base font-bold transition-colors ${
        active ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-card text-muted-foreground'
      }`}
    >
      {children}
    </button>
  );

  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent side="bottom" className="h-[96vh] overflow-y-auto rounded-t-3xl p-0 [&>button]:hidden">
        {/* Header */}
        <div className="sticky top-0 z-20 bg-background/95 backdrop-blur-md border-b px-4 py-3 flex items-center gap-3">
          {step > 1 && step < 5 ? (
            <button
              onClick={() => setStep(step - 1)}
              aria-label="Go back"
              className="h-11 w-11 rounded-full bg-muted flex items-center justify-center active:scale-95 transition-transform"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          ) : (
            <div className="h-11 w-11 rounded-2xl bg-gradient-to-br from-emerald-500 to-primary flex items-center justify-center">
              <Banknote className="h-5 w-5 text-primary-foreground" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-lg font-extrabold leading-none truncate">Give a loan</p>
            {step < 5 ? (
              <>
                <p className="mt-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                  Step {step} of 4 · {STEP_LABELS[step - 1]}
                </p>
                <div className="mt-1.5"><StepDots /></div>
              </>
            ) : (
              <p className="mt-1 text-[11px] font-bold uppercase tracking-wide text-emerald-600">Finished</p>
            )}
          </div>
          <button
            onClick={() => close(false)}
            aria-label="Close"
            className="h-11 w-11 rounded-full bg-muted flex items-center justify-center active:scale-95 transition-transform"
          >
            <X className="h-5 w-5" />
          </button>
        </div>


        <div className="px-4 py-5 pb-16 space-y-5">
          {/* STEP 1 — find person */}
          {step === 1 && (
            <>
              <div className="flex items-center gap-2">
                <Phone className="h-5 w-5 text-primary" />
                <p className="text-xl font-extrabold">Who do you want to pay?</p>
              </div>
              <p className="text-sm text-muted-foreground">Type their phone number.</p>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="07XX XXX XXX"
                inputMode="tel"
                className="h-16 text-2xl font-bold text-center rounded-2xl tracking-wider"
                onKeyDown={(e) => e.key === 'Enter' && doSearch()}
              />
              <Button onClick={doSearch} disabled={searching} className="w-full h-16 text-lg font-extrabold rounded-2xl">
                {searching ? <Loader2 className="h-6 w-6 mr-2 animate-spin" /> : <Search className="h-6 w-6 mr-2" />}
                Find person
              </Button>

              {results.length > 1 && (
                <div className="space-y-2">
                  <p className="text-sm font-bold">Choose the right person</p>
                  {results.map((r) => (
                    <button
                      key={r.user_id}
                      onClick={() => { setPerson(r); setStep(2); }}
                      className="w-full flex items-center gap-3 rounded-2xl border-2 border-border p-4 text-left active:bg-muted"
                    >
                      <div className="h-11 w-11 rounded-full bg-primary/10 flex items-center justify-center">
                        <User className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <p className="text-base font-bold">{r.full_name ?? 'Welile user'}</p>
                        <p className="text-sm text-muted-foreground">{r.phone}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {/* STEP 2 — amount */}
          {step === 2 && person && (
            <>
              <div className="rounded-2xl bg-muted/50 p-4 flex items-center gap-3">
                <div className="h-11 w-11 rounded-full bg-primary/10 flex items-center justify-center">
                  <User className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-base font-bold">{person.full_name ?? 'Welile user'}</p>
                  <p className="text-sm text-muted-foreground">{person.phone}</p>
                </div>
              </div>
              <p className="text-xl font-extrabold">How much money?</p>
              <div className="grid grid-cols-2 gap-2.5">
                {AMOUNTS.map((a) => (
                  <Chip key={a} active={amount === a} onClick={() => setAmount(a)}>{formatUGX(a)}</Chip>
                ))}
              </div>
              <Input
                type="number"
                value={amount || ''}
                onChange={(e) => setAmount(Number(e.target.value))}
                placeholder="Other amount"
                className="h-16 text-2xl font-bold text-center rounded-2xl"
              />
              <p className="text-sm text-muted-foreground">
                Your wallet has <span className="font-bold text-foreground">{formatUGX(lendablePool)}</span>
              </p>
              <div className="sticky bottom-0 -mx-4 px-4 pt-3 pb-4 bg-gradient-to-t from-background via-background to-transparent">
                <Button
                  onClick={() => setStep(3)}
                  disabled={!amount || amount <= 0}
                  className="w-full h-16 text-lg font-extrabold rounded-2xl"
                >
                  Next
                </Button>
              </div>
            </>
          )}

          {/* STEP 3 — profit + plan */}
          {step === 3 && (
            <>
              <p className="text-xl font-extrabold">How much profit do you want?</p>
              <div className="grid grid-cols-3 gap-2.5">
                {RATES.map((r) => (
                  <Chip key={r} active={rate === r} onClick={() => setRate(r)}>{r}%</Chip>
                ))}
              </div>
              <Input
                type="number"
                value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
                className="h-14 text-xl font-bold text-center rounded-2xl"
              />
              <div className="rounded-2xl bg-emerald-500/10 border border-emerald-500/30 p-4">
                <p className="text-sm text-muted-foreground">They pay back in total</p>
                <p className="text-2xl font-extrabold text-emerald-600">{formatUGX(Math.round(totalOwed))}</p>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <CalendarClock className="h-5 w-5 text-primary" />
                <p className="text-xl font-extrabold">How will they pay back?</p>
              </div>
              <div className="space-y-2">
                {PLANS.map((p, i) => (
                  <button
                    key={p.freq}
                    onClick={() => setPlanIdx(i)}
                    className={`w-full rounded-2xl border-2 p-4 text-left transition-colors ${
                      planIdx === i ? 'border-primary bg-primary/10' : 'border-border bg-card'
                    }`}
                  >
                    <p className="text-base font-bold">{p.label}</p>
                    <p className="text-sm text-muted-foreground">{p.sub}</p>
                  </button>
                ))}
              </div>
              <div className="sticky bottom-0 -mx-4 px-4 pt-3 pb-4 bg-gradient-to-t from-background via-background to-transparent">
                <Button onClick={() => setStep(4)} className="w-full h-16 text-lg font-extrabold rounded-2xl">
                  Next
                </Button>
              </div>
            </>
          )}

          {/* STEP 4 — confirm */}
          {step === 4 && person && (
            <>
              <p className="text-xl font-extrabold">Check before you send</p>
              <div className="rounded-2xl border-2 border-border divide-y">
                <Row label="To" value={person.full_name ?? 'Welile user'} sub={person.phone ?? undefined} />
                <Row label="You send" value={formatUGX(amount)} />
                <Row label="Welile fee (1%)" value={formatUGX(fee)} />
                <Row label="Leaves your wallet" value={formatUGX(amount + fee)} />
                <Row label="They pay back" value={formatUGX(Math.round(totalOwed))} />
                <Row
                  label="Payments"
                  value={plan.freq === 'once' ? `1 payment of ${formatUGX(sched.installment)}` : `${sched.periods} × ${formatUGX(sched.installment)}`}
                  sub={`${plan.label} · first on ${sched.firstDate}`}
                />
              </div>
              <div className="rounded-2xl bg-emerald-500/10 border border-emerald-500/30 p-4 flex items-start gap-3">
                <ShieldCheck className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
                <p className="text-sm leading-relaxed">
                  Welile pays you back <span className="font-bold">100% of your money</span> if they fail to pay.
                </p>
              </div>
              <div className="sticky bottom-0 -mx-4 px-4 pt-3 pb-4 bg-gradient-to-t from-background via-background to-transparent space-y-2">
                <Button onClick={send} disabled={sending} className="w-full h-16 text-lg font-extrabold rounded-2xl">
                  {sending ? <Loader2 className="h-6 w-6 mr-2 animate-spin" /> : <Check className="h-6 w-6 mr-2" />}
                  Send the money
                </Button>
                <Button variant="ghost" onClick={() => setStep(3)} className="w-full h-11 text-sm font-bold rounded-2xl">
                  Change something
                </Button>
              </div>
            </>
          )}

          {/* STEP 5 — done */}
          {step === 5 && (
            <div className="pt-10 text-center space-y-4">
              <div className="h-20 w-20 mx-auto rounded-full bg-emerald-500/15 flex items-center justify-center">
                <PartyPopper className="h-10 w-10 text-emerald-600" />
              </div>
              <p className="text-2xl font-extrabold">Money sent!</p>
              <p className="text-base text-muted-foreground">
                {formatUGX(sentAmount)} is now in {person?.full_name ?? 'the borrower'}'s wallet. They got an SMS with the payment plan.
              </p>
              <div className="space-y-2 pt-2">
                <Button onClick={() => { reset(); }} variant="outline" className="w-full h-14 text-base font-bold rounded-2xl">
                  Give another loan
                </Button>
                <Button onClick={() => close(false)} className="w-full h-14 text-base font-bold rounded-2xl">
                  Done
                </Button>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Row({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <div className="text-right">
        <p className="text-base font-bold">{value}</p>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}
