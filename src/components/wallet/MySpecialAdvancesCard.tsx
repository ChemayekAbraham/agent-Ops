import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, HandCoins, Info, Wallet } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useMySpecialAdvances, usePayFromWallet } from '@/hooks/useMySpecialAdvances';
import { newIdempotencyKey } from '@/lib/specialAdvances';
import {
  REPAYMENT_METHOD_LABEL, checkWalletAmount, describeWalletPaymentError, maxWalletPayment, nextInstalment,
  type MySpecialAdvance, type WalletRepaymentReceipt,
} from '@/lib/specialAdvanceWallet';

const ugx = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const day = (d: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';

/**
 * The signed-in borrower's Special Advances, with Pay from Wallet. Renders nothing when the user has none (or the
 * server does not offer it yet). Paying through the Merchant Line is unchanged: the finance team records it.
 */
export function MySpecialAdvancesCard({ onPaid }: { onPaid?: () => void }) {
  const { data } = useMySpecialAdvances();
  const [paying, setPaying] = useState<MySpecialAdvance | null>(null);
  if (!data || data.advances.length === 0) return null;
  const open = data.advances.filter((a) => a.status === 'disbursed');
  const settled = data.advances.filter((a) => a.status === 'settled');

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <HandCoins className="h-5 w-5 text-primary" aria-hidden />
          <h3 className="font-semibold">My Special Advances</h3>
        </div>

        {open.map((a) => {
          const next = nextInstalment(a);
          const canPay = maxWalletPayment(a.position.outstanding, data.wallet_available) > 0;
          return (
            <div key={a.id} className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{a.reference}</p>
                {a.position.overdue_amount > 0 && (
                  <Badge variant="destructive" className="gap-1">
                    <AlertTriangle className="h-3 w-3" aria-hidden /> {ugx(a.position.overdue_amount)} overdue
                  </Badge>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-md bg-muted p-2">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Outstanding</p>
                  <p className="text-lg font-bold tabular-nums">{ugx(a.position.outstanding)}</p>
                </div>
                <div className="rounded-md bg-muted p-2">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Wallet available</p>
                  <p className="text-lg font-bold tabular-nums">{ugx(data.wallet_available)}</p>
                </div>
              </div>
              {next && (
                <p className="text-xs text-muted-foreground">
                  Next instalment: {ugx(next.outstanding)}{next.due_date ? ` due ${day(next.due_date)}` : ''}
                </p>
              )}
              <Button className="w-full gap-2" disabled={!canPay} onClick={() => setPaying(a)}>
                <Wallet className="h-4 w-4" aria-hidden /> Pay from Wallet
              </Button>
              {!canPay && <p className="text-xs text-muted-foreground">Your wallet has no available balance to pay with.</p>}
              <div className="flex gap-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <p>You can also pay through the Welile Merchant Line; the finance team records that payment for you.</p>
              </div>
              {a.repayments.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-xs text-muted-foreground">Payments ({a.repayments.length})</summary>
                  <ul className="mt-2 divide-y divide-border">
                    {a.repayments.map((r) => (
                      <li key={r.id} className="flex items-center justify-between gap-3 py-1.5">
                        <div className="min-w-0">
                          <p className={r.reversed ? 'truncate line-through text-muted-foreground' : 'truncate'}>
                            {REPAYMENT_METHOD_LABEL[r.method] ?? r.method}
                          </p>
                          <p className="text-xs text-muted-foreground">{day(r.paid_on)} · {r.reference}{r.reversed ? ' · reversed' : ''}</p>
                        </div>
                        <p className="shrink-0 font-medium tabular-nums">{ugx(r.amount)}</p>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          );
        })}

        {settled.length > 0 && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden />
            Fully repaid: {settled.map((a) => a.reference).join(', ')}
          </p>
        )}
      </CardContent>

      {paying && (
        <PayFromWalletDialog
          advance={open.find((a) => a.id === paying.id) ?? paying}
          walletAvailable={data.wallet_available}
          onClose={() => setPaying(null)}
          onPaid={onPaid}
        />
      )}
    </Card>
  );
}

type Step = 'amount' | 'confirm' | 'done';

function PayFromWalletDialog({ advance, walletAvailable, onClose, onPaid }: {
  advance: MySpecialAdvance; walletAvailable: number; onClose: () => void; onPaid?: () => void;
}) {
  const pay = usePayFromWallet();
  const outstanding = advance.position.outstanding;
  const max = maxWalletPayment(outstanding, walletAvailable);
  const next = nextInstalment(advance);
  const [step, setStep] = useState<Step>('amount');
  const [text, setText] = useState(String(Math.min(next?.outstanding ?? max, max)));
  const [notice, setNotice] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<WalletRepaymentReceipt | null>(null);
  // one key per payment intent: a retry of the same payment reuses it and is never charged twice
  const keyRef = useRef(newIdempotencyKey());
  // the figures the borrower confirms against; if the server's have moved it refuses and we show the new ones
  const confirmed = useRef({ outstanding, walletAvailable });
  useEffect(() => {
    if (step === 'amount') confirmed.current = { outstanding, walletAvailable };
  }, [step, outstanding, walletAvailable]);

  const check = checkWalletAmount(text, outstanding, walletAvailable);
  const amount = check.ok ? check.amount : 0;
  const amountError = 'message' in check ? check.message : null;
  const chips = [
    next && next.outstanding <= max ? { label: 'Next instalment', value: next.outstanding } : null,
    advance.position.overdue_amount > 0 && advance.position.overdue_amount <= max && advance.position.overdue_amount !== next?.outstanding
      ? { label: 'Overdue', value: advance.position.overdue_amount } : null,
    outstanding <= walletAvailable ? { label: 'Full balance', value: outstanding } : { label: 'All my wallet', value: max },
  ].filter((c): c is { label: string; value: number } => !!c && c.value > 0);

  const submit = async () => {
    if (!check.ok || pay.isPending) return;
    setNotice(null);
    try {
      const r = await pay.mutateAsync({
        advanceId: advance.id, amount, expectedOutstanding: confirmed.current.outstanding, idempotencyKey: keyRef.current,
      });
      setReceipt(r);
      setStep('done');
      keyRef.current = newIdempotencyKey();
      onPaid?.();
    } catch (err) {
      const { message, refresh } = describeWalletPaymentError(err);
      setNotice(`${message} Nothing was taken from your wallet.`);
      if (refresh) {
        // the figures changed: start a new payment on the new figures
        keyRef.current = newIdempotencyKey();
        setStep('amount');
      }
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !pay.isPending) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-primary" aria-hidden />
            {step === 'done' ? 'Payment received' : 'Pay from Wallet'}
          </DialogTitle>
          <DialogDescription>Special Advance {advance.reference}</DialogDescription>
        </DialogHeader>

        {notice && (
          <div role="alert" className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> <p>{notice}</p>
          </div>
        )}

        {step === 'amount' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-md bg-muted p-2">
                <p className="text-[11px] text-muted-foreground">You owe</p>
                <p className="font-semibold tabular-nums">{ugx(outstanding)}</p>
              </div>
              <div className="rounded-md bg-muted p-2">
                <p className="text-[11px] text-muted-foreground">Wallet available</p>
                <p className="font-semibold tabular-nums">{ugx(walletAvailable)}</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sa-wallet-amount">Amount to pay (UGX)</Label>
              <Input id="sa-wallet-amount" inputMode="numeric" autoComplete="off" value={text}
                onChange={(e) => setText(e.target.value)} aria-invalid={!check.ok} />
              {amountError && text !== '' && <p className="text-xs text-destructive">{amountError}</p>}
            </div>
            {chips.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {chips.map((c) => (
                  <Button key={c.label} type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => setText(String(c.value))}>
                    {c.label} · {ugx(c.value)}
                  </Button>
                ))}
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button disabled={!check.ok} onClick={() => { setNotice(null); setStep('confirm'); }}>Continue</Button>
            </DialogFooter>
          </div>
        )}

        {step === 'confirm' && (
          <div className="space-y-3">
            <p className="text-sm">
              Pay <span className="font-semibold">{ugx(amount)}</span> from your wallet to Special Advance {advance.reference}?
            </p>
            <dl className="space-y-1.5 rounded-md border border-border p-3 text-sm">
              <Row label="Wallet now" value={ugx(confirmed.current.walletAvailable)} />
              <Row label="Wallet after" value={ugx(confirmed.current.walletAvailable - amount)} />
              <Row label="You owe now" value={ugx(confirmed.current.outstanding)} />
              <Row label="You will owe" value={ugx(confirmed.current.outstanding - amount)} strong />
            </dl>
            <p className="text-xs text-muted-foreground">The payment goes to the access fee first, then the principal, oldest instalment first.</p>
            <DialogFooter>
              <Button variant="outline" disabled={pay.isPending} onClick={() => setStep('amount')}>Back</Button>
              <Button disabled={pay.isPending} onClick={submit}>{pay.isPending ? 'Paying…' : 'Confirm payment'}</Button>
            </DialogFooter>
          </div>
        )}

        {step === 'done' && receipt && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              {receipt.status === 'settled' ? 'Your Special Advance is fully repaid.' : 'Your payment was recorded.'}
            </div>
            <dl className="space-y-1.5 rounded-md border border-border p-3 text-sm">
              <Row label="Receipt" value={receipt.receipt_reference} />
              <Row label="Amount paid" value={ugx(receipt.amount)} strong />
              <Row label="Applied to access fee" value={ugx(receipt.applied_to_access_fee)} />
              <Row label="Applied to principal" value={ugx(receipt.applied_to_principal)} />
              <Row label="You now owe" value={ugx(receipt.outstanding)} strong />
              <Row label="Wallet available" value={ugx(receipt.wallet_available)} />
            </dl>
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={strong ? 'font-semibold tabular-nums' : 'tabular-nums'}>{value}</dd>
    </div>
  );
}
