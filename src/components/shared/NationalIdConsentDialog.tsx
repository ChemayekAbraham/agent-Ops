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
import { ShieldAlert, Phone, KeyRound, Loader2, AlertCircle, ArrowLeft, RefreshCw } from 'lucide-react';

export interface NationalIdConsentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stage: 'awaiting_owner_phone' | 'awaiting_code';
  declarationId?: string | null;
  errorMessage?: string | null;
  idOwnerName?: string;
  registrantName?: string;
  initialOwnerPhone?: string;
  submitting?: boolean;
  onSubmitPhone: (phone: string) => Promise<void> | void;
  onSubmitCode: (code: string) => Promise<void> | void;
  onResendCode?: () => Promise<void> | void;
}

export function NationalIdConsentDialog({
  open,
  onOpenChange,
  stage,
  declarationId,
  errorMessage,
  idOwnerName,
  registrantName,
  initialOwnerPhone = '',
  submitting = false,
  onSubmitPhone,
  onSubmitCode,
  onResendCode,
}: NationalIdConsentDialogProps) {
  const [phone, setPhone] = useState(initialOwnerPhone);
  const [code, setCode] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (initialOwnerPhone) {
      setPhone(initialOwnerPhone);
    }
  }, [initialOwnerPhone]);

  useEffect(() => {
    setLocalError(errorMessage || null);
  }, [errorMessage]);

  // Clear code and local errors on dialog reopen or stage change
  useEffect(() => {
    if (stage === 'awaiting_owner_phone') {
      setCode('');
    }
  }, [stage]);

  const handlePhoneSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = phone.trim();
    if (!clean) {
      setLocalError("Please enter the ID owner's phone number.");
      return;
    }
    const digits = clean.replace(/\D/g, '');
    if (digits.length < 9) {
      setLocalError('Please enter a valid phone number (e.g. 0771 234 567).');
      return;
    }
    setLocalError(null);
    onSubmitPhone(clean);
  };

  const handleCodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = code.trim();
    if (!clean) {
      setLocalError('Please enter the 6-digit confirmation code.');
      return;
    }
    if (clean.length !== 6) {
      setLocalError('The code must be 6 digits.');
      return;
    }
    setLocalError(null);
    onSubmitCode(clean);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10 text-amber-600">
            {stage === 'awaiting_owner_phone' ? (
              <ShieldAlert className="h-6 w-6" />
            ) : (
              <KeyRound className="h-6 w-6" />
            )}
          </div>
          <DialogTitle className="text-center text-lg font-bold">
            {stage === 'awaiting_owner_phone'
              ? 'ID Owner Permission Required'
              : 'Enter Owner Confirmation Code'}
          </DialogTitle>
          <DialogDescription className="text-center text-sm">
            {stage === 'awaiting_owner_phone' ? (
              <>
                This National ID appears to belong to{' '}
                <span className="font-semibold text-foreground">
                  {idOwnerName || 'someone else'}
                </span>
                {registrantName ? ` (not ${registrantName})` : ''}. Enter their phone number so we
                can confirm they&apos;ve allowed you to use it.
              </>
            ) : (
              <>
                We&apos;ve sent a 6-digit code to the ID owner&apos;s phone
                {phone ? (
                  <>
                    {' '}
                    (<span className="font-semibold text-foreground">{phone}</span>)
                  </>
                ) : (
                  ''
                )}
                . Ask them to share it with you to confirm permission.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {localError && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="flex-1">{localError}</div>
          </div>
        )}

        {stage === 'awaiting_owner_phone' ? (
          <form onSubmit={handlePhoneSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="idOwnerPhone" className="text-xs font-semibold">
                ID Owner&apos;s Phone Number
              </Label>
              <div className="relative">
                <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="idOwnerPhone"
                  type="tel"
                  inputMode="tel"
                  placeholder="0771 234 567"
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    if (localError) setLocalError(null);
                  }}
                  className="h-11 pl-9 text-base"
                  autoFocus
                  required
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                We will send an SMS to this number with a one-time verification code.
              </p>
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting || !phone.trim()}>
                {submitting ? (
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
        ) : (
          <form onSubmit={handleCodeSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="consentCode" className="text-xs font-semibold">
                6-Digit Confirmation Code
              </Label>
              <Input
                id="consentCode"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="123456"
                value={code}
                onChange={(e) => {
                  const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                  setCode(val);
                  if (localError) setLocalError(null);
                }}
                className="h-12 text-center font-mono text-xl tracking-widest"
                autoFocus
                required
              />
              <p className="text-[11px] text-muted-foreground text-center">
                The code expires in 30 minutes.
              </p>
            </div>

            <div className="flex items-center justify-between text-xs pt-1">
              <button
                type="button"
                onClick={() => {
                  if (onResendCode) {
                    onResendCode();
                  } else {
                    onSubmitPhone(phone);
                  }
                }}
                disabled={submitting}
                className="flex items-center gap-1 font-medium text-primary hover:underline disabled:opacity-50"
              >
                <RefreshCw className="h-3 w-3" />
                Resend code
              </button>

              <button
                type="button"
                onClick={() => {
                  setCode('');
                  setLocalError(null);
                  // Return to phone entry step
                  onSubmitPhone('');
                }}
                disabled={submitting}
                className="flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-3 w-3" />
                Change phone number
              </button>
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting || code.trim().length !== 6}>
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Verifying…
                  </>
                ) : (
                  'Confirm & Complete'
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
