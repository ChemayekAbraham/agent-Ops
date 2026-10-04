import { useEffect, useRef, useState } from 'react';
import { ShieldCheck, Loader2, LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { useAuth } from '@/hooks/useAuth';
import { useTwoFactor } from '@/hooks/useTwoFactor';

/**
 * Full-screen block for a device that has NOT been verified while the account
 * has two-step verification switched on. A 6-digit code is emailed to the
 * account owner; the dashboard stays hidden until it is entered.
 */
export default function TwoFactorGate() {
  const { user, signOut } = useAuth();
  const { enabled, deviceTrusted, loading, emailMasked, requestCode, verifyCode, refresh } =
    useTwoFactor(user?.id);
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const requestedRef = useRef(false);

  const mustVerify = Boolean(user?.id) && !loading && enabled && !deviceTrusted;

  // Send the first code automatically once we know this device is unverified.
  useEffect(() => {
    if (!mustVerify || requestedRef.current) return;
    requestedRef.current = true;
    setSending(true);
    requestCode().then(({ data }) => {
      setSending(false);
      if (data) setSentTo((data as any)?.email_masked ?? emailMasked ?? null);
    });
  }, [mustVerify, requestCode, emailMasked]);

  if (!mustVerify) return null;

  const submit = async () => {
    if (code.length !== 6 || verifying) return;
    setVerifying(true);
    const { error } = await verifyCode(code);
    setVerifying(false);
    if (error) {
      setCode('');
      return;
    }
    toast.success('Device verified');
    await refresh();
  };

  const resend = async () => {
    setSending(true);
    const { data } = await requestCode();
    setSending(false);
    if (data) {
      setSentTo((data as any)?.email_masked ?? emailMasked ?? null);
      toast.success('New code sent');
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background p-5">
      <div className="w-full max-w-sm space-y-5 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
          <ShieldCheck className="h-7 w-7 text-primary" />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold text-foreground">Verify this device</h1>
          <p className="text-sm text-muted-foreground">
            Two-step verification is on for your account. Enter the 6-digit code we emailed to{' '}
            <strong className="text-foreground">{sentTo ?? emailMasked ?? 'your email'}</strong>.
          </p>
        </div>

        <div className="flex justify-center">
          <InputOTP
            maxLength={6}
            value={code}
            onChange={(v) => setCode(v.replace(/\D/g, ''))}
            onComplete={submit}
            disabled={verifying}
          >
            <InputOTPGroup>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <InputOTPSlot key={i} index={i} />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>

        <Button className="w-full" onClick={submit} disabled={code.length !== 6 || verifying}>
          {verifying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {verifying ? 'Verifying…' : 'Verify & continue'}
        </Button>

        <div className="flex items-center justify-center gap-3 text-xs">
          <Button variant="ghost" size="sm" onClick={resend} disabled={sending}>
            {sending ? 'Sending…' : 'Send a new code'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => signOut()}
          >
            <LogOut className="mr-1.5 h-3.5 w-3.5" />
            Sign out
          </Button>
        </div>

        <p className="text-[11px] text-muted-foreground">
          Didn't request this? Sign out and change your password from a device you trust.
        </p>
      </div>
    </div>
  );
}
