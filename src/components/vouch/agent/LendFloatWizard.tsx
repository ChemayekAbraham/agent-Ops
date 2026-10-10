import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Search, ArrowLeft, CheckCircle2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { safeUUID } from '@/lib/safeUUID';
import { toast } from 'sonner';
import { buildSchedule, type RepaymentFrequency } from './lendingHelpers';

interface Match { user_id: string; full_name: string | null; phone: string | null; city: string | null; ai_id: string }

const FREQS: { value: RepaymentFrequency; label: string }[] = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' },
  { value: 'once', label: 'All at once' },
];
const QUICK_AMOUNTS = [50000, 100000, 200000, 500000];
const QUICK_DAYS = [7, 14, 30, 60];

export default function LendFloatWizard({ open, onOpenChange, floatAvailable, onDone }: {
  open: boolean; onOpenChange: (o: boolean) => void; floatAvailable: number; onDone: () => void;
}) {
  const [step, setStep] = useState(1);
  const [phone, setPhone] = useState('');
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState<Match[]>([]);
  const [who, setWho] = useState<Match | null>(null);
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('10');
  const [days, setDays] = useState(30);
  const [freq, setFreq] = useState<RepaymentFrequency>('daily');
  const [sending, setSending] = useState(false);
  const [requestId] = useState(() => safeUUID());

  const reset = () => { setStep(1); setPhone(''); setMatches([]); setWho(null); setAmount(''); setRate('10'); setDays(30); setFreq('daily'); };
  const close = (o: boolean) => { if (!o) reset(); onOpenChange(o); };

  const principal = Math.floor(Number(amount) || 0);
  const total = Math.round(principal * (1 + (Number(rate) || 0) / 100));
  const due = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const schedule = buildSchedule(total, freq, new Date(), due);

  const search = async () => {
    const digits = phone.replace(/[^0-9]/g, '');
    if (digits.length < 9) { toast.error('Enter the full phone number'); return; }
    setSearching(true);
    const { data, error } = await (supabase.rpc('lending_find_user_by_phone', { p_phone: digits }) as any);
    setSearching(false);
    if (error) { toast.error(String(error.message).includes('lending_agreement_required') ? 'Sign the lending agreement first' : 'Could not search that number'); return; }
    const rows = (data ?? []) as Match[];
    if (!rows.length) { toast.error('No Welile user on that number'); return; }
    if (rows.length === 1) { setWho(rows[0]); setStep(2); } else setMatches(rows);
  };

  const send = async () => {
    if (!who) return;
    setSending(true);
    const { data, error } = await supabase.functions.invoke('lending-borrower-pay', {
      body: { action: 'disburse', request_id: requestId, borrower_user_id: who.user_id, borrower_ai_id: who.ai_id,
        principal, interest_rate_pct: Number(rate) || 0, due_date: due, frequency: freq,
        installment: schedule.installment, first_date: schedule.firstDate },
    });
    setSending(false);
    const msg = (data as any)?.error || (error ? await (error as any)?.context?.json?.().then((j: any) => j?.error).catch(() => null) : null);
    if (error || !(data as any)?.ok) { toast.error(msg || 'Loan failed. No float was sent.'); return; }
    toast.success(`${formatUGX(principal)} float sent to ${who.full_name ?? 'borrower'}`);
    onDone();
    close(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md max-sm:h-[100dvh] max-sm:max-w-none max-sm:rounded-none max-sm:overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step > 1 && <button aria-label="Back" onClick={() => setStep(step - 1)}><ArrowLeft className="h-5 w-5" /></button>}
            Lend float · Step {step} of 3 · {['','Borrower','Amount & schedule','Confirm'][step]}
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground -mt-2">Your float available: <span className="font-semibold text-foreground">{formatUGX(floatAvailable)}</span></p>

        {step === 1 && (
          <div className="space-y-3">
            <Label className="text-base">Who are you lending to?</Label>
            <div className="flex gap-2">
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="0700 000 000" className="h-14 text-lg" onKeyDown={(e) => e.key === 'Enter' && search()} />
              <Button onClick={search} disabled={searching} className="h-14 w-14">{searching ? <Loader2 className="h-5 w-5 animate-spin" /> : <Search className="h-5 w-5" />}</Button>
            </div>
            {matches.map((m) => (
              <button key={m.user_id} onClick={() => { setWho(m); setStep(2); }} className="w-full text-left rounded-xl border border-border p-3 hover:bg-muted/40">
                <p className="font-semibold">{m.full_name || 'Unnamed user'}</p>
                <p className="text-xs text-muted-foreground">{m.phone || '—'} · {m.city || '—'}</p>
              </button>
            ))}
          </div>
        )}

        {step === 2 && who && (
          <div className="space-y-3">
            <p className="text-sm">Lending to <span className="font-semibold">{who.full_name}</span></p>
            <Label className="text-base">How much?</Label>
            <Input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" placeholder="UGX" className="h-14 text-2xl font-bold" />
            <div className="grid grid-cols-4 gap-2">
              {QUICK_AMOUNTS.map((a) => <Button key={a} variant="outline" size="sm" onClick={() => setAmount(String(a))}>{a / 1000}K</Button>)}
            </div>
            <Label>Interest %</Label>
            <Input value={rate} onChange={(e) => setRate(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" className="h-12 text-lg" />
            {principal > 0 && <p className="text-sm">They will pay back <span className="font-bold">{formatUGX(total)}</span></p>}
            <Label className="text-base">How will they pay back?</Label>
            <div className="grid grid-cols-2 gap-2">
              {FREQS.map((f) => <Button key={f.value} variant={freq === f.value ? 'default' : 'outline'} className="h-12" onClick={() => setFreq(f.value)}>{f.label}</Button>)}
            </div>
            <Label>Finish paying within</Label>
            <div className="grid grid-cols-4 gap-2">
              {QUICK_DAYS.map((d) => <Button key={d} variant={days === d ? 'default' : 'outline'} onClick={() => setDays(d)}>{d} days</Button>)}
            </div>
            <Button className="w-full h-14 text-base" disabled={principal < 1000 || principal > floatAvailable} onClick={() => setStep(3)}>
              {principal > floatAvailable ? 'Not enough float' : 'Next'}
            </Button>
          </div>
        )}

        {step === 3 && who && (
          <div className="space-y-3">
            <Label className="text-base">Confirm your loan</Label>
            <div className="rounded-xl bg-muted/40 p-3 text-sm space-y-2">
              <p>Borrower: <span className="font-bold">{who.full_name}</span> · {who.phone || '—'}</p>
              <p>Send now: <span className="font-bold">{formatUGX(principal)}</span> from your float to their float</p>
              <p>Interest: {rate || 0}% · They pay back <span className="font-bold">{formatUGX(total)}</span></p>
              <p>They pay: <span className="font-bold">{formatUGX(schedule.installment)}</span> {freq === 'once' ? 'once' : FREQS.find((f) => f.value === freq)?.label.toLowerCase()}, taken automatically</p>
              <p>Last day: {due}</p>
              <p className="text-xs text-muted-foreground">Each repayment: your money back goes to your float, the interest goes to your main wallet.</p>
            </div>
            <Button className="w-full h-14 text-base" onClick={send} disabled={sending}>
              {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <><CheckCircle2 className="h-5 w-5 mr-2" />Confirm &amp; send {formatUGX(principal)}</>}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
