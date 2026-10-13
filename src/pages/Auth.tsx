import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { ArrowLeft, Mail, Lock, User, Phone, Loader2, MessageCircle, AlertCircle, LogIn, Smartphone, ArrowRight, Key, Clock, House, Building2, Handshake, HeartHandshake, type LucideIcon } from 'lucide-react';
import { CountryCodeSelect, COUNTRIES } from '@/components/auth/CountryCodeSelect';
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
import './auth-design.css';
import authArtAsset from '@/assets/auth/sign-in-panel.png.asset.json';
import authLogoAsset from '@/assets/welcome-new/welile-logo.png.asset.json';
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

const DESIGN_ROLES: { role: string; label: string; desc: string; icon: LucideIcon }[] = [
  { role: 'tenant', label: 'Tenant', desc: 'Find a home, pay rent and access support', icon: House },
  { role: 'landlord', label: 'Landlord', desc: 'List properties, manage tenants and grow your income', icon: Building2 },
  { role: 'agent', label: 'Agent', desc: 'Connect people, manage listings and close deals', icon: Handshake },
  { role: 'supporter', label: 'Supporter', desc: 'Support tenants and communities through funding and services', icon: HeartHandshake },
];

const SIGNUP_ROLE_CONFIG: Record<string, { label: string; icon: LucideIcon; text: string }> = {
  tenant: { label: 'Join as a Tenant', icon: House, text: 'A safer, simpler way to find your next home and access rent support.' },
  landlord: { label: 'Join as a Landlord', icon: Building2, text: 'List properties, manage tenants and track rent activity from one place.' },
  agent: { label: 'Join as an Agent', icon: Handshake, text: 'Connect people, support onboarding and grow through field opportunities.' },
  supporter: { label: 'Join as a Partner', icon: HeartHandshake, text: 'Support rent opportunities, monitor portfolios and help make housing possible.' },
};

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
  const [resetMethod, setResetMethod] = useState<"sms" | "email">("sms");
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
  const [pendingRole, setPendingRole] = useState<string>('tenant');

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
    <div className="welile-auth">
      <Helmet>
        <title>Sign In or Create Your Welile Account</title>
        <meta name="description" content="Log in or sign up to access rent, fund tenants, and manage your Welile wallet securely." />
        <link rel="canonical" href="https://welileapp.com/auth" />
        <meta property="og:title" content="Sign In or Create Your Welile Account" />
        <meta property="og:description" content="Log in or sign up to access rent, fund tenants, and manage your Welile wallet securely." />
        <meta property="og:url" content="https://welileapp.com/auth" />
      </Helmet>
      <main className="app-container">
      <div
        className="screen-layout screen-account-layout screen-auth-layout"
        style={{ ['--desktop-art' as string]: `url('${authArtAsset.url}')` } as React.CSSProperties}
      >

        <div className="screen-top-header">
          <button
            type="button"
            className="btn-circle-nav"
            aria-label="Back"
            onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/welcome'))}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        </div>

        {!isSignUp && (<div className="auth-brand">
          <img src={authLogoAsset.url} alt="Welile" className="auth-logo" />
        </div>)}

        <div className="auth-step" style={{ flex: '1 0 auto' }}>
        {isLoginView && (
          <>
            <h1 className="auth-title" tabIndex={-1}>
              {hadSession && lastUserName ? `Welcome back, ${lastUserName}` : 'Welcome back'}
            </h1>
            <p className="auth-subtitle">Sign in to your Welile account</p>
          </>
        )}
        {!isLoginView && !isSignUp && <div className="mb-2" />}

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

        {/* Role selection step (design screen 7) — shown after "Create account" */}
        {needsRoleSelection && (
          <div className="flex flex-col" role="group" aria-label="Role selection">
            <div className="roles-intro-block">
              <h2 className="roles-main-title">How will you use Welile?</h2>
              <p className="roles-sub-title">Your role helps personalize your experience.</p>
            </div>
            <div className="role-cards-stack" role="radiogroup" aria-label="Choose your role">
              {DESIGN_ROLES.map((r) => {
                const active = pendingRole === r.role;
                return (
                  <div
                    key={r.role}
                    className={cn('role-item', active && 'active')}
                    role="radio"
                    aria-checked={active}
                    tabIndex={0}
                    onClick={() => setPendingRole(r.role)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPendingRole(r.role); }
                    }}
                  >
                    <div className={cn('role-circle-badge', `role-badge-${r.role}`)}>
                      <r.icon className="role-badge-svg" strokeWidth={2} aria-hidden="true" />
                    </div>
                    <div className="role-info">
                      <h3 className="role-name">{r.label}</h3>
                      <p className="role-desc">{r.desc}</p>
                    </div>
                    <div className="role-radio-mark"><span className="radio-core" /></div>
                  </div>
                );
              })}
            </div>
            <div className="roles-dots-row" aria-hidden="true">
              <span className="dot" /><span className="dot" /><span className="dot" /><span className="dot active" />
            </div>
            <div className="roles-btn-stack">
              <button type="button" className="btn btn-primary" onClick={() => handleSelectRole(pendingRole)}>
                <span>Continue</span>
                <ArrowRight className="h-4 w-4" />
              </button>
              <button type="button" className="btn-link-muted" onClick={() => setIsSignUp(false)}>Back</button>
            </div>
          </div>
        )}

        {!needsRoleSelection && (
          <div className="flex flex-col">

            {/* Design layout: Google → "or sign in with" → method tabs → active form.
                Tabs are bound to the existing loginMode state (logic unchanged). */}
            {isLoginView && (
              <>
                <OAuthEnvironmentHint />
                <OAuthErrorCard />
                <div className="flex w-full flex-col gap-2.5">
                  <button
                    type="button"
                    className="btn btn-google"
                    onClick={wrappedHandleGoogleSignIn}
                    disabled={isGoogleLoading || isAppleLoading || isLoading || emailLoginLoading}
                  >
                    {isGoogleLoading ? <Loader2 className="btn-spin" /> : <GoogleMark />}
                    <span>Continue with Google</span>
                  </button>
                  {/* Apple sign-in kept in code but hidden from the screen. */}
                  <button
                    type="button"
                    className="btn btn-apple"
                    style={{ display: "none" }}
                    onClick={() => {
                      localStorage.setItem('welile_last_login_method', 'apple');
                      // OAuth sign-ins are always persistent — clear stale ephemeral flag.
                      setDeviceTrust(true);
                      handleAppleSignIn();
                    }}
                    disabled={isGoogleLoading || isAppleLoading || isLoading}
                  >
                    {isAppleLoading ? <Loader2 className="btn-spin" /> : <AppleMark />}
                    <span>Continue with Apple</span>
                  </button>
                </div>

                <div className="or-separator">
                  <span className="sep-line" />
                  <span className="sep-text">or sign in with</span>
                  <span className="sep-line" />
                </div>

                <div className="auth-tabs" role="tablist" aria-label="Sign-in method">
                  {([
                    ['email', 'Email'],
                    ['password', 'Phone'],
                    ['otp', 'One-time code'],
                  ] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      role="tab"
                      aria-selected={loginMode === mode}
                      tabIndex={loginMode === mode ? 0 : -1}
                      className={cn('auth-tab', loginMode === mode && 'active')}
                      onClick={() => setLoginMode(mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* ===== SIGN IN VIEW (phone + password) ===== */}
            {isLoginView && loginMode === 'password' && (
              <>
                <form onSubmit={wrappedHandleSubmit} className="auth-form" role="tabpanel" aria-label="Phone" noValidate>
                  <div className="form-row">
                    <label className="input-label" htmlFor="authPwPhoneInput">Phone number</label>
                    <DesignPhoneInput
                      id="authPwPhoneInput"
                      inputRef={phoneInputRef}
                      code={countryCode}
                      onCodeChange={setCountryCode}
                      value={phone}
                      onChange={(v) => { setPhone(v); setLoginError(null); }}
                      invalid={!!loginError}
                    />
                  </div>

                  <div className="form-row">
                    <label className="input-label" htmlFor="authPhonePassword">Password</label>
                    <DesignPasswordInput
                      id="authPhonePassword"
                      inputRef={passwordInputRef}
                      value={password}
                      onChange={setPassword}
                      shown={showPassword}
                      onToggle={() => setShowPassword(!showPassword)}
                    />
                  </div>

                  {loginError && <p className="form-error" role="alert">{loginError.message}</p>}
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

                  <div className="form-options-row">
                    <label>
                      <Checkbox
                        checked={rememberMe}
                        onCheckedChange={(checked) => {
                          setRememberMe(!!checked);
                          localStorage.setItem('welile_remember_me', String(!!checked));
                        }}
                        className="h-4 w-4"
                      />
                      <span>Remember me</span>
                    </label>
                    <button type="button" className="link-purple" onClick={() => { if (phone) setResetPhone(phone); setIsForgotPassword(true); }}>
                      {failedAttempts >= 1 ? 'Reset password via SMS' : 'Forgot password?'}
                    </button>
                  </div>

                  <button type="submit" className="btn btn-primary" disabled={isLoading}>
                    {isLoading ? <><Loader2 className="btn-spin" /> <span className="truncate">{stageText}</span></> : <span>Sign in</span>}
                  </button>
                  <button type="button" onClick={() => { if (phone) setResetPhone(phone); setResetStep('phone'); setIsForgotPassword(true); }} className="btn-link-muted">
                    Forgot password? Send a reset code
                  </button>
                </form>

                {failedAttempts >= 2 && (
                  <button
                    type="button"
                    className="btn-link-muted"
                    onClick={() => {
                      const message = encodeURIComponent(`Hello Welile Support,\n\nI'm having trouble logging in.\n\nPhone: ${phone}\n\nPlease help.`);
                      window.open(`https://wa.me/256783673998?text=${message}`, '_blank');
                    }}
                  >
                    Need help? Contact Support
                  </button>
                )}
              </>
            )}

            {/* ===== EMAIL LOGIN ===== */}
            {isLoginView && loginMode === 'email' && (
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
                }} className="auth-form" role="tabpanel" aria-label="Email" noValidate>
                  <div className="form-row">
                    <label className="input-label" htmlFor="authEmailInput">Email</label>
                    <input
                      id="authEmailInput"
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      className="text-input-field"
                      value={emailLoginAddress}
                      onChange={(e) => { setEmailLoginAddress(e.target.value); setLoginError(null); }}
                      placeholder="you@example.com"
                      aria-invalid={!!loginError}
                      required
                      autoFocus
                    />
                  </div>

                  <div className="form-row">
                    <label className="input-label" htmlFor="authEmailPassword">Password</label>
                    <DesignPasswordInput
                      id="authEmailPassword"
                      value={password}
                      onChange={setPassword}
                      shown={showPassword}
                      onToggle={() => setShowPassword(!showPassword)}
                    />
                  </div>

                  {loginError && <p className="form-error" role="alert">{loginError.message}</p>}
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

                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={emailLoginLoading || !emailLoginAddress.trim() || !password.trim()}
                  >
                    {emailLoginLoading ? <><Loader2 className="btn-spin" /> <span>Signing in…</span></> : <span>Sign in</span>}
                  </button>
                  <button type="button" onClick={() => { if (phone) setResetPhone(phone); setResetStep('phone'); setIsForgotPassword(true); }} className="btn-link-muted">
                    Forgot password? Send a reset code
                  </button>
                </form>
            )}

            {/* ===== OTP LOGIN ===== */}
            {isLoginView && loginMode === 'otp' && (
              otpLoginStep === 'phone' ? (
                <form
                  className="auth-form"
                  role="tabpanel"
                  aria-label="One-time code"
                  noValidate
                  onSubmit={(e) => { e.preventDefault(); if (!otpLoginLoading && otpLoginPhone.replace(/\D/g, '').length >= 7) handleSendOtpForLogin(); }}
                >
                  <div className="form-row">
                    <label className="input-label" htmlFor="authOtpPhoneInput">Phone number</label>
                    <DesignPhoneInput
                      id="authOtpPhoneInput"
                      code={otpLoginCountryCode}
                      onCodeChange={setOtpLoginCountryCode}
                      value={otpLoginPhone}
                      onChange={setOtpLoginPhone}
                      autoFocus
                    />
                    <p className="field-hint">We'll text you a 6-digit code.</p>
                  </div>

                  <label className="form-options-row" style={{ justifyContent: 'flex-start' }}>
                    <Checkbox
                      checked={rememberThisDevice}
                      onCheckedChange={(checked) => setRememberThisDevice(!!checked)}
                      className="h-4 w-4"
                    />
                    <span>Keep me logged in on this device</span>
                  </label>
                  {!rememberThisDevice && (
                    <p className="field-hint">You'll be signed out when you close this browser, and need a new code next time.</p>
                  )}

                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={otpLoginLoading || otpLoginPhone.replace(/\D/g, '').length < 7}
                  >
                    {otpLoginLoading ? <><Loader2 className="btn-spin" /> <span>Sending code…</span></> : <span>Send code</span>}
                  </button>
                </form>
              ) : (
                <div className="auth-form">
                  <h2 className="auth-title" tabIndex={-1} style={{ fontSize: '1.2rem' }}>Enter your code</h2>
                  <p className="auth-subtitle" style={{ margin: '0 0 8px' }}>
                    We sent a verification code to <strong>+{getFullOtpPhone(otpLoginPhone, otpLoginCountryCode)}</strong>
                  </p>

                  <div className="otp-boxes-group">
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
                      <InputOTPGroup className="gap-2">
                        {[0, 1, 2, 3, 4, 5].map((i) => (
                          <InputOTPSlot key={i} index={i} className="otp-cell" />
                        ))}
                      </InputOTPGroup>
                    </InputOTP>
                  </div>

                  <div className="otp-resend-bar">
                    <span>{otpResendCooldown > 0 ? <>Resend code in <strong>0:{String(otpResendCooldown).padStart(2, '0')}</strong></> : "Didn't get it?"}</span>
                    <button
                      type="button"
                      className="resend-trigger-btn"
                      onClick={handleSendOtpForLogin}
                      disabled={otpLoginLoading || otpResendCooldown > 0}
                    >
                      Resend code
                    </button>
                  </div>

                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => handleOtpLogin()}
                    disabled={otpLoginLoading || otpLoginCode.length !== 6}
                  >
                    {otpLoginLoading ? <><Loader2 className="btn-spin" /> <span>Verifying…</span></> : <span>Verify &amp; sign in</span>}
                  </button>
                  <button
                    type="button"
                    className="btn-link-muted"
                    onClick={() => { setOtpLoginStep('phone'); setOtpLoginCode(''); setOtpResendCooldown(0); }}
                  >
                    Use a different number
                  </button>
                </div>
              )
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
                  <p className="text-base font-semibold text-foreground flex items-center gap-2">
                    {resetStep === 'phone' ? (<><Key className="h-4 w-4 text-primary" /> Reset Your Password</>) : resetStep === 'otp' ? (<><Smartphone className="h-4 w-4 text-primary" /> Enter SMS Code</>) : (<><Lock className="h-4 w-4 text-primary" /> Create New Password</>)}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {resetStep === 'phone' ? (resetMethod === 'email' ? 'Enter your email and we\'ll send you a reset link' : 'Enter your phone number and we\'ll send you a code via SMS') : resetStep === 'otp' ? `We sent a 6-digit code to ${resetPhone || 'your phone'}` : 'Choose a strong password you\'ll remember'}
                  </p>
                </div>

                <form onSubmit={wrappedHandleSubmit} className="space-y-3">
                  {resetStep === 'phone' && (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <button type="button" onClick={() => { setResetMethod('sms'); setEmail(''); }} className={cn("h-12 rounded-xl border-2 text-sm font-semibold flex items-center justify-center gap-2", resetMethod === 'sms' ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground")}><Smartphone className="h-4 w-4" /> Phone (SMS)</button>
                        <button type="button" onClick={() => setResetMethod('email')} className={cn("h-12 rounded-xl border-2 text-sm font-semibold flex items-center justify-center gap-2", resetMethod === 'email' ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground")}><Mail className="h-4 w-4" /> Email</button>
                      </div>
                      {resetMethod === 'sms' ? (
                      <div className="relative">
                        <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                        <Input type="tel" inputMode="tel" value={resetPhone} onChange={(e) => setResetPhone(e.target.value)} placeholder="Enter your phone number e.g. 0700123456" className="pl-11 h-14 text-base rounded-xl border-2 focus:border-primary" style={{ fontSize: '16px' }} autoFocus />
                      </div>
                      ) : (
                      <div className="relative">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                        <Input type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className="pl-11 h-14 text-base rounded-xl border-2 focus:border-primary" style={{ fontSize: '16px' }} autoFocus />
                      </div>
                      )}
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
                    {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : (
                      <span className="flex items-center justify-center gap-2">
                        {resetStep === 'phone' ? (resetMethod === 'email' ? (<><Mail className="h-4 w-4" /> Send Reset Link</>) : (<><Smartphone className="h-4 w-4" /> Send SMS Code</>)) : resetStep === 'otp' ? (<><Key className="h-4 w-4" /> Verify Code</>) : (<><Lock className="h-4 w-4" /> Reset Password</>)}
                      </span>
                    )}
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

            {/* ===== SIGN UP (design screen 8) ===== */}
            {isSignUp && !needsRoleSelection && (() => {
              const cfg = SIGNUP_ROLE_CONFIG[preSelectedRole ?? 'tenant'] ?? SIGNUP_ROLE_CONFIG.tenant;
              const fullPhone = () => {
                const d = phone.replace(/\D/g, '');
                return d.startsWith(countryCode) ? d : countryCode + (d.startsWith('0') ? d.slice(1) : d);
              };
              const mismatch = !!confirmPassword && password !== confirmPassword;
              const formError = namePartsError || (isDuplicate ? duplicateMessage : null) || (mismatch ? "Passwords don't match" : null);
              return (
              <div className="flex flex-col">
                <div className="account-profile-header">
                  <div className="account-heading-box">
                    <h1 className="account-title" tabIndex={-1}>Create your account</h1>
                    <p className="account-role-label">
                      {cfg.label}
                      {referringAgentName ? ` · through Agent ${referringAgentName}` : ''}
                    </p>
                  </div>
                  <div className="account-avatar-wrapper">
                    <cfg.icon className="account-avatar-icon" strokeWidth={2} aria-hidden="true" />
                  </div>
                </div>

                <div className="account-value-box">
                  <p className="value-box-text">{cfg.text}</p>
                </div>

                <form className="account-creation-form" onSubmit={wrappedHandleSubmit} noValidate>
                  <div className="form-row-pair">
                    <div className="form-row">
                      <label className="input-label" htmlFor="signup-first">First name</label>
                      <input id="signup-first" className="text-input-field" placeholder="First name" autoComplete="given-name" required
                        aria-describedby="signup-form-error" value={nameParts.firstName} disabled={isLoading}
                        onChange={(e) => { setNameParts({ ...nameParts, firstName: e.target.value }); if (namePartsError) setNamePartsError(null); }} />
                    </div>
                    <div className="form-row">
                      <label className="input-label" htmlFor="signup-last">Last name</label>
                      <input id="signup-last" className="text-input-field" placeholder="Last name" autoComplete="family-name" required
                        aria-describedby="signup-form-error" value={nameParts.lastName} disabled={isLoading}
                        onChange={(e) => { setNameParts({ ...nameParts, lastName: e.target.value }); if (namePartsError) setNamePartsError(null); }} />
                    </div>
                  </div>

                  <div className="form-row">
                    <label className="input-label" htmlFor="signup-email">Email</label>
                    <input id="signup-email" type="email" inputMode="email" autoComplete="email" className="text-input-field"
                      placeholder="you@example.com" aria-describedby="signup-form-error"
                      value={signupEmail} onChange={(e) => setSignupEmail(e.target.value)} />
                  </div>

                  <div className="form-row">
                    <label className="input-label" htmlFor="signup-phone">Phone number</label>
                    <DesignPhoneInput
                      id="signup-phone"
                      code={countryCode}
                      onCodeChange={setCountryCode}
                      value={phone}
                      onChange={(v) => { setPhone(v); setLoginError(null); }}
                      invalid={isDuplicate}
                      inputRef={phoneInputRef}
                    />
                    <p className="field-hint">
                      {isCheckingDuplicate ? 'Checking this number…' : "We'll text you a code to verify this number."}
                    </p>
                  </div>

                  {!signupEmail.trim() && phone.replace(/\D/g, '').length >= 9 && !isDuplicate && (
                    <div className="signup-otp-box">
                      <OtpVerificationStep
                        phone={fullPhone()}
                        otpSent={otpSent}
                        otpVerified={otpVerified}
                        otpLoading={otpLoading}
                        otpError={otpError}
                        sendStatus={otpSendStatus}
                        cooldownSeconds={otpCooldownSeconds}
                        onSendOtp={() => sendOtp(fullPhone(), { category: 'signup' })}
                        onVerifyOtp={(code) => verifyOtp(fullPhone(), code, { category: 'signup' })}
                        onResendOtp={() => sendOtp(fullPhone(), { category: 'signup' })}
                      />
                    </div>
                  )}

                  <div className="form-row">
                    <label className="input-label" htmlFor="signup-password">Password</label>
                    <DesignPasswordInput id="signup-password" value={password} onChange={setPassword}
                      shown={showPassword} onToggle={() => setShowPassword(!showPassword)}
                      placeholder="Create a password" autoComplete="new-password" describedBy="signup-password-hint" />
                    <p className="field-hint" id="signup-password-hint">At least 8 characters.</p>
                  </div>

                  <div className="form-row">
                    <label className="input-label" htmlFor="signup-confirm-password">Confirm password</label>
                    <DesignPasswordInput id="signup-confirm-password" value={confirmPassword} onChange={setConfirmPassword}
                      shown={showConfirmPassword} onToggle={() => setShowConfirmPassword(!showConfirmPassword)}
                      placeholder="Re-enter your password" autoComplete="new-password" describedBy="signup-form-error" />
                  </div>

                  <p className="form-error" id="signup-form-error" role="alert">{formError ?? ''}</p>

                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={isLoading || isDuplicate || isCheckingDuplicate || (!signupEmail.trim() && !otpVerified)}
                  >
                    {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : (<><span>Continue</span><ArrowRight className="h-4 w-4" /></>)}
                  </button>
                </form>

                <div className="security-guarantee-card">
                  <svg className="security-shield-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><polyline points="9 12 11 14 15 10" />
                  </svg>
                  <div className="security-content">
                    <h4 className="security-heading">Secure verification</h4>
                    <p className="security-text">Your information is protected and never shared without your consent.</p>
                  </div>
                </div>

                <div className="or-separator">
                  <span className="sep-line" /><span className="sep-text">or</span><span className="sep-line" />
                </div>
              </div>
              );
            })()}

          </div>
        )}

        {/* Sign in / Sign up toggle */}
        {!isForgotPassword && !isForgotPhone && !SIGNUP_PAUSED && (
          <div className="signin-redirect-row auth-switch-row">
            <span>{isSignUp ? 'Already have an account?' : 'New to Welile?'}</span>
            <button
              type="button"
              onClick={() => {
                if (!isSignUp) {
                  const p = new URLSearchParams(searchParams);
                  p.delete('role');
                  setSearchParams(p, { replace: true });
                }
                setIsSignUp(!isSignUp);
              }}
              className="signin-highlight-btn"
            >
              {isSignUp ? 'Sign in' : 'Create account'}
            </button>
          </div>
        )}
        {(isForgotPassword || isForgotPhone || SIGNUP_PAUSED) && <div className="auth-spacer" />}

        <footer className="legal-footer compact">
          <a className="legal-action" href="/privacy-policy" target="_blank" rel="noopener">Privacy Policy</a>
          <span className="legal-divider">|</span>
          <Link className="legal-action" to="/terms">Terms of Service</Link>
        </footer>
        </div>
      </div>
      </main>
    </div>
  );
}

/* ---------- design-matched field pieces (presentation only) ---------- */

function GoogleMark() {
  return (
    <svg className="google-icon" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function AppleMark() {
  return (
    <svg className="google-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16.37 12.6c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.71-3.18-1.73-1.35-.14-2.64.8-3.33.8-.69 0-1.74-.78-2.86-.76-1.47.02-2.83.86-3.59 2.17-1.53 2.66-.39 6.59 1.1 8.75.73 1.05 1.6 2.24 2.73 2.2 1.1-.04 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.4 1.2-2.46-.03-.01-2.29-.88-2.3-3.51zM14.2 6.13c.6-.73 1.01-1.75.9-2.76-.87.04-1.92.58-2.54 1.31-.56.64-1.05 1.67-.92 2.66.97.08 1.96-.49 2.56-1.21z" />
    </svg>
  );
}

function DesignPasswordInput({ id, value, onChange, shown, onToggle, inputRef, placeholder = 'Your password', autoComplete = 'current-password', describedBy }: {
  id: string; value: string; onChange: (v: string) => void; shown: boolean; onToggle: () => void;
  inputRef?: React.Ref<HTMLInputElement>; placeholder?: string; autoComplete?: string; describedBy?: string;
}) {
  return (
    <div className="password-field">
      <input
        id={id}
        ref={inputRef}
        type={shown ? 'text' : 'password'}
        autoComplete={autoComplete}
        aria-describedby={describedBy}
        className="text-input-field password-input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
      />
      <button type="button" className="password-toggle" aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown} aria-controls={id} onClick={onToggle}>
        {shown ? (
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" /></svg>
        )}
      </button>
    </div>
  );
}

function DesignPhoneInput({ id, code, onCodeChange, value, onChange, invalid, autoFocus, inputRef }: {
  id: string; code: string; onCodeChange: (c: string) => void; value: string; onChange: (v: string) => void;
  invalid?: boolean; autoFocus?: boolean; inputRef?: React.Ref<HTMLInputElement>;
}) {
  const current = COUNTRIES.find((c) => c.code === code);
  return (
    <div className="phone-input-combo has-code">
      <div className="country-trigger">
        <span className="country-dial-code" aria-hidden="true">{current ? `${current.flag} +${current.code}` : `+${code}`}</span>
        <svg className="chevron-svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
        <select className="country-select" aria-label="Country code" value={code} onChange={(e) => onCodeChange(e.target.value)}>
          {COUNTRIES.map((c, i) => (
            <option key={`${c.short}-${i}`} value={c.code}>{c.flag} {c.name} (+{c.code})</option>
          ))}
        </select>
      </div>
      <input
        id={id}
        ref={inputRef}
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        className="phone-number-field"
        placeholder="Phone number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid || undefined}
        autoFocus={autoFocus}
        required
      />
    </div>
  );
}
