import { useEffect, useRef, useState } from 'react';
import { Smartphone, Loader2, LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { useAuth } from '@/hooks/useAuth';
import { useDeviceStepUp } from '@/hooks/useDeviceStepUp';

/**
 * Full-screen block shown when this is the 3rd or later account to sign in on
 * this device: the account's owner confirms a code texted to the account's own
 * phone, once, and the device is trusted for that account from then on.
 *
 * Logic: useDeviceStepUp / device-step-up edge function. Markup mirrors
 * TwoFactorGate; styling is Gemini's to refine.
 */
export default function DeviceStepUpGate() {
  const { user, signOut } = useAuth();
  const { required, loading, phoneMasked, requestCode, verifyCode } = useDeviceStepUp(user?.id);
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const requestedRef = useRef(false);

  const mustVerify = Boolean(user?.id) && !loading && required;

  // Send the first code automatically once we know a code is needed.
  useEffect(() => {
    if (!mustVerify || requestedRef.current) return;
    requestedRef.current = true;
    setSending(true);
    requestCode().then(({ data }) => {
      setSending(false);
      if (data?.phone_masked) setSentTo(data.phone_masked);
    });
  }, [mustVerify, requestCode]);

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
    toast.success('Phone confirmed');
  };

  const resend = async () => {
    setSending(true);
    const { data } = await requestCode();
    setSending(false);
    if (data?.phone_masked) {
      setSentTo(data.phone_masked);
      toast.success('New code sent');
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background p-5">
      <div className="w-full max-w-sm space-y-5 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
          <Smartphone className="h-7 w-7 text-primary" />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold text-foreground">Confirm it's you</h1>
          <p className="text-sm text-muted-foreground">
            Several accounts have signed in on this phone. To keep your account safe, enter the 6-digit code we sent
            by SMS to <strong className="text-foreground">{sentTo ?? phoneMasked ?? 'your phone'}</strong>.
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
          {verifying ? 'Verifying…' : 'Confirm & continue'}
        </Button>

        <div className="flex items-center justify-center gap-3 text-xs">
          <Button variant="ghost" size="sm" onClick={resend} disabled={sending}>
            {sending ? 'Sending…' : 'Send a new code'}
          </Button>
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => signOut()}>
            <LogOut className="mr-1.5 h-3.5 w-3.5" />
            Sign out
          </Button>
        </div>

        <p className="text-[11px] text-muted-foreground">
          This is a one-time check for your account on this phone.
        </p>
      </div>
    </div>
  );
}
