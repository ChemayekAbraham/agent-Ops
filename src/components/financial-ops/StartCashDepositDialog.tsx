import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Lock, MessageSquare, ShieldCheck, Smartphone } from 'lucide-react';
import { cn } from '@/lib/utils';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { joinPersonName, validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';

interface StartCashDepositDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a code has been issued so the panel can refresh. */
  onIssued?: () => void;
}

/**
 * Financial Ops starts a cash deposit on behalf of a depositor: enter the
 * depositor's phone number and the cash received, and the one-time code is
 * sent by SMS straight to that phone. Crediting still only happens when the
 * depositor enters the code in the app — this dialog never moves money.
 *
 * Presentation (2026-10): phone-first — grouped "Depositor" / "Cash" sections,
 * one-line hints instead of paragraphs, a locked Purpose row, and the send
 * action pinned below a scrollable body so it is reachable without scrolling
 * the whole form on a phone.
 */
export function StartCashDepositDialog({ open, onOpenChange, onIssued }: StartCashDepositDialogProps) {
  const { toast } = useToast();
  const [phone, setPhone] = useState('');
  // Captured in parts; the RPC/edge payload keeps one `cash_owner_name` string.
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const ownerName = joinPersonName(nameParts);
  const [amount, setAmount] = useState('');
  // Fixed to operational_float — this dialog starts a cash deposit received at
  // the counter, which is always operational float money. The dropdown was
  // removed on request; the payload still sends a valid enum value.
  const purpose = 'operational_float';
  const [cashLocation, setCashLocation] = useState<'bank' | 'cash_at_hand'>('cash_at_hand');
  const [reason, setReason] = useState('');
  // The depositor's email is required — the code always goes out by SMS and
  // email together. Crediting still only happens when the depositor enters it.
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const digits = phone.replace(/\D/g, '');
  const amountNum = Number(amount.replace(/[^0-9]/g, ''));
  const ownerNameClean = ownerName.trim().replace(/\s+/g, ' ');
  const nameCheck = validatePersonNameParts(nameParts);
  // Tell the operator exactly what is still blocking the send instead of leaving
  // the button greyed out with no explanation.
  const emailClean = email.trim();
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean);
  const blockedReason = !nameCheck.valid
    ? nameCheck.error || 'Enter the depositor\u2019s first and last name'
    : ownerNameClean.length < 3
      ? 'Enter the depositor\u2019s full name'
      : digits.length < 9
        ? 'Enter a valid depositor phone number (at least 9 digits)'
        : !Number.isFinite(amountNum) || amountNum < 500
          ? 'Enter a cash amount of at least UGX 500'
          : !emailValid
            ? 'Enter the depositor\u2019s email address \u2014 it is required'
            : null;
  const canSubmit = !blockedReason && !submitting;

  const reset = () => {
    setPhone('');
    setNameParts({ firstName: '', otherNames: '', lastName: '' });
    setAmount('');
    setCashLocation('cash_at_hand');
    setReason('');
    setEmail('');
    setError(null);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    const { data, error: fnErr } = await supabase.functions.invoke('finops-cash-deposit-initiate', {
      body: {
        phone: digits,
        cash_owner_name: ownerNameClean,
        amount: amountNum,
        deposit_purpose: purpose,
        cash_location: cashLocation,
        reason: reason.trim() || undefined,
        send_email: true,
        email: emailClean,
      },
    });
    setSubmitting(false);

    const payloadError = (data as any)?.error ? ((data as any)?.message || (data as any)?.error) : null;
    if (fnErr || payloadError) {
      const msg = payloadError || fnErr?.message || 'Could not start the cash deposit';
      setError(msg);
      toast({ title: 'Could not start the cash deposit', description: msg, variant: 'destructive' });
      return;
    }

    const smsSent = Boolean((data as any)?.sms_sent);
    const emailSent = Boolean((data as any)?.email_sent);
    const name = (data as any)?.depositor_name || 'the depositor';
    const channels = [
      smsSent ? `SMS on ${(data as any)?.depositor_phone}` : null,
      emailSent ? `email to ${(data as any)?.depositor_email}` : null,
    ].filter(Boolean) as string[];
    toast({
      title: channels.length ? 'Code sent' : 'Code issued (delivery not confirmed)',
      description: channels.length
        ? `${name} has been sent the code by ${channels.join(' and ')}. It expires in 10 minutes.`
        : `The code is in the Cash Deposit Codes list below — read it back to ${name}.`,
    });
    reset();
    onOpenChange(false);
    onIssued?.();
  };

  const sectionHeading = 'text-[11px] font-semibold uppercase tracking-wider text-muted-foreground';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md p-0 gap-0 overflow-hidden flex flex-col max-h-[92dvh]">
        <div className="overflow-y-auto overscroll-contain">
          <DialogHeader className="px-4 pt-5 pb-3 text-left sm:px-6 sm:pt-6">
            <DialogTitle className="flex items-center gap-2">
              <Smartphone className="h-5 w-5 text-primary" />
              Start cash deposit code
            </DialogTitle>
            <DialogDescription>
              Generate a secure deposit code for cash you have physically received.
            </DialogDescription>
          </DialogHeader>

          <div className="px-4 pb-5 space-y-5 sm:px-6">
            {/* ── Depositor ─────────────────────────────────────────── */}
            <section className="space-y-3">
              <h3 className={sectionHeading}>Depositor</h3>
              <div className="space-y-3">
                <PersonNameFields idPrefix="fin-cash-owner" value={nameParts} onChange={setNameParts} />
                <p className="text-[11px] text-muted-foreground">
                  The person whose cash this is — the name shown in the deposits list.
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="fin-cash-phone">Depositor phone number</Label>
                  <Input
                    id="fin-cash-phone"
                    inputMode="tel"
                    placeholder="0704 000 000"
                    className="h-11"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    The phone of the Welile account whose wallet will be credited.
                  </p>
                </div>
              </div>
            </section>

            {/* ── Cash ──────────────────────────────────────────────── */}
            <section className="space-y-3">
              <h3 className={sectionHeading}>Cash</h3>

              <div className="space-y-1.5">
                <Label htmlFor="fin-cash-amount">Amount</Label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
                    UGX
                  </span>
                  <Input
                    id="fin-cash-amount"
                    inputMode="numeric"
                    placeholder="50000"
                    className="h-11 pl-12 text-base font-semibold"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </div>
                {amountNum > 0 && (
                  <p className="text-[11px] text-muted-foreground">
                    UGX {amountNum.toLocaleString()}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label>Where is the cash?</Label>
                <div
                  role="radiogroup"
                  aria-label="Where is the cash?"
                  className="grid grid-cols-2 gap-1 rounded-lg border border-input bg-muted/50 p-1"
                >
                  {([
                    ['cash_at_hand', 'Cash at hand'],
                    ['bank', 'Deposited on bank'],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={cashLocation === value}
                      onClick={() => setCashLocation(value)}
                      className={cn(
                        'min-h-[44px] rounded-md px-2 text-sm font-medium transition-all',
                        cashLocation === value
                          ? 'bg-background text-primary shadow-sm'
                          : 'text-muted-foreground',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 rounded-lg border border-input bg-muted/40 px-3 py-2.5">
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground">Purpose</p>
                  <p className="text-sm font-medium">Operational Float</p>
                </div>
                <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Locked" />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="fin-cash-reason">
                  Note <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Textarea
                  id="fin-cash-reason"
                  rows={2}
                  placeholder="Cash received at the office counter"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
            </section>

            {/* ── Code delivery ─────────────────────────────────────── */}
            <section className="space-y-1.5 rounded-lg border border-primary/20 bg-primary/5 p-3">
              <Label htmlFor="fin-cash-email" className="text-sm">
                Depositor email address <span className="text-destructive">*</span>
              </Label>
              <Input
                id="fin-cash-email"
                type="email"
                inputMode="email"
                placeholder="depositor@example.com"
                className="h-11 bg-background"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                The code goes to this email and their phone, so it still arrives when SMS fails.
              </p>
            </section>

            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-700 dark:text-amber-400">
              <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                Only start after you have the cash in hand. The code expires in 10 minutes.
              </span>
            </div>

            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}
            {!error && blockedReason && (
              <p className="text-xs text-muted-foreground">{blockedReason}</p>
            )}
          </div>
        </div>

        {/* ── Pinned actions — reachable without scrolling on a phone ── */}
        <div className="border-t border-border/60 bg-muted/40 p-4 space-y-2 sm:px-6">
          <Button
            onClick={submit}
            disabled={!canSubmit}
            className="w-full h-12 gap-2 text-base"
          >
            {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <MessageSquare className="h-5 w-5" />}
            Send code by SMS + email
          </Button>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="w-full h-10 text-muted-foreground"
          >
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
