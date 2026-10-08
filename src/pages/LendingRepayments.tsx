import { safeUUID } from '@/lib/safeUUID';
import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, Wallet, Check, Loader2, CalendarDays, Receipt, CheckCircle2, AlertTriangle, Clock } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';

interface Installment { due_date: string; amount_ugx: number; paid_ugx: number; status: string }
interface Payment { amount_ugx: number; paid_at: string; method: 'auto' | 'you' | 'agent' }
interface Loan {
  id: string; lender_name: string; principal_ugx: number; total_owed_ugx: number;
  repaid_ugx: number; outstanding_ugx: number; status: string; end_date: string | null;
  schedule: Installment[]; payments: Payment[];
}

const STATUS: Record<string, { label: string; cls: string; Icon: typeof Clock }> = {
  paid: { label: 'Paid', cls: 'text-primary', Icon: CheckCircle2 },
  overdue: { label: 'Late', cls: 'text-destructive', Icon: AlertTriangle },
  due_today: { label: 'Today', cls: 'text-destructive', Icon: Clock },
  part_paid: { label: 'Part paid', cls: 'text-muted-foreground', Icon: Clock },
  upcoming: { label: 'Coming', cls: 'text-muted-foreground', Icon: CalendarDays },
};
const METHOD: Record<string, string> = { auto: 'Taken automatically', you: 'You paid', agent: 'Paid to agent' };
const day = (d: string) => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export default function LendingRepayments() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [loans, setLoans] = useState<Loan[]>([]);
  const [available, setAvailable] = useState(0);
  const [loading, setLoading] = useState(true);
  const [payFor, setPayFor] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [paying, setPaying] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.functions.invoke('lending-borrower-pay', { body: { action: 'list' } });
    if (error) toast.error('Could not load your loans');
    else { setLoans(data?.loans ?? []); setAvailable(data?.available_ugx ?? 0); }
    setLoading(false);
  }, []);

  useEffect(() => {
    document.title = 'My loans · Welile';
    if (authLoading) return;
    if (!user) { navigate(`/auth?redirect=${encodeURIComponent('/repay')}`); return; }
    load();
  }, [user, authLoading, load, navigate]);

  const pay = async (loan: Loan) => {
    const amt = Math.floor(Number(amount) || 0);
    if (amt <= 0) { toast.error('Enter an amount'); return; }
    setPaying(true);
    const { data, error } = await supabase.functions.invoke('lending-borrower-pay', {
      body: { action: 'pay', loan_id: loan.id, amount: amt, request_id: safeUUID() },
    });
    setPaying(false);
    if (error || data?.error) {
      let msg = data?.error;
      try { msg = msg || (await (error as any)?.context?.json())?.error; } catch { /* ignore */ }
      toast.error(msg || 'Payment failed. No money was taken.');
      return;
    }
    toast.success(data.fully_repaid ? 'Paid in full. Well done!' : `Paid ${formatUGX(amt)}. Left: ${formatUGX(data.remaining_ugx)}`);
    setPayFor(null); setAmount('');
    load();
  };

  return (
    <main className="mx-auto min-h-[100dvh] max-w-md px-4 pb-16 pt-5">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" className="h-11 w-11" onClick={() => navigate(-1)} aria-label="Back">
          <ArrowLeft className="h-6 w-6" />
        </Button>
        <h1 className="text-xl font-bold">My loans</h1>
      </div>

      <Card className="mt-3 rounded-2xl">
        <CardContent className="flex items-center gap-3 p-4">
          <Wallet className="h-8 w-8 text-primary" />
          <div>
            <p className="text-xs text-muted-foreground">Money in your wallet</p>
            <p className="text-xl font-bold">{formatUGX(available)}</p>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="mt-4 space-y-3"><Skeleton className="h-48 rounded-2xl" /><Skeleton className="h-48 rounded-2xl" /></div>
      ) : loans.length === 0 ? (
        <p className="mt-10 text-center text-muted-foreground">You have no loans.</p>
      ) : (
        <div className="mt-4 space-y-4">
          {loans.map((loan) => {
            const open = loan.status === 'active' || loan.status === 'partially_repaid';
            const pct = loan.total_owed_ugx > 0 ? Math.min(100, Math.round((loan.repaid_ugx / loan.total_owed_ugx) * 100)) : 0;
            const next = loan.schedule.find((s) => s.status !== 'paid');
            const nextLeft = next ? next.amount_ugx - next.paid_ugx : 0;
            const late = loan.schedule.filter((s) => s.status === 'overdue').reduce((a, s) => a + s.amount_ugx - s.paid_ugx, 0);
            const daysToNext = next ? Math.round((new Date(next.due_date + 'T00:00:00').getTime() - new Date(new Date().toDateString()).getTime()) / 86400000) : 99;
            const soon = late === 0 && daysToNext <= 2;
            return (
              <Card key={loan.id} className="rounded-2xl overflow-hidden">
                <CardContent className="p-4 space-y-3">
                  <div>
                    <p className="text-xs text-muted-foreground">From {loan.lender_name}</p>
                    <p className="text-xs text-muted-foreground mt-2">You still owe</p>
                    <p className="text-3xl font-bold">{formatUGX(loan.outstanding_ugx)}</p>
                    <Progress value={pct} className="mt-2 h-2" />
                    <p className="mt-1 text-xs text-muted-foreground">{pct}% paid · {formatUGX(loan.repaid_ugx)} of {formatUGX(loan.total_owed_ugx)}</p>
                  </div>

                  {open && next && (
                    <div role={late > 0 || soon ? 'alert' : undefined} className={`rounded-xl p-3 ${late > 0 ? 'bg-destructive/10' : soon ? 'bg-accent/30 border border-accent' : 'bg-primary/10'}`}>
                      <p className="text-xs font-semibold">{late > 0 ? 'You are late' : daysToNext <= 0 ? '⏰ Pay today to stay on time' : soon ? `⏰ Due in ${daysToNext} day${daysToNext === 1 ? '' : 's'}` : 'Next payment'}</p>
                      <p className="text-lg font-bold">{formatUGX(late > 0 ? late : nextLeft)}</p>
                      {late === 0 && <p className="text-xs text-muted-foreground">by {day(next.due_date)}</p>}
                    </div>
                  )}

                  {open && (payFor === loan.id ? (
                    <div className="space-y-2 rounded-xl border p-3">
                      <p className="text-sm font-bold">How much will you pay?</p>
                      <Input type="number" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)}
                        placeholder="UGX" className="h-12 text-lg font-bold" />
                      <div className="grid grid-cols-2 gap-2">
                        {nextLeft > 0 && (
                          <Button variant="outline" className="h-11 text-xs font-semibold" onClick={() => setAmount(String(late > 0 ? late : nextLeft))}>
                            {late > 0 ? 'Late amount' : 'This payment'}
                          </Button>
                        )}
                        <Button variant="outline" className="h-11 text-xs font-semibold" onClick={() => setAmount(String(loan.outstanding_ugx))}>
                          Pay all
                        </Button>
                      </div>
                      <Button className="h-12 w-full text-base font-bold" disabled={paying} onClick={() => pay(loan)}>
                        {paying ? <Loader2 className="h-5 w-5 animate-spin" /> : <><Check className="mr-1 h-5 w-5" /> Pay from wallet</>}
                      </Button>
                      <Button variant="ghost" className="h-10 w-full" onClick={() => { setPayFor(null); setAmount(''); }}>Cancel</Button>
                    </div>
                  ) : (
                    <Button className="h-14 w-full text-base font-bold" onClick={() => { setPayFor(loan.id); setAmount(String(late > 0 ? late : nextLeft || '')); }}>
                      <Wallet className="mr-2 h-5 w-5" /> Pay now
                    </Button>
                  ))}

                  <div>
                    <p className="flex items-center gap-1.5 text-sm font-bold"><CalendarDays className="h-4 w-4" /> Payment plan</p>
                    <ul className="mt-2 divide-y rounded-xl border">
                      {loan.schedule.map((s, i) => {
                        const st = STATUS[s.status] ?? STATUS.upcoming;
                        return (
                          <li key={i} className="flex items-center justify-between gap-2 px-3 py-2.5">
                            <div>
                              <p className="text-sm font-semibold">{formatUGX(s.amount_ugx)}</p>
                              <p className="text-xs text-muted-foreground">Due {day(s.due_date)}</p>
                            </div>
                            <span className={`flex items-center gap-1 text-xs font-bold ${st.cls}`}>
                              <st.Icon className="h-4 w-4" />
                              {s.status === 'part_paid' || (s.paid_ugx > 0 && s.status !== 'paid') ? `${formatUGX(s.paid_ugx)} paid` : st.label}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>

                  <div>
                    <p className="flex items-center gap-1.5 text-sm font-bold"><Receipt className="h-4 w-4" /> Money paid</p>
                    {loan.payments.length === 0 ? (
                      <p className="mt-1 text-xs text-muted-foreground">No payments yet.</p>
                    ) : (
                      <ul className="mt-2 divide-y rounded-xl border">
                        {loan.payments.map((p, i) => (
                          <li key={i} className="flex items-center justify-between px-3 py-2.5">
                            <div>
                              <p className="text-sm font-semibold">{formatUGX(p.amount_ugx)}</p>
                              <p className="text-xs text-muted-foreground">{METHOD[p.method]}</p>
                            </div>
                            <p className="text-xs text-muted-foreground">{day(p.paid_at)}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </main>
  );
}
