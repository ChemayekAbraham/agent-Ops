import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShieldCheck, Loader2, LogOut, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { supabase } from '@/integrations/supabase/client';
import { useSafeAuth } from '@/components/auth/useSafeAuth';
import { useAuthenticatorMfa } from '@/hooks/useAuthenticatorMfa';

interface AuthenticatorSetupScreenProps {
  onSuccess?: () => void;
  isDialog?: boolean;
}

export function AuthenticatorSetupScreen({ onSuccess, isDialog = false }: AuthenticatorSetupScreenProps) {
  const { user, signOut } = useSafeAuth();
  const { enrol, busy, error, startEnrol, verifyEnrol } = useAuthenticatorMfa(user?.id);
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    if (!enrol && !busy) {
      void startEnrol();
    }
  }, [enrol, busy, startEnrol]);

  const copySecret = async () => {
    if (!enrol?.secret) return;
    try {
      await navigator.clipboard.writeText(enrol.secret);
      setCopied(true);
      toast.success('Key copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy key');
    }
  };

  const handleConfirm = async () => {
    const cleanCode = code.replace(/\D/g, '');
    if (cleanCode.length !== 6 || verifying) return;
    setVerifying(true);
    const res = await verifyEnrol(cleanCode);
    setVerifying(false);
    if (res.ok) {
      toast.success('Authenticator app configured');
      onSuccess?.();
    }
  };

  const content = (
    <div className="w-full max-w-md space-y-5 rounded-2xl border border-border/60 bg-card p-6 shadow-xl">
      <div className="text-center space-y-2">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <ShieldCheck className="h-6 w-6" />
        </div>
        <h1 className="text-lg font-bold text-foreground">Set up authenticator app</h1>
        <p className="text-xs text-muted-foreground">
          Protect your staff account with multi-factor authentication.
        </p>
      </div>

      <div className="space-y-4 text-xs">
        <div className="space-y-2 rounded-xl bg-muted/30 p-3">
          <p className="font-semibold text-foreground">Follow these steps:</p>
          <ol className="list-decimal pl-4 space-y-1 text-muted-foreground">
            <li>Install <strong className="text-foreground">Google Authenticator</strong> or <strong className="text-foreground">Microsoft Authenticator</strong> on your phone.</li>
            <li>Scan this QR code with the app.</li>
            <li>Type the 6-digit number shown by your app.</li>
          </ol>
        </div>

        <div className="flex flex-col items-center justify-center gap-3">
          {busy && !enrol ? (
            <div className="flex h-48 w-48 items-center justify-center rounded-xl border border-dashed border-border bg-muted/20">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : enrol?.qrSvg ? (
            <div className="rounded-xl border border-border bg-white p-3 shadow-sm">
              <img src={enrol.qrSvg} alt="Scan QR code with authenticator app" className="h-44 w-44" />
            </div>
          ) : (
            <div className="flex h-48 w-48 flex-col items-center justify-center gap-2 rounded-xl border border-border bg-muted/20 p-4 text-center">
              <p className="text-[11px] text-destructive">{error || 'Could not generate setup code'}</p>
              <Button size="sm" variant="outline" onClick={() => void startEnrol()}>Retry</Button>
            </div>
          )}

          {enrol?.secret && (
            <div className="w-full space-y-1">
              <p className="text-[11px] text-muted-foreground text-center">Can't scan? Enter this key manually:</p>
              <div className="flex items-center justify-center gap-2 rounded-lg border border-border/80 bg-muted/40 px-3 py-1.5 font-mono text-xs">
                <span className="select-all tracking-wider font-semibold">{enrol.secret}</span>
                <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" onClick={copySecret} title="Copy key">
                  {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-2 pt-2">
          <label htmlFor="authenticator-setup-code" className="block text-center font-medium text-foreground">
            Enter 6-digit code
          </label>
          <div className="flex justify-center">
            <InputOTP
              id="authenticator-setup-code"
              maxLength={6}
              value={code}
              onChange={(v) => setCode(v.replace(/\D/g, ''))}
              onComplete={handleConfirm}
              disabled={verifying}
              autoComplete="one-time-code"
            >
              <InputOTPGroup>
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <InputOTPSlot key={i} index={i} />
                ))}
              </InputOTPGroup>
            </InputOTP>
          </div>
          {error && (
            <p role="alert" className="text-center text-xs font-medium text-destructive">
              {error}
            </p>
          )}
          <p className="text-center text-[11px] text-muted-foreground">
            If the code is rejected, check that the time on your phone is automatic.
          </p>
        </div>

        <Button
          id="authenticator-setup-confirm"
          className="w-full h-10 font-semibold"
          disabled={code.length !== 6 || verifying}
          onClick={handleConfirm}
        >
          {verifying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Confirm
        </Button>

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

export default AuthenticatorSetupScreen;
