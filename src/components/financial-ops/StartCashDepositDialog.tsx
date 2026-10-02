import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Loader2, MessageSquare, ShieldCheck, Smartphone } from 'lucide-react';
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

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="h-5 w-5 text-primary" />
            Start cash deposit code
          </DialogTitle>
          <DialogDescription>
            Enter the depositor's phone number and the cash you received. The one-time code is sent
            straight to their phone and to their email. Their
            wallet is only credited once they enter that code.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>
              Depositor's full name <span className="text-destructive">*</span>
            </Label>
            <PersonNameFields idPrefix="fin-cash-owner" value={nameParts} onChange={setNameParts} />
            <p className="text-[11px] text-muted-foreground">
              The person whose cash this actually is — even when the money lands in the operator's
              wallet for later transfer. This is the name that appears in the cash deposits list.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="fin-cash-phone">Depositor phone number</Label>
            <Input
              id="fin-cash-phone"
              inputMode="tel"
              placeholder="0704 000 000"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              The phone of the Welile account whose wallet will be credited (the operator's own
              number is fine when they will transfer the money on).
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="fin-cash-amount">Cash amount (UGX)</Label>
            <Input
              id="fin-cash-amount"
              inputMode="numeric"
              placeholder="50000"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            {amountNum > 0 && (
              <p className="text-[11px] text-muted-foreground">
                UGX {amountNum.toLocaleString()}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Where is the cash?</Label>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={cashLocation === 'cash_at_hand' ? 'default' : 'outline'}
                onClick={() => setCashLocation('cash_at_hand')}
                className="justify-center"
              >
                Cash at hand
              </Button>
              <Button
                type="button"
                variant={cashLocation === 'bank' ? 'default' : 'outline'}
                onClick={() => setCashLocation('bank')}
                className="justify-center"
              >
                Deposited on bank
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Purpose</Label>
            <div className="rounded-md border border-input bg-muted/40 px-3 py-2 text-sm">
              Operational Float
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="fin-cash-reason">Note (optional)</Label>
            <Textarea
              id="fin-cash-reason"
              rows={2}
              placeholder="Cash received at the office counter"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>

          <div className="space-y-2 rounded-lg border border-border/60 p-3">
            <div className="space-y-1">
              <Label htmlFor="fin-cash-email" className="text-sm">
                Depositor email address <span className="text-destructive">*</span>
              </Label>
              <Input
                id="fin-cash-email"
                type="email"
                inputMode="email"
                placeholder="depositor@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Required. The code goes out by SMS and email together, so it still arrives when
                SMS is not getting through.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-700 dark:text-amber-400">
            <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              Only start this after you have physically received the cash. The code expires in
              10 minutes and can be reissued from the list.
            </span>
          </div>

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
          {!error && blockedReason && (
            <p className="text-xs text-muted-foreground">{blockedReason}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit} className="gap-2">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />}
            Send code by SMS + email
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}