import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ShieldCheck, Loader2, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { supabase } from '@/integrations/supabase/client';
import { useSafeAuth } from '@/components/auth/useSafeAuth';
import { useAuthenticatorMfa } from '@/hooks/useAuthenticatorMfa';

interface AuthenticatorChallengeScreenProps {
  onSuccess?: () => void;
  isDialog?: boolean;
}

export function AuthenticatorChallengeScreen({ onSuccess, isDialog = false }: AuthenticatorChallengeScreenProps) {
  const { user, signOut } = useSafeAuth();
  const { error, verifyChallenge } = useAuthenticatorMfa(user?.id);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleVerify = async () => {
    const cleanCode = code.replace(/\D/g, '');
    if (cleanCode.length !== 6 || verifying) return;
    setVerifying(true);
    setLocalError(null);
    const res = await verifyChallenge(cleanCode);
    setVerifying(false);
    if (res.ok) {
      onSuccess?.();
    } else {
      setCode('');
    }
  };

  const displayError = localError || error;

  const content = (
    <div className="w-full max-w-sm space-y-5 rounded-2xl border border-border/60 bg-card p-6 text-center shadow-xl">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <ShieldCheck className="h-7 w-7" />
      </div>

      <div className="space-y-1.5">
        <h1 className="text-lg font-bold text-foreground">Two-factor authentication</h1>
        <p className="text-xs text-muted-foreground">
          Enter the 6-digit code from your authenticator app to continue.
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex justify-center">
          <InputOTP
            id="authenticator-challenge-code"
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
          <p role="alert" className="text-center text-xs font-medium text-destructive">
            {displayError}
          </p>
        )}

        <Button
          id="authenticator-challenge-verify"
          className="w-full h-11 font-semibold"
          disabled={code.length !== 6 || verifying}
          onClick={handleVerify}
        >
          {verifying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Verify
        </Button>

        <p className="text-[11px] text-muted-foreground">
          Lost your phone? Ask a super admin to reset your authenticator.
        </p>

        {!isDialog && (
          <div className="flex justify-center pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => void (signOut ? signOut() : supabase.auth.signOut())}
            >
              <LogOut className="mr-1.5 h-3.5 w-3.5" />
              Sign out
            </Button>
          </div>
        )}
      </div>
    </div>
  );

  if (isDialog) {
    return content;
  }

  return createPortal(
    <div className="fixed inset-0 z-[200] grid h-screen w-screen place-items-center overflow-y-auto bg-background/95 p-4 backdrop-blur-sm">
      {content}
    </div>,
    document.body
  );
}

export default AuthenticatorChallengeScreen;
