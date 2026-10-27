import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { kampalaLabel, kampalaTodayYmd } from '@/lib/kampalaDays';
import { rateLabel } from '@/lib/specialAdvancePreview';
import { STATUS_LABEL, describeSpecialAdvanceError, newIdempotencyKey, type SpecialAdvanceStatement } from '@/lib/specialAdvances';
import {
  useDisburseSpecialAdvance, useRecordSpecialAdvanceRepayment, useSpecialAdvanceDecision, useSpecialAdvanceStatement,
} from '@/hooks/useSpecialAdvances';

const EVENT_TEXT: Record<string, string> = {
  created: 'Recorded', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled', disbursed: 'Paid out', settled: 'Settled',
};
const INSTALMENT_TEXT: Record<string, string> = { paid: 'Paid', not_due: 'Not paid out', overdue: 'Overdue', part_paid: 'Part paid', due: 'Due' };

/**
 * One Special Advance: the server statement and the actions its status allows. Every action is a CFO-only server
 * function; approval and payout are refused by the server while issuance is switched off, so they are disabled here
 * too. Reject, cancel and repayments stay available.
 */
export function SpecialAdvanceDetailSheet({ advanceId, issuanceEnabled, onOpenChange }: {
  advanceId: string | null; issuanceEnabled: boolean; onOpenChange: (open: boolean) => void;
}) {
  const st = useSpecialAdvanceStatement(advanceId);
  const a = st.data;
  return (
    <Sheet open={!!advanceId} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader className="text-left">
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {a ? <><span className="font-mono text-sm text-primary">{a.reference}</span><span>{a.borrower_name ?? 'Borrower'}</span></> : 'Special Advance'}
          </SheetTitle>
          <SheetDescription>{a ? `${STATUS_LABEL[a.status]} · ${a.borrower_kind === 'external' ? 'External borrower' : 'Welile account'}` : 'Loading...'}</SheetDescription>
        </SheetHeader>
        {st.isLoading && <p className="py-10 text-center text-xs text-muted-foreground">Loading...</p>}
        {st.isError && <p role="alert" className="py-10 text-center text-xs text-destructive">{describeSpecialAdvanceError(st.error)}</p>}
        {a && (
          <div className="mt-5 space-y-6 text-xs">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
              <Item label="Agreed rate" value={rateLabel(a.rate_percent, a.rate_basis)} />
              <Item label="Term" value={`${a.term_days} days, ${a.frequency} repayments`} />
              <Item label="Principal" value={formatUGX(a.principal)} />
              <Item label="Access fee" value={formatUGX(a.access_fee)} />
              <Item label="Registration fee" value={formatUGX(a.registration_fee)} />
              <Item label="Total repayable" value={formatUGX(a.total_repayable)} />
              <Item label="Paid" value={formatUGX(a.position.total_paid)} />
              <Item label="Outstanding" value={formatUGX(a.position.outstanding)} />
              {a.position.overdue_amount > 0 && <Item label="Overdue" value={`${formatUGX(a.position.overdue_amount)} (${a.position.overdue_instalments} instalment${a.position.overdue_instalments === 1 ? '' : 's'})`} />}
              {a.payout_date && <Item label="Paid out" value={`${kampalaLabel(a.payout_date)} · ${a.payout_method === 'wallet' ? 'to wallet' : `${a.payout_method?.replace('_', ' ')} ${a.payout_reference ?? ''}`}`} />}
              <Item label="Purpose" value={a.purpose} wide />
              {a.decision_reason && <Item label="Decision note" value={a.decision_reason} wide />}
            </dl>

            <section id="special-advance-actions" className="space-y-3 rounded-xl border border-border p-3">
              {!issuanceEnabled && (a.status === 'pending_approval' || a.status === 'approved') && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400">Issuance is switched off on the server: approval and payout are disabled.</p>
              )}
              {a.status === 'pending_approval' && <DecisionForm advance={a} issuanceEnabled={issuanceEnabled} allowApprove />}
              {a.status === 'approved' && <PayoutForm advance={a} issuanceEnabled={issuanceEnabled} />}
              {a.status === 'approved' && <DecisionForm advance={a} issuanceEnabled={issuanceEnabled} allowApprove={false} />}
              {a.status === 'disbursed' && <RepaymentForm advance={a} />}
              {['rejected', 'cancelled', 'settled'].includes(a.status) && <p className="text-muted-foreground">No further action: this advance is {STATUS_LABEL[a.status].toLowerCase()}.</p>}
            </section>

            <section>
              <h4 className="mb-2 text-sm font-semibold">Schedule</h4>
              <table className="w-full">
                <thead className="text-[10px] uppercase text-muted-foreground">
                  <tr><th className="py-1 text-left">#</th><th className="text-left">Due</th><th className="text-right">Amount</th><th className="text-right">Paid</th><th className="text-right">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-border/60 tabular-nums">
                  {a.position.instalments.map((i) => (
                    <tr key={i.number}>
                      <td className="py-1">{i.number}</td>
                      <td>{i.due_date ? kampalaLabel(i.due_date) : '—'}</td>
                      <td className="text-right">{formatUGX(i.amount)}</td>
                      <td className="text-right">{formatUGX(i.paid)}</td>
                      <td className={`text-right ${i.status === 'overdue' ? 'font-semibold text-destructive' : ''}`}>{INSTALMENT_TEXT[i.status] ?? i.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {a.repayments.length > 0 && (
              <section>
                <h4 className="mb-2 text-sm font-semibold">Repayments</h4>
                <ul className="space-y-1">
                  {a.repayments.map((r) => (
                    <li key={r.id} className="flex justify-between gap-2">
                      <span>{kampalaLabel(r.received_date)} · {r.method.replace('_', ' ')} · {r.reference}</span>
                      <span className="font-mono">{formatUGX(r.amount)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <h4 className="mb-2 text-sm font-semibold">History</h4>
              <ol className="space-y-1">
                {(a.events ?? []).map((e, k) => (
                  <li key={k}>
                    <span className="font-medium">{EVENT_TEXT[e.event_type] ?? e.event_type}</span>
                    <span className="text-muted-foreground"> · {new Date(e.created_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' })}{e.actor_name ? ` · ${e.actor_name}` : ''}</span>
                    {e.reason && <span className="block italic text-muted-foreground">“{e.reason}”</span>}
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DecisionForm({ advance, issuanceEnabled, allowApprove }: { advance: SpecialAdvanceStatement; issuanceEnabled: boolean; allowApprove: boolean }) {
  const decide = useSpecialAdvanceDecision();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reasonOk = note.trim().length >= 5;
  const run = async (action: 'approve' | 'reject' | 'cancel') => {
    setError(null);
    try {
      const r = await decide.mutateAsync({ action, advance, reason: note.trim() || null });
      toast.success(`${r.reference} ${action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled'}`);
      setNote('');
    } catch (e) {
      setError(describeSpecialAdvanceError(e));
    }
  };
  return (
    <div className="space-y-2">
      <Label htmlFor={`special-advance-note-${allowApprove ? 'pending' : 'approved'}`}>
        {allowApprove ? 'Decision note (required to reject or cancel)' : 'Reason to cancel before payout'}
      </Label>
      <Textarea id={`special-advance-note-${allowApprove ? 'pending' : 'approved'}`} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        {allowApprove && (
          <Button id="special-advance-approve" size="sm" disabled={!issuanceEnabled || decide.isPending} onClick={() => void run('approve')}>Approve</Button>
        )}
        {allowApprove && (
          <Button id="special-advance-reject" size="sm" variant="outline" disabled={!reasonOk || decide.isPending} onClick={() => void run('reject')}>Reject</Button>
        )}
        <Button id={`special-advance-cancel-${allowApprove ? 'pending' : 'approved'}`} size="sm" variant="outline" disabled={!reasonOk || decide.isPending}
          onClick={() => void run('cancel')}>Cancel advance</Button>
      </div>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  );
}

function PayoutForm({ advance, issuanceEnabled }: { advance: SpecialAdvanceStatement; issuanceEnabled: boolean }) {
  const disburse = useDisburseSpecialAdvance();
  const external = advance.borrower_kind === 'external';
  const [date, setDate] = useState(kampalaTodayYmd());
  const [method, setMethod] = useState<'mobile_money' | 'bank_transfer'>('mobile_money');
  const [reference, setReference] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = issuanceEnabled && confirmed && !!date && (!external || reference.trim().length >= 3) && !disburse.isPending;
  const run = async () => {
    setError(null);
    try {
      const r = await disburse.mutateAsync({ advance, payout: external
        ? { payout_date: date, method, reference: reference.trim() } : { payout_date: date, method: 'wallet' } });
      toast.success(`${r.reference} paid out`);
    } catch (e) {
      setError(describeSpecialAdvanceError(e));
    }
  };
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold">Record payout</h4>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label htmlFor="special-advance-payout-date">Payout date</Label>
          <Input id="special-advance-payout-date" type="date" max={kampalaTodayYmd()} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        {external ? (
          <div>
            <Label htmlFor="special-advance-payout-method">Paid by</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as typeof method)}>
              <SelectTrigger id="special-advance-payout-method"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="mobile_money">Mobile money</SelectItem>
                <SelectItem value="bank_transfer">Bank transfer</SelectItem>
              </SelectContent>
            </Select>
          </div>
        ) : <p className="self-end text-muted-foreground">Credited to the borrower's Welile wallet (withdrawable).</p>}
      </div>
      {external && (
        <div>
          <Label htmlFor="special-advance-payout-reference">Transaction reference</Label>
          <Input id="special-advance-payout-reference" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
      )}
      <label htmlFor="special-advance-payout-confirm" className="flex items-start gap-2">
        <Checkbox id="special-advance-payout-confirm" checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} />
        <span>I confirm {formatUGX(advance.principal)} is paid to {advance.borrower_name ?? 'the borrower'}{external ? ' off-platform with the reference above' : ' into their Welile wallet'}.</span>
      </label>
      <Button id="special-advance-payout" size="sm" disabled={!ready} onClick={() => void run()}>
        {disburse.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Record payout
      </Button>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  );
}

function RepaymentForm({ advance }: { advance: SpecialAdvanceStatement }) {
  const record = useRecordSpecialAdvanceRepayment();
  const key = useRef(newIdempotencyKey());
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(kampalaTodayYmd());
  const [method, setMethod] = useState<'mobile_money' | 'bank_transfer'>('mobile_money');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const value = Number(amount) || 0;
  const outstanding = advance.position.outstanding;
  // a new action (any change of the details) gets a new key; an unchanged retry reuses it
  useEffect(() => { key.current = newIdempotencyKey(); }, [amount, date, method, reference]);
  const ready = value > 0 && value <= outstanding && !!date && reference.trim().length >= 3 && !record.isPending;
  const run = async () => {
    setError(null);
    try {
      await record.mutateAsync({ advanceId: advance.id, repayment: {
        amount: value, received_date: date, method, reference: reference.trim(), note: note.trim() || null, idempotency_key: key.current } });
      toast.success(`Repayment of ${formatUGX(value)} recorded`);
      setAmount(''); setReference(''); setNote('');
    } catch (e) {
      setError(describeSpecialAdvanceError(e));
    }
  };
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold">Record a repayment</h4>
      <p className="text-muted-foreground">Outstanding: <span className="font-mono">{formatUGX(outstanding)}</span>. Overpayments are not accepted; paying it all settles the advance.</p>
      <div className="grid grid-cols-2 gap-2">
        <Field id="special-advance-repay-amount" label="Amount (UGX)">
          <Input id="special-advance-repay-amount" inputMode="numeric" value={amount ? Number(amount).toLocaleString() : ''}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, '').slice(0, 12))} />
        </Field>
        <Field id="special-advance-repay-date" label="Date received">
          <Input id="special-advance-repay-date" type="date" max={kampalaTodayYmd()} min={advance.payout_date ?? undefined} value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field id="special-advance-repay-method" label="Received by">
          <Select value={method} onValueChange={(v) => setMethod(v as typeof method)}>
            <SelectTrigger id="special-advance-repay-method"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="mobile_money">Mobile money</SelectItem>
              <SelectItem value="bank_transfer">Bank transfer</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field id="special-advance-repay-reference" label="Transaction reference">
          <Input id="special-advance-repay-reference" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      </div>
      <Field id="special-advance-repay-note" label="Note (optional)">
        <Textarea id="special-advance-repay-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {value > outstanding && <p className="text-destructive">That is more than is outstanding.</p>}
      <Button id="special-advance-repay" size="sm" disabled={!ready} onClick={() => void run()}>
        {record.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Record repayment
      </Button>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return <div><Label htmlFor={id}>{label}</Label>{children}</div>;
}

function Item({ label, value, wide }: { label: string; value: string | null; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : undefined}>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words font-medium">{value || '—'}</dd>
    </div>
  );
}
