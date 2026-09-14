import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { usePhoneDuplicateCheck } from '@/hooks/usePhoneDuplicateCheck';
import { useOtpVerification } from '@/hooks/useOtpVerification';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { loginTelemetry as lt } from '@/lib/loginTelemetry';
import { getLocationData } from '@/hooks/useGeolocation';
import { generatePhoneEmailVariants, cleanPhoneNumber, isValidPhoneNumber, getTriedPhoneFormats } from '@/lib/phoneUtils';
import {
  validateSignUp,
  validateFullName,
  joinPersonName,
  splitPersonName,
  validatePersonNameParts,
  type PersonNameParts,
} from '@/lib/authValidation';
import { roleToSlug } from '@/lib/roleRoutes';
import { getStoredAttributionToken } from '@/lib/campaignAttribution';
import { captureReferralAttribution, getStoredReferrerId } from '@/lib/referralAttribution';

const VALID_SIGNUP_ROLES = ['tenant', 'agent', 'landlord', 'supporter'] as const;

// Attribution: where did this signup originate? Sanitised to a short slug so
// only safe, comparable values (e.g. `chatgpt`, `claude`, `internship`) land in
// `profiles.signup_source`. Powers connector conversion tracking.
const SIGNUP_SOURCE_KEY = 'welile_signup_source';
function sanitizeSignupSource(raw: string | null | undefined): string | null {
  const cleaned = (raw ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  return cleaned || null;
}

export function useAuthForm() {
  const [searchParams, setSearchParams] = useSearchParams();
  const referralId = searchParams.get('ref');
  const becomeRole = searchParams.get('become');
  const rawRole = searchParams.get('role');
  const preSelectedRole = rawRole && VALID_SIGNUP_ROLES.includes(rawRole as any) ? rawRole : null;

  // Connector/campaign attribution (e.g. `?signup_source=chatgpt`). Persist it
  // so it survives role selection and OAuth redirects before the account exists.
  const signupSourceParam = sanitizeSignupSource(searchParams.get('signup_source') || searchParams.get('source'));
  const [signupSourceState, setSignupSourceState] = useState<string | null>(() => {
    if (signupSourceParam) return signupSourceParam;
    try { return localStorage.getItem(SIGNUP_SOURCE_KEY); } catch { return null; }
  });

  const [referrerIdState, setReferrerIdState] = useState<string | null>(() => {
    if (referralId) return referralId;
    return getStoredReferrerId();
  });

  const [isSignUp, setIsSignUp] = useState(!!referralId || !!becomeRole || !!preSelectedRole);
  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [isForgotPhone, setIsForgotPhone] = useState(false);
  const [email, setEmail] = useState('');
  // Optional email collected on the SIGNUP form. Kept separate from `email`
  // (which is reused by the forgot-password / forgot-phone flows) so the two
  // never overwrite each other.
  const [signupEmail, setSignupEmail] = useState('');
  // Set when a real-email signup is waiting on the mandatory confirmation link.
  const [emailConfirmationSent, setEmailConfirmationSent] = useState<string | null>(null);

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  // Person-name capture is split into parts in the UI, but `fullName` (and the
  // submitted payload) stays the exact same single string it has always been.
  const [nameParts, setNameParts] = useState<PersonNameParts>({
    firstName: '',
    otherNames: '',
    lastName: '',
  });
  const [namePartsError, setNamePartsError] = useState<string | null>(null);
  const fullName = joinPersonName(nameParts);
  // Kept for backwards compatibility with any consumer that sets a whole name
  // string (e.g. the `?name=` URL param) — it hydrates the parts.
  const setFullName = (value: string) => setNameParts(splitPersonName(value));
  const [phone, setPhone] = useState('');
  const [countryCode, setCountryCode] = useState('256');
  const [isLoading, setIsLoading] = useState(false);
  const [loginError, setLoginError] = useState<{ message: string; triedFormats: string[] } | null>(null);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [rememberMe, setRememberMe] = useState(() => {
    const saved = localStorage.getItem('welile_remember_me');
    return saved !== 'false';
  });
  const [showPassword, setShowPassword] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [isAppleLoading, setIsAppleLoading] = useState(false);
  // Granular progress for the Sign In button so users see what's happening
  // instead of a generic spinner. Set throughout handleSignInSubmit.
  type LoginStage =
    | 'idle'
    | 'validating'
    | 'checking-cache'
    | 'looking-up'
    | 'trying-fast'
    | 'trying-extended'
    | 'finalizing';
  const [loginStage, setLoginStage] = useState<LoginStage>('idle');

  const phoneInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  const { signUpWithoutRole, signIn, signInWithGoogle, signInWithApple, resetPassword, user, roles } = useAuth();
  const { isDuplicate, isChecking: isCheckingDuplicate, duplicateMessage } = usePhoneDuplicateCheck(phone, 400);
  const { otpSent, otpVerified, verifiedPhone, otpLoading, otpError, sendStatus: otpSendStatus, cooldownSeconds: otpCooldownSeconds, sendOtp, verifyOtp, resetOtp: resetOtpState } = useOtpVerification();
  const navigate = useNavigate();
  const { toast } = useToast();

  // Store referral/role params & validate role
  useEffect(() => {
    if (referralId) {
      captureReferralAttribution();
      setReferrerIdState(referralId);
    } else if (!referrerIdState) {
      const durable = getStoredReferrerId();
      if (durable) setReferrerIdState(durable);
    }
    if (signupSourceParam) {
      try { localStorage.setItem(SIGNUP_SOURCE_KEY, signupSourceParam); } catch { /* ignore */ }
      setSignupSourceState(signupSourceParam);
    }
    if (becomeRole) {
      localStorage.setItem('become_role', becomeRole);
    }
    if (preSelectedRole) {
      localStorage.setItem('become_role', preSelectedRole);
    }
    // If role param is present but invalid, remove it from URL
    if (rawRole && !preSelectedRole) {
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('role');
      setSearchParams(newParams, { replace: true });
    }
  }, [referralId, signupSourceParam, becomeRole, preSelectedRole, rawRole]);

  // Redirect on auth — wait briefly for roles to load before deciding
  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!user) return;
    localStorage.setItem('welile_had_session', 'true');

    // Best-effort attribution backfill for social sign-ups (Google/Apple), which
    // don't carry our signup metadata. Only sets `signup_source` when it's still
    // empty so we never overwrite an existing attribution (e.g. funder-onboarding).
    (async () => {
      let stored: string | null = null;
      try { stored = localStorage.getItem(SIGNUP_SOURCE_KEY); } catch { /* ignore */ }
      const source = sanitizeSignupSource(stored);
      if (!source) return;
      try {
        const { data: prof } = await supabase
          .from('profiles')
          .select('signup_source')
          .eq('id', user.id)
          .maybeSingle();
        if (prof && !prof.signup_source) {
          await supabase.from('profiles').update({ signup_source: source }).eq('id', user.id);
        }
        localStorage.removeItem(SIGNUP_SOURCE_KEY);
      } catch { /* non-fatal */ }
    })();

    // If roles already loaded, navigate immediately
    if (roles.length > 0) {
      if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
      navigate(roleToSlug(roles[0]), { replace: true });
      return;
    }

    // Roles not yet loaded — give them up to 3s before falling back to /select-role
    if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
    redirectTimerRef.current = setTimeout(() => {
      if (roles.length > 0) {
        navigate(roleToSlug(roles[0]), { replace: true });
      } else {
        navigate('/select-role', { replace: true });
      }
    }, 3000);

    return () => {
      if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
    };
  }, [user, roles, navigate]);

  // Auto-focus
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!isSignUp) {
        phoneInputRef.current?.focus();
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [isSignUp]);

  const saveLocationInBackground = () => {
    getLocationData().then(async (locationData) => {
      if (locationData?.country || locationData?.city) {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          await supabase
            .from('profiles')
            .update({
              country: locationData.country,
              city: locationData.city,
              country_code: locationData.countryCode
            })
            .eq('id', user.id);
        }
      }
    }).catch(console.error);
  };

  const handleForgotPhoneSubmit = async () => {
    const isValidEmail = email.includes('@') && email.includes('.');
    if (!isValidEmail) {
      toast({ title: 'Error', description: 'Please enter a valid email', variant: 'destructive' });
      return;
    }
    const { error } = await signIn(email, password);
    if (error) {
      let errorMessage = error.message;
      if (error.message.includes('Invalid login credentials')) {
        // Try to detect a deleted/archived account by email so we can show a precise message.
        try {
          const { data: lookup } = await supabase.rpc('check_archived_account_by_email', {
            p_email: email.trim().toLowerCase(),
          });
          const archivedRow = Array.isArray(lookup) ? lookup[0] : null;
          if (archivedRow?.is_archived) {
            const cleanName = (archivedRow.full_name || '').trim();
            const when = archivedRow.archived_at ? ` on ${new Date(archivedRow.archived_at).toLocaleDateString()}` : '';
            if (archivedRow.status === 'freed') {
              errorMessage = `The previous account${cleanName ? ` for ${cleanName}` : ''} using this email was permanently closed${when}. ` +
                `That account can't be restored — please tap "Sign up" to create a brand-new account with this email.`;
            } else {
              errorMessage = `This account${cleanName ? ` for ${cleanName}` : ''} was archived${when}. ` +
                `It can still be restored — contact Welile support to recover access. This email cannot sign in until then.`;
            }
            try {
              await supabase.rpc('log_archived_login_attempt', {
                p_identifier: email.trim().toLowerCase(),
                p_identifier_type: 'email',
                p_archived_user_id: archivedRow.user_id ?? null,
                p_full_name: cleanName || null,
                p_archived_at: archivedRow.archived_at ?? null,
              });
            } catch (e) { console.warn('[Auth] audit log failed', e); }
            toast({
              title: archivedRow.status === 'freed' ? 'Account Permanently Closed' : 'Account Archived',
              description: errorMessage,
              variant: 'destructive',
            });
            return;
          }
        } catch { /* fall through to generic message */ }
        errorMessage = 'No account found with this email, or the password is incorrect. If you signed in with Google, please use the "Continue with Google" button instead.';
      }
      toast({ title: 'Sign In Failed', description: errorMessage, variant: 'destructive' });
      return;
    }
    // Persistent login: once signed in, stay signed in until the user
    // explicitly signs out. Suppress the inactivity lock indefinitely
    // by parking the "remember until" timestamp 10 years in the future.
    try {
      const until = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
      localStorage.setItem('welile_remember_until', String(until));
    } catch { /* non-critical */ }
  };

  // SMS reset state
  const [resetStep, setResetStep] = useState<'phone' | 'otp' | 'new-password'>('phone');
  const [resetPhone, setResetPhone] = useState('');
  const [resetOtp, setResetOtpCode] = useState('');
  const [resetNewPassword, setResetNewPassword] = useState('');
  const [resetConfirmPassword, setResetConfirmPassword] = useState('');

  const clearPhoneLoginCache = (rawPhone: string) => {
    const last9 = rawPhone.replace(/\D/g, '').slice(-9);
    if (!last9) return;
    try {
      localStorage.removeItem(`welile_phone_email_cache_v2_${last9}`);
      localStorage.removeItem(`welile_phone_email_cache_${last9}`);
    } catch { /* non-critical */ }
  };

  const markRecentPasswordReset = (rawPhone: string) => {
    const last9 = rawPhone.replace(/\D/g, '').slice(-9);
    if (!last9) return;
    try { localStorage.setItem(`welile_recent_password_reset_${last9}`, String(Date.now())); } catch { /* non-critical */ }
  };

  const wasRecentlyReset = (rawPhone: string) => {
    const last9 = rawPhone.replace(/\D/g, '').slice(-9);
    if (!last9) return false;
    try {
      const at = Number(localStorage.getItem(`welile_recent_password_reset_${last9}`) || 0);
      return at > 0 && Date.now() - at < 15 * 60 * 1000;
    } catch {
      return false;
    }
  };

  const handleForgotPasswordSubmit = async () => {
    if (resetStep === 'phone') {
      // Check if it looks like an email (real email user) or phone
      const isEmail = email && email.includes('@') && email.includes('.') && !email.includes('@welile.');
      if (isEmail) {
        // Real email user — use Supabase email reset
        const { error } = await resetPassword(email);
        if (error) {
          toast({ title: 'Reset Failed', description: error.message, variant: 'destructive' });
        } else {
          toast({ title: 'Check Your Email', description: 'We sent you a password reset link' });
          setIsForgotPassword(false);
        }
        return;
      }

      // Phone-based reset via SMS
      const cleanedPhone = resetPhone.replace(/\D/g, '');
      if (cleanedPhone.length < 9) {
        toast({ title: 'Error', description: 'Please enter a phone number or email', variant: 'destructive' });
        return;
      }
      try {
        const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/password-reset-sms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
          body: JSON.stringify({ action: 'send', phone: cleanedPhone }),
        });
        const data = await response.json();
        if (!response.ok) {
          toast({ title: 'Error', description: data.error || 'Failed to send reset code', variant: 'destructive' });
        } else {
          toast({ title: 'Code Sent', description: 'Check your phone for the reset code' });
          setResetStep('otp');
        }
      } catch {
        toast({ title: 'Error', description: 'Network error. Please try again.', variant: 'destructive' });
      }
      return;
    }

    if (resetStep === 'otp') {
      if (resetOtp.length !== 6) {
        toast({ title: 'Error', description: 'Please enter the 6-digit code', variant: 'destructive' });
        return;
      }
      const cleanedPhone = resetPhone.replace(/\D/g, '');
      try {
        const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/password-reset-sms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
          body: JSON.stringify({ action: 'verify', phone: cleanedPhone, otp: resetOtp }),
        });
        const data = await response.json();
        if (!response.ok) {
          toast({ title: 'Invalid Code', description: data.error || 'That code is not valid.', variant: 'destructive' });
          return;
        }
        setResetStep('new-password');
      } catch {
        toast({ title: 'Error', description: 'Network error. Please try again.', variant: 'destructive' });
      }
      return;
    }

    if (resetStep === 'new-password') {
      if (resetNewPassword.length < 6) {
        toast({ title: 'Error', description: 'Password must be at least 6 characters', variant: 'destructive' });
        return;
      }
      if (resetNewPassword !== resetConfirmPassword) {
        toast({ title: 'Error', description: "Passwords don't match", variant: 'destructive' });
        return;
      }
      const cleanedPhone = resetPhone.replace(/\D/g, '');
      try {
        const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/password-reset-sms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
          body: JSON.stringify({ action: 'verify-and-reset', phone: cleanedPhone, otp: resetOtp, new_password: resetNewPassword }),
        });
        const data = await response.json();
        if (!response.ok) {
          if (data.error?.includes('Invalid code') || data.error?.includes('expired')) {
            setResetStep('otp');
          }
          toast({ title: 'Reset Failed', description: data.error || 'Failed to reset password', variant: 'destructive' });
        } else {
          const last9 = cleanedPhone.slice(-9);
          clearPhoneLoginCache(cleanedPhone);
          markRecentPasswordReset(cleanedPhone);
          setPhone(last9 ? `0${last9}` : resetPhone);
          setCountryCode('256');
          setPassword('');
          setShowPassword(false);
          setLoginError(null);
          setFailedAttempts(0);
          toast({ title: 'Password Reset!', description: 'Enter your new password below to sign in.' });
          setIsForgotPassword(false);
          setResetStep('phone');
          setResetPhone('');
          setResetOtpCode('');
          setResetNewPassword('');
          setResetConfirmPassword('');
          setTimeout(() => passwordInputRef.current?.focus(), 150);
        }
      } catch {
        toast({ title: 'Error', description: 'Network error. Please try again.', variant: 'destructive' });
      }
    }
  };

  const handleSignUpSubmit = async () => {
    if (isDuplicate) {
      toast({ title: 'Phone Already Registered', description: duplicateMessage || 'This phone number is already in use.', variant: 'destructive' });
      return;
    }
    const partsCheck = validatePersonNameParts(nameParts);
    if (!partsCheck.valid) {
      setNamePartsError(partsCheck.error);
      toast({ title: 'Error', description: partsCheck.error || 'Please enter your first and last name', variant: 'destructive' });
      return;
    }
    setNamePartsError(null);
    const nameCheck = validateFullName(fullName);
    const trimmedFullName = nameCheck.trimmed;
    const validationError = validateSignUp({ password, confirmPassword, fullName: trimmedFullName, phone });
    if (validationError) {
      toast({ title: 'Error', description: validationError, variant: 'destructive' });
      return;
    }
    setIsLoading(true);
    const trimmedEmail = signupEmail.trim().toLowerCase();
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const hasRealEmail = trimmedEmail.length > 0 && EMAIL_RE.test(trimmedEmail) && !trimmedEmail.endsWith('@welile.user') && !trimmedEmail.endsWith('@welile.agent');

    const cleanPhone = phone.replace(/\D/g, '');
    const fullPhone = cleanPhone.startsWith(countryCode) ? cleanPhone : countryCode + (cleanPhone.startsWith('0') ? cleanPhone.slice(1) : cleanPhone);
    // No email provided → require phone OTP verification before creating
    // the account (no email confirmation will be sent because the auth
    // identifier becomes a synthetic @welile.user placeholder and the
    // project is configured with auto_confirm_email = true).
    // The verified phone must match the number being submitted — otherwise a
    // user who verified one number then edited the field would send a stale
    // `otpVerified=true` and hit the server's "Phone not verified recently" 403.
    const verifiedMatchesCurrent =
      otpVerified && !!verifiedPhone && verifiedPhone.slice(-9) === fullPhone.replace(/\D/g, '').slice(-9);
    if (!hasRealEmail && !verifiedMatchesCurrent) {
      setIsLoading(false);
      toast({
        title: 'Verify your phone',
        description: 'Please verify your phone number with the code we sent before creating your account.',
        variant: 'destructive',
      });
      return;
    }
    const authEmail = hasRealEmail ? trimmedEmail : `${fullPhone}@welile.user`;
    const storedReferrerId = referrerIdState || getStoredReferrerId();
    console.log('[Auth] Signup with referrer:', storedReferrerId, '(state:', referrerIdState, ', durable:', getStoredReferrerId(), ')');

    // Pre-flight duplicate-phone check. The DB trigger `handle_new_user`
    // raises `phone_already_registered`, but GoTrue masks any trigger error
    // as an opaque "Database error while creating new user" (unexpected_failure),
    // so the raw message never reaches the client. Catch duplicates up front
    // to give the user an accurate, friendly message instead.
    try {
      const last9 = fullPhone.replace(/\D/g, '').slice(-9);
      if (last9.length === 9) {
        const { data: fraudRows } = await (supabase as any).rpc('check_fraud_account_by_phone', {
          phone_variants: [`0${last9}`, `256${last9}`, last9],
        });
        const fraudRow = Array.isArray(fraudRows) ? fraudRows[0] : null;
        if (fraudRow?.is_blocked) {
          setIsLoading(false);
          toast({
            title: 'Account Restricted',
            description: 'This phone number is permanently restricted for fraud review and cannot create a Welile account.',
            variant: 'destructive',
          });
          return;
        }

        if (hasRealEmail) {
          const { data: emailFraudRows } = await (supabase as any).rpc('check_fraud_account_by_email', {
            p_email: trimmedEmail,
          });
          const emailFraudRow = Array.isArray(emailFraudRows) ? emailFraudRows[0] : null;
          if (emailFraudRow?.is_blocked) {
            setIsLoading(false);
            toast({
              title: 'Account Restricted',
              description: 'This email is permanently restricted for fraud review and cannot create a Welile account.',
              variant: 'destructive',
            });
            return;
          }
        }

        // Block recycled fraud accounts that reuse the same display name with a
        // fresh phone/email. The DB trigger enforces this too, but we pre-check
        // to show a clear message before attempting account creation.
        const { data: nameFraudRows } = await (supabase as any).rpc('check_fraud_account_by_name', {
          p_full_name: trimmedFullName,
        });
        const nameFraudRow = Array.isArray(nameFraudRows) ? nameFraudRows[0] : null;
        if (nameFraudRow?.is_blocked) {
          setIsLoading(false);
          toast({
            title: 'Account Restricted',
            description: 'This name is linked to an account that was permanently restricted for fraud review and cannot be used to create a new Welile account.',
            variant: 'destructive',
          });
          return;
        }

        const { data: existing } = await supabase.rpc('check_phone_exists', { phone_suffix: last9 });
        if (Array.isArray(existing) && existing.length > 0) {
          setIsLoading(false);
          toast({
            title: 'Phone already registered',
            description: 'This phone number is already linked to an account. Please sign in instead.',
            variant: 'destructive',
          });
          return;
        }
      }
    } catch {
      // Non-fatal: fall through to signUp; the generic-error mapping below covers it.
    }

    const storedSignupSource = signupSourceState || sanitizeSignupSource((() => { try { return localStorage.getItem(SIGNUP_SOURCE_KEY); } catch { return null; } })());
    const campaignAttributionToken = getStoredAttributionToken();
    // Effective intended role. The sub-agent recruiting link uses `?become=agent`
    // (not `?role=agent`), so also honour `become`/localStorage `become_role`.
    // Passing `intended_role='agent'` + a referrer is what lets the server-side
    // `handle_new_user` trigger reliably create the `agent_subagents` link,
    // instead of depending on fragile localStorage in SelectRole.tsx (which is
    // routinely wiped on WhatsApp/iOS Safari opens, dropping sub-agents to plain
    // referrals).
    const storedBecomeRole = ((becomeRole || (() => { try { return localStorage.getItem('become_role'); } catch { return null; } })()) || '').trim();
    const effectiveIntendedRole = preSelectedRole
      || (VALID_SIGNUP_ROLES.includes(storedBecomeRole as any) ? storedBecomeRole : null);

    // Phone-only recruits (synthetic @welile.user address) are created entirely
    // server-side via the `phone-signup` edge function. This bypasses the built-in
    // mailer completely, so they are NEVER blocked by "email rate limit exceeded"
    // when the shared SMTP quota is exhausted. Their number is already SMS-verified
    // (otpVerified gate above), and the account is created pre-confirmed so they can
    // sign in immediately. Real-email signups keep the normal client signUp +
    // email-verification flow.
    if (!hasRealEmail) {
      const { data: fnData, error: fnError } = await supabase.functions.invoke('phone-signup', {
        body: {
          email: authEmail,
          password,
          full_name: trimmedFullName,
          phone: fullPhone,
          referrer_id: storedReferrerId || null,
          intended_role: effectiveIntendedRole || null,
          signup_source: storedSignupSource || null,
          campaign_attribution_token: campaignAttributionToken || null,
        },
      });
      // When the edge function returns a non-2xx status, supabase-js sets `fnError`
      // to a FunctionsHttpError whose generic message is "Edge Function returned a
      // non-2xx status code" and leaves `fnData` null. The real, friendly message
      // lives in the JSON body, reachable via `fnError.context` (a Response). Parse
      // it so the user sees "This phone number is already registered" etc.
      let serverError = (fnData as { error?: string } | null)?.error || null;
      if (!serverError && fnError) {
        const ctx = (fnError as { context?: Response }).context;
        if (ctx && typeof ctx.json === 'function') {
          try {
            const parsed = await ctx.clone().json();
            serverError = (parsed as { error?: string })?.error || null;
          } catch { /* body not JSON */ }
        }
        if (!serverError) serverError = fnError.message;
      }
      if (serverError) {
        setIsLoading(false);
        toast({ title: 'Sign Up Failed', description: serverError, variant: 'destructive' });
        return;
      }

      toast({ title: 'Account Created!', description: 'Welcome to Welile' });
      saveLocationInBackground();
      try { localStorage.removeItem(SIGNUP_SOURCE_KEY); } catch { /* ignore */ }

      const { error: signInError } = await signIn(authEmail, password);
      if (signInError) {
        setIsLoading(false);
        toast({
          title: 'Almost there',
          description: 'Your account was created. Please sign in to continue.',
        });
        return;
      }
      setIsLoading(false);
      return;
    }

    const { data, error } = await signUpWithoutRole(authEmail, password, trimmedFullName, fullPhone, storedReferrerId || undefined, effectiveIntendedRole || undefined, storedSignupSource || undefined);
    if (error) {
      setIsLoading(false);
      let errorMessage = error.message;
      if (error.message.includes('already registered')) {
        errorMessage = 'This phone number is already registered. Please sign in instead.';
      } else if (error.message.includes('phone_already_registered')) {
        errorMessage = 'This phone number is already linked to another account. Please sign in instead.';
      } else if (error.message.includes('fraud_blocked_identifier')) {
        errorMessage = 'This phone/email/name is permanently restricted for fraud review and cannot create a Welile account.';
      } else if (
        error.message.toLowerCase().includes('database error') ||
        (error as { code?: string }).code === 'unexpected_failure'
      ) {
        // GoTrue masks trigger exceptions (e.g. duplicate phone) with this generic error.
        errorMessage = 'This phone number may already be registered. Please try signing in, or use a different number.';
      }
      toast({ title: 'Sign Up Failed', description: errorMessage, variant: 'destructive' });
      return;
    }

    saveLocationInBackground();
    // Attribution captured in signup metadata — clear the stored source so it
    // can't leak onto a later, unrelated signup on the same device.
    try { localStorage.removeItem(SIGNUP_SOURCE_KEY); } catch { /* ignore */ }

    // Email verification is MANDATORY for real-email signups. GoTrue returns
    // no session until the confirmation link is clicked, and we must never
    // paper over that by signing the user in — doing so would let unconfirmed
    // (potentially fake) email accounts straight into the app.
    if (hasRealEmail && !data?.session) {
      setIsLoading(false);
      setEmailConfirmationSent(authEmail);
      toast({
        title: 'Confirm your email to finish',
        description: `We sent a confirmation link to ${authEmail}. Open it, then sign in.`,
      });
      return;
    }

    toast({
      title: 'Account Created!',
      description: 'Welcome to Welile',
    });

    // Phone-only (synthetic email) accounts are created pre-confirmed server
    // side, so a missing session here is just a client-side race — sign in.
    if (!data?.session) {
      const { error: signInError } = await signIn(authEmail, password);
      if (signInError) {
        setIsLoading(false);
        toast({
          title: 'Almost there',
          description: 'Your account was created. Please sign in to continue.',
        });
        return;
      }
    }
    setIsLoading(false);

  };

  const handleSignInSubmit = async () => {
    setLoginStage('validating');
    if (!isValidPhoneNumber(phone)) {
      toast({ title: 'Invalid Phone Number', description: 'Please enter a valid phone number', variant: 'destructive' });
      setLoginStage('idle');
      return;
    }

    if (!password) {
      toast({ title: 'Error', description: 'Password is required', variant: 'destructive' });
      setLoginStage('idle');
      return;
    }

    // Normalize phone to last 9 digits (strips country code / leading zeros)
    const digits = phone.replace(/\D/g, '');
    const last9 = digits.slice(-9);

    // ── Login performance metrics ────────────────────────────────────────
    const t0 = performance.now();
    const metrics = {
      rpcMs: 0,
      rpcFoundEmails: 0,
      attempts: 0,
      attemptTimings: [] as { email: string; ms: number; ok: boolean }[],
      phase1Ms: 0,
      phase2Ms: 0,
      winnerEmail: null as string | null,
      winnerPhase: null as 'phase1' | 'phase2' | null,
      totalMs: 0,
    };

    // PARALLEL LOGIN STRATEGY (fast path)
    // The old flow ran an RPC lookup (up to 5s) → optional profile fallback
    // (~500ms) → then up to 5+ sequential signInWithPassword attempts. On the
    // common phone-only account that meant 4–8s before the user got in.
    //
    // New flow: fire the 3 most likely placeholder identifiers AND the RPC
    // lookup in parallel. Whichever signin returns a session first wins.
    // Only if every placeholder fails do we wait on the RPC result and try
    // any real (Gmail/Outlook) email it returns.
    let loginSuccess = false;
    let lastError: Error | null = null;
    let accountExists = false;

    // ── Transient-error retry helper ────────────────────────────────────
    // Retries an async op with exponential backoff (200ms → 500ms → 1100ms,
    // jittered) for network/fetch/timeout/5xx errors. STOPS IMMEDIATELY on
    // auth-meaningful errors like "Invalid login credentials" so a wrong
    // password never gets retried (avoids rate-limit lockouts).
    const isTransientError = (err: any): boolean => {
      const msg = (err?.message || err?.error_description || String(err || '')).toLowerCase();
      if (!msg) return false;
      // Hard NO — auth-meaningful, do not retry.
      if (msg.includes('invalid login credentials')) return false;
      if (msg.includes('email not confirmed')) return false;
      if (msg.includes('user not found')) return false;
      if (msg.includes('rate') || msg.includes('too many')) return false;
      // Transient signals worth retrying.
      return (
        msg.includes('fetch') ||
        msg.includes('network') ||
        msg.includes('timeout') ||
        msg.includes('timed out') ||
        msg.includes('failed to fetch') ||
        msg.includes('load failed') ||
        msg.includes('econn') ||
        msg.includes('socket') ||
        msg.includes('502') ||
        msg.includes('503') ||
        msg.includes('504') ||
        msg.includes('gateway')
      );
    };
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
    const withRetry = async <T,>(
      op: () => Promise<T>,
      opts: { maxAttempts?: number; baseMs?: number; label: string; isTransient?: (e: any) => boolean } = { label: 'op' },
    ): Promise<T> => {
      const max = opts.maxAttempts ?? 3;
      const base = opts.baseMs ?? 200;
      const transient = opts.isTransient ?? isTransientError;
      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        attempt += 1;
        try {
          return await op();
        } catch (e: any) {
          if (attempt >= max || !transient(e)) throw e;
          const backoff = base * Math.pow(2.2, attempt - 1);
          const jitter = Math.random() * (base / 2);
          const wait = Math.round(backoff + jitter);
          // eslint-disable-next-line no-console
          console.warn(`[LoginRetry] ${opts.label} attempt ${attempt} failed (transient): ${e?.message || e}. Retrying in ${wait}ms`);
          (metrics as any).retries = ((metrics as any).retries ?? 0) + 1;
          await sleep(wait);
        }
      }
    };

    type SignInAttempt = { ok: boolean; email: string; error: Error | null };
    const placeholderCandidates = [
      `0${last9}@welile.user`,
      `256${last9}@welile.user`,
      `${last9}@welile.user`,
    ];

    // Resolve as soon as ONE candidate authenticates instead of waiting for
    // every parallel attempt to settle. Losing candidates keep running in the
    // background and are harmless — previously a single slow/queued attempt
    // (database under load) held the whole submit open even though the user
    // was already signed in, which is what left the button on "Signing in...".
    const raceForSuccess = async (
      emails: string[],
    ): Promise<{ winner: SignInAttempt | null; results: SignInAttempt[] }> => {
      const running = emails.map(tryOne);
      let winner: SignInAttempt | null = null;
      await new Promise<void>((resolve) => {
        let pending = running.length;
        if (!pending) return resolve();
        running.forEach((p) => {
          p.then((r) => {
            if (r.ok && !winner) {
              winner = r;
              resolve();
            }
          }).finally(() => {
            pending -= 1;
            if (pending === 0) resolve();
          });
        });
      });
      if (winner) return { winner, results: [] };
      return { winner: null, results: await Promise.all(running) };
    };

    const rpcLookup = (async (): Promise<string[]> => {
      const rpcStart = performance.now();
      // Short-TTL cache: repeated logins on the same device should not
      // re-pay the 300–3000ms RPC cost. Keyed by phone last-9, cached
      // for 7 days. Cleared on auth errors below if it goes stale.
      // v2: the lookup now prioritizes the real Supabase Auth login email over
      // the profile display email. Version the cache so devices holding the old
      // profile-only result do not keep failing after an admin password reset.
      const cacheKey = `welile_phone_email_cache_v2_${last9}`;
      const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
      try {
        const raw = localStorage.getItem(cacheKey);
        if (raw) {
          const parsed = JSON.parse(raw) as { at: number; emails: string[] };
          if (parsed?.at && Date.now() - parsed.at < CACHE_TTL_MS && Array.isArray(parsed.emails)) {
            metrics.rpcMs = Math.round(performance.now() - rpcStart);
            metrics.rpcFoundEmails = parsed.emails.length;
            (metrics as any).rpcCacheHit = true;
            return parsed.emails;
          }
        }
      } catch { /* non-critical */ }
      (metrics as any).rpcCacheHit = false;
      try {
        const { data } = await Promise.race([
          withRetry(
            async () => {
              const res = await supabase.rpc('get_email_by_phone', { phone_variants: [`0${last9}`, `256${last9}`, last9] });
              if (res.error && isTransientError(res.error)) throw res.error;
              return res;
            },
            { maxAttempts: 2, baseMs: 250, label: 'rpc:get_email_by_phone' },
          ),
          new Promise<{ data: null }>((resolve) => setTimeout(() => resolve({ data: null }), 3000)),
        ]);
        metrics.rpcMs = Math.round(performance.now() - rpcStart);
        if (data?.length) {
          const emails = (data as { email: string }[]).map(r => r.email).filter(Boolean);
          metrics.rpcFoundEmails = emails.length;
          try {
            localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), emails }));
          } catch { /* non-critical */ }
          return emails;
        }
      } catch {
        metrics.rpcMs = Math.round(performance.now() - rpcStart);
      }
      return [];
    })();

    const recentReset = wasRecentlyReset(phone);
    const earlyRpcEmails = recentReset
      ? await Promise.race<string[] | null>([
        rpcLookup,
        sleep(3000).then(() => null),
      ])
      : null;
    const phase1Candidates = earlyRpcEmails?.length
      ? [...new Set([
        ...earlyRpcEmails.filter((e) => !e.includes('@welile.')),
        ...earlyRpcEmails.filter((e) => e.includes('@welile.')),
      ])].slice(0, 4)
      : placeholderCandidates;
    if (earlyRpcEmails?.length) accountExists = true;

    const tryOne = async (emailToTry: string): Promise<SignInAttempt> => {
      const tStart = performance.now();
      try {
        // Retry only on transient failures. signIn returns { error } rather
        // than throwing on auth failures, so promote transient errors into
        // throws that withRetry can catch — auth-meaningful errors (wrong
        // password, unknown user) fall through immediately on the first try.
        const { error } = await withRetry(
          async () => {
            const res = await signIn(emailToTry, password);
            if (res?.error && isTransientError(res.error)) throw res.error;
            return res;
          },
          { maxAttempts: 3, baseMs: 200, label: `signIn:${emailToTry}` },
        );
        const ms = Math.round(performance.now() - tStart);
        metrics.attempts += 1;
        metrics.attemptTimings.push({ email: emailToTry, ms, ok: !error });
        return { ok: !error, email: emailToTry, error: error ?? null };
      } catch (e: any) {
        const ms = Math.round(performance.now() - tStart);
        metrics.attempts += 1;
        metrics.attemptTimings.push({ email: emailToTry, ms, ok: false });
        return { ok: false, email: emailToTry, error: e };
      }
    };

    // Phase 1 — race the most likely auth identifiers in parallel.
    setLoginStage('trying-fast');
    const p1Start = performance.now();
    const { winner: p1Winner, results: phase1 } = await raceForSuccess(phase1Candidates);
    metrics.phase1Ms = Math.round(performance.now() - p1Start);
    const phase1Winner = p1Winner;
    if (phase1Winner) {
      loginSuccess = true;
      metrics.winnerEmail = phase1Winner.email;
      metrics.winnerPhase = 'phase1';
    } else {
      for (const r of phase1) {
        if (r.error?.message?.includes('Invalid login credentials')) accountExists = true;
        lastError = r.error;
      }
    }

    // Phase 2 — only if no placeholder matched, consult the RPC for a real
    // contact email (Gmail/Outlook). Run remaining candidates in parallel too.
    if (!loginSuccess) {
      setLoginStage('looking-up');
      const p2Start = performance.now();
      const rpcEmails = await rpcLookup;
      const remaining = [...new Set([
        ...rpcEmails.filter(e => !e.includes('@welile.')),
        ...rpcEmails.filter(e => e.includes('@welile.')),
        `0${last9}@welile.agent`,
        `256${last9}@welile.agent`,
        `${last9}@welile.agent`,
      ])].filter(e => !phase1Candidates.includes(e)).slice(0, 4);

      if (remaining.length) {
        if (rpcEmails.length) accountExists = true;
        setLoginStage('trying-extended');
        const { winner: phase2Winner, results: phase2 } = await raceForSuccess(remaining);
        if (phase2Winner) {
          loginSuccess = true;
          metrics.winnerEmail = phase2Winner.email;
          metrics.winnerPhase = 'phase2';
        } else {
          for (const r of phase2) {
            if (r.error?.message?.includes('Invalid login credentials')) accountExists = true;
            lastError = r.error ?? lastError;
          }
        }
      }
      metrics.phase2Ms = Math.round(performance.now() - p2Start);
    }

    // If we relied on a cached RPC result and still failed every attempt,
    // drop the cache so the next try re-fetches a fresh email list.
    if (!loginSuccess && (metrics as any).rpcCacheHit) {
      try {
        localStorage.removeItem(`welile_phone_email_cache_v2_${last9}`);
        localStorage.removeItem(`welile_phone_email_cache_${last9}`);
      } catch { /* non-critical */ }
    }

    metrics.totalMs = Math.round(performance.now() - t0);

    // One row per actual user-facing login attempt (not per candidate email
    // guess — a single tap can fire several signInWithPassword calls while
    // probing placeholder emails, and most of those are expected to fail by
    // design). This is what the board's sign-in success-rate KPI reads,
    // instead of the unrelated boot/gate telemetry phases.
    const signinRateLimited = !loginSuccess && (
      lastError?.message?.toLowerCase().includes('rate') ||
      lastError?.message?.toLowerCase().includes('too many')
    );
    lt.mark(
      'auth.signin.attempt',
      {
        attempts: metrics.attempts,
        winnerPhase: metrics.winnerPhase,
        totalMs: metrics.totalMs,
        accountExists,
      },
      loginSuccess ? 'success' : (signinRateLimited ? 'rate_limited' : 'error'),
    );
    // The success path navigates away immediately; make sure the row lands
    // instead of waiting on the 4s buffered flush.
    void lt.flushNow();

    // Persist last login metrics for in-app diagnostics + log to console for
    // remote debugging via session capture. Compact label so it stands out.
    try {
      localStorage.setItem('welile_last_login_metrics', JSON.stringify({
        at: new Date().toISOString(),
        success: loginSuccess,
        ...metrics,
      }));
    } catch { /* non-critical */ }
    // eslint-disable-next-line no-console
    console.log(
      `[LoginPerf] ${loginSuccess ? '✅' : '❌'} total=${metrics.totalMs}ms ` +
      `rpc=${metrics.rpcMs}ms (found ${metrics.rpcFoundEmails}) ` +
      `attempts=${metrics.attempts} phase1=${metrics.phase1Ms}ms phase2=${metrics.phase2Ms}ms ` +
      `winner=${metrics.winnerPhase ?? 'none'}`,
      metrics.attemptTimings,
    );

    if (loginSuccess) {
      setLoginStage('finalizing');
      setLoginError(null);
      setFailedAttempts(0);
      saveLocationInBackground();
        // Persistent login: stay signed in until the user explicitly
        // signs out. Park the "remember until" stamp 10 years out so
        // the inactivity lock, PIN, and biometric prompts all stay
        // suppressed. Cleared on explicit sign-out.
        try {
          const until = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
          localStorage.setItem('welile_remember_until', String(until));
        } catch { /* non-critical */ }
      // Save user name for returning-user greeting
      try {
        // Cosmetic greeting only — never let it hold the spinner open.
        const currentUser = await Promise.race([
          supabase.auth.getUser().then(({ data }) => data.user),
          sleep(1500).then(() => null),
        ]);
        if (currentUser) {
          const name = currentUser.user_metadata?.full_name;
          if (name) localStorage.setItem('welile_last_user_name', name);
        }
      } catch { /* non-critical */ }
      return;
    }

    // Build helpful error message
    setFailedAttempts(prev => prev + 1);
    const triedFormats = getTriedPhoneFormats(phone);
    let errorMessage = 'Sign in failed. Please try again.';

    if (lastError?.message?.includes('fetch') || lastError?.message?.includes('network') || lastError?.message?.includes('timeout')) {
      errorMessage = 'Network error. Please check your connection and try again.';
    } else if (lastError?.message?.includes('rate') || lastError?.message?.includes('too many')) {
      errorMessage = 'Too many login attempts. Please wait a moment and try again.';
    } else if (accountExists) {
      errorMessage = 'Incorrect password. Tap "Forgot Password?" below to reset it via SMS.';
    } else {
      // Before giving up, check whether this phone belongs to a
      // deleted/archived account so we can show a precise message
      // instead of "no account found".
      try {
        const { data: fraud } = await (supabase as any).rpc('check_fraud_account_by_phone', {
          phone_variants: [`0${last9}`, `256${last9}`, last9],
        });
        const fraudRow = Array.isArray(fraud) ? fraud[0] : null;
        if (fraudRow?.is_blocked) {
          errorMessage = 'This account has been permanently restricted for fraud review. Access is blocked and the linked phone/email cannot be used again.';
          setLoginError({ message: errorMessage, triedFormats });
          toast({
            title: 'Account Restricted',
            description: errorMessage,
            variant: 'destructive',
          });
          return;
        }

        const { data: archived } = await supabase.rpc('check_archived_account_by_phone', {
          phone_variants: [`0${last9}`, `256${last9}`, last9],
        });
        const row = Array.isArray(archived) ? archived[0] : null;
        if (row?.is_archived) {
          const who = row.full_name ? ` for ${row.full_name}` : '';
          const when = row.archived_at ? ` on ${new Date(row.archived_at).toLocaleDateString()}` : '';
          if (row.status === 'freed') {
            errorMessage = `The previous account${who} using this phone was permanently closed${when}. ` +
              `It can't be restored — please tap "Sign up" below to create a brand-new account with this phone number.`;
          } else {
            errorMessage = `This account${who} was archived${when}. ` +
              `It can still be restored — contact Welile support to recover access. Your phone number cannot sign in until then.`;
          }
          try {
            await supabase.rpc('log_archived_login_attempt', {
              p_identifier: `+${countryCode}${last9}`,
              p_identifier_type: 'phone',
              p_archived_user_id: row.user_id ?? null,
              p_full_name: row.full_name ?? null,
              p_archived_at: row.archived_at ?? null,
            });
          } catch (e) { console.warn('[Auth] audit log failed', e); }
          setLoginError({ message: errorMessage, triedFormats });
          toast({
            title: row.status === 'freed' ? 'Account Permanently Closed' : 'Account Archived',
            description: errorMessage,
            variant: 'destructive',
          });
          return;
        }
      } catch { /* non-critical — fall back to the generic message */ }
      errorMessage = 'No account found with this phone number. Please check the number or sign up.';
    }

    setLoginError({ message: errorMessage, triedFormats });
    toast({ title: 'Sign In Failed', description: errorMessage, variant: 'destructive' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    // Safety timeout: reset spinner after 6s so UI never gets stuck
    const safetyTimer = setTimeout(() => setIsLoading(false), 6000);

    try {
      if (isForgotPhone) {
        await handleForgotPhoneSubmit();
      } else if (isForgotPassword) {
        await handleForgotPasswordSubmit();
      } else if (isSignUp) {
        await handleSignUpSubmit();
      } else {
        await handleSignInSubmit();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AuthForm] Unexpected error:', err);
      toast({ title: 'Error', description: `Unexpected error: ${msg}`, variant: 'destructive' });
    } finally {
      clearTimeout(safetyTimer);
      setIsLoading(false);
      setLoginStage('idle');
    }
  };

  const handleGoogleSignIn = async () => {
    setIsGoogleLoading(true);
    let safetyTimer: ReturnType<typeof setTimeout> | null = null;
    safetyTimer = setTimeout(async () => {
      setIsGoogleLoading(false);
      try {
        const { recordOAuthError } = await import('@/lib/oauthErrorLog');
        recordOAuthError({
          provider: 'google',
          message: 'Sign-in did not start — the provider window never opened or was blocked.',
          context: 'signInWithOAuth:timeout',
        });
      } catch { /* logging must never break sign-in */ }
      toast({
        title: 'Google Sign In Failed',
        description: 'That took too long to start. Please try again, or sign in with your phone number and password below.',
        variant: 'destructive',
      });
    }, 15000);
    try {
      const { error } = await signInWithGoogle();
      if (error) {
        const isProviderError = error.message?.toLowerCase().includes('not supported') || error.message?.toLowerCase().includes('provider');
        try {
          const { recordOAuthError } = await import('@/lib/oauthErrorLog');
          recordOAuthError({
            provider: 'google',
            message: error.message || 'Unknown error',
            code: (error as { code?: string; status?: number }).code || String((error as { status?: number }).status || ''),
            context: 'signInWithOAuth',
          });
        } catch { /* logging must never break sign-in */ }
        // Account linking recovery: if Google refused because the email is
        // already registered with a password, stash a pending link and guide
        // the user to sign in with their password. useAuth will auto-link
        // once the session is established.
        try {
          const { isAccountExistsError, setPendingIdentityLink } =
            await import('@/lib/pendingIdentityLink');
          if (isAccountExistsError(error.message)) {
            setPendingIdentityLink({ provider: 'google' });
            toast({
              title: 'This email already has an account',
              description:
                'Sign in with your password below and we will connect your Google account automatically.',
            });
            return;
          }
        } catch { /* fall through to generic toast */ }
        toast({
          title: 'Google Sign In Failed',
          description: isProviderError
            ? 'Google sign-in is temporarily unavailable. Please try again in a few seconds or use phone/password.'
            : error.message,
          variant: 'destructive',
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[GoogleSignIn] Unexpected error:', err);
      try {
        const { recordOAuthError } = await import('@/lib/oauthErrorLog');
        recordOAuthError({ provider: 'google', message: msg, context: 'signInWithOAuth:throw' });
      } catch { /* ignore */ }
      // Friendlier message for provider config issues
      const isProviderError = msg.toLowerCase().includes('not supported') || msg.toLowerCase().includes('provider');
      toast({
        title: 'Google Sign In Failed',
        description: isProviderError
          ? 'Google sign-in is temporarily unavailable. Please try again in a few seconds or use phone/password.'
          : `Unexpected error: ${msg}`,
        variant: 'destructive',
      });
    } finally {
      if (safetyTimer) clearTimeout(safetyTimer);
      setIsGoogleLoading(false);
    }
  };


  const handleAppleSignIn = async () => {
    setIsAppleLoading(true);
    let safetyTimer: ReturnType<typeof setTimeout> | null = null;
    safetyTimer = setTimeout(async () => {
      setIsAppleLoading(false);
      try {
        const { recordOAuthError } = await import('@/lib/oauthErrorLog');
        recordOAuthError({
          provider: 'apple',
          message: 'Sign-in did not start — the provider window never opened or was blocked.',
          context: 'signInWithOAuth:timeout',
        });
      } catch { /* logging must never break sign-in */ }
      toast({
        title: 'Apple Sign In Failed',
        description: 'That took too long to start. Please try again, or sign in with your phone number and password below.',
        variant: 'destructive',
      });
    }, 15000);
    try {
      const { error } = await signInWithApple();
      if (error) {
        toast({ title: 'Apple Sign In Failed', description: error.message, variant: 'destructive' });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AppleSignIn] Unexpected error:', err);
      toast({ title: 'Apple Sign In Failed', description: `Unexpected error: ${msg}`, variant: 'destructive' });
    } finally {
      if (safetyTimer) clearTimeout(safetyTimer);
      setIsAppleLoading(false);
    }
  };


  return {
    // URL params
    referralId,
    becomeRole,
    preSelectedRole,
    // Form state
    isSignUp, setIsSignUp,
    isForgotPassword, setIsForgotPassword,
    isForgotPhone, setIsForgotPhone,
    email, setEmail,
    signupEmail, setSignupEmail,
    emailConfirmationSent, setEmailConfirmationSent,

    password, setPassword,
    confirmPassword, setConfirmPassword,
    showConfirmPassword, setShowConfirmPassword,
    fullName, setFullName,
    nameParts, setNameParts,
    namePartsError, setNamePartsError,
    phone, setPhone,
    countryCode, setCountryCode,
    isLoading,
    loginStage,
    loginError, setLoginError,
    failedAttempts,
    rememberMe, setRememberMe,
    showPassword, setShowPassword,
    isGoogleLoading,
    isAppleLoading,
    // Refs
    phoneInputRef,
    passwordInputRef,
    // Duplicate check
    isDuplicate, isCheckingDuplicate, duplicateMessage,
    // OTP
    otpSent, otpVerified, otpLoading, otpError, otpSendStatus, otpCooldownSeconds,
    sendOtp, verifyOtp, resetOtp: resetOtpState,
    // SMS password reset
    resetStep, setResetStep,
    resetPhone, setResetPhone,
    resetOtpCode: resetOtp, setResetOtpCode,
    resetNewPassword, setResetNewPassword,
    resetConfirmPassword, setResetConfirmPassword,
    // Handlers
    handleSubmit,
    handleGoogleSignIn,
    handleAppleSignIn,
  };
}
