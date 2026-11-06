import { useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Label } from '@/components/ui/label';
import { pinErrorMessage, setupPin, type PinResult } from '@/hooks/useWithdrawalPin';

/**
 * Sets a FIRST withdrawal PIN (docs 262, 263). The PIN is typed twice, then a 6-digit code is texted to the account's
 * registered phone and the code and the PIN are sent together. The text proves the person holds that phone, not just a
 * logged-in session; without it a stolen session could set a PIN and withdraw to a number of its choice.
 * Used in the withdraw dialog and in Settings.
 */
function Digits({ value, onChange, length, disabled, mask }: { value: string; onChange: (v: string) => void; length: number; disabled?: boolean; mask?: boolean }) {
  return (
    <InputOTP maxLength={length} value={value} onChange={(v) => onChange(v.replace(/\D/g, ''))} inputMode="numeric" disabled={disabled}>
      <InputOTPGroup>
        {Array.from({ length }, (_, i) => (
          <InputOTPSlot key={i} index={i} className={mask ? '[-webkit-text-security:disc]' : undefined} />
        ))}
      </InputOTPGroup>
    </InputOTP>
  );
}

export default function FirstPinSetup({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [step, setStep] = useState<'pin' | 'code'>('pin');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fail = (r: PinResult) => setError(pinErrorMessage(r));

  const sendCode = async () => {
    if (busy) return;
    if (pin.length !== 4) { setError('Choose a 4-digit PIN.'); return; }
    if (pin !== confirm) { setError('The two PINs do not match.'); return; }
    setBusy(true);
    setError(null);
    const r = await setupPin.sendCode();
    setBusy(false);
    if (!r.success) { fail(r); return; }
    setSentTo(r.destinationMasked ?? 'your registered phone');
    setCode('');
    setStep('code');
  };

  const save = async () => {
    if (busy) return;
    if (code.length !== 6) { setError('Enter the 6-digit code.'); return; }
    setBusy(true);
    setError(null);
    const r = await setupPin.complete(code, pin);
    setBusy(false);
    if (!r.success) {
      fail(r);
      setCode('');
      // A used-up or expired code needs a fresh one; a weak PIN needs a new PIN.
      if (r.code === 'code_expired_or_used_up') setStep('pin');
      if (r.code === 'weak_pin') { setPin(''); setConfirm(''); setStep('pin'); }
      return;
    }
    setPin('');
    setConfirm('');
    setCode('');
    toast.success('Withdrawal PIN set', { description: 'You will enter it every time you withdraw. Keep it secret.' });
    onDone();
  };

  return (
    <div className="space-y-3 text-left">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-primary" />
        <h4 className="font-semibold text-sm">Set your withdrawal PIN first</h4>
      </div>

      {step === 'pin' ? (
        <>
          <p className="text-xs text-muted-foreground">
            Choose a secret 4-digit PIN. You will enter it every time you withdraw. Do not share it, and avoid 1234 or repeats like 1111.
            We will text a code to your registered phone to confirm it is you.
          </p>
          <div className="space-y-1.5">
            <Label className="text-xs">New PIN</Label>
            <Digits value={pin} onChange={(v) => { setPin(v); setError(null); }} length={4} disabled={busy} mask />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Repeat the PIN</Label>
            <Digits value={confirm} onChange={(v) => { setConfirm(v); setError(null); }} length={4} disabled={busy} mask />
          </div>
          {error && <p role="alert" className="text-xs text-destructive font-medium">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" className="flex-1 h-11" onClick={sendCode} disabled={busy || pin.length !== 4 || confirm.length !== 4}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Text me a code'}
            </Button>
            {onCancel && <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>}
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">Code sent to {sentTo}. It is valid for 10 minutes.</p>
          <div className="space-y-1.5">
            <Label className="text-xs">6-digit code from the text message</Label>
            <Digits value={code} onChange={(v) => { setCode(v); setError(null); }} length={6} disabled={busy} />
          </div>
          {error && <p role="alert" className="text-xs text-destructive font-medium">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" className="flex-1 h-11" onClick={save} disabled={busy || code.length !== 6}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save PIN'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => { setStep('pin'); setError(null); }} disabled={busy}>Back</Button>
          </div>
        </>
      )}
    </div>
  );
}
