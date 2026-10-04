import { ReactNode, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Loader2, Phone, ShieldCheck, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { cleanPhoneNumber, isValidPhoneNumber } from '@/lib/phoneUtils';
import { useNavigate } from 'react-router-dom';
import ScreenLoader from '@/components/common/ScreenLoader';

interface Props {
  children: ReactNode;
}

/**
 * Post-login phone verification gate. Blocks role-specific routes until the
 * signed-in user has a verified phone number on their profile.
 */
export default function PhoneVerificationGate({ children }: Props) {
  const { user } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [checking, setChecking] = useState(true);
  const [needsPhone, setNeedsPhone] = useState(false);
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);

  // Check current profile.phone on mount / user change
  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setChecking(false);
      setNeedsPhone(false);
      return;
    }
    (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('phone')
        .eq('id', user.id)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        // Fail open — don't trap the user out if the lookup itself errored
        setNeedsPhone(false);
      } else {
        const p = (data?.phone || '').trim();
        setNeedsPhone(!p);
      }
      setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleSend = async () => {
    const cleaned = cleanPhoneNumber(phone);
    if (!isValidPhoneNumber(cleaned)) {
      toast({ title: 'Invalid number', description: 'Please enter a valid phone number.', variant: 'destructive' });
      return;
    }
    setSending(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sms-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send', phone: cleaned }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to send code');
      toast({ title: 'Code sent', description: 'Check your phone for the 6-digit code.' });
      setStep('otp');
    } catch (e: any) {
      toast({ title: 'Could not send code', description: e.message, variant: 'destructive' });
    } finally {
      setSending(false);
    }
  };

  const handleVerify = async () => {
    if (!user) return;
    const cleaned = cleanPhoneNumber(phone);
    if (otp.trim().length !== 6) {
      toast({ title: 'Enter 6-digit code', variant: 'destructive' });
      return;
    }
    setVerifying(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sms-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', phone: cleaned, otp: otp.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Verification failed');

      // Persist on profile
      const { error: updErr } = await supabase
        .from('profiles')
        .update({ phone: cleaned })
        .eq('id', user.id);
      if (updErr) {
        // Most likely a unique-phone collision
        throw new Error(
          updErr.message?.includes('duplicate') || updErr.code === '23505'
            ? 'This phone number is already linked to another account.'
            : updErr.message,
        );
      }

      toast({ title: 'Phone verified', description: 'Welcome back!' });
      setNeedsPhone(false);
    } catch (e: any) {
      toast({ title: 'Verification failed', description: e.message, variant: 'destructive' });
    } finally {
      setVerifying(false);
    }
  };

  if (checking) {
    return (
      <ScreenLoader />
    );
  }

  if (!needsPhone) return <>{children}</>;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6 py-10">
      <div className="max-w-md w-full space-y-6">
        <div className="text-center space-y-3">
          <div className="mx-auto h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
            {step === 'phone' ? (
              <Phone className="h-7 w-7 text-primary" />
            ) : (
              <ShieldCheck className="h-7 w-7 text-primary" />
            )}
          </div>
          <h1 className="text-xl font-bold text-foreground">
            {step === 'phone' ? 'Verify your phone number' : 'Enter the 6-digit code'}
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {step === 'phone'
              ? 'We need to verify a phone number on your account before you can continue. This keeps your wallet, payments and rent records secure.'
              : `We sent a code to ${phone}. Enter it below to confirm this number is yours.`}
          </p>
        </div>

        <div className="space-y-3">
          {step === 'phone' ? (
            <>
              <Input
                type="tel"
                inputMode="tel"
                placeholder="e.g. 0772 123 456"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={sending}
                autoFocus
              />
              <Button onClick={handleSend} disabled={sending || !phone.trim()} className="w-full gap-2">
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}
                Send verification code
              </Button>
            </>
          ) : (
            <>
              <Input
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="123456"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                disabled={verifying}
                autoFocus
                className="text-center text-lg tracking-[0.4em]"
              />
              <Button onClick={handleVerify} disabled={verifying || otp.length !== 6} className="w-full gap-2">
                {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                Verify & continue
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setStep('phone');
                  setOtp('');
                }}
                disabled={verifying}
                className="w-full gap-2"
              >
                <ArrowLeft className="h-4 w-4" />
                Use a different number
              </Button>
            </>
          )}

          <Button
            variant="outline"
            onClick={async () => {
              await supabase.auth.signOut();
              navigate('/auth');
            }}
            className="w-full"
          >
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}