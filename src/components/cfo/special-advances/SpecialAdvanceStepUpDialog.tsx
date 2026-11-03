import { useState } from 'react';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { useSafeAuth } from '@/components/auth/useSafeAuth';
import { useAuthenticatorMfa } from '@/hooks/useAuthenticatorMfa';
import { AuthenticatorSetupDialog } from '@/components/auth/AuthenticatorSetupDialog';

interface SpecialAdvanceStepUpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => Promise<void> | void;
}

export function SpecialAdvanceStepUpDialog({ open, onOpenChange, onSuccess }: SpecialAdvanceStepUpDialogProps) {
  const { user } = useSafeAuth();
  const { error, verifyChallenge } = useAuthenticatorMfa(user?.id);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);

  const handleVerify = async () => {
    const cleanCode = code.replace(/\D/g, '');
    if (cleanCode.length !== 6 || verifying) return;
    setVerifying(true);
    setLocalError(null);
    const res = await verifyChallenge(cleanCode);
    setVerifying(false);
    if (res.ok) {
      setCode('');
      onOpenChange(false);
      await onSuccess();
    } else {
      setCode('');
    }
  };

  const displayError = localError || error;
  const noFactorFound = displayError && /no authenticator found/i.test(displayError);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-sm sm:rounded-2xl text-center space-y-4">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <ShieldCheck className="h-6 w-6" />
          </div>

          <DialogHeader className="text-center sm:text-center space-y-1">
            <DialogTitle className="text-base font-bold">Authenticator verification</DialogTitle>
            <DialogDescription className="text-xs">
              This action requires step-up verification. Enter the 6-digit code from your authenticator app.
            </DialogDescription>
          </DialogHeader>

          {noFactorFound ? (
            <div className="space-y-3 py-2 text-xs">
              <p className="text-destructive font-medium">Set up your authenticator app first.</p>
              <Button
                size="sm"
                className="w-full"
                onClick={() => {
                  onOpenChange(false);
                  setSetupOpen(true);
                }}
              >
                Set up authenticator app
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex justify-center">
                <InputOTP
                  id="special-advance-step-up-code"
                  maxLength={6}
                  value={code}
                  onChange={(v) => setCode(v.replace(/\D/g, ''))}
                  onComplete={handleVerify}
                  disabled={verifying}
                  autoComplete="one-time-code"
                  autoFocus
                >
                  <InputOTPGroup>
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <InputOTPSlot key={i} index={i} />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
              </div>

              {displayError && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {displayError}
                </p>
              )}

              <Button
                id="special-advance-step-up-submit"
                className="w-full h-10 font-semibold"
                disabled={code.length !== 6 || verifying}
                onClick={handleVerify}
              >
                {verifying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Confirm & Proceed
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AuthenticatorSetupDialog open={setupOpen} onOpenChange={setSetupOpen} />
    </>
  );
}

export default SpecialAdvanceStepUpDialog;
