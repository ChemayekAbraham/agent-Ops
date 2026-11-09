import { getSessionCheckedUser } from '@/lib/authenticatedRequests';
import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { joinPersonName, splitPersonName, type PersonNameParts } from '@/lib/authValidation';
import { Card, CardContent } from '@/components/ui/card';
import { Shield, TrendingUp, Loader2, CheckCircle, ArrowRight } from 'lucide-react';
import ScreenLoader from '@/components/common/ScreenLoader';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';
import { roleToSlug } from '@/lib/roleRoutes';
import { getSignupDeviceFp } from '@/lib/signupGuard';
import { formatRatePct } from '@/lib/partnerReturnPolicy';
import {
  activationErrorFrom,
  noteReturnFigures,
  parseActivationResult,
  type ActivationError,
  type ActivationResult,
} from '@/lib/promissoryNoteActivation';

export default function ActivatePartner() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');

  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<any>(null);
  const [error, setError] = useState('');

  // Auth state
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Captured in parts; `full_name` stays one concatenated string.
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const fullName = joinPersonName(nameParts);
  const [phone, setPhone] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [activated, setActivated] = useState(false);
  // What activate-promissory-note answered (rate fields null when absent), and why it refused.
  const [activation, setActivation] = useState<ActivationResult | null>(null);
  const [activationError, setActivationError] = useState<ActivationError | null>(null);

  // Rates come only from the database answers; null = hidden (a person-stamped note that is not
  // the viewer's, or an older lookup without rate fields). Never a fallback rate (design v2 §3.4.3).
  const { rate: noteRate, monthlyReturn: noteMonthlyReturn } = noteReturnFigures(note);
  const noteRatePct = formatRatePct(noteRate);
  const yourRate = activation?.yourRate ?? null;
  const yourRatePct = formatRatePct(yourRate);

  // Lookup by token through the edge function (the caller's session, when there is one, lets the
  // database show the rate of a note linked to them). `initial` also decides the signed-in state.
  const fetchNote = useCallback(async (initial: boolean) => {
    if (!token) return;
    const { data, error: fetchError } = await supabase.functions.invoke('lookup-promissory-note', {
      body: { token },
    });

    if (fetchError || !data?.note) {
      if (initial) {
        setError('This activation link is invalid or has expired');
        setLoading(false);
      }
      return;
    }

    setNote(data.note);
    if (!initial) return;
    // The lookup returns only masked contact hints (shown as placeholders), so the
    // partner types their own phone and email.
    setNameParts(splitPersonName(data.note.partner_name || ''));

    // Check if user is already logged in
    const { data: { user } } = await getSessionCheckedUser();
    if (user) {
      setIsLoggedIn(true);
    }
    setLoading(false);
  }, [token]);

  useEffect(() => {
    if (!token) {
      setError('Invalid activation link');
      setLoading(false);
      return;
    }
    fetchNote(true);
  }, [token, fetchNote]);

  const handleAuth = async () => {
    setAuthLoading(true);
    try {
      if (authMode === 'signup') {
        if (!fullName.trim() || !phone.trim() || !email.trim() || !password) {
          toast.error('Please fill in all fields');
          setAuthLoading(false);
          return;
        }
        const { error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: {
              full_name: fullName.trim(),
              phone: phone.trim(),
              // Per-device signup caps are enforced from this in handle_new_user.
              device_fp: await getSignupDeviceFp(),
            },
          },
        });
        if (signUpError) throw signUpError;
        toast.success('Account created! Check your email to verify.');
        setIsLoggedIn(true);
      } else {
        const { error: loginError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (loginError) throw loginError;
        setIsLoggedIn(true);
      }
      // Signed in now (a sign-up that waits for email confirmation has no session yet): look the
      // note up again, so a note already linked to this account shows its own rate.
      const { data: { session } } = await supabase.auth.getSession();
      if (session) await fetchNote(false);
    } catch (err: any) {
      toast.error(err.message || 'Authentication failed');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleActivate = async () => {
    setAuthLoading(true);
    setActivationError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        const e = activationErrorFrom(401, null);
        setActivationError(e);
        setIsLoggedIn(false);
        toast.error(e.message);
        return;
      }

      // The function links the note to the signed-in account from the session token. `user_id` is
      // ignored by the new function and still read by the old one until both are live (design v2 §8.6).
      const { data, error: activateError } = await supabase.functions.invoke('activate-promissory-note', {
        body: { token, user_id: session.user.id },
      });

      if (activateError) {
        const ctx = (activateError as any).context;
        const status = typeof ctx?.status === 'number' ? ctx.status : null;
        let body: unknown = null;
        try { body = await ctx?.json?.(); } catch { /* no JSON body */ }
        const e = activationErrorFrom(status, body);
        setActivationError(e);
        if (e.kind === 'sign_in') setIsLoggedIn(false);
        if (e.kind === 'changed') void fetchNote(false);
        toast.error(e.message);
        return;
      }
      setActivation(parseActivationResult(data));
      setActivated(true);
      toast.success('Your support account is now active!');
      // Land them on the supporter dashboard immediately — all 4 public roles
      // are now granted, so RoleSwitcher will let them access the others too.
      setTimeout(() => navigate('/dashboard/funder'), 1200);
    } catch (err: any) {
      const e = activationErrorFrom(null, null);
      setActivationError(e);
      toast.error(e.message);
    } finally {
      setAuthLoading(false);
    }
  };

  if (loading) {
    return (
      <ScreenLoader className="bg-gradient-to-b from-primary/10 to-background" />
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-primary/10 to-background p-4">
        <Card className="max-w-md w-full">
          <CardContent className="p-6 text-center space-y-4">
            <Shield className="h-12 w-12 text-destructive mx-auto" />
            <h2 className="text-lg font-bold">Invalid Link</h2>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button onClick={() => navigate('/')} variant="outline">Go Home</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-primary/10 to-background p-4">
      <div className="max-w-md mx-auto space-y-4 pt-8">
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold text-primary">WELILE</h1>
          <p className="text-xs text-muted-foreground">TECHNOLOGIES LIMITED</p>
        </div>

        {/* Note Details */}
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="p-5 space-y-3">
            <h2 className="text-base font-bold text-center">Support Promissory Note</h2>

            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Partner</span>
                <span className="font-medium">{note.partner_name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Amount</span>
                <span className="font-bold text-primary">{formatUGX(Number(note.amount))}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Type</span>
                <span className="font-medium">{note.contribution_type === 'monthly' ? `Monthly (Day ${note.deduction_day})` : 'Once-off'}</span>
              </div>
            </div>

            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-center">
              <TrendingUp className="h-5 w-5 text-emerald-600 mx-auto mb-1" />
              {noteRatePct ? (
                <>
                  <p className="text-xs font-medium text-emerald-700">
                    Earn <span className="text-base font-bold">{noteRatePct}</span> monthly Returns on your support
                  </p>
                  {noteMonthlyReturn != null && (
                    <p className="text-xs text-emerald-600 mt-1">
                      Expected: {formatUGX(noteMonthlyReturn)}/month
                    </p>
                  )}
                </>
              ) : (
                <p className="text-xs font-medium text-emerald-700">Sign in to see your Returns rate</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Activated state */}
        {activated ? (
          <Card className="border-emerald-200 bg-emerald-50">
            <CardContent className="p-5 text-center space-y-3">
              <CheckCircle className="h-12 w-12 text-emerald-600 mx-auto" />
              <h2 className="text-lg font-bold text-emerald-700">Account Activated!</h2>
              <p className="text-sm text-emerald-600">
                Deposit {formatUGX(Number(note.amount))} into your wallet to start earning monthly Returns.
              </p>
              {yourRatePct && (
                <p className="text-xs text-emerald-600">A deposit opens at {yourRatePct} monthly Returns for you.</p>
              )}
              <Button onClick={() => navigate('/dashboard/funder')} className="w-full gap-2">
                Go to Dashboard <ArrowRight className="h-4 w-4" />
              </Button>
            </CardContent>
          </Card>
        ) : isLoggedIn ? (
          <Card>
            <CardContent className="p-5 space-y-3">
              <h3 className="font-bold text-center">Activate Your Support</h3>
              <p className="text-sm text-muted-foreground text-center">
                Tap below to link this promissory note to your account and enable auto-deduction.
              </p>
              <Button onClick={handleActivate} disabled={authLoading} className="w-full h-12 gap-2">
                {authLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
                Activate Support
              </Button>
              {activationError && activationError.kind !== 'sign_in' && (
                <p role="alert" className="text-sm text-destructive text-center">{activationError.message}</p>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-5 space-y-3">
              <div className="flex gap-2 mb-2">
                <Button variant={authMode === 'signup' ? 'default' : 'outline'} onClick={() => setAuthMode('signup')} className="flex-1 text-xs h-9">
                  New Account
                </Button>
                <Button variant={authMode === 'login' ? 'default' : 'outline'} onClick={() => setAuthMode('login')} className="flex-1 text-xs h-9">
                  I Have an Account
                </Button>
              </div>

              {authMode === 'signup' && (
                <>
                  <div>
                    <Label>Full Name</Label>
                    <div className="mt-1">
                      <PersonNameFields idPrefix="activate-partner" value={nameParts} onChange={setNameParts} />
                    </div>
                  </div>
                  <div>
                    <Label>Phone Number</Label>
                    <Input value={phone} onChange={e => setPhone(e.target.value)} type="tel" className="mt-1" placeholder={note?.whatsapp_hint || undefined} />
                  </div>
                </>
              )}
              <div>
                <Label>Email</Label>
                <Input value={email} onChange={e => setEmail(e.target.value)} type="email" className="mt-1" placeholder={note?.email_hint || undefined} />
              </div>
              <div>
                <Label>Password</Label>
                <Input value={password} onChange={e => setPassword(e.target.value)} type="password" className="mt-1" placeholder={authMode === 'signup' ? 'Create a password' : 'Enter password'} />
              </div>

              <Button onClick={handleAuth} disabled={authLoading} className="w-full h-12 gap-2">
                {authLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                {authMode === 'signup' ? 'Create Account' : 'Sign In'}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
