import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Label } from '@/components/ui/label';
import { useWithdrawalPinPrompt } from '@/components/wallet/WithdrawalPinPrompt';
import FirstPinSetup from '@/components/wallet/FirstPinSetup';
import {
  cancelReset,
  changePin,
  fetchPinStatus,
  forgotPin,
  pinErrorMessage,
  type PinResult,
  type PinStatus,
} from '@/hooks/useWithdrawalPin';

/**
 * Withdrawal PIN settings (docs 258 to 260). Not the app-lock PIN above it: this one is checked by the database
 * and is needed to withdraw money or ask to change the payout number.
 *   no PIN       -> set one
 *   has a PIN    -> change it (current PIN + emailed code), or "forgot" it (emailed code only)
 *   reset waiting-> cancel it with the PIN, if it was not you
 */
type Mode = 'idle' | 'set' | 'change' | 'forgot';
type Step = 'start' | 'code';

function PinInput({ value, onChange, disabled, label }: { value: string; onChange: (v: string) => void; disabled?: boolean; label: string }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <InputOTP maxLength={4} value={value} onChange={(v) => onChange(v.replace(/\D/g, ''))} inputMode="numeric" disabled={disabled}>
        <InputOTPGroup>
          {[0, 1, 2, 3].map((i) => (
            <InputOTPSlot key={i} index={i} className="[-webkit-text-security:disc]" />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </div>
  );
}

function CodeInput({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">6-digit code from your email</Label>
      <InputOTP maxLength={6} value={value} onChange={(v) => onChange(v.replace(/\D/g, ''))} inputMode="numeric" disabled={disabled}>
        <InputOTPGroup>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <InputOTPSlot key={i} index={i} />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </div>
  );
}

export default function WithdrawalPinSection() {
  const [status, setStatus] = useState<PinStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>('idle');
  const [step, setStep] = useState<Step>('start');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const { askPin, pinPrompt } = useWithdrawalPinPrompt();

  const refresh = useCallback(async () => {
    setStatus(await fetchPinStatus());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const close = () => {
    setMode('idle');
    setStep('start');
    setError(null);
    setSentTo(null);
    setCurrentPin('');
    setNewPin('');
    setConfirmPin('');
    setEmailCode('');
  };

  const fail = (r: PinResult) => {
    setError(pinErrorMessage(r));
    return false;
  };

  const pinsMatch = () => {
    if (newPin.length !== 4) { setError('Choose a 4-digit PIN.'); return false; }
    if (newPin !== confirmPin) { setError('The two PINs do not match.'); return false; }
    return true;
  };

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  // Change: the code goes out first, then the current PIN + code + new PIN are sent together.
  const sendChangeCode = () => run(async () => {
    if (currentPin.length !== 4) { setError('Enter your current PIN.'); return; }
    const r = await changePin.sendCode();
    if (!r.success) { fail(r); return; }
    setSentTo(r.destinationMasked ?? 'your email');
    setStep('code');
  });
  const doChange = () => run(async () => {
    if (emailCode.length !== 6) { setError('Enter the 6-digit code.'); return; }
    if (!pinsMatch()) return;
    const r = await changePin.complete(currentPin, emailCode, newPin);
    if (!r.success) {
      fail(r);
      setEmailCode('');
      return;
    }
    toast.success('Withdrawal PIN changed');
    close();
    await refresh();
  });

  // Forgot: begin the reset, email a code, then the code + new PIN.
  const startForgot = () => run(async () => {
    const b = await forgotPin.begin();
    if (!b.success) { fail(b); return; }
    const s = await forgotPin.sendCode();
    if (!s.success) { fail(s); await refresh(); return; }
    setSentTo(s.destinationMasked ?? b.destinationMasked ?? 'your email');
    setStep('code');
    await refresh();
  });
  const doForgot = () => run(async () => {
    if (emailCode.length !== 6) { setError('Enter the 6-digit code.'); return; }
    if (!pinsMatch()) return;
    const r = await forgotPin.complete(emailCode, newPin);
    if (!r.success) {
      fail(r);
      setEmailCode('');
      return;
    }
    toast.success('New withdrawal PIN set');
    close();
    await refresh();
  });

  const doCancelReset = () => run(async () => {
    if (!status?.pendingReset) return;
    // Cancelling a reset is itself proved with the PIN (purpose pin_change), so a stranger cannot cancel yours.
    if (!(await askPin('pin_change'))) return;
    const r = await cancelReset(status.pendingReset.id);
    if (!r.success) { toast.error(pinErrorMessage(r)); return; }
    toast.success('PIN reset cancelled');
    await refresh();
  });

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

  return (
    <>
      {pinPrompt}
      <Card className="border-border/40 rounded-2xl">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">Withdrawal PIN</CardTitle>
          </div>
          <CardDescription>
            A secret 4-digit PIN that protects your wallet. It is needed to withdraw and to ask to change your payout number.
            It is separate from the PIN that unlocks the app.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
          ) : !status ? (
            <p className="text-sm text-muted-foreground">Could not load your PIN status. Try again later.</p>
          ) : (
            <>
              {status.lockedUntil && (
                <p className="flex items-center gap-1.5 text-sm text-destructive"><Lock className="h-4 w-4" /> Locked after wrong tries until {fmt(status.lockedUntil)}.</p>
              )}
              {status.numberChangeHoldUntil && (
                <p className="text-xs text-muted-foreground">For your safety, payout number changes are paused until {fmt(status.numberChangeHoldUntil)}.</p>
              )}
              {status.pendingReset && (
                <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
                  <p className="font-medium">A PIN reset is waiting on your account.</p>
                  <p className="mt-0.5 text-muted-foreground">If it was not you, cancel it with your current PIN and contact support.</p>
                  <Button size="sm" variant="outline" className="mt-2" onClick={doCancelReset} disabled={busy}>Cancel the reset</Button>
                </div>
              )}

              {mode === 'idle' && (
                <div className="flex flex-wrap gap-2">
                  {!status.hasPin ? (
                    <Button onClick={() => setMode('set')}>Set withdrawal PIN</Button>
                  ) : (
                    <>
                      <Button variant="outline" onClick={() => setMode('change')} disabled={!!status.pendingReset}>Change PIN</Button>
                      <Button variant="ghost" onClick={() => setMode('forgot')} disabled={!!status.pendingReset}>Forgot PIN</Button>
                    </>
                  )}
                </div>
              )}

              {mode === 'set' && (
                <FirstPinSetup onDone={() => { close(); void refresh(); }} onCancel={close} />
              )}

              {mode === 'change' && (
                <div className="space-y-3">
                  {step === 'start' ? (
                    <>
                      <PinInput label="Current PIN" value={currentPin} onChange={setCurrentPin} disabled={busy} />
                      <p className="text-xs text-muted-foreground">We will email you a code to confirm the change.</p>
                      <div className="flex gap-2">
                        <Button onClick={sendChangeCode} disabled={busy}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Email me a code</Button>
                        <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-xs text-muted-foreground">Code sent to {sentTo}.</p>
                      <CodeInput value={emailCode} onChange={setEmailCode} disabled={busy} />
                      <PinInput label="New PIN" value={newPin} onChange={setNewPin} disabled={busy} />
                      <PinInput label="Repeat the new PIN" value={confirmPin} onChange={setConfirmPin} disabled={busy} />
                      <div className="flex gap-2">
                        <Button onClick={doChange} disabled={busy}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Change PIN</Button>
                        <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {mode === 'forgot' && (
                <div className="space-y-3">
                  {step === 'start' ? (
                    <>
                      <p className="text-sm text-muted-foreground">We will email a 6-digit code to the email on your account. You will need it to choose a new PIN.</p>
                      <div className="flex gap-2">
                        <Button onClick={startForgot} disabled={busy}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Email me a code</Button>
                        <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-xs text-muted-foreground">Code sent to {sentTo}.</p>
                      <CodeInput value={emailCode} onChange={setEmailCode} disabled={busy} />
                      <PinInput label="New PIN" value={newPin} onChange={setNewPin} disabled={busy} />
                      <PinInput label="Repeat the new PIN" value={confirmPin} onChange={setConfirmPin} disabled={busy} />
                      <div className="flex gap-2">
                        <Button onClick={doForgot} disabled={busy}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Set new PIN</Button>
                        <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
