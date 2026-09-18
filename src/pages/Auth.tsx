import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { ArrowLeft, Mail, Lock, User, Phone, Loader2, MessageCircle, AlertCircle, LogIn, Smartphone, ArrowRight, Key, Clock } from 'lucide-react';
import { CountryCodeSelect } from '@/components/auth/CountryCodeSelect';
import WelileLogo from '@/components/WelileLogo';
import PasswordStrengthIndicator from '@/components/auth/PasswordStrengthIndicator';
import { GoogleSignInButton } from '@/components/auth/GoogleSignInButton';
import { OAuthEnvironmentHint } from '@/components/auth/OAuthEnvironmentHint';
import { OAuthErrorCard } from '@/components/auth/OAuthErrorCard';
import { AppleSignInButton } from '@/components/auth/AppleSignInButton';
import { ReferralBanner } from '@/components/auth/ReferralBanner';
import { OtpVerificationStep } from '@/components/auth/OtpVerificationStep';
import { ArchivedAccountSupport } from '@/components/auth/ArchivedAccountSupport';
import { useAuthForm } from '@/hooks/useAuthForm';
import { SIGNUP_PAUSED } from '@/components/SignupPauseBanner';
import { useState, useEffect, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useOtpVerification } from '@/hooks/useOtpVerification';
import { setDeviceTrust } from '@/lib/deviceTrust';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { setCriticalFlowActive } from '@/lib/criticalFlowGuard';
import { captureOAuthRedirectError } from '@/lib/oauthErrorLog';
import { getStoredAttributionToken, restoreAttributionFromToken } from '@/lib/campaignAttribution';
import ScreenLoader from '@/components/common/ScreenLoader';
import PersonNameFields from '@/components/shared/PersonNameFields';

const VALID_SIGNUP_ROLES = ['tenant', 'agent', 'landlord', 'supporter'] as const;

const ROLE_OPTIONS = [
  { role: 'tenant' as const, emoji: '🏠', label: 'I need rent help', desc: 'Get funded instantly', gradient: 'from-blue-500 to-indigo-600' },
  { role: 'supporter' as const, emoji: '💰', label: 'I want to earn', desc: '15% monthly returns', gradient: 'from-emerald-500 to-teal-600' },
  { role: 'agent' as const, emoji: '⚡', label: 'I want to earn and learn', desc: 'Register & earn cash', gradient: 'from-amber-500 to-orange-600' },
  { role: 'landlord' as const, emoji: '🏢', label: 'Guaranteed rent', desc: 'Never chase tenants', gradient: 'from-purple-500 to-violet-600' },
];

export default function Auth() {
  // Detect an active recruitment-campaign attribution (secure token stored
  // server-side + first-party cookie + localStorage). We never expose the
  // referring agent id or campaign id in the URL — the token is the only
  // handle the client keeps, and the server is the source of truth.
  const [hasCampaignAttribution, setHasCampaignAttribution] = useState<boolean>(
    () => !!getStoredAttributionToken(),
  );
  const [referringAgentName, setReferringAgentName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = getStoredAttributionToken();
      if (!token) {
        if (!cancelled) setHasCampaignAttribution(false);
        return;
      }
      const res = await restoreAttributionFromToken().catch(() => null);
      if (cancelled) return;
      const ok = !!res && (res as { status?: string }).status === 'ok';
      setHasCampaignAttribution(ok);
      setReferringAgentName(
        ok ? ((res as { referring_agent_name?: string }).referring_agent_name ?? null) : null,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const {
    referralId, becomeRole, preSelectedRole,
    isSignUp, setIsSignUp,
    isForgotPassword, setIsForgotPassword,
    isForgotPhone, setIsForgotPhone,
    email, setEmail,
    signupEmail, setSignupEmail,
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
    isGoogleLoading, isAppleLoading,
    phoneInputRef, passwordInputRef,
    isDuplicate, isCheckingDuplicate, duplicateMessage,
    otpSent, otpVerified, otpLoading, otpError, otpSendStatus, otpCooldownSeconds,
    sendOtp, verifyOtp, resetOtp: resetOtpState,
    resetStep, setResetStep,
    resetPhone, setResetPhone,
    resetOtpCode, setResetOtpCode,
    resetNewPassword, setResetNewPassword,
    resetConfirmPassword, setResetConfirmPassword,
    handleSubmit, handleGoogleSignIn, handleAppleSignIn,
  } = useAuthForm();

  const [searchParams, setSearchParams] = useSearchParams();

  // Friendly progress labels for the Sign In button so users know what's
  // happening instead of staring at a blank spinner. Keep <22 chars to fit
  // on small screens beside the spinner.
  const loginStageLabel: Record<string, string> = {
    'validating': 'Checking details…',
    'checking-cache': 'Checking saved account…',
    'looking-up': 'Looking up account…',
    'trying-fast': 'Signing in…',
    'trying-extended': 'Trying alternate emails…',
    'finalizing': 'Finalizing…',
  };
  const stageText = loginStageLabel[loginStage] ?? 'Signing in…';
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, loading: authLoading, signIn: authSignIn, roles: authRoles } = useAuth();
  const [emailLoginLoading, setEmailLoginLoading] = useState(false);

  // Internship funnel: auto-fill from query params and switch to signup
  useEffect(() => {
    const source = searchParams.get('source');
    const hasCampaignToken = !!getStoredAttributionToken();
    const wantsSignup =
      source === 'internship' ||
      searchParams.get('signup') === '1' ||
      hasCampaignToken;
    if (wantsSignup) {
      setIsSignUp(true);
      const nameParam = searchParams.get('name');
      const phoneParam = searchParams.get('phone');
      const emailParam = searchParams.get('email');
      if (nameParam) setFullName(decodeURIComponent(nameParam));
      if (phoneParam) setPhone(decodeURIComponent(phoneParam));
      if (emailParam) setEmail(decodeURIComponent(emailParam));
    }
  }, []); // Run once on mount

  // Protect the entire auth flow from being nuked by the iOS background freshness
  // checker or the query cache invalidator if the user dips out to read their OTP
  useEffect(() => {
    setCriticalFlowActive('auth', true);
    return () => setCriticalFlowActive('auth', false);
  }, []);

  const hasValidRole = !!preSelectedRole && VALID_SIGNUP_ROLES.includes(preSelectedRole as any);
  const needsRoleSelection = isSignUp && !hasValidRole;

  const handleSelectRole = (role: string) => {
    const newParams = new URLSearchParams(searchParams);
    newParams.set('role', role);
    setSearchParams(newParams, { replace: true });
  };

  const roleLabelMap: Record<string, string> = {
    tenant: '🏠 Tenant',
    supporter: '💰 Funder',
    agent: '⚡ Agent',
    landlord: '🏢 Landlord',
  };

  useEffect(() => {
    if (!authLoading && user) {
      const redirectParam = searchParams.get('redirect');
      if (redirectParam && redirectParam.startsWith('/')) {
        navigate(redirectParam, { replace: true });
        return;
      }
      // OAuth consent and other flows that started via Google/Apple lose the
      // ?redirect query during the provider round-trip, so we recover the
      // intended path from sessionStorage (set by OAuthConsent before redirect).
      let storedRedirect: string | null = null;
      try {
        storedRedirect = sessionStorage.getItem('welile_post_auth_redirect');
        if (storedRedirect) sessionStorage.removeItem('welile_post_auth_redirect');
      } catch { /* ignore */ }
      if (storedRedirect && storedRedirect.startsWith('/')) {
        navigate(storedRedirect, { replace: true });
        return;
      }
      // Let the central resolver (/dashboard → DashboardRedirect) decide the
      // persona: forced default → device/server preference → last-used role →
      // merchant-agent rule → tenant-first fallback. Using authRoles[0] here
      // depended on unstable database row order.
      navigate('/dashboard', { replace: true });
    }
  }, [authLoading, user, authRoles, navigate, searchParams]);


  // Login mode: phone + password is the default tab on /auth. 'otp' (SMS code)
  // and 'email' remain available as backups via the in-form switchers.
  const [loginMode, setLoginMode] = useState<'password' | 'otp' | 'email'>('password');
  const [emailLoginAddress, setEmailLoginAddress] = useState('');
  const [otpLoginPhone, setOtpLoginPhone] = useState('');
  const [otpLoginCode, setOtpLoginCode] = useState('');
  const [otpLoginStep, setOtpLoginStep] = useState<'phone' | 'code'>('phone');
  const [otpLoginLoading, setOtpLoginLoading] = useState(false);
  const [otpLoginCountryCode, setOtpLoginCountryCode] = useState('256');
  const [otpResendCooldown, setOtpResendCooldown] = useState(0);
  // Permanent login by default. When unchecked the session is
  // ephemeral and OTP is required again after the browser is fully closed.
  const [rememberThisDevice, setRememberThisDevice] = useState(true);
  const loginOtp = useOtpVerification();

  // Agent deeplink
  const deepLinkPhone = searchParams.get('phone');
  const deepLinkToken = searchParams.get('token');
  const deepLinkAgent = searchParams.get('agent');

  // If the OTP login fallback guard aborted a sign-in because the resolved
  // account did not match the established session, let the user know here.
  useEffect(() => {
    let mismatch = false;
    try { mismatch = localStorage.getItem('welile_otp_mismatch') === '1'; } catch { /* ignore */ }
    if (mismatch) {
      try { localStorage.removeItem('welile_otp_mismatch'); } catch { /* ignore */ }
      setLoginMode('otp');
      toast({
        title: 'Couldn’t confirm your account',
        description: 'We signed you out for safety. Please request a new code and try again.',
        variant: 'destructive',
      });
    }
  }, []);

  useEffect(() => {
    if (deepLinkPhone && deepLinkToken) {
      setLoginMode('otp');
      setOtpLoginPhone(deepLinkPhone);
      setOtpLoginCode(deepLinkToken);
      setOtpLoginStep('code');
      const timer = setTimeout(() => {
        handleOtpLogin(deepLinkPhone, deepLinkToken);
      }, 800);
      return () => clearTimeout(timer);
    }
  }, [deepLinkPhone, deepLinkToken]);

  // Resend SMS cooldown timer
  useEffect(() => {
    if (otpResendCooldown <= 0) return;
    const timer = setInterval(() => {
      setOtpResendCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [otpResendCooldown]);

  const getFullOtpPhone = useCallback((phoneVal: string, codeVal: string) => {
    const cleanDigits = phoneVal.replace(/\D/g, '');
    return cleanDigits.startsWith(codeVal) ? cleanDigits : codeVal + (cleanDigits.startsWith('0') ? cleanDigits.slice(1) : cleanDigits);
  }, []);

  const handleSendOtpForLogin = async () => {
    const fullNum = getFullOtpPhone(otpLoginPhone, otpLoginCountryCode);
    if (fullNum.length < 10) {
      toast({ title: 'Error', description: 'Please enter a valid phone number', variant: 'destructive' });
      return;
    }
    setOtpLoginLoading(true);
    // Safety net: never let the button spin forever if the request hangs.
    const safety = setTimeout(() => setOtpLoginLoading(false), 20000);
    try {
      const success = await loginOtp.sendOtp(fullNum, { category: 'login' });
      if (success) {
        setOtpLoginStep('code');
        setOtpResendCooldown(60);
        toast({ title: 'Code Sent! 📱', description: 'Check your phone for the 6-digit code' });
      } else {
        toast({ title: 'Failed', description: loginOtp.otpError || 'Could not send code', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Error', description: 'Network error. Please check your connection and try again.', variant: 'destructive' });
    } finally {
      clearTimeout(safety);
      setOtpLoginLoading(false);
    }
  };

  const handleOtpLogin = async (phoneOverride?: string, codeOverride?: string) => {
    const phoneVal = phoneOverride || otpLoginPhone;
    const codeVal = codeOverride || otpLoginCode;
    const fullNum = getFullOtpPhone(phoneVal, otpLoginCountryCode);

    if (codeVal.length !== 6) {
      toast({ title: 'Error', description: 'Please enter the 6-digit code', variant: 'destructive' });
      return;
    }

    setOtpLoginLoading(true);
    // Safety net: guarantee the spinner is released even if a network call
    // never settles (e.g. verifyOtp / fetch hangs on a flaky connection),
    // otherwise the "Verify & Log In" button stays stuck in a loading state.
    const safety = setTimeout(() => setOtpLoginLoading(false), 20000);
    try {
      const controller = new AbortController();
      const fetchTimeout = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/otp-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
        body: JSON.stringify({ phone: fullNum, otp: codeVal }),
        signal: controller.signal,
      }).finally(() => clearTimeout(fetchTimeout));
      const data = await response.json();
      if (!response.ok) {
        toast({ title: 'Login Failed', description: data.error || 'Could not verify code', variant: 'destructive' });
        return;
      }

      if (data.token_hash || data.verify_url) {
        if (data.user_name) localStorage.setItem('welile_last_user_name', data.user_name);
        localStorage.setItem('welile_last_login_method', 'otp');
        localStorage.setItem('welile_had_session', 'true');
        // OTP login fallback guard: remember the auth user id the OTP backend
        // resolved for this phone. Once the session is established, the auth
        // listener verifies the session's user id matches this value before
        // completing sign-in (and signs out on mismatch).
        try {
          if (data.user_id) localStorage.setItem('welile_otp_expected_uid', data.user_id);
          else localStorage.removeItem('welile_otp_expected_uid');
        } catch { /* storage unavailable — guard simply won't run */ }
        setDeviceTrust(rememberThisDevice);

        // PREFERRED: verify the magic-link token FIRST-PARTY (same-origin). This
        // writes the session into localStorage directly, with NO cross-domain
        // bounce through <project>.supabase.co. iOS Safari ITP evicts storage
        // written as the result of a cross-site bounce on the next cold launch,
        // which is why iPhone users were getting logged out. verifyOtp avoids it.
        if (data.token_hash) {
          const { error: verifyErr } = await supabase.auth.verifyOtp({
            type: 'magiclink',
            token_hash: data.token_hash,
          });
          if (verifyErr) {
            toast({ title: 'Login Failed', description: verifyErr.message || 'Could not complete login. Please try again.', variant: 'destructive' });
            return;
          }
          toast({ title: `Welcome back${data.user_name ? ', ' + data.user_name : ''}! 🎉`, description: 'Logging you in...' });
          // Same-origin navigation — session is already persisted first-party.
          window.location.href = '/';
          return;
        }

        // LEGACY fallback: server didn't return a token_hash (older deploy).
        toast({ title: `Welcome back${data.user_name ? ', ' + data.user_name : ''}! 🎉`, description: 'Logging you in...' });
        window.location.href = data.verify_url;
      }
    } catch {
      toast({ title: 'Error', description: 'Network error or the request timed out. Please check your connection and try again.', variant: 'destructive' });
    } finally {
      clearTimeout(safety);
      setOtpLoginLoading(false);
    }
  };

  const wrappedHandleSubmit = async (e: React.FormEvent) => {
    await handleSubmit(e);
    if (!isSignUp && !isForgotPassword && !isForgotPhone) {
      localStorage.setItem('welile_last_login_method', 'password');
      // Honour the same device-trust choice for password sign-ins.
      setDeviceTrust(rememberMe);
    }
  };

  const wrappedHandleGoogleSignIn = async () => {
    localStorage.setItem('welile_last_login_method', 'google');
    // OAuth sign-ins are always persistent — clear any stale ephemeral flag
    // left by a previous "don't remember this device" login, otherwise the
    // boot guard keeps wiping the session on iOS cold starts.
    setDeviceTrust(true);
    await handleGoogleSignIn();
  };

  // Deep-link auto-start: EnvironmentBanner (and shared links) can open
  // `/auth?oauth=google|apple` on the correct origin to kick off that provider
  // immediately. Consume the param once so a reload doesn't re-trigger it.
  const oauthAutoStartedRef = useRef(false);
  useEffect(() => {
    // Capture provider-side failures returned via ?error= / #error= on redirect
    // back to the auth page. This makes the exact reason visible instead of a
    // silent bounce back to the login form.
    try { captureOAuthRedirectError('google'); } catch { /* non-fatal */ }
    if (oauthAutoStartedRef.current) return;
    const provider = searchParams.get('oauth');
    if (provider !== 'google' && provider !== 'apple') return;
    oauthAutoStartedRef.current = true;
    const next = new URLSearchParams(searchParams);
    next.delete('oauth');
    setSearchParams(next, { replace: true });
    if (provider === 'google') {
      void wrappedHandleGoogleSignIn();
    } else {
      localStorage.setItem('welile_last_login_method', 'apple');
      setDeviceTrust(true);
      void handleAppleSignIn();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  if (authLoading) {
    return (
      <ScreenLoader label="Just a moment..." />
    );
  }

  // Returning user info
  const lastUserName = localStorage.getItem('welile_last_user_name');
  const lastLoginMethod = localStorage.getItem('welile_last_login_method');
  const hadSession = localStorage.getItem('welile_had_session') === 'true';

  const isLoginView = !isSignUp && !isForgotPassword && !isForgotPhone;

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Helmet>
        <title>Sign In or Create Your Welile Account</title>
        <meta name="description" content="Log in or sign up to access rent, fund tenants, and manage your Welile wallet securely." />
        <link rel="canonical" href="https://welileapp.com/auth" />
        <meta property="og:title" content="Sign In or Create Your Welile Account" />
        <meta property="og:description" content="Log in or sign up to access rent, fund tenants, and manage your Welile wallet securely." />
        <meta property="og:url" content="https://welileapp.com/auth" />
      </Helmet>
      <div className="w-full max-w-sm relative z-10">

        {/* Logo — compact */}
        <div className="text-center mb-6">
          <div className="flex items-center justify-center mb-2">
            <WelileLogo linkToHome={false} />
          </div>
          {isLoginView && (
            <p className="text-lg font-semibold text-foreground mt-3 animate-in fade-in duration-300">
              {hadSession && lastUserName ? `Welcome back, ${lastUserName}` : 'Welcome back'}
            </p>
          )}
          {isLoginView && (
            <p className="text-sm text-muted-foreground mt-0.5 animate-in fade-in duration-300">
              Sign in with a one-time SMS code
            </p>
          )}
          {isSignUp && (
            <p className="text-lg font-semibold text-foreground mt-3 animate-in fade-in duration-300">Create your account</p>
          )}
        </div>

        {/* Agent deeplink banner */}
        {deepLinkAgent && (
          <div className="mb-4 p-3 rounded-xl bg-accent/50 border border-accent flex items-center gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
            <MessageCircle className="h-5 w-5 text-primary shrink-0" />
            <div>
              <p className="text-sm font-medium text-foreground">Sent by Agent {deepLinkAgent}</p>
              <p className="text-xs text-muted-foreground">Verifying automatically...</p>
            </div>
          </div>
        )}

        <ReferralBanner referralId={referralId} becomeRole={becomeRole} />

        {/* Recruitment-campaign banner. Shown when the visitor arrived via
            /c/{district}/{shortCode} and their attribution token validated
            server-side. No agent id / campaign id is revealed. */}
        {hasCampaignAttribution && (
          <div className="mb-4 p-3 rounded-xl bg-primary/5 border border-primary/20 flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
            <MessageCircle className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-foreground">
                {referringAgentName
                  ? `You are joining through Agent ${referringAgentName}`
                  : 'You are joining through a Welile recruitment campaign'}
              </p>
              <p className="text-xs text-muted-foreground">
                {referringAgentName
                  ? `${referringAgentName} will be linked as your referring agent automatically after sign up.`
                  : 'Your referring agent will be linked to you automatically after sign up.'}
              </p>
            </div>
          </div>
        )}

        {/* Role badge for signup */}
        {isSignUp && hasValidRole && (
          <div className="mb-4 p-3 rounded-xl bg-primary/5 border border-primary/20 flex items-center justify-between animate-in fade-in duration-200">
            <span className="text-sm font-medium text-foreground">
              Joining as <span className="font-bold">{roleLabelMap[preSelectedRole!] || preSelectedRole}</span>
              {referringAgentName && (
                <span className="block text-xs font-normal text-muted-foreground mt-0.5">
                  through Agent <span className="font-semibold text-foreground">{referringAgentName}</span>
                </span>
              )}
            </span>
            <button type="button" onClick={() => navigate('/welcome')} className="text-xs text-primary hover:underline">
              Change
            </button>
          </div>
        )}

        {/* Inline role selector for signup without role */}
        {needsRoleSelection && (
          <div className="space-y-2 mb-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <p className="text-sm font-medium text-foreground mb-3">What do you need?</p>
            {ROLE_OPTIONS.map((opt) => (
              <button
                key={opt.role}
                type="button"
                onClick={() => handleSelectRole(opt.role)}
                className={cn(
                  "w-full flex items-center gap-3 p-3 rounded-xl text-left transition-all duration-150",
                  "bg-card border border-border/50 shadow-sm",
                  "hover:shadow-md hover:scale-[1.01] active:scale-[0.98]",
                  "touch-manipulation"
                )}
              >
                <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center text-xl shrink-0 bg-gradient-to-br", opt.gradient)}>
                  <span>{opt.emoji}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-foreground text-sm">{opt.label}</p>
                  <p className="text-xs text-muted-foreground">{opt.desc}</p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
              </button>
            ))}
          </div>
        )}

        {!needsRoleSelection && (
          <div className="animate-in fade-in slide-in-from-bottom-3 duration-400 rounded-2xl border border-border/60 bg-card p-5 shadow-lg shadow-black/5 sm:p-6">

            {/* Sign In / Sign Up tabs — bound to the existing isSignUp state so
                deep links (?signup=1, ?become=…, referral links) still land on
                the right panel. Hidden during reset flows. */}
            {!isForgotPassword && !isForgotPhone && !SIGNUP_PAUSED && (
              <Tabs
                value={isSignUp ? 'sign-up' : 'sign-in'}
                onValueChange={(v) => setIsSignUp(v === 'sign-up')}
                className="mb-5"
              >
                <TabsList className="grid w-full grid-cols-2 h-12 rounded-xl p-1">
                  <TabsTrigger value="sign-in" className="h-10 rounded-lg text-sm font-semibold">Sign In</TabsTrigger>
                  <TabsTrigger value="sign-up" className="h-10 rounded-lg text-sm font-semibold">Sign Up</TabsTrigger>
                </TabsList>
              </Tabs>
            )}

            {/* ===== SIGN IN VIEW ===== */}
            {isLoginView && loginMode === 'password' && (
              <div className="space-y-5">
                {/* Social sign-in first — matches the card layout */}
                <OAuthEnvironmentHint />
                <OAuthErrorCard />

                <div className="flex w-full flex-wrap items-center justify-center gap-4">
                  <GoogleSignInButton
                    onClick={wrappedHandleGoogleSignIn}
                    disabled={isGoogleLoading || isAppleLoading || isLoading}
                    isLoading={isGoogleLoading}
                    variant="icon"
                  />
                  <AppleSignInButton
                    onClick={() => {
                      localStorage.setItem('welile_last_login_method', 'apple');
                      // OAuth sign-ins are always persistent — clear stale ephemeral flag.
                      setDeviceTrust(true);
                      handleAppleSignIn();
                    }}
                    disabled={isGoogleLoading || isAppleLoading || isLoading}
                    isLoading={isAppleLoading}
                    variant="icon"
                  />
                </div>

                <div className="relative flex items-center py-1">
                  <div className="flex-1 border-t border-border/40" />
                  <span className="px-3 text-xs text-muted-foreground">or</span>
                  <div className="flex-1 border-t border-border/40" />
                </div>

                {/* Phone + Password — primary path (phone-first for African users) */}
                <form onSubmit={wrappedHandleSubmit} className="space-y-5">
                  <div className="space-y-2">
                    <Label className="text-sm font-semibold text-foreground px-1">Phone number</Label>
                    <div className="relative flex">
                      <CountryCodeSelect value={countryCode} onChange={setCountryCode} triggerClassName="h-16 text-lg" />
                      <div className="relative flex-1">
                        <Phone className="absolute left-3.5 top-1/2 -translate-y-1/2 h-6 w-6 text-muted-foreground" />
                        <Input
                          ref={phoneInputRef}
                          type="tel"
                          inputMode="tel"
                          autoComplete="tel"
                          value={phone}
                          onChange={(e) => { setPhone(e.target.value); setLoginError(null); }}
                          placeholder="700 123 456"
                          className={cn("pl-12 h-16 text-lg rounded-xl rounded-l-none", loginError && 'border-destructive')}
                          style={{ fontSize: '16px' }}
                          required
                        />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-sm font-semibold text-foreground px-1">Password</Label>
                    <div className="relative">
                      <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-6 w-6 text-muted-foreground" />
                      <Input
                        ref={passwordInputRef}
                        type={showPassword ? "text" : "password"}
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Your password"
                        className="pl-12 pr-16 h-16 text-lg rounded-xl"
                        style={{ fontSize: '16px' }}
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-2 text-sm font-semibold text-primary hover:text-primary/80 transition-colors"
                      >
                        {showPassword ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  </div>

                  {loginError && (
                    <p className="text-xs text-destructive px-1">{loginError.message}</p>
                  )}
                  {loginError && (
                    <ArchivedAccountSupport
                      identifier={phone ? `+${countryCode}${phone.replace(/\D/g, '')}` : undefined}
                      errorMessage={loginError.message}
                      onSignUp={() => {
                        setLoginError(null);
                        setIsSignUp(true);
                      }}
                    />
                  )}

                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 cursor-pointer select-none py-1">
                      <Checkbox
                        checked={rememberMe}
                        onCheckedChange={(checked) => {
                          setRememberMe(!!checked);
                          localStorage.setItem('welile_remember_me', String(!!checked));
                        }}
                        className="h-5 w-5"
                      />
                      <span className="text-sm text-muted-foreground">Remember me</span>
                    </label>
                    <button type="button" onClick={() => { if (phone) setResetPhone(phone); setIsForgotPassword(true); }} className="text-sm font-semibold text-primary hover:underline py-1">
                      Forgot password?
                    </button>
                  </div>

                  {/* Prominent reset banner after 1 failed attempt */}
                  {failedAttempts >= 1 && (
                    <button
                      type="button"
                      onClick={() => { if (phone) setResetPhone(phone); setIsForgotPassword(true); }}
                      className="w-full flex items-center gap-2 p-3 rounded-xl bg-primary/10 border border-primary/20 text-primary text-sm font-medium hover:bg-primary/15 transition-colors"
                    >
                      <Key className="h-4 w-4 shrink-0" />
                      <span>Can't remember? Reset your password via SMS</span>
                    </button>
                  )}

                  <Button
                    type="submit"
                    className="w-full h-16 text-lg rounded-xl font-bold shadow-md touch-manipulation active:scale-[0.98] transition-transform"
                    disabled={isLoading}
                    style={{ fontSize: '16px', WebkitTapHighlightColor: 'transparent' }}
                  >
                    {isLoading ? (
                      <span className="flex items-center justify-center gap-2">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        <span className="text-sm font-medium truncate">{stageText}</span>
                      </span>
                    ) : 'Sign In'}
                  </Button>
                </form>

                {failedAttempts >= 2 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full gap-2 text-primary text-xs"
                    onClick={() => {
                      const message = encodeURIComponent(`Hello Welile Support,\n\nI'm having trouble logging in.\n\nPhone: ${phone}\n\nPlease help.`);
                      window.open(`https://wa.me/256783673998?text=${message}`, '_blank');
                    }}
                  >
                    <MessageCircle className="h-4 w-4" />
                    Need help? Contact Support
                  </Button>
                )}

                {/* Alternative login methods */}
                <div className="pt-2 space-y-2">
                  {/* Prominent SMS code login card */}
                  <button
                    type="button"
                    onClick={() => setLoginMode('otp')}
                    className={cn(
                      "w-full flex items-center gap-4 p-4 rounded-xl text-left transition-all duration-150",
                      "bg-card border border-border/60 shadow-sm",
                      "hover:shadow-md hover:border-primary/30 active:scale-[0.98]",
                      "touch-manipulation"
                    )}
                  >
                    <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                      <Smartphone className="h-6 w-6 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-foreground text-sm">Log in with SMS code</p>
                      <p className="text-xs text-muted-foreground">Get a one-time code sent to your phone — no password needed</p>
                    </div>
                    <ArrowRight className="h-5 w-5 text-muted-foreground/40 shrink-0" />
                  </button>

                  <button
                    type="button"
                    onClick={() => setLoginMode('email')}
                    className="w-full text-sm text-muted-foreground hover:text-primary transition-colors py-1 text-center"
                  >
                    Use email & password instead
                  </button>
                </div>
              </div>
            )}

            {/* ===== EMAIL LOGIN ===== */}
            {isLoginView && loginMode === 'email' && (
              <div className="space-y-3 animate-in fade-in duration-200">
                <form onSubmit={async (e) => {
                  e.preventDefault();
                  if (!emailLoginAddress.trim() || !password.trim()) return;
                  setEmailLoginLoading(true);
                  const safetyTimer = setTimeout(() => setEmailLoginLoading(false), 6000);
                  try {
                    const typed = emailLoginAddress.trim();
                    let { error } = await authSignIn(typed, password);

                    // Fallback: typed email may be the user's contact email (profiles.email)
                    // but their auth email is a phone-based placeholder (e.g. 256xxx@welile.user).
                    // Look up the profile by email, then retry with phone-based placeholders.
                    if (error && error.message.includes('Invalid login credentials')) {
                      try {
                        const { data: profileMatch } = await supabase
                          .from('profiles')
                          .select('phone')
                          .ilike('email', typed)
                          .not('phone', 'is', null)
                          .limit(1)
                          .maybeSingle();
                        const phoneDigits = profileMatch?.phone?.replace(/\D/g, '') || '';
                        const last9 = phoneDigits.slice(-9);
                        if (last9) {
                          const candidates = [
                            `256${last9}@welile.user`,
                            `0${last9}@welile.user`,
                            `${last9}@welile.user`,
                            `256${last9}@welile.agent`,
                            `0${last9}@welile.agent`,
                          ];
                          for (const candidate of candidates) {
                            const retry = await authSignIn(candidate, password);
                            if (!retry.error) { error = null; break; }
                            error = retry.error;
                            if (!retry.error.message.includes('Invalid login credentials')) break;
                          }
                        }
                      } catch { /* ignore lookup failure */ }
                    }

                    if (error) {
                      let msg = error.message;
                      if (msg.includes('Invalid login credentials')) {
                        try {
                          const { data: fraudRows } = await (supabase as any).rpc('check_fraud_account_by_email', {
                            p_email: typed,
                          });
                          const fraudRow = Array.isArray(fraudRows) ? fraudRows[0] : null;
                          if (fraudRow?.is_blocked) {
                            msg = 'This account has been permanently restricted for fraud review. Access is blocked and the linked phone/email cannot be used again.';
                          } else {
                            msg = 'Incorrect email or password. Try Google sign-in if you used it before.';
                          }
                        } catch {
                          msg = 'Incorrect email or password. Try Google sign-in if you used it before.';
                        }
                      }
                      setLoginError({ message: msg, triedFormats: [] });
                      toast({ title: 'Sign In Failed', description: msg, variant: 'destructive' });
                    } else {
                      setLoginError(null);
                      localStorage.setItem('welile_last_login_method', 'email');
                    }
                  } finally {
                    clearTimeout(safetyTimer);
                    setEmailLoginLoading(false);
                  }
                }} className="space-y-3">
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      value={emailLoginAddress}
                      onChange={(e) => { setEmailLoginAddress(e.target.value); setLoginError(null); }}
                      placeholder="you@example.com"
                      className={cn("pl-10 h-12 text-base rounded-xl", loginError && 'border-destructive')}
                      style={{ fontSize: '16px' }}
                      required
                      autoFocus
                    />
                  </div>

                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Password"
                      className="pl-10 h-12 text-base rounded-xl"
                      style={{ fontSize: '16px' }}
                      required
                    />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground">
                      {showPassword ? 'Hide' : 'Show'}
                    </button>
                  </div>

                  {loginError && <p className="text-xs text-destructive px-1">{loginError.message}</p>}
                  {loginError && (
                    <ArchivedAccountSupport
                      identifier={emailLoginAddress || undefined}
                      errorMessage={loginError.message}
                      onSignUp={() => {
                        setLoginError(null);
                        setIsSignUp(true);
                      }}
                    />
                  )}

                  <Button
                    type="submit"
                    className="w-full h-12 text-base rounded-xl font-semibold touch-manipulation active:scale-[0.98]"
                    disabled={emailLoginLoading || !emailLoginAddress.trim() || !password.trim()}
                    style={{ fontSize: '16px', WebkitTapHighlightColor: 'transparent' }}
                  >
                    {emailLoginLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : 'Sign In'}
                  </Button>
                </form>

                <OAuthEnvironmentHint />
                <OAuthErrorCard />

                <GoogleSignInButton
                  onClick={wrappedHandleGoogleSignIn}
                  disabled={isGoogleLoading || isAppleLoading || emailLoginLoading}
                  isLoading={isGoogleLoading}
                  variant="standard"
                />

                <button type="button" onClick={() => setLoginMode('password')} className="w-full text-xs text-muted-foreground hover:text-primary text-center pt-1">
                  ← Back to phone login
                </button>
              </div>
            )}

            {/* ===== OTP LOGIN ===== */}
            {isLoginView && loginMode === 'otp' && (
              <div className="space-y-4 animate-in fade-in duration-200">
                {/* Step indicator */}
                <div className="flex items-center gap-3 mb-1">
                  <div className={cn(
                    "h-9 w-9 rounded-full flex items-center justify-center text-sm font-bold transition-colors shrink-0",
                    otpLoginStep === 'phone' ? "bg-primary text-primary-foreground" : "bg-primary/20 text-primary"
                  )}>
                    1
                  </div>
                  <div className={cn("flex-1 h-1 rounded-full", otpLoginStep === 'code' ? "bg-primary/40" : "bg-muted")} />
                  <div className={cn(
                    "h-9 w-9 rounded-full flex items-center justify-center text-sm font-bold transition-colors shrink-0",
                    otpLoginStep === 'code' ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                  )}>
                    2
                  </div>
                </div>

                {otpLoginStep === 'phone' ? (
                  <>
                    <div>
                      <p className="text-base font-semibold text-foreground">Enter your phone number</p>
                      <p className="text-sm text-muted-foreground mt-0.5">We will send you a 6-digit code</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Phone className="h-6 w-6 text-muted-foreground shrink-0" />
                      <div className="relative flex flex-1">
                        <CountryCodeSelect value={otpLoginCountryCode} onChange={setOtpLoginCountryCode} triggerClassName="h-16 text-lg" />
                        <Input
                          type="tel"
                          inputMode="tel"
                          autoComplete="tel"
                          value={otpLoginPhone}
                          onChange={(e) => setOtpLoginPhone(e.target.value)}
                          placeholder="700 123 456"
                          className="flex-1 h-16 text-lg rounded-xl rounded-l-none"
                          style={{ fontSize: '16px' }}
                          autoFocus
                        />
                      </div>
                    </div>
                    <Button
                      type="button"
                      onClick={handleSendOtpForLogin}
                      disabled={otpLoginLoading || otpLoginPhone.replace(/\D/g, '').length < 7}
                      className="w-full h-16 text-lg rounded-xl font-bold shadow-md touch-manipulation active:scale-[0.98] transition-transform"
                      style={{ fontSize: '16px', WebkitTapHighlightColor: 'transparent' }}
                    >
                      {otpLoginLoading ? (
                        <span className="flex items-center justify-center gap-2">
                          <Loader2 className="h-5 w-5 animate-spin" />
                          <span className="text-sm font-medium">Sending code…</span>
                        </span>
                      ) : (
                        <span className="flex items-center justify-center gap-2">
                          <MessageCircle className="h-5 w-5" />
                          Send SMS Code
                        </span>
                      )}
                    </Button>

                    {/* Remember this device — permanent login */}
                    <label className="flex items-start gap-2.5 cursor-pointer select-none touch-manipulation">
                      <Checkbox
                        checked={rememberThisDevice}
                        onCheckedChange={(checked) => setRememberThisDevice(!!checked)}
                        className="h-4 w-4 mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="block text-xs font-medium text-foreground">Keep me logged in on this device</span>
                        <span className="block text-[11px] text-muted-foreground mt-0.5">Stay signed in permanently — you'll only need a code on a new device or after you log out.</span>
                      </span>
                    </label>

                    {!rememberThisDevice && (
                      <div className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3.5">
                        <Clock className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">You will be signed out when you close this browser</p>
                          <p className="text-xs text-amber-600/80 dark:text-amber-400/70 mt-0.5">Next time you open Welile, you will need to enter a new SMS code to log in again.</p>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div>
                      <p className="text-base font-semibold text-foreground">Enter the 6-digit code</p>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        Sent to <span className="font-medium text-foreground">+{getFullOtpPhone(otpLoginPhone, otpLoginCountryCode)}</span>
                      </p>
                    </div>

                    <div className="flex justify-center py-1">
                      <InputOTP
                        maxLength={6}
                        value={otpLoginCode}
                        onChange={(value) => {
                          setOtpLoginCode(value);
                          if (value.length === 6) {
                            handleOtpLogin(otpLoginPhone, value);
                          }
                        }}
                      >
                        <InputOTPGroup>
                          <InputOTPSlot index={0} className="h-14 w-12 text-lg" />
                          <InputOTPSlot index={1} className="h-14 w-12 text-lg" />
                          <InputOTPSlot index={2} className="h-14 w-12 text-lg" />
                          <InputOTPSlot index={3} className="h-14 w-12 text-lg" />
                          <InputOTPSlot index={4} className="h-14 w-12 text-lg" />
                          <InputOTPSlot index={5} className="h-14 w-12 text-lg" />
                        </InputOTPGroup>
                      </InputOTP>
                    </div>

                    {otpLoginLoading && (
                      <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Verifying code…
                      </div>
                    )}

                    <Button
                      type="button"
                      onClick={() => handleOtpLogin()}
                      disabled={otpLoginLoading || otpLoginCode.length !== 6}
                      className="w-full h-16 text-lg rounded-xl font-bold shadow-md touch-manipulation active:scale-[0.98] transition-transform"
                      style={{ fontSize: '16px', WebkitTapHighlightColor: 'transparent' }}
                    >
                      {otpLoginLoading ? (
                        <span className="flex items-center justify-center gap-2">
                          <Loader2 className="h-5 w-5 animate-spin" />
                          <span className="text-sm font-medium">Verifying…</span>
                        </span>
                      ) : (
                        <span className="flex items-center justify-center gap-2">
                          <LogIn className="h-5 w-5" />
                          Verify & Log In
                        </span>
                      )}
                    </Button>

                    <div className="flex items-center justify-between pt-1">
                      <button
                        type="button"
                        onClick={() => { setOtpLoginStep('phone'); setOtpLoginCode(''); setOtpResendCooldown(0); }}
                        className="text-sm text-muted-foreground hover:text-primary flex items-center gap-1 py-1"
                      >
                        <ArrowLeft className="h-4 w-4" /> Change number
                      </button>
                      <button
                        type="button"
                        onClick={handleSendOtpForLogin}
                        disabled={otpLoginLoading || otpResendCooldown > 0}
                        className={cn(
                          "text-sm py-1 font-medium transition-colors",
                          otpResendCooldown > 0
                            ? "text-muted-foreground cursor-not-allowed"
                            : "text-primary hover:underline"
                        )}
                      >
                        {otpResendCooldown > 0 ? `Resend in ${otpResendCooldown}s` : 'Resend code'}
                      </button>
                    </div>
                  </>
                )}

                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => setLoginMode('password')}
                    className="w-full text-sm text-muted-foreground hover:text-primary text-center py-2 flex items-center justify-center gap-1"
                  >
                    Prefer a password? <span className="font-medium">Sign in with password</span>
                  </button>
                </div>
              </div>
            )}

            {/* ===== FORGOT PASSWORD ===== */}
            {isForgotPassword && (
              <div className="space-y-4 animate-in fade-in duration-200">
                {/* Step indicator */}
                <div className="flex items-center gap-2 mb-2">
                  {['phone', 'otp', 'new-password'].map((step, i) => (
                    <div key={step} className="flex items-center gap-2">
                      <div className={cn(
                        "h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold transition-colors",
                        resetStep === step ? "bg-primary text-primary-foreground" :
                        ['phone', 'otp', 'new-password'].indexOf(resetStep) > i ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
                      )}>
                        {i + 1}
                      </div>
                      {i < 2 && <div className={cn("w-6 h-0.5", ['phone', 'otp', 'new-password'].indexOf(resetStep) > i ? "bg-primary/40" : "bg-muted")} />}
                    </div>
                  ))}
                </div>

                <div>
                  <p className="text-base font-semibold text-foreground">
                    {resetStep === 'phone' ? '🔑 Reset Your Password' : resetStep === 'otp' ? '📱 Enter SMS Code' : '🔒 Create New Password'}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {resetStep === 'phone' ? 'Enter your phone number and we\'ll send you a code via SMS' : resetStep === 'otp' ? `We sent a 6-digit code to ${resetPhone || 'your phone'}` : 'Choose a strong password you\'ll remember'}
                  </p>
                </div>

                <form onSubmit={wrappedHandleSubmit} className="space-y-3">
                  {resetStep === 'phone' && (
                    <>
                      <div className="relative">
                        <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                        <Input type="tel" inputMode="tel" value={resetPhone} onChange={(e) => setResetPhone(e.target.value)} placeholder="Enter your phone number e.g. 0700123456" className="pl-11 h-14 text-base rounded-xl border-2 focus:border-primary" style={{ fontSize: '16px' }} autoFocus />
                      </div>
                      <div className="relative flex items-center">
                        <div className="flex-1 border-t border-border/40" />
                        <span className="px-3 text-xs text-muted-foreground">or use email</span>
                        <div className="flex-1 border-t border-border/40" />
                      </div>
                      <div className="relative">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                        <Input type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className="pl-11 h-14 text-base rounded-xl border-2 focus:border-primary" style={{ fontSize: '16px' }} />
                      </div>
                    </>
                  )}

                  {resetStep === 'otp' && (
                    <>
                      <Input type="text" inputMode="numeric" maxLength={6} value={resetOtpCode} onChange={(e) => setResetOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" className="h-16 text-center text-3xl tracking-[0.5em] rounded-xl font-mono border-2 focus:border-primary" style={{ fontSize: '28px' }} required autoFocus />
                      <button
                        type="button"
                        onClick={() => {
                          setResetOtpCode('');
                          setResetStep('phone');
                          // Re-trigger send
                          setTimeout(() => {
                            const form = document.querySelector('form');
                            if (form) form.requestSubmit();
                          }, 100);
                        }}
                        className="w-full text-sm text-primary hover:underline text-center"
                      >
                        Didn't get the code? Resend SMS
                      </button>
                    </>
                  )}

                  {resetStep === 'new-password' && (
                    <>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                        <Input type={showPassword ? "text" : "password"} value={resetNewPassword} onChange={(e) => setResetNewPassword(e.target.value)} placeholder="New password (min 6 chars)" className="pl-11 h-14 text-base rounded-xl border-2 focus:border-primary" style={{ fontSize: '16px' }} required autoFocus />
                        <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground">{showPassword ? 'Hide' : 'Show'}</button>
                      </div>
                      <PasswordStrengthIndicator password={resetNewPassword} />
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                        <Input type={showPassword ? "text" : "password"} value={resetConfirmPassword} onChange={(e) => setResetConfirmPassword(e.target.value)} placeholder="Confirm new password" className={cn("pl-11 h-14 text-base rounded-xl border-2 focus:border-primary", resetConfirmPassword && resetNewPassword !== resetConfirmPassword && 'border-destructive')} style={{ fontSize: '16px' }} required />
                      </div>
                      {resetConfirmPassword && resetNewPassword !== resetConfirmPassword && (
                        <p className="text-xs text-destructive flex items-center gap-1"><AlertCircle className="h-3 w-3" /> Passwords don't match</p>
                      )}
                    </>
                  )}

                  <Button type="submit" className="w-full h-14 text-base rounded-xl font-bold touch-manipulation active:scale-[0.98] shadow-md" disabled={isLoading} style={{ fontSize: '16px' }}>
                    {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : resetStep === 'phone' ? (email ? '📧 Send Reset Link' : '📲 Send SMS Code') : resetStep === 'otp' ? '✅ Verify Code' : '🔐 Reset Password'}
                  </Button>
                </form>

                <button
                  type="button"
                  onClick={() => {
                    if (resetStep !== 'phone') {
                      setResetStep(resetStep === 'new-password' ? 'otp' : 'phone');
                    } else {
                      setIsForgotPassword(false);
                      setResetStep('phone');
                      setResetPhone('');
                      setResetOtpCode('');
                      setResetNewPassword('');
                      setResetConfirmPassword('');
                    }
                  }}
                  className="w-full text-sm text-muted-foreground hover:text-primary text-center flex items-center justify-center gap-1 py-2"
                >
                  <ArrowLeft className="h-4 w-4" />
                  {resetStep !== 'phone' ? 'Go Back' : 'Back to Sign In'}
                </button>
              </div>
            )}

            {/* ===== FORGOT PHONE (email login) ===== */}
            {isForgotPhone && (
              <div className="space-y-3 animate-in fade-in duration-200">
                <p className="text-sm font-medium text-foreground">Sign In with Email</p>
                <form onSubmit={wrappedHandleSubmit} className="space-y-3">
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className="pl-10 h-12 text-base rounded-xl" style={{ fontSize: '16px' }} required />
                  </div>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" className="pl-10 h-12 text-base rounded-xl" style={{ fontSize: '16px' }} required />
                  </div>
                  <Button type="submit" className="w-full h-12 text-base rounded-xl font-semibold touch-manipulation active:scale-[0.98]" disabled={isLoading} style={{ fontSize: '16px' }}>
                    {isLoading ? (
                      <span className="flex items-center justify-center gap-2">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        <span className="text-sm font-medium truncate">{stageText}</span>
                      </span>
                    ) : 'Sign In'}
                  </Button>
                </form>
                <button type="button" onClick={() => { setIsForgotPhone(false); setEmail(''); }} className="w-full text-xs text-muted-foreground hover:text-primary text-center flex items-center justify-center gap-1">
                  <ArrowLeft className="h-3 w-3" /> Back to sign in
                </button>
              </div>
            )}

            {/* ===== SIGN UP ===== */}
            {isSignUp && !needsRoleSelection && (
              <div className="space-y-3 animate-in fade-in duration-200">
                {/* Social signup */}
                <div className="space-y-2.5">
                  <OAuthEnvironmentHint />
                <OAuthErrorCard />
                  <GoogleSignInButton
                    onClick={wrappedHandleGoogleSignIn}
                    disabled={isGoogleLoading || isAppleLoading || isLoading}
                    isLoading={isGoogleLoading}
                    variant="prominent"
                  />
                  <AppleSignInButton
                    onClick={handleAppleSignIn}
                    disabled={isGoogleLoading || isAppleLoading || isLoading}
                    isLoading={isAppleLoading}
                  />
                </div>

                <div className="relative flex items-center py-1">
                  <div className="flex-1 border-t border-border/40" />
                  <span className="px-3 text-xs text-muted-foreground">or</span>
                  <div className="flex-1 border-t border-border/40" />
                </div>

                <form onSubmit={wrappedHandleSubmit} className="space-y-4">
                  {/* Person name — split capture, single `full_name` payload */}
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 px-1">
                      <User className="h-4 w-4 text-muted-foreground" />
                      <Label className="p-0">Your name</Label>
                    </div>
                    <PersonNameFields
                      idPrefix="signup"
                      value={nameParts}
                      onChange={(next) => {
                        setNameParts(next);
                        if (namePartsError) setNamePartsError(null);
                      }}
                      disabled={isLoading}
                      errors={{
                        firstName: namePartsError && !nameParts.firstName.trim() ? namePartsError : null,
                        lastName: namePartsError && nameParts.firstName.trim() && !nameParts.lastName.trim() ? namePartsError : null,
                        otherNames: namePartsError && nameParts.firstName.trim() && nameParts.lastName.trim() ? namePartsError : null,
                      }}
                    />
                  </div>

                  {/* Email (optional — lets users sign up without SMS OTP) */}
                  <div className="space-y-1.5">
                    <Label htmlFor="signup-email" className="px-1">Email <span className="font-normal text-muted-foreground">(optional)</span></Label>
                    <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="signup-email"
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      value={signupEmail}
                      onChange={(e) => setSignupEmail(e.target.value)}
                      placeholder="you@example.com"
                      className="pl-10 h-14 text-base rounded-lg"
                      style={{ fontSize: '16px' }}
                    />
                    </div>
                  </div>

                  {/* Phone */}
                  <div className="space-y-1.5">
                    <Label htmlFor="signup-phone" className="px-1">Phone number</Label>
                    <div className="relative flex">
                    <CountryCodeSelect value={countryCode} onChange={setCountryCode} />
                    <div className="relative flex-1">
                      <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="signup-phone"
                        ref={phoneInputRef}
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel"
                        value={phone}
                        onChange={(e) => { setPhone(e.target.value); setLoginError(null); }}
                        placeholder="700 123 456"
                        className={cn("pl-10 h-14 text-base rounded-lg rounded-l-none", isDuplicate && 'border-destructive')}
                        style={{ fontSize: '16px' }}
                        required
                      />
                    </div>
                    </div>
                  </div>
                  {isDuplicate && (
                    <p className="text-xs text-destructive flex items-center gap-1 px-1"><AlertCircle className="h-3 w-3" />{duplicateMessage}</p>
                  )}
                  {isCheckingDuplicate && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1 px-1"><Loader2 className="h-3 w-3 animate-spin" />Checking...</p>
                  )}

                  {/* Phone OTP — required only when no email was provided */}
                  {!signupEmail.trim() && phone.replace(/\D/g, '').length >= 9 && !isDuplicate && (
                    <div className="rounded-xl border border-border/60 bg-muted/30 p-3 space-y-2">
                      <p className="text-xs text-muted-foreground">
                        No email provided — we'll verify your phone instead. No email will be sent.
                      </p>
                      <OtpVerificationStep
                        phone={(() => {
                          const d = phone.replace(/\D/g, '');
                          return d.startsWith(countryCode) ? d : countryCode + (d.startsWith('0') ? d.slice(1) : d);
                        })()}
                        otpSent={otpSent}
                        otpVerified={otpVerified}
                        otpLoading={otpLoading}
                        otpError={otpError}
                        sendStatus={otpSendStatus}
                        cooldownSeconds={otpCooldownSeconds}
                        onSendOtp={() => {
                          const d = phone.replace(/\D/g, '');
                          const full = d.startsWith(countryCode) ? d : countryCode + (d.startsWith('0') ? d.slice(1) : d);
                          sendOtp(full, { category: 'signup' });
                        }}
                        onVerifyOtp={(code) => {
                          const d = phone.replace(/\D/g, '');
                          const full = d.startsWith(countryCode) ? d : countryCode + (d.startsWith('0') ? d.slice(1) : d);
                          verifyOtp(full, code, { category: 'signup' });
                        }}
                        onResendOtp={() => {
                          const d = phone.replace(/\D/g, '');
                          const full = d.startsWith(countryCode) ? d : countryCode + (d.startsWith('0') ? d.slice(1) : d);
                          sendOtp(full, { category: 'signup' });
                        }}
                      />
                    </div>
                  )}

                  {/* Password */}
                  <div className="space-y-1.5">
                    <Label htmlFor="signup-password" className="px-1">Password</Label>
                    <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="signup-password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Password"
                      className="pl-10 pr-14 h-14 text-base rounded-lg"
                      style={{ fontSize: '16px' }}
                      required
                    />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground">
                      {showPassword ? 'Hide' : 'Show'}
                    </button>
                    </div>
                  </div>
                  <PasswordStrengthIndicator password={password} />

                  {/* Confirm Password */}
                  <div className="space-y-1.5">
                    <Label htmlFor="signup-confirm-password" className="px-1">Confirm password</Label>
                    <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="signup-confirm-password"
                      type={showConfirmPassword ? "text" : "password"}
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Confirm password"
                      className={cn("pl-10 pr-14 h-14 text-base rounded-lg", confirmPassword && password !== confirmPassword && 'border-destructive', confirmPassword && password === confirmPassword && 'border-emerald-500')}
                      style={{ fontSize: '16px' }}
                      required
                    />
                    <button type="button" onClick={() => setShowConfirmPassword(!showConfirmPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground">
                      {showConfirmPassword ? 'Hide' : 'Show'}
                    </button>
                    </div>
                  </div>
                  {confirmPassword && password !== confirmPassword && (
                    <p className="text-xs text-destructive px-1">Passwords don't match</p>
                  )}

                  <Button
                    type="submit"
                    className="w-full h-14 text-base rounded-lg font-semibold touch-manipulation active:scale-[0.98]"
                    disabled={
                      isLoading ||
                      isDuplicate ||
                      isCheckingDuplicate ||
                      (!signupEmail.trim() && !otpVerified)
                    }
                    style={{ fontSize: '16px', WebkitTapHighlightColor: 'transparent' }}
                  >
                    {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : 'Create Account'}
                  </Button>
                </form>
              </div>
            )}

            {/* Sign in / Sign up toggle */}
            {!isForgotPassword && !isForgotPhone && !SIGNUP_PAUSED && (
              <div className="text-center mt-5">
                <p className="text-sm text-muted-foreground">
                  {isSignUp ? 'Already have an account?' : "Don't have an account?"}
                  {' '}
                  <button
                    type="button"
                    onClick={() => setIsSignUp(!isSignUp)}
                    className="text-primary font-semibold hover:underline"
                  >
                    {isSignUp ? 'Sign In' : 'Sign Up'}
                  </button>
                </p>
              </div>
            )}
          </div>
        )}

        <p className="text-center text-[10px] text-muted-foreground/60 mt-6">
          By continuing, you agree to our{' '}
          <Link to="/terms" className="hover:underline">Terms</Link>
          {' & '}
          <Link to="/privacy" className="hover:underline">Privacy Policy</Link>
        </p>
      </div>
    </div>
  );
}
