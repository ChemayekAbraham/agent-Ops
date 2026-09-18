import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useOtpVerification } from '@/hooks/useOtpVerification';
import { cleanPhoneNumber } from '@/lib/phoneUtils';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { joinPersonName, validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { toast } from 'sonner';
import { Store, Loader2, CheckCircle2, ShieldCheck, ArrowLeft } from 'lucide-react';
import welileLogo from '@/assets/welile-contract-logo.png';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_KEY = 'merchant_agent_ref';

/**
 * Simplified public Merchant Agent onboarding.
 *
 * URL: /merchant/register?ref=<referrer-uuid>
 *
 * Two steps only:
 *  1. Collect Full Name, Phone, NIN + T&Cs checkbox.
 *  2. Verify phone via SMS OTP, then create the account server-side
 *     (phone-signup edge fn), sign in, activate the Merchant Agent role
 *     via auto_activate_merchant_referral, and land on the merchant
 *     dashboard.
 */
export default function MerchantRegister() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user, loading, signIn } = useAuth();

  const rawRef = (params.get('ref') || '').trim();
  const ref = UUID_RX.test(rawRef) ? rawRef : '';

  const [step, setStep] = useState<'form' | 'otp'>('form');
  // Captured in parts; the submitted string stays a single `full_name`.
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const fullName = joinPersonName(nameParts);
  const [phone, setPhone] = useState('');
  const [nin, setNin] = useState('');
  const [agree, setAgree] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const {
    otpSent, otpVerified, otpLoading, otpError,
    sendStatus, cooldownSeconds,
    sendOtp, verifyOtp,
  } = useOtpVerification();

  // Persist referrer so it survives any navigation/browser reload.
  useEffect(() => {
    if (ref) { try { localStorage.setItem(REF_KEY, ref); } catch { /* ignore */ } }
  }, [ref]);

  // If already signed in as an active merchant agent, jump straight in.
  useEffect(() => {
    if (loading || !user?.id) return;
    (async () => {
      const { data: ca } = await supabase
        .from('cashout_agents')
        .select('id, is_active')
        .eq('agent_id', user.id)
        .maybeSingle();
      if (ca?.is_active) navigate('/dashboard/agent', { replace: true });
    })();
  }, [user?.id, loading, navigate]);

  const trimmedName = fullName.trim();
  const trimmedNin = nin.trim().toUpperCase();
  const cleanedPhone = cleanPhoneNumber(phone);

  const formValid = useMemo(() => {
    if (!validatePersonNameParts(nameParts).valid) return false;
    if (cleanedPhone.replace(/\D/g, '').length < 9) return false;
    if (trimmedNin.length < 10 || trimmedNin.length > 14) return false;
    if (!/^[A-Z0-9]+$/.test(trimmedNin)) return false;
    if (!agree) return false;
    return true;
  }, [nameParts, cleanedPhone, trimmedNin, agree]);

  const handleContinue = async () => {
    if (!formValid) {
      toast.error('Please complete every field and accept the terms.');
      return;
    }
    setSubmitting(true);
    try {
      // Uniqueness pre-check for phone (best-effort — server enforces authoritatively).
      const { data: available } = await supabase.rpc('is_phone_available', { p_phone: cleanedPhone });
      if (available === false) {
        toast.error('This phone number is already registered. Please sign in instead.');
        setSubmitting(false);
        return;
      }
      const ok = await sendOtp(cleanedPhone, { category: 'signup' });
      if (ok) setStep('otp');
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerify = async () => {
    if (otpCode.length !== 6) {
      toast.error('Enter the 6-digit code we sent.');
      return;
    }
    setSubmitting(true);
    try {
      const verified = await verifyOtp(cleanedPhone, otpCode, { category: 'signup' });
      if (!verified) {
        toast.error(otpError || 'Invalid or expired code.');
        return;
      }

      // Create the account via the phone-signup edge fn (proof-of-OTP guarded).
      const last9 = cleanedPhone.replace(/\D/g, '').slice(-9);
      const authEmail = `${last9}@welile.agent`;
      const password = `Wm${last9}${Math.random().toString(36).slice(2, 8)}!`;
      const { data: fnData, error: fnError } = await supabase.functions.invoke('phone-signup', {
        body: {
          email: authEmail,
          password,
          full_name: trimmedName,
          phone: cleanedPhone,
          referrer_id: ref || null,
          intended_role: 'agent',
          signup_source: 'merchant_register',
        },
      });
      let serverError = (fnData as { error?: string } | null)?.error || null;
      if (!serverError && fnError) {
        const ctx = (fnError as { context?: Response }).context;
        if (ctx && typeof ctx.json === 'function') {
          try { serverError = (await ctx.clone().json())?.error || null; } catch { /* ignore */ }
        }
        if (!serverError) serverError = fnError.message;
      }
      if (serverError) {
        toast.error(serverError);
        return;
      }

      // Sign the new merchant in.
      const { error: signInError } = await signIn(authEmail, password);
      if (signInError) {
        toast.error('Account created, but automatic sign-in failed. Please sign in manually.');
        navigate('/auth', { replace: true });
        return;
      }

      // Persist NIN + merchant flags on the profile.
      const { data: sessionData } = await supabase.auth.getUser();
      const uid = sessionData.user?.id;
      if (uid) {
        await supabase
          .from('profiles')
          .update({
            national_id: trimmedNin,
            full_name: trimmedName,
            phone: cleanedPhone,
            phone_verified: true,
            phone_verified_at: new Date().toISOString(),
            pending_merchant_agent: true,
            merchant_agent_referrer_id: ref || null,
          })
          .eq('id', uid);

        // Activate the Merchant Agent role (cashout_agents + 'agent' role).
        if (ref) {
          try {
            await supabase.rpc('auto_activate_merchant_referral', { p_referrer: ref });
          } catch (err) {
            console.warn('[MerchantRegister] auto-activate failed', err);
          }
        }
      }

      toast.success('Welcome to Welile! Your Merchant Agent account is ready.');
      navigate('/dashboard/agent', { replace: true });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/10 via-background to-background safe-area-top safe-area-bottom">
      <div className="max-w-md mx-auto px-4 py-8 space-y-5">
        <div className="flex items-center gap-3">
          <img src={welileLogo} alt="Welile" className="h-9 w-auto" />
          <div className="flex-1">
            <h1 className="text-lg font-extrabold leading-tight">Become a Merchant Agent</h1>
            <p className="text-xs text-muted-foreground">Takes less than 2 minutes.</p>
          </div>
          <div className="p-2 rounded-xl bg-primary/15">
            <Store className="h-5 w-5 text-primary" />
          </div>
        </div>

        {step === 'form' && (
          <Card className="p-5 rounded-2xl space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Full Name</Label>
              <PersonNameFields idPrefix="mr" value={nameParts} onChange={setNameParts} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mr-phone" className="text-xs font-semibold">Phone Number</Label>
              <Input
                id="mr-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0772 123 456"
                inputMode="tel"
                autoComplete="tel"
                className="h-11 rounded-xl"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mr-nin" className="text-xs font-semibold">National ID Number (NIN)</Label>
              <Input
                id="mr-nin"
                value={nin}
                onChange={(e) => setNin(e.target.value.toUpperCase())}
                placeholder="CM1234567890AB"
                maxLength={14}
                className="h-11 rounded-xl uppercase tracking-wider"
              />
            </div>

            <label className="flex items-start gap-2.5 p-3 rounded-xl bg-muted/40 cursor-pointer">
              <Checkbox
                checked={agree}
                onCheckedChange={(v) => setAgree(Boolean(v))}
                className="mt-0.5"
              />
              <span className="text-xs leading-relaxed">
                I confirm that the information provided is correct, and I agree to the{' '}
                <span className="font-semibold text-primary">Merchant Agent Terms and Conditions</span>.
              </span>
            </label>

            <Button
              className="w-full h-12 rounded-xl text-base font-bold"
              disabled={!formValid || submitting}
              onClick={handleContinue}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
              Continue
            </Button>
          </Card>
        )}

        {step === 'otp' && (
          <Card className="p-5 rounded-2xl space-y-4">
            <button
              type="button"
              onClick={() => setStep('form')}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-3 w-3" /> Edit details
            </button>

            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              <h3 className="text-base font-bold">Verify your phone</h3>
            </div>
            <p className="text-xs text-muted-foreground">
              We sent a 6-digit code to <span className="font-semibold text-foreground">{cleanedPhone}</span>.
            </p>

            <div className="flex justify-center py-2">
              <InputOTP
                maxLength={6}
                value={otpCode}
                onChange={setOtpCode}
                disabled={submitting || otpVerified}
              >
                <InputOTPGroup>
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <InputOTPSlot key={i} index={i} />
                  ))}
                </InputOTPGroup>
              </InputOTP>
            </div>

            {otpError && (
              <p className="text-xs text-destructive text-center">{otpError}</p>
            )}

            <Button
              className="w-full h-12 rounded-xl text-base font-bold"
              disabled={otpCode.length !== 6 || submitting || otpLoading}
              onClick={handleVerify}
            >
              {submitting || otpLoading
                ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                : <CheckCircle2 className="h-4 w-4 mr-1.5" />}
              Verify &amp; Create Account
            </Button>

            <Button
              type="button"
              variant="ghost"
              className="w-full h-10 rounded-xl text-xs"
              disabled={cooldownSeconds > 0 || otpLoading}
              onClick={() => sendOtp(cleanedPhone, { category: 'signup' })}
            >
              {cooldownSeconds > 0
                ? `Resend code in ${cooldownSeconds}s`
                : sendStatus === 'pending' ? 'Sending…' : 'Resend code'}
            </Button>

            {!otpSent && (
              <p className="text-[11px] text-muted-foreground text-center">
                Didn't get a code? Tap resend or go back and check your phone number.
              </p>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}