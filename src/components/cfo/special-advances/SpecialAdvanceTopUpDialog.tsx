import { useEffect, useRef, useState } from 'react';
import { Loader2, PlusCircle, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import {
  TOPUP_MIN_PRINCIPAL, TOPUP_REASON_MAX, TOPUP_REASON_MIN, describeSpecialAdvanceError, newIdempotencyKey, type SpecialAdvanceStatement,
} from '@/lib/specialAdvances';
import { uploadSpecialAdvanceProof, useAddSpecialAdvanceTopup, useSpecialAdvanceTopupQuote } from '@/hooks/useSpecialAdvances';
import { SpecialAdvanceProofInput } from './SpecialAdvanceProofInput';

/**
 * CFO-only: add a top-up to a paid-out Special Advance. One confirmed action records the top-up AND pays it out
 * (CFO, 12 Nov 2026): a Welile-user borrower's wallet is credited immediately; an external borrower is paid by mobile
 * money or bank, recorded with its reference and proof. The server calculates every figure; the CFO confirms them and
 * the server refuses if they changed. The original agreement, its schedule and its repayments are not touched.
 */
export function SpecialAdvanceTopUpDialog({ open, onOpenChange, advance, onSuccess }: {
  open: boolean; onOpenChange: (open: boolean) => void; advance: SpecialAdvanceStatement; onSuccess?: () => void;
}) {
  const add = useAddSpecialAdvanceTopup();
  const wallet = advance.borrower_kind === 'welile_user';
  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<'mobile_money' | 'bank_transfer'>('mobile_money');
  const [reference, setReference] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [step, setStep] = useState<'details' | 'confirm'>('details');
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // one key per top-up intent; a retry of the same top-up reuses it (the server replays, never pays twice)
  const keyRef = useRef(newIdempotencyKey());

  useEffect(() => {
    if (!open) return;
    setAmountText(''); setReason(''); setReference(''); setFile(null); setUploadedPath(null);
    setStep('details'); setConfirmed(false); setError(null);
    keyRef.current = newIdempotencyKey();
  }, [open]);

  const cleaned = amountText.replace(/[,\s]/g, '');
  const principal = /^\d+$/.test(cleaned) ? Number(cleaned) : null;
  const quote = useSpecialAdvanceTopupQuote(open && principal && principal >= TOPUP_MIN_PRINCIPAL ? advance.id : null, principal);
  const q = quote.data;
  const reasonLen = reason.trim().length;

  const problems = [
    principal === null ? 'Enter the top-up amount in whole UGX.' : principal < TOPUP_MIN_PRINCIPAL ? `The minimum top-up is ${formatUGX(TOPUP_MIN_PRINCIPAL)}.` : null,
    reasonLen < TOPUP_REASON_MIN || reasonLen > TOPUP_REASON_MAX ? `Give the reason in ${TOPUP_REASON_MIN} to ${TOPUP_REASON_MAX} characters.` : null,
    !wallet && reference.trim().length < 3 ? 'Enter the transaction reference of the payment.' : null,
    !wallet && !file && !uploadedPath ? 'Attach proof of the payment.' : null,
  ].filter(Boolean) as string[];
  const ready = problems.length === 0 && !!q && !quote.isFetching;

  // any change to what is being paid is a different top-up
  const changed = <T,>(set: (v: T) => void) => (v: T) => { set(v); keyRef.current = newIdempotencyKey(); setConfirmed(false); };

  const submit = async () => {
    if (!ready || !confirmed || submitting || !q || principal === null) return;
    setSubmitting(true); setError(null);
    try {
      let proof = uploadedPath;
      if (!wallet && !proof && file) {
        proof = await uploadSpecialAdvanceProof(advance.id, file);
        setUploadedPath(proof);
      }
      const res = await add.mutateAsync({
        advanceId: advance.id,
        expectedUpdatedAt: advance.updated_at,
        request: {
          idempotency_key: keyRef.current, principal, reason: reason.trim(), expected_total_repayable: q.schedule.total_repayable,
          ...(wallet ? {} : { method, reference: reference.trim(), proof_path: proof }),
        },
      });
      toast.success(`Top-up ${res.topup.reference} added`, {
        description: wallet ? `${formatUGX(principal)} credited to the borrower's wallet.` : `${formatUGX(principal)} paid by ${method.replace('_', ' ')}.`,
      });
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      setError(describeSpecialAdvanceError(err));
      // back to the figures; a retry needs a fresh confirmation (the key is kept, so it is never paid twice)
      setConfirmed(false);
      setStep('details');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!submitting) onOpenChange(o); }}>
      <DialogContent className="max-w-md space-y-4 sm:rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-bold">
            <PlusCircle className="h-5 w-5 text-primary" aria-hidden /> Add top-up
          </DialogTitle>
          <DialogDescription className="text-xs">
            {advance.reference} · the top-up is paid out as soon as you confirm. The original agreement and its repayments stay as they are.
          </DialogDescription>
        </DialogHeader>

        {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</p>}

        {step === 'details' && (
          <div className="space-y-3 text-xs">
            <div className="space-y-1">
              <Label htmlFor="topup-amount">Top-up amount (UGX) *</Label>
              <Input id="topup-amount" inputMode="numeric" autoComplete="off" value={amountText} onChange={(e) => changed(setAmountText)(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="topup-reason">Reason *</Label>
              <Textarea id="topup-reason" rows={3} maxLength={TOPUP_REASON_MAX} value={reason} onChange={(e) => changed(setReason)(e.target.value)} />
              <p className="text-[11px] text-muted-foreground">{reasonLen}/{TOPUP_REASON_MAX} (at least {TOPUP_REASON_MIN})</p>
            </div>
            {wallet ? (
              <p className="flex items-center gap-1.5 rounded-md bg-muted p-2 text-[11px]">
                <Wallet className="h-3.5 w-3.5" aria-hidden /> Paid to the borrower's Welile wallet immediately.
              </p>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="topup-method">Payment method</Label>
                <Select value={method} onValueChange={(v) => changed(setMethod)(v as 'mobile_money' | 'bank_transfer')}>
                  <SelectTrigger id="topup-method"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mobile_money">Mobile money</SelectItem>
                    <SelectItem value="bank_transfer">Bank transfer</SelectItem>
                  </SelectContent>
                </Select>
                <Label htmlFor="topup-reference">Transaction reference *</Label>
                <Input id="topup-reference" maxLength={100} value={reference} onChange={(e) => changed(setReference)(e.target.value)} />
                <SpecialAdvanceProofInput id="topup-proof" label="Proof of payment" required file={file}
                  onFileChange={(f) => { changed(setFile)(f); setUploadedPath(null); }} />
              </div>
            )}

            {quote.isError && <p role="alert" className="text-destructive">{describeSpecialAdvanceError(quote.error)}</p>}
            {q && (
              <dl className="space-y-1 rounded-md border border-border p-2.5" aria-label="Top-up terms">
                <Row label="Access fee (agreed rate, plus fixed fee)" value={formatUGX(q.schedule.access_fee)} />
                <Row label="Top-up repayable" value={formatUGX(q.schedule.total_repayable)} strong />
                <Row label="Instalments" value={`${q.schedule.instalments}, last due ${q.end_date}`} />
                <Row label="Outstanding now" value={formatUGX(q.outstanding_now)} />
                <Row label="Outstanding after the top-up" value={formatUGX(q.outstanding_after)} strong />
              </dl>
            )}
            {problems.length > 0 && amountText !== '' && <ul className="list-disc pl-4 text-muted-foreground">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}

            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button size="sm" disabled={!ready} onClick={() => { setError(null); setStep('confirm'); }}>Review</Button>
            </DialogFooter>
          </div>
        )}

        {step === 'confirm' && q && principal !== null && (
          <div className="space-y-3 text-xs">
            <dl className="space-y-1 rounded-md border border-border p-2.5">
              <Row label="Pay out now" value={formatUGX(principal)} strong />
              <Row label="To" value={wallet ? "Borrower's Welile wallet" : `${method.replace('_', ' ')} · ${reference.trim()}`} />
              <Row label="Access fee" value={formatUGX(q.schedule.access_fee)} />
              <Row label="Outstanding after" value={formatUGX(q.outstanding_after)} strong />
            </dl>
            <ul className="space-y-0.5 text-[11px] text-muted-foreground">
              {q.schedule.schedule.map((i) => <li key={i.number}>Instalment {i.number}: {formatUGX(i.amount)} due {i.due_date}</li>)}
            </ul>
            <label className="flex items-start gap-2">
              <Checkbox id="topup-confirm" checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} />
              <span>
                I authorise this top-up. {wallet ? `${formatUGX(principal)} will be credited to the borrower's wallet now.` : `I confirm ${formatUGX(principal)} was paid by ${method.replace('_', ' ')}.`}
              </span>
            </label>
            <DialogFooter>
              <Button variant="outline" size="sm" disabled={submitting} onClick={() => setStep('details')}>Back</Button>
              <Button size="sm" disabled={!confirmed || submitting} onClick={submit}>
                {submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Add top-up and pay out
              </Button>
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
