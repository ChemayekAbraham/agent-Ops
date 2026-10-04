/**
 * Ask Financial Ops to change the locked withdrawal number.
 *
 * The person must first prove they hold the new SIM with the code we send to
 * it, and say why the number must change. Nothing changes until Financial Ops
 * approves the request.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Send, Smartphone } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useOtpVerification } from '@/hooks/useOtpVerification';
import {
  useRequestNumberChange,
  usePayoutNumberAvailability,
} from '@/hooks/usePayoutNumberChange';
import { useAuth } from '@/hooks/useAuth';

type Provider = 'mtn' | 'airtel';

function detectProvider(raw: string): Provider | null {
  const d = raw.replace(/\D/g, '');
  const local = d.startsWith('256') ? `0${d.slice(3)}` : d.startsWith('0') ? d : `0${d}`;
  const p = local.slice(0, 3);
  if (['077', '078', '076', '039'].includes(p)) return 'mtn';
  if (['075', '070', '074', '020'].includes(p)) return 'airtel';
  return null;
}

export default function PayoutNumberChangeDialog({
  open,
  onOpenChange,
  onSubmitted,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmitted?: () => void;
}) {
  const { user } = useAuth();
  const otp = useOtpVerification();
  const request = useRequestNumberChange();

  const [number, setNumber] = useState('');
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<Provider>('mtn');
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [codeOk, setCodeOk] = useState(false);
  const [busy, setBusy] = useState(false);

  const digits = number.replace(/\D/g, '');
  const nameOk = name.trim().split(/\s+/).filter(Boolean).length >= 2;
  const check = usePayoutNumberAvailability(number);
  const checkState = check.data?.state;
  const takenByOther = checkState === 'taken';
  const isOwnNumber = checkState === 'mine';

  const sendCode = async () => {
    if (digits.length < 9) {
      toast.error('Enter a valid mobile money number.');
      return;
    }
    if (!nameOk) {
      toast.error('Enter the full name exactly as it shows on that number.');
      return;
    }
    if (takenByOther) {
      toast.error(check.data?.message || 'That number belongs to another account.');
      return;
    }
    const requesterName =
      (user?.user_metadata?.full_name as string | undefined)?.trim() || name.trim();
    const sent = await otp.sendOtp(number.trim(), {
      purpose: 'payout_number',
      subject_name: requesterName,
      recipient_name: name.trim(),
      phone_last4: digits.slice(-4),
    });
    if (sent) {
      setCode('');
      setCodeOk(false);
      setCodeSentTo(number.trim());
    }
  };

  const verifyCode = async () => {
    if (!codeSentTo || code.replace(/\D/g, '').length !== 6) {
      toast.error('Enter the 6-digit code we sent to that number.');
      return;
    }
    const ok = await otp.verifyOtp(codeSentTo, code.replace(/\D/g, ''), { category: 'payout_number' });
    if (!ok) {
      toast.error(otp.otpError || 'That code is not correct.');
      return;
    }
    setCodeOk(true);
    toast.success('Number confirmed. Now tell Financial Ops why it must change.');
  };

  const submit = async () => {
    if (!codeOk || !codeSentTo) return;
    if (reason.trim().length < 10) {
      toast.error('Explain in at least 10 characters why the number must change.');
      return;
    }
    setBusy(true);
    try {
      await request.mutateAsync({
        number: codeSentTo,
        name: name.trim(),
        provider,
        reason: reason.trim(),
      });
      toast.success('Request sent. Financial Ops will review it and you will be told the outcome.');
      onSubmitted?.();
      onOpenChange(false);
      setNumber('');
      setName('');
      setReason('');
      setCode('');
      setCodeSentTo(null);
      setCodeOk(false);
      otp.resetOtp();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send the request.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Ask to change your withdrawal number</DialogTitle>
          <DialogDescription>
            Your money can only be sent to the number linked to your identity. Financial Ops must
            approve any change, so nothing moves until they do.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">New mobile money number</Label>
            <Input
              type="tel"
              inputMode="tel"
              placeholder="e.g. 0770123456"
              value={number}
              disabled={!!codeSentTo || busy}
              onChange={(e) => {
                setNumber(e.target.value);
                const d = detectProvider(e.target.value);
                if (d) setProvider(d);
              }}
              className="h-11"
            />
            {digits.length >= 9 && check.data && (
              <p
                className={
                  takenByOther
                    ? 'text-[11px] font-semibold text-destructive'
                    : isOwnNumber
                      ? 'text-[11px] text-amber-600'
                      : 'text-[11px] text-emerald-600'
                }
              >
                {isOwnNumber
                  ? 'This is already your withdrawal number. Keep it and correct the registered name below.'
                  : check.data.message}
              </p>
            )}
          </div>


          <div className="space-y-1.5">
            <Label className="text-xs">Provider</Label>
            <div className="flex gap-2">
              {(['mtn', 'airtel'] as Provider[]).map((p) => (
                <Button
                  key={p}
                  type="button"
                  size="sm"
                  variant={provider === p ? 'default' : 'outline'}
                  className="flex-1 capitalize"
                  disabled={!!codeSentTo || busy}
                  onClick={() => setProvider(p)}
                >
                  {p}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Name registered on that number</Label>
            <Input
              value={name}
              disabled={!!codeSentTo || busy}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. NAKATO SARAH NAMULI"
              className="h-11"
            />
          </div>

          {!codeSentTo ? (
            <Button
              className="w-full h-11"
              onClick={sendCode}
              disabled={otp.otpLoading || busy || takenByOther}
            >
              {otp.otpLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Smartphone className="mr-2 h-4 w-4" />
              )}
              {isOwnNumber ? 'Send code to that number' : 'Send code to the new number'}
            </Button>
          ) : !codeOk ? (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">Code sent to {codeSentTo}</Label>
                <Input
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="h-11 text-center text-lg tracking-[0.4em]"
                />
              </div>
              <Button className="w-full h-11" onClick={verifyCode} disabled={otp.otpLoading}>
                {otp.otpLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Confirm the code
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={sendCode}
                disabled={otp.otpLoading || otp.cooldownSeconds > 0}
              >
                {otp.cooldownSeconds > 0 ? `Resend in ${otp.cooldownSeconds}s` : 'Resend code'}
              </Button>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">
                  {isOwnNumber
                    ? 'What must Financial Ops correct?'
                    : 'Why must the number change?'}
                </Label>
                <Textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={
                    isOwnNumber
                      ? 'e.g. The name registered on this number changed and must be corrected.'
                      : 'e.g. I lost the SIM card for my old number and this is my new line.'
                  }
                  rows={3}
                />
                <p className="text-[11px] text-muted-foreground">
                  {reason.trim().length}/10 characters minimum.
                </p>
              </div>
              <Button className="w-full h-11" onClick={submit} disabled={busy}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                Send request to Financial Ops
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
