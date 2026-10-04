import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { joinPersonName, type PersonNameParts } from '@/lib/authValidation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, CheckCircle2, Eye, EyeOff, ArrowRight, AlertCircle, UserPlus, KeyRound, Copy, MessageCircle, MapPin, Navigation } from 'lucide-react';
import WelileLogo from '@/components/WelileLogo';
import ThreeBodyLoader from '@/components/common/ThreeBodyLoader';
import { roleToSlug } from '@/lib/roleRoutes';

type PageState = 'loading' | 'invalid' | 'activated-already' | 'ready' | 'profile-setup' | 'review' | 'success' | 'forgot-password' | 'password-reset';

const extractActivationToken = (value: string | null): string => {
  if (!value) return '';
  const decoded = decodeURIComponent(value).trim();
  const match = decoded.match(/[a-zA-Z0-9-]{10,100}/);
  return match?.[0] ?? '';
};

const extractActivationPassword = (rawToken: string | null, passwordParam: string | null): string => {
  const directPassword = typeof passwordParam === 'string' ? decodeURIComponent(passwordParam).trim() : '';
  if (directPassword) return directPassword;

  if (!rawToken) return '';
  const decoded = decodeURIComponent(rawToken);
  const legacyMatch = decoded.match(/password\s*[:=]\s*([^\n\r]+)/i);
  return legacyMatch?.[1]?.trim() ?? '';
};

export default function ActivateSupporter() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const rawTokenParam = searchParams.get('token');
  const token = useMemo(() => extractActivationToken(rawTokenParam), [rawTokenParam]);
  const passwordFromUrl = useMemo(
    () => extractActivationPassword(rawTokenParam, searchParams.get('password')),
    [rawTokenParam, searchParams]
  );
  const passwordInputRef = useRef<HTMLInputElement>(null);

  const [password, setPassword] = useState(passwordFromUrl);
  const [showPassword, setShowPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [pageState, setPageState] = useState<PageState>('loading');
  const [isValidating, setIsValidating] = useState(true);
  const [activatedEmail, setActivatedEmail] = useState('');
  const [inviteDetails, setInviteDetails] = useState<{ full_name: string; role?: string; phone?: string } | null>(null);

  // Profile completion fields
  // Captured in parts; the activation payload keeps one `fullName` string.
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const fullName = joinPersonName(nameParts);
  const [email, setEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [locationStatus, setLocationStatus] = useState<'idle' | 'requesting' | 'granted' | 'denied'>('idle');
  const [locationData, setLocationData] = useState<{ latitude: number; longitude: number } | null>(null);

  // Review checklist state
  const [emailConfirmed, setEmailConfirmed] = useState(false);
  const [locationConfirmed, setLocationConfirmed] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);

  // Forgot password state
  const [emailForReset, setEmailForReset] = useState('');
  const [newTempPassword, setNewTempPassword] = useState('');
  const [resetPhone, setResetPhone] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (pageState === 'ready' && passwordInputRef.current) {
      setTimeout(() => passwordInputRef.current?.focus(), 100);
    }
  }, [pageState]);

  useEffect(() => {
    if (passwordFromUrl && !password) {
      setPassword(passwordFromUrl);
    }
  }, [passwordFromUrl, password]);

  // Request location when entering profile setup
  useEffect(() => {
    if (pageState === 'profile-setup' && locationStatus === 'idle') {
      requestLocation();
    }
  }, [pageState, locationStatus]);

  const requestLocation = async () => {
    if (!navigator.geolocation) {
      setLocationStatus('denied');
      return;
    }
    setLocationStatus('requesting');
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 0,
        });
      });
      setLocationData({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      });
      setLocationStatus('granted');
    } catch {
      setLocationStatus('denied');
    }
  };

  // Validate invite in background (with race-safety + retry for flaky networks)
  useEffect(() => {
    const normalizedToken = typeof token === 'string' ? decodeURIComponent(token).trim() : '';

    if (!normalizedToken) {
      setPageState('invalid');
      setIsValidating(false);
      return;
    }

    let cancelled = false;
    const maxAttempts = 3;

    const fetchInvite = async (attempt = 1) => {
      try {
        const { data: rpcData, error } = await supabase
          .rpc('lookup_invite_by_token', { p_token: normalizedToken });
        const data = rpcData && rpcData.length > 0 ? rpcData[0] : null;

        if (cancelled) return;

        if (error || !data) {
          if (attempt < maxAttempts) {
            setTimeout(() => {
              if (!cancelled) fetchInvite(attempt + 1);
            }, 250 * attempt);
            return;
          }

          setPageState('invalid');
          setIsValidating(false);
          return;
        }

        if (data.status === 'activated' || data.activated_user_id) {
          setPageState('activated-already');
          setActivatedEmail(data.email);
        } else {
          setInviteDetails({ full_name: data.full_name, role: data.role, phone: data.phone });
          setEmailForReset(data.email);
          setResetPhone(data.phone || '');
          setPageState('ready');
        }
      } catch {
        if (cancelled) return;

        if (attempt < maxAttempts) {
          setTimeout(() => {
            if (!cancelled) fetchInvite(attempt + 1);
          }, 250 * attempt);
          return;
        }

        setPageState('invalid');
      } finally {
        if (!cancelled) setIsValidating(false);
      }
    };

    setPageState('loading');
    setIsValidating(true);
    fetchInvite();

    return () => {
      cancelled = true;
    };
  }, [token]);

  // Step 1: Verify temp password, then go to profile setup
  const handleVerifyPassword = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !password) return;
    // Just move to profile setup - actual verification happens on final submit
    setPageState('profile-setup');
  }, [token, password]);

  // Step 2 -> 3: Validate profile inputs, then move to Review & Confirm
  const handleReview = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName.trim() || !newPassword.trim()) return;
    if (newPassword.trim().length < 6) {
      toast({ title: 'Password too short', description: 'Password must be at least 6 characters', variant: 'destructive' });
      return;
    }
    setPageState('review');
  }, [fullName, newPassword, toast]);

  // Step 2: Complete profile and activate
  const handleActivate = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !password || !fullName.trim() || !newPassword.trim()) return;

    if (newPassword.trim().length < 6) {
      toast({ title: 'Password too short', description: 'Password must be at least 6 characters', variant: 'destructive' });
      return;
    }

    setIsLoading(true);

    try {
      const response = await supabase.functions.invoke('activate-supporter', {
        body: { 
          token: token.trim(), 
          password: password.trim(),
          fullName: fullName.trim(),
          email: email.trim() || undefined,
          newPassword: newPassword.trim(),
        },
      });

      if (response.error) {
        // Extract human-readable error from edge function
        let errorMsg = 'Activation failed';
        try {
          const ctx = (response.error as any)?.context;
          if (ctx && typeof ctx.json === 'function') {
            const body = await ctx.json();
            if (body?.error) errorMsg = body.error;
          } else if (ctx?.body) {
            const body = typeof ctx.body === 'string' ? JSON.parse(ctx.body) : ctx.body;
            if (body?.error) errorMsg = body.error;
          }
        } catch { /* fall through */ }
        throw new Error(errorMsg);
      }
      if (response.data?.error) throw new Error(response.data.error);

      const finalEmail = response.data.email;
      setActivatedEmail(finalEmail);

      toast({
        title: response.data?.alreadyActivated ? '✅ Already Activated' : '🎉 Account Activated!',
        description: 'Signing you in...',
      });

      // Auto sign-in with the new password
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: finalEmail,
        password: newPassword.trim(),
      });

      if (signInError) {
        setPageState('success');
        toast({ title: 'Account Activated', description: 'Please sign in manually.' });
      } else {
        // Save location after sign-in
        if (locationData) {
          try {
            const { data: { user } } = await supabase.auth.getUser();
            if (user) {
              await supabase.from('user_locations').insert({
                user_id: user.id,
                latitude: locationData.latitude,
                longitude: locationData.longitude,
                accuracy: null,
              });
            }
          } catch (locErr) {
            console.warn('Location save failed:', locErr);
          }
        }
        
        toast({ title: '🎉 Welcome to Welile!', description: 'Redirecting to your dashboard...' });
        // Navigate with role param so Dashboard switches to the correct role (e.g. supporter)
        const activatedRole = inviteDetails?.role || 'supporter';
        navigate(roleToSlug(activatedRole as any));
      }
    } catch (error: any) {
      toast({
        title: 'Activation Failed',
        description: error.message || 'Please check your password and try again.',
        variant: 'destructive',
      });
      // Go back to password step if credentials were wrong
      if (error.message?.toLowerCase().includes('credential') || error.message?.toLowerCase().includes('password')) {
        setPageState('ready');
      }
    } finally {
      setIsLoading(false);
    }
  }, [token, password, fullName, email, newPassword, toast, navigate, locationData]);

  const handleLogin = async () => {
    setIsLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: activatedEmail, password: newPassword || password });
      if (error) throw error;
      navigate('/dashboard/funder');
    } catch {
      toast({ title: 'Login Failed', description: 'Please try logging in manually.', variant: 'destructive' });
      navigate('/auth');
    } finally {
      setIsLoading(false);
    }
  };

  // Generate new temporary password
  const generatePassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let result = '';
    for (let i = 0; i < 8; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
  };

  const handleResetPassword = async () => {
    if (!token) return;
    setIsLoading(true);
    try {
      const pw = generatePassword();
      const { error } = await supabase.from('supporter_invites').update({ temp_password: pw }).eq('activation_token', token).eq('status', 'pending');
      if (error) throw error;

      // Notification removed - table dropped

      setNewTempPassword(pw);
      setPageState('password-reset');
      toast({ title: '🔑 New Password Generated', description: 'Opening WhatsApp...' });

      if (resetPhone) {
        const phone = resetPhone.replace(/\D/g, '');
        const message = encodeURIComponent(`🔑 Your new Welile password: ${pw}\n\nUse this to activate your account.`);
        setTimeout(() => window.open(`https://wa.me/${phone}?text=${message}`, '_blank'), 500);
      }
    } catch (error: any) {
      toast({ title: 'Reset Failed', description: error.message || 'Could not reset password.', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopyPassword = async () => {
    try {
      await navigator.clipboard.writeText(newTempPassword);
      setCopied(true);
      toast({ title: 'Password copied!' });
      setTimeout(() => setCopied(false), 2000);
    } catch { toast({ title: 'Failed to copy', variant: 'destructive' }); }
  };

  const handleShareWhatsApp = () => {
    const phone = resetPhone.replace(/\D/g, '');
    const message = encodeURIComponent(`🔑 Your new Welile password: ${newTempPassword}\n\nUse this to activate your account.`);
    window.open(`https://wa.me/${phone}?text=${message}`, '_blank');
  };

  const handleBackToActivation = () => {
    setPassword(newTempPassword);
    setPageState('ready');
  };

  // Invalid token
  if (pageState === 'invalid') {
    return (
      <div className="min-h-screen bg-gradient-to-b from-destructive/5 to-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4"><WelileLogo linkToHome={false} /></div>
            <div className="mx-auto p-3 rounded-full bg-destructive/10 w-fit mb-4">
              <AlertCircle className="h-8 w-8 text-destructive" />
            </div>
            <CardTitle className="text-2xl">Invalid Invitation</CardTitle>
            <CardDescription>This activation link is invalid or has expired.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Link to="/auth" className="block">
              <Button className="w-full gap-2"><ArrowRight className="h-4 w-4" />Go to Sign In</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Already activated
  if (pageState === 'activated-already') {
    return (
      <div className="min-h-screen bg-gradient-to-b from-primary/5 to-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4"><WelileLogo linkToHome={false} /></div>
            <div className="mx-auto p-3 rounded-full bg-success/10 w-fit mb-4">
              <CheckCircle2 className="h-8 w-8 text-success" />
            </div>
            <CardTitle className="text-2xl">Already Activated</CardTitle>
            <CardDescription>This account has already been activated. Please sign in.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {activatedEmail && (
              <div className="p-3 rounded-lg bg-muted text-center">
                <p className="text-xs text-muted-foreground mb-1">Sign in with</p>
                <p className="font-medium text-sm break-all">{activatedEmail}</p>
              </div>
            )}
            <Link to="/auth" className="block">
              <Button className="w-full gap-2"><ArrowRight className="h-4 w-4" />Sign In Now</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Success
  if (pageState === 'success') {
    const roleLabel = inviteDetails?.role ? inviteDetails.role.charAt(0).toUpperCase() + inviteDetails.role.slice(1) : 'User';
    return (
      <div className="min-h-screen bg-gradient-to-b from-success/5 to-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4"><WelileLogo linkToHome={false} /></div>
            <div className="mx-auto p-4 rounded-full bg-success/10 w-fit mb-4">
              <CheckCircle2 className="h-10 w-10 text-success" />
            </div>
            <CardTitle className="text-2xl">Account Activated!</CardTitle>
            <CardDescription>Welcome to Welile! Your {roleLabel} account is ready.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button onClick={handleLogin} className="w-full gap-2" disabled={isLoading}>
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Forgot password
  if (pageState === 'forgot-password') {
    return (
      <div className="min-h-screen bg-gradient-to-b from-warning/5 to-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4"><WelileLogo linkToHome={false} /></div>
            <div className="mx-auto p-3 rounded-full bg-warning/10 w-fit mb-4"><KeyRound className="h-8 w-8 text-warning" /></div>
            <CardTitle className="text-2xl">Lost Your Password?</CardTitle>
            <CardDescription>We can generate a new password for you.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="p-3 rounded-lg bg-muted text-center">
              <p className="text-xs text-muted-foreground mb-1">Account for</p>
              <p className="font-medium text-sm">{inviteDetails?.full_name}</p>
            </div>
            <Button onClick={handleResetPassword} className="w-full h-12 gap-2" disabled={isLoading}>
              {isLoading ? <><Loader2 className="h-4 w-4 animate-spin" />Generating...</> : <><KeyRound className="h-4 w-4" />Generate New Password</>}
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => setPageState('ready')}>Back to Activation</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Password reset success
  if (pageState === 'password-reset') {
    return (
      <div className="min-h-screen bg-gradient-to-b from-success/5 to-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4"><WelileLogo linkToHome={false} /></div>
            <div className="mx-auto p-3 rounded-full bg-success/10 w-fit mb-4"><CheckCircle2 className="h-8 w-8 text-success" /></div>
            <CardTitle className="text-2xl">New Password Ready!</CardTitle>
            <CardDescription>Use this password to activate your account.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="p-4 rounded-xl bg-primary/5 border border-primary/20">
              <p className="text-xs text-muted-foreground mb-2 text-center">Your new password</p>
              <div className="flex items-center justify-center gap-2">
                <code className="text-2xl font-mono font-bold tracking-wider text-primary">{newTempPassword}</code>
                <Button variant="ghost" size="icon" onClick={handleCopyPassword} className="h-8 w-8">
                  <Copy className={`h-4 w-4 ${copied ? 'text-success' : ''}`} />
                </Button>
              </div>
            </div>
            {resetPhone && (
              <div className="space-y-1">
                <Button className="w-full h-12 gap-2" onClick={handleShareWhatsApp}>
                  <MessageCircle className="h-4 w-4" />Resend to WhatsApp
                </Button>
                <p className="text-[10px] text-center text-muted-foreground">Tap here if WhatsApp didn't open automatically</p>
              </div>
            )}
            <Button variant="outline" onClick={handleBackToActivation} className="w-full gap-2">
              <ArrowRight className="h-4 w-4" />Continue to Activate
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Review & Confirm (Step 3)
  if (pageState === 'review') {
    const locationLabel =
      locationStatus === 'granted' && locationData
        ? `${locationData.latitude.toFixed(4)}, ${locationData.longitude.toFixed(4)}`
        : 'Not shared';
    return (
      <div className="min-h-screen bg-gradient-to-b from-primary/5 to-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4"><WelileLogo linkToHome={false} /></div>
            <CardTitle className="text-2xl">Review &amp; Confirm</CardTitle>
            <CardDescription className="text-base">Check your details before activating</CardDescription>
          </CardHeader>
          <CardContent>
            {/* Step Progress Indicator */}
            <div className="flex items-center gap-2 mb-5">
              <div className="flex-1 flex flex-col items-center gap-1.5">
                <div className="h-2 w-full rounded-full bg-emerald-500" />
                <span className="text-xs font-semibold text-emerald-600">1. Activate</span>
              </div>
              <div className="flex-1 flex flex-col items-center gap-1.5">
                <div className="h-2 w-full rounded-full bg-emerald-500" />
                <span className="text-xs font-semibold text-emerald-600">2. Profile</span>
              </div>
              <div className="flex-1 flex flex-col items-center gap-1.5">
                <div className="h-2 w-full rounded-full bg-primary" />
                <span className="text-xs font-semibold text-primary">3. Confirm</span>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-muted/40 border border-border/40">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Full Name</p>
                  <p className="text-base font-semibold truncate">{fullName.trim()}</p>
                </div>
                <button type="button" onClick={() => setPageState('profile-setup')} className="text-sm text-primary font-medium shrink-0">Edit</button>
              </div>

              <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-muted/40 border border-border/40">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Email</p>
                  <p className="text-base font-semibold truncate">{email.trim() || 'Not provided'}</p>
                </div>
                <button type="button" onClick={() => setPageState('profile-setup')} className="text-sm text-primary font-medium shrink-0">Edit</button>
              </div>

              <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-muted/40 border border-border/40">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Password</p>
                  <p className="text-base font-semibold tracking-widest">{'•'.repeat(Math.min(newPassword.length, 10))}</p>
                </div>
                <button type="button" onClick={() => setPageState('profile-setup')} className="text-sm text-primary font-medium shrink-0">Edit</button>
              </div>

              <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-muted/40 border border-border/40">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Location</p>
                  <p className="text-base font-semibold truncate">{locationLabel}</p>
                </div>
                <button type="button" onClick={() => setPageState('profile-setup')} className="text-sm text-primary font-medium shrink-0">Edit</button>
              </div>
            </div>

            {/* Required Checklist */}
            <div className="mt-4 p-4 rounded-xl bg-primary/5 border border-primary/20 space-y-3">
              <p className="text-sm font-semibold text-primary">Confirm before activating</p>

              <label className="flex items-start gap-3 cursor-pointer">
                <div className="mt-0.5">
                  <input
                    type="checkbox"
                    checked={emailConfirmed}
                    onChange={(e) => setEmailConfirmed(e.target.checked)}
                    className="h-5 w-5 accent-primary shrink-0"
                  />
                </div>
                <span className="text-sm leading-5">
                  My email <span className="font-semibold">{email.trim() || 'and details'}</span> are correct
                </span>
              </label>

              <label className="flex items-start gap-3 cursor-pointer">
                <div className="mt-0.5">
                  <input
                    type="checkbox"
                    checked={locationConfirmed}
                    onChange={(e) => setLocationConfirmed(e.target.checked)}
                    className="h-5 w-5 accent-primary shrink-0"
                  />
                </div>
                <span className="text-sm leading-5">
                  My location is correct
                  {locationStatus === 'granted' && locationData ? (
                    <span className="block text-xs text-muted-foreground mt-0.5">
                      {locationData.latitude.toFixed(4)}, {locationData.longitude.toFixed(4)}
                    </span>
                  ) : (
                    <span className="block text-xs text-warning mt-0.5">Location not shared</span>
                  )}
                </span>
              </label>

              <label className="flex items-start gap-3 cursor-pointer">
                <div className="mt-0.5">
                  <input
                    type="checkbox"
                    checked={termsAccepted}
                    onChange={(e) => setTermsAccepted(e.target.checked)}
                    className="h-5 w-5 accent-primary shrink-0"
                  />
                </div>
                <span className="text-sm leading-5">
                  I agree to work as a <span className="font-semibold">Welile {inviteDetails?.role ? inviteDetails.role.charAt(0).toUpperCase() + inviteDetails.role.slice(1) : 'Agent'}</span>
                </span>
              </label>
            </div>

            <div className="sticky bottom-0 -mx-6 px-6 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] mt-4 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-t border-border/40 space-y-2">
              <Button onClick={(e) => handleActivate(e as any)} className="w-full h-14 text-base font-semibold" disabled={isLoading || !emailConfirmed || !locationConfirmed || !termsAccepted}>
                {isLoading ? (
                  <><Loader2 className="h-5 w-5 mr-2 animate-spin" />Activating...</>
                ) : (
                  <><CheckCircle2 className="h-5 w-5 mr-2" />Confirm &amp; Activate</>
                )}
              </Button>
              <button
                type="button"
                onClick={() => setPageState('profile-setup')}
                className="w-full text-sm text-muted-foreground hover:text-foreground text-center py-1"
                disabled={isLoading}
              >
                ← Back
              </button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Profile Setup (Step 2)
  if (pageState === 'profile-setup') {
    return (
      <div className="min-h-screen bg-gradient-to-b from-primary/5 to-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4"><WelileLogo linkToHome={false} /></div>
            <CardTitle className="text-2xl">Complete Your Profile</CardTitle>
            <CardDescription className="text-base">Enter your details to finish setting up your account</CardDescription>
          </CardHeader>
          <CardContent>
            {/* Step Progress Indicator */}
            <div className="flex items-center gap-2 mb-5">
              <div className="flex-1 flex flex-col items-center gap-1.5">
                <div className="h-2 w-full rounded-full bg-emerald-500" />
                <span className="text-xs font-semibold text-emerald-600">1. Activate</span>
              </div>
              <div className="flex-1 flex flex-col items-center gap-1.5">
                <div className="h-2 w-full rounded-full bg-primary" />
                <span className="text-xs font-semibold text-primary">2. Profile</span>
              </div>
              <div className="flex-1 flex flex-col items-center gap-1.5">
                <div className="h-2 w-full rounded-full bg-muted" />
                <span className="text-xs font-medium text-muted-foreground">3. Confirm</span>
              </div>
            </div>
            <form onSubmit={handleReview} className="space-y-4">
              <div className="space-y-2">
                <Label className="text-base font-semibold">👤 Full Name (as on your ID) *</Label>
                <PersonNameFields idPrefix="activate-supporter" value={nameParts} onChange={setNameParts} />
              </div>

              <div className="space-y-2">
                <Label htmlFor="userEmail" className="text-base font-semibold">✉️ Email (optional)</Label>
                <Input
                  id="userEmail"
                  type="email"
                  placeholder="your@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-14 text-base"
                  style={{ fontSize: '16px' }}
                  autoComplete="email"
                  inputMode="email"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="newPassword" className="text-base font-semibold">🔑 Set Your Password *</Label>
                <div className="relative">
                  <Input
                    id="newPassword"
                    type={showNewPassword ? 'text' : 'password'}
                    placeholder="Choose a strong password (6+ chars)"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    minLength={6}
                    className="h-14 text-base pr-12"
                    style={{ fontSize: '16px' }}
                    autoComplete="new-password"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0 h-full"
                    onClick={() => setShowNewPassword(!showNewPassword)}
                  >
                    {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">
                  This will be your login password
                </p>
              </div>

              {/* Location Status */}
              <div className={`p-3 rounded-xl border ${
                locationStatus === 'granted' ? 'bg-success/10 border-success/30' : 
                locationStatus === 'denied' ? 'bg-warning/10 border-warning/30' :
                'bg-muted/50 border-muted'
              }`}>
                <div className="flex items-center gap-3">
                  {locationStatus === 'requesting' ? (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin text-primary" />
                      <div>
                        <p className="text-sm font-medium">Requesting location access...</p>
                        <p className="text-xs text-muted-foreground">Please allow location sharing</p>
                      </div>
                    </>
                  ) : locationStatus === 'granted' ? (
                    <>
                      <Navigation className="h-5 w-5 text-success" />
                      <div>
                        <p className="text-sm font-medium text-success">📍 Location captured!</p>
                        <p className="text-xs text-muted-foreground">
                          {locationData?.latitude.toFixed(4)}, {locationData?.longitude.toFixed(4)}
                        </p>
                      </div>
                    </>
                  ) : locationStatus === 'denied' ? (
                    <>
                      <MapPin className="h-5 w-5 text-warning" />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-warning">Location not shared</p>
                        <p className="text-xs text-muted-foreground">Enable location in browser settings</p>
                      </div>
                      <Button type="button" variant="outline" size="sm" onClick={requestLocation} className="text-xs">
                        Retry
                      </Button>
                    </>
                  ) : (
                    <>
                      <MapPin className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-medium">Location sharing</p>
                        <p className="text-xs text-muted-foreground">We'll ask for your location</p>
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="sticky bottom-0 -mx-6 px-6 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-t border-border/40 space-y-2">
                <Button type="submit" className="w-full h-14 text-base font-semibold" disabled={!fullName.trim() || !newPassword.trim()}>
                  <ArrowRight className="h-5 w-5 mr-2" />
                  Review &amp; Confirm
                </Button>

                <button
                  type="button"
                  onClick={() => setPageState('ready')}
                  className="w-full text-sm text-muted-foreground hover:text-foreground text-center py-1"
                >
                  ← Back
                </button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Loading state - show spinner while validating token
  if (pageState === 'loading') {
    return (
      <div className="min-h-screen bg-gradient-to-b from-primary/5 to-background flex flex-col items-center justify-center p-4 gap-4">
        <WelileLogo linkToHome={false} />
        <ThreeBodyLoader size={32} />
        <p className="text-sm text-muted-foreground">Verifying your invitation...</p>
      </div>
    );
  }

  // Ready state - Step 1: Enter temp password
  return (
    <div className="min-h-screen bg-gradient-to-b from-primary/5 to-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4"><WelileLogo linkToHome={false} /></div>
          <CardTitle className="text-2xl">Activate Your Account</CardTitle>
          <CardDescription className="text-base">
            {isValidating ? (
              <span className="inline-block h-4 w-48 bg-muted/50 rounded animate-pulse" />
            ) : (
              <>Welcome! Enter the temporary password you received to continue.</>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Step Progress Indicator */}
          <div className="flex items-center gap-2 mb-5">
            <div className="flex-1 flex flex-col items-center gap-1.5">
              <div className="h-2 w-full rounded-full bg-primary" />
              <span className="text-xs font-semibold text-primary">1. Activate</span>
            </div>
            <div className="flex-1 flex flex-col items-center gap-1.5">
              <div className="h-2 w-full rounded-full bg-muted" />
              <span className="text-xs font-medium text-muted-foreground">2. Profile</span>
            </div>
          </div>
          <form onSubmit={handleVerifyPassword} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password" className="text-base font-semibold">🔑 Temporary Password</Label>
              <div className="relative">
                <Input
                  ref={passwordInputRef}
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  inputMode="text"
                  autoComplete="current-password"
                  placeholder="Enter the password you received"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={1}
                  className="h-14 text-base"
                  style={{ fontSize: '16px' }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">Use the password shared with you by the agent</p>
            </div>

            <div className="sticky bottom-0 -mx-6 px-6 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-t border-border/40">
              <Button type="submit" className="w-full h-14 text-base font-semibold" disabled={!password.trim()}>
                <ArrowRight className="h-5 w-5 mr-2" />
                Continue
              </Button>
            </div>

            <div className="text-center pt-1">
              <button type="button" onClick={() => setPageState('forgot-password')} className="text-sm text-primary hover:underline">
                Lost your password?
              </button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
