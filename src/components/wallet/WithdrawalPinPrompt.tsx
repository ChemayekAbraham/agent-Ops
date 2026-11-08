import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { fetchPinStatus, pinErrorMessage, verifyPin, type PinPurpose } from '@/hooks/useWithdrawalPin';

interface PromptProps {
  open: boolean;
  purpose: PinPurpose;
  /** Called with true after the database accepted the PIN (a one-use proof now exists), false on cancel. */
  onDone: (ok: boolean) => void;
}

export function WithdrawalPinPrompt({ open, purpose, onDone }: PromptProps) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPin('');
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const submit = async (value: string) => {
    if (busy || value.length !== 4) return;
    setBusy(true);
    setError(null);
    const r = await verifyPin(value, purpose);
    setBusy(false);
    if (r.success) {
      setPin('');
      onDone(true);
      return;
    }
    setPin('');
    setError(pinErrorMessage(r));
  };

  const what =
    purpose === 'payout_number_change' ? 'change your payout number' : purpose === 'pin_change' ? 'continue' : 'withdraw';

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onDone(false); }}>
      <DialogContent className="max-w-sm rounded-2xl">
        <DialogHeader className="items-center text-center">
          <div className="mx-auto mb-1 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <DialogTitle className="text-center">Enter your withdrawal PIN</DialogTitle>
          <DialogDescription className="text-center">
            Your 4-digit PIN is needed to {what}. It is not your sign-in password.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-center py-2">
          <InputOTP
            maxLength={4}
            value={pin}
            onChange={(v) => {
              const digits = v.replace(/\D/g, '');
              setPin(digits);
              if (digits.length === 4) void submit(digits);
            }}
            inputMode="numeric"
            autoFocus
            disabled={busy}
          >
            <InputOTPGroup>
              {[0, 1, 2, 3].map((i) => (
                <InputOTPSlot key={i} index={i} className="[-webkit-text-security:disc]" />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>
        {error && <p role="alert" className="text-center text-sm text-destructive">{error}</p>}
        <DialogFooter className="sm:justify-center">
          <Button variant="ghost" onClick={() => onDone(false)} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Cancel'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Imperative helper for a flow that must hold a PIN proof before a gated insert:
 *   const { askPin, pinPrompt } = useWithdrawalPinPrompt();
 *   if (!(await askPin('withdrawal'))) return;       // user cancelled, or must set a PIN first
 *   ... create the withdrawal right away: the proof lives 5 minutes and is spent by that insert ...
 *   return (<>{...}{pinPrompt}</>);
 * askPin asks the database fresh each time whether a PIN is required; when none is required it resolves true
 * without showing anything, so accounts without a PIN behave exactly as before.
 */
export function useWithdrawalPinPrompt() {
  const [state, setState] = useState<{ open: boolean; purpose: PinPurpose }>({ open: false, purpose: 'withdrawal' });
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const askPin = useCallback(async (purpose: PinPurpose): Promise<boolean> => {
    const status = await fetchPinStatus();
    // Status unreadable: do not block a person who may have no PIN; the database trigger is the real gate and
    // will answer withdrawal_pin_proof_required, which the flows map to "enter your PIN again".
    if (!status || !status.required) return true;
    if (!status.hasPin) {
      toast.error(pinErrorMessage({ code: 'withdrawal_pin_required' }), { duration: 8000 });
      return false;
    }
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setState({ open: true, purpose });
    });
  }, []);

  const onDone = useCallback((ok: boolean) => {
    setState((s) => ({ ...s, open: false }));
    resolver.current?.(ok);
    resolver.current = null;
  }, []);

  const pinPrompt = <WithdrawalPinPrompt open={state.open} purpose={state.purpose} onDone={onDone} />;
  return { askPin, pinPrompt };
}
