import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  ShieldCheck,
  Phone,
  KeyRound,
  Loader2,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  ArrowLeft,
  Building2,
  Smartphone,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { MyPayoutDestination } from '@/hooks/usePayoutVerification';

export interface PayoutDestinationConsentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  destination: MyPayoutDestination | null;
  onVerified?: () => void;
}

export function PayoutDestinationConsentDialog({
  open,
  onOpenChange,
  destination,
  onVerified,
}: PayoutDestinationConsentDialogProps) {
  const [step, setStep] = useState<'initial' | 'enter_phone' | 'enter_code' | 'success'>('initial');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [declarationId, setDeclarationId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isBank = destination?.destination_type === 'bank_transfer';
  const isMomo = destination?.destination_type === 'mobile_money';

  // Reset state on open/destination change
  useEffect(() => {
    if (open && destination) {
      setError(null);
      setCode('');
      setDeclarationId(null);
      setServerMessage(null);
      // For bank transfer, start at phone entry if no phone known
      if (isBank) {
        setStep('enter_phone');
        setOwnerPhone('');
      } else {
        setStep('initial');
        setOwnerPhone(destination.momo_number || '');
      }
    }
  }, [open, destination, isBank]);

  const handleRequestCode = async (phoneToUse?: string) => {
    if (!destination) return;
    setLoading(true);
    setError(null);

    const targetPhone = phoneToUse !== undefined ? phoneToUse : ownerPhone;

    try {
      const { data, error: fnError } = await supabase.functions.invoke('payout-destination-consent', {
        body: {
          action: 'request',
          destination_verification_id: destination.id,
          owner_phone: targetPhone.trim() || undefined,
        },
      });

      if (fnError) {
        let errPayload: any = null;
        if (fnError.context) {
          try {
            errPayload = await fnError.context.clone().json();
          } catch {
            try {
              errPayload = await fnError.context.json();
            } catch {}
          }
        }
        if (!errPayload && data) errPayload = data;

        if (errPayload?.code === 'owner_phone_required') {
          setStep('enter_phone');
          setError('Enter the account owner’s phone number so we can send them a verification code.');
          setLoading(false);
          return;
        }

        throw new Error(errPayload?.error || fnError.message || 'Failed to request consent code.');
      }

      if (data?.error) {
        throw new Error(data.error);
      }

      if (data?.already_verified) {
        setStep('success');
        onVerified?.();
        toast.success('This destination is already verified!');
        return;
      }

      if (data?.declaration_id) {
        setDeclarationId(data.declaration_id);
        setServerMessage(
          data.message ||
            "We've sent a code to the destination owner's phone. Ask them to share it with you, then confirm it here.",
        );
        setStep('enter_code');
        toast.success('Verification code sent to destination owner');
      } else {
        throw new Error('No declaration received from server.');
      }
    } catch (err: any) {
      setError(err.message || 'Could not send verification code. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!declarationId) {
      setError('Verification session missing. Please request a new code.');
      return;
    }
    const cleanCode = code.trim();
    if (cleanCode.length !== 6) {
      setError('Please enter the 6-digit confirmation code.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { data, error: fnError } = await supabase.functions.invoke('payout-destination-consent', {
        body: {
          action: 'confirm',
          declaration_id: declarationId,
          code: cleanCode,
        },
      });

      if (fnError) {
        let errPayload: any = null;
        if (fnError.context) {
          try {
            errPayload = await fnError.context.clone().json();
          } catch {
            try {
              errPayload = await fnError.context.json();
            } catch {}
          }
        }
        if (!errPayload && data) errPayload = data;
        throw new Error(errPayload?.error || fnError.message || 'Failed to confirm code.');
      }

      if (data?.error) {
        throw new Error(data.error);
      }

      if (data?.verified) {
        setStep('success');
        toast.success('Destination verified successfully!');
        onVerified?.();
      } else {
        throw new Error('Verification was not confirmed. Please try again.');
      }
    } catch (err: any) {
      setError(err.message || 'Could not verify code. Please check and try again.');
    } finally {
      setLoading(false);
    }
  };

  if (!destination) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            {step === 'success' ? (
              <CheckCircle2 className="h-6 w-6 text-primary" />
            ) : isBank ? (
              <Building2 className="h-6 w-6" />
            ) : (
              <Smartphone className="h-6 w-6" />
            )}
          </div>
          <DialogTitle className="text-center text-lg font-bold">
            {step === 'success'
              ? 'Payout Destination Verified'
              : step === 'enter_code'
                ? 'Enter Confirmation Code'
                : 'Verify Payout Destination by SMS'}
          </DialogTitle>
          <DialogDescription className="text-center text-sm">
            {step === 'success'
              ? 'The destination owner has confirmed permission. You can now withdraw directly to this account.'
              : step === 'enter_code'
                ? serverMessage || 'Enter the 6-digit code sent to the account owner to verify permission.'
                : 'Get instant verification without waiting for Financial Ops to make a phone call.'}
          </DialogDescription>
        </DialogHeader>

        {/* Destination preview card */}
        <div className="rounded-lg border bg-muted/40 p-3 text-xs space-y-1">
          <div className="flex items-center justify-between font-semibold text-foreground">
            <span>{isBank ? destination.bank_name || 'Bank Transfer' : 'Mobile Money'}</span>
            <span className="capitalize text-muted-foreground">{destination.provider || ''}</span>
          </div>
          <div className="text-muted-foreground">
            {isMomo && destination.momo_number && <span>Number: {destination.momo_number}</span>}
            {isBank && destination.bank_account_number && (
              <span>Account: {destination.bank_account_number}</span>
            )}
          </div>
          {destination.account_name && (
            <div className="text-foreground">
              <span className="text-muted-foreground">Registered Name: </span>
              <span className="font-medium">{destination.account_name}</span>
            </div>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="flex-1">{error}</div>
          </div>
        )}

        {/* Step: Initial confirmation prompt (Mobile Money) */}
        {step === 'initial' && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground leading-relaxed">
              We will send an SMS code to the registered number (
              <span className="font-semibold text-foreground">{destination.momo_number}</span>). Ask
              the owner to share this code with you to approve this payout destination.
            </p>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                Cancel
              </Button>
              <Button type="button" onClick={() => handleRequestCode()} disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sending SMS…
                  </>
                ) : (
                  'Send SMS Code'
                )}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step: Enter Owner's Phone (Bank Transfer or fallback) */}
        {step === 'enter_phone' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleRequestCode(ownerPhone);
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="bankOwnerPhone" className="text-xs font-semibold">
                Account Owner&apos;s Phone Number
              </Label>
              <div className="relative">
                <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="bankOwnerPhone"
                  type="tel"
                  inputMode="tel"
                  placeholder="0771 234 567"
                  value={ownerPhone}
                  onChange={(e) => {
                    setOwnerPhone(e.target.value);
                    if (error) setError(null);
                  }}
                  className="h-11 pl-9 text-base"
                  autoFocus
                  required
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Enter the phone number belonging to{' '}
                <span className="font-semibold text-foreground">
                  {destination.account_name || 'the account owner'}
                </span>
                . We will send them an SMS verification code.
              </p>
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                Cancel
              </Button>
              <Button type="submit" disabled={loading || !ownerPhone.trim()}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sending code…
                  </>
                ) : (
                  'Send Verification Code'
                )}
              </Button>
            </DialogFooter>
          </form>
        )}

        {/* Step: Enter 6-digit code */}
        {step === 'enter_code' && (
          <form onSubmit={handleConfirmCode} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="consentVerifyCode" className="text-xs font-semibold">
                6-Digit Confirmation Code
              </Label>
              <Input
                id="consentVerifyCode"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="123456"
                value={code}
                onChange={(e) => {
                  const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                  setCode(val);
                  if (error) setError(null);
                }}
                className="h-12 text-center font-mono text-xl tracking-widest"
                autoFocus
                required
              />
              <p className="text-[11px] text-muted-foreground text-center">
                The code was sent by SMS and expires in 30 minutes.
              </p>
            </div>

            <div className="flex items-center justify-between text-xs pt-1">
              <button
                type="button"
                onClick={() => handleRequestCode()}
                disabled={loading}
                className="flex items-center gap-1 font-medium text-primary hover:underline disabled:opacity-50"
              >
                <RefreshCw className="h-3 w-3" />
                Resend code
              </button>

              {isBank && (
                <button
                  type="button"
                  onClick={() => {
                    setCode('');
                    setError(null);
                    setStep('enter_phone');
                  }}
                  disabled={loading}
                  className="flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground"
                >
                  <ArrowLeft className="h-3 w-3" />
                  Change phone number
                </button>
              )}
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                Cancel
              </Button>
              <Button type="submit" disabled={loading || code.trim().length !== 6}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Verifying…
                  </>
                ) : (
                  'Confirm & Verify'
                )}
              </Button>
            </DialogFooter>
          </form>
        )}

        {/* Step: Success */}
        {step === 'success' && (
          <div className="space-y-4 pt-2">
            <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 p-3 text-center">
              <p className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                Destination Verified Instantly
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                You can now proceed with your withdrawal using this account.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" className="w-full" onClick={() => onOpenChange(false)}>
                Continue Withdrawal
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
