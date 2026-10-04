import { useState, useEffect } from 'react';
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

  useEffect(() => {
    if (!token) {
      setError('Invalid activation link');
      setLoading(false);
      return;
    }

    const fetchNote = async () => {
      // Use edge function to look up by token (bypasses RLS)
      const { data, error: fetchError } = await supabase.functions.invoke('lookup-promissory-note', {
        body: { token },
      });

      if (fetchError || !data?.note) {
        setError('This activation link is invalid or has expired');
        setLoading(false);
        return;
      }

      setNote(data.note);
      if (data.note.email) setEmail(data.note.email);
      setNameParts(splitPersonName(data.note.partner_name || ''));
      setPhone(data.note.whatsapp_number);

      // Check if user is already logged in
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        setIsLoggedIn(true);
      }
      setLoading(false);
    };
    fetchNote();
  }, [token]);

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
    } catch (err: any) {
      toast.error(err.message || 'Authentication failed');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleActivate = async () => {
    setAuthLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error: activateError } = await supabase.functions.invoke('activate-promissory-note', {
        body: { token, user_id: user.id },
      });

      if (activateError) {
        let msg = activateError.message;
        try { const b = await (activateError as any).context?.json?.(); if (b?.error) msg = b.error; } catch { /* keep default */ }
        throw new Error(msg);
      }
      setActivated(true);
      toast.success('Your support account is now active!');
      // Land them on the supporter dashboard immediately — all 4 public roles
      // are now granted, so RoleSwitcher will let them access the others too.
      setTimeout(() => navigate('/dashboard/funder'), 1200);
    } catch (err: any) {
      toast.error(err.message || 'Activation failed');
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
              <p className="text-xs font-medium text-emerald-700">
                Earn <span className="text-base font-bold">15%</span> monthly returns on your support
              </p>
              <p className="text-xs text-emerald-600 mt-1">
                Expected: {formatUGX(Number(note.amount) * 0.15)}/month
              </p>
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
                Deposit {formatUGX(Number(note.amount))} into your wallet to start earning 15% monthly returns.
              </p>
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
                    <Input value={phone} onChange={e => setPhone(e.target.value)} type="tel" className="mt-1" />
                  </div>
                </>
              )}
              <div>
                <Label>Email</Label>
                <Input value={email} onChange={e => setEmail(e.target.value)} type="email" className="mt-1" />
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
