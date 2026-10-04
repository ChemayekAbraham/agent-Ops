import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { usePhoneDuplicateCheck } from '@/hooks/usePhoneDuplicateCheck';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { UserPlus, LogIn, ArrowLeft, Lock, User, Phone, TrendingUp, Wallet, Users, Sparkles, Gift, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import WelileLogo from '@/components/WelileLogo';
import { CurrencySwitcher } from '@/components/CurrencySwitcher';

import {
  validateFullName,
  joinPersonName,
  validatePersonNameParts,
  type PersonNameParts,
} from '@/lib/authValidation';
import PersonNameFields from '@/components/shared/PersonNameFields';

// Simplified validation - check inline for faster response
const validateSignUp = (data: { password: string; fullName: string; phone: string }) => {
  if (data.password.length < 6) return 'Password must be at least 6 characters';
  const nameCheck = validateFullName(data.fullName);
  if (!nameCheck.valid) return nameCheck.error;
  if (data.phone.replace(/\D/g, '').length < 10) return 'Please enter a valid phone number';
  return null;
};

const validateSignIn = (data: { phone: string; password: string }) => {
  if (data.phone.replace(/\D/g, '').length < 9) return 'Please enter a valid phone number';
  if (!data.password) return 'Password is required';
  return null;
};

const benefits = [
  { icon: TrendingUp, title: '15% Monthly Returns', description: 'Earn interest on your investments' },
  { icon: Wallet, title: 'Flexible Withdrawals', description: 'Access your funds anytime' },
  { icon: Users, title: 'Help Tenants', description: 'Support people with rent payments' },
];

export default function BecomeSupporter() {
  const [searchParams] = useSearchParams();
  const referrerId = searchParams.get('ref');
  
  // Store referrer ID in state as fallback for iOS (localStorage can be unreliable on iOS Safari)
  const [referrerIdState, setReferrerIdState] = useState<string | null>(() => {
    // Initialize from URL param or localStorage
    if (referrerId) return referrerId;
    try {
      return localStorage.getItem('supporter_referrer_id');
    } catch {
      return null;
    }
  });
  
  const [isSignUp, setIsSignUp] = useState(true);
  const [password, setPassword] = useState('');
  // Captured in parts; the signup payload keeps one concatenated string.
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const fullName = joinPersonName(nameParts);
  const [phone, setPhone] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [referrerName, setReferrerName] = useState<string | null>(null);
  
  const { signUpWithoutRole, signIn, user, roles, addRole, role } = useAuth();
  const { isDuplicate, isChecking: isCheckingDuplicate, duplicateMessage } = usePhoneDuplicateCheck(phone, 400);
  const navigate = useNavigate();
  const { toast } = useToast();

  // Store referrer ID and fetch referrer name
  useEffect(() => {
    if (referrerId) {
      localStorage.setItem('supporter_referrer_id', referrerId);
      setReferrerIdState(referrerId);
      // Fetch referrer name
      supabase
        .from('profiles')
        .select('full_name')
        .eq('id', referrerId)
        .single()
        .then(({ data }) => {
          if (data) {
            setReferrerName(data.full_name);
          }
        });
    }
  }, [referrerId]);

  useEffect(() => {
    // If user is already logged in
    if (user) {
      if (roles.includes('supporter')) {
        // Already a supporter, go to dashboard
        navigate(roleToSlug(role));
      } else {
        // User exists but not a supporter, add the role
        handleAddSupporterRole();
      }
    }
  }, [user, roles]);

  const handleAddSupporterRole = async () => {
    const { error } = await addRole('supporter');
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      // Create referral records if there's a referrer
      // Use state-based referrer first (more reliable on iOS), fallback to localStorage
      const storedReferrerId = referrerIdState || localStorage.getItem('supporter_referrer_id');
      console.log('[BecomeSupporter] Processing referral with referrer:', storedReferrerId);
      
      if (storedReferrerId && user && storedReferrerId !== user.id) {
        // Create supporter-specific referral
        await supabase.from('supporter_referrals').insert({
          referrer_id: storedReferrerId,
          referred_id: user.id,
          bonus_amount: 500,
        });
        
        // Create general referral record and credit bonus (500 UGX standard)
        await supabase.from('referrals').insert({
          referrer_id: storedReferrerId,
          referred_id: user.id,
          bonus_amount: 500,
          credited: true,
          credited_at: new Date().toISOString(),
        });

        // Referral bonus is handled server-side via the referral record
        // The credit_referral_bonus trigger/function processes the 500 UGX credit via ledger

        // Notification removed - table dropped

        localStorage.removeItem('supporter_referrer_id');
        setReferrerIdState(null);
      }
      
      toast({ 
        title: '🎉 Welcome, Supporter!', 
        description: 'You are now a Tenant Supporter. Start investing today!' 
      });
      navigate(roleToSlug(role));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      if (isSignUp) {
        // Check for duplicate phone before attempting signup
        if (isDuplicate) {
          toast({ title: 'Phone Already Registered', description: duplicateMessage || 'This phone number is already in use.', variant: 'destructive' });
          setIsLoading(false);
          return;
        }

        const partsCheck = validatePersonNameParts(nameParts);
        if (!partsCheck.valid) {
          toast({ title: 'Error', description: partsCheck.error || 'Enter first and last name', variant: 'destructive' });
          setIsLoading(false);
          return;
        }
        const nameCheck = validateFullName(fullName);
        const trimmedFullName = nameCheck.trimmed;
        const validationError = validateSignUp({ password, fullName: trimmedFullName, phone });
        if (validationError) {
          toast({ title: 'Error', description: validationError, variant: 'destructive' });
          setIsLoading(false);
          return;
        }

        // Generate email from phone number
        const cleanPhone = phone.replace(/\D/g, '');
        const generatedEmail = `${cleanPhone}@welile.user`;

        // Store that this user should become a supporter
        localStorage.setItem('pending_supporter_signup', 'true');

        // Get referrer ID from localStorage (set when they arrived via referral link)
        // Use state-based referrer first (more reliable on iOS), fallback to localStorage
        const storedReferrerId = referrerIdState || localStorage.getItem('supporter_referrer_id');
        console.log('[BecomeSupporter] Signup with referrer:', storedReferrerId, '(state:', referrerIdState, ')');
        
        const { error } = await signUpWithoutRole(generatedEmail, password, trimmedFullName, phone, storedReferrerId || undefined);
        // DON'T clear referrer here - handleAddSupporterRole needs it after the user session activates
        // It will be cleared in handleAddSupporterRole after the referral records are created
        if (error) {
          let errorMessage = error.message;
          if (error.message.includes('already registered')) {
            errorMessage = 'This phone number is already registered. Please sign in instead.';
          }
          toast({ title: 'Sign Up Failed', description: errorMessage, variant: 'destructive' });
          localStorage.removeItem('pending_supporter_signup');
        } else {
          toast({ title: 'Account Created!', description: 'Welcome to Welile as a Supporter!' });
        }
      } else {
        const validationError = validateSignIn({ phone, password });
        if (validationError) {
          toast({ title: 'Error', description: validationError, variant: 'destructive' });
          setIsLoading(false);
          return;
        }

        // Try multiple phone format variants to find the user
        const cleanPhone = phone.replace(/\D/g, '');
        const emailVariants = [
          `${cleanPhone}@welile.user`,
          `${cleanPhone}@welile.agent`,
          cleanPhone.startsWith('256') ? `${cleanPhone.slice(3)}@welile.user` : `256${cleanPhone}@welile.user`,
          cleanPhone.startsWith('256') ? `${cleanPhone.slice(3)}@welile.agent` : null,
        ].filter(Boolean) as string[];

        let loginSuccess = false;
        let lastError: Error | null = null;

        for (const emailVariant of emailVariants) {
          const { error } = await signIn(emailVariant, password);
          if (!error) {
            loginSuccess = true;
            break;
          }
          lastError = error;
          if (!error.message.includes('Invalid login credentials')) {
            break;
          }
        }

        if (!loginSuccess && lastError) {
          let errorMessage = lastError.message;
          if (lastError.message.includes('Invalid login credentials')) {
            errorMessage = 'Invalid phone number or password. Please try again.';
          }
          toast({ title: 'Sign In Failed', description: errorMessage, variant: 'destructive' });
        }
        // After sign in, the useEffect will handle adding supporter role
      }
    } catch {
      toast({ title: 'Error', description: 'An unexpected error occurred', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  // Check for pending supporter signup after auth
  useEffect(() => {
    if (user && localStorage.getItem('pending_supporter_signup')) {
      localStorage.removeItem('pending_supporter_signup');
      handleAddSupporterRole();
    }
  }, [user]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-primary/5">
      <Helmet>
        <title>Become a Supporter — Earn Returns | Welile</title>
        <meta
          name="description"
          content="Become a Welile Supporter: fund tenants' rent, earn monthly returns on your capital, and withdraw flexibly while helping people stay housed in Uganda."
        />
        <link rel="canonical" href="https://welileapp.com/become-supporter" />
        <meta property="og:title" content="Become a Welile Supporter — Earn Returns" />
        <meta
          property="og:description"
          content="Fund tenants' rent and earn monthly returns while helping people stay housed across Uganda."
        />
        <meta property="og:url" content="https://welileapp.com/become-supporter" />
      </Helmet>
      {/* Background decoration */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 -left-20 w-72 h-72 bg-success/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 -right-20 w-96 h-96 bg-primary/5 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-gradient-to-r from-success/5 to-primary/5 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 container mx-auto px-4 py-8">
        <Link 
          to="/" 
          className="inline-flex items-center gap-2 text-muted-foreground hover:text-primary mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back to Home</span>
        </Link>

        <div className="max-w-4xl mx-auto">
          {/* Hero Section */}
          <div className="text-center mb-8 animate-fadeIn">
            <div className="flex items-center justify-center mb-4">
              <WelileLogo linkToHome={false} />
            </div>
            
            {/* Currency Selector */}
            <div className="flex items-center justify-center mb-4">
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-card/50 border border-border/50">
                <span className="text-xs text-muted-foreground">Currency:</span>
                <CurrencySwitcher variant="compact" />
              </div>
            </div>
            
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-success/10 border border-success/20 mb-4">
              <Sparkles className="h-4 w-4 text-success" />
              <span className="text-sm font-medium text-success">Become a Tenant Supporter</span>
            </div>
            <h1 className="text-3xl sm:text-4xl font-black mb-3">
              Invest & Earn <span className="text-success">15% Monthly</span>
            </h1>
            <p className="text-muted-foreground max-w-md mx-auto">
              Help tenants pay their rent while growing your investment portfolio with guaranteed returns
            </p>
          </div>

          {/* Referral Badge */}
          {referrerName && (
            <div className="mb-6 animate-fadeIn">
              <div className="max-w-md mx-auto p-4 rounded-xl bg-gradient-to-r from-primary/10 to-violet-500/10 border border-primary/20">
                <div className="flex items-center justify-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/20">
                    <Gift className="h-5 w-5 text-primary" />
                  </div>
                  <div className="text-center">
                    <p className="text-sm text-muted-foreground">Invited by</p>
                    <p className="font-bold text-primary">{referrerName}</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-2 text-center">
                  Your friend will earn a bonus when you make your first investment!
                </p>
              </div>
            </div>
          )}

          <div className="grid lg:grid-cols-2 gap-8 items-start">
            {/* Benefits Section */}
            <div className="space-y-4 animate-fadeIn">
              <h2 className="text-xl font-bold mb-4">Why Become a Supporter?</h2>
              
              {benefits.map((benefit) => (
                <div
                  key={benefit.title}
                  className="flex items-start gap-4 p-4 rounded-xl bg-card border shadow-sm"
                >
                  <div className="p-3 rounded-xl bg-success/10">
                    <benefit.icon className="h-6 w-6 text-success" />
                  </div>
                  <div>
                    <h3 className="font-bold">{benefit.title}</h3>
                    <p className="text-sm text-muted-foreground">{benefit.description}</p>
                  </div>
                </div>
              ))}

              {/* Referral Bonus Info */}
              <div className="p-4 rounded-xl bg-gradient-to-r from-primary/5 to-violet-500/5 border border-primary/20">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-primary/20">
                    <Gift className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-bold text-sm">Referral Rewards</h3>
                    <p className="text-xs text-muted-foreground">
                      Invite friends and earn <span className="font-bold text-primary">5,000 UGX</span> when they make their first investment!
                    </p>
                  </div>
                </div>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-3 gap-3 mt-6">
                <div className="p-4 rounded-xl bg-success/5 border border-success/20 text-center">
                  <p className="text-2xl font-black text-success">15%</p>
                  <p className="text-xs text-muted-foreground">Monthly ROI</p>
                </div>
                <div className="p-4 rounded-xl bg-primary/5 border border-primary/20 text-center">
                  <p className="text-2xl font-black text-primary">24/7</p>
                  <p className="text-xs text-muted-foreground">Access</p>
                </div>
                <div className="p-4 rounded-xl bg-warning/5 border border-warning/20 text-center">
                  <p className="text-2xl font-black text-warning">100%</p>
                  <p className="text-xs text-muted-foreground">Secure</p>
                </div>
              </div>
            </div>

            {/* Sign Up Form */}
            <div className="animate-fadeIn">
              <Card className="border-success/20 shadow-xl shadow-success/5">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <div className="p-2 rounded-lg bg-success/10">
                      {isSignUp ? <UserPlus className="h-5 w-5 text-success" /> : <LogIn className="h-5 w-5 text-success" />}
                    </div>
                    {isSignUp ? 'Create Supporter Account' : 'Sign In as Supporter'}
                  </CardTitle>
                  <CardDescription>
                    {isSignUp 
                      ? 'Join as a Tenant Supporter and start earning today' 
                      : 'Sign in to access your supporter dashboard'}
                  </CardDescription>
                </CardHeader>
                
                <CardContent>
                  <form onSubmit={handleSubmit} className="space-y-4">
                    {isSignUp && (
                      <div className="space-y-2">
                        <Label className="flex items-center gap-2">
                          <User className="h-4 w-4 text-muted-foreground" /> Full Name
                        </Label>
                        <PersonNameFields idPrefix="become-supporter" value={nameParts} onChange={setNameParts} />
                      </div>
                    )}

                    <div className="space-y-2">
                      <Label htmlFor="phone">Phone Number</Label>
                      <div className="relative">
                        <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          id="phone"
                          type="tel"
                          inputMode="tel"
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                          placeholder="e.g., 0700123456"
                          className={`pl-10 h-12 text-base ${isDuplicate ? 'border-destructive' : ''}`}
                          style={{ fontSize: '16px' }}
                          required
                        />
                      </div>
                      {/* Duplicate phone warning */}
                      {isSignUp && isDuplicate && (
                        <div className="flex items-center gap-2 p-2 rounded-lg bg-destructive/10 border border-destructive/20">
                          <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0" />
                          <p className="text-xs text-destructive">{duplicateMessage}</p>
                        </div>
                      )}
                      {isSignUp && isCheckingDuplicate && (
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Checking availability...
                        </p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="password">Password</Label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          id="password"
                          type="password"
                          autoComplete={isSignUp ? "new-password" : "current-password"}
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="••••••••"
                          className="pl-10 h-12 text-base"
                          style={{ fontSize: '16px' }}
                          required
                        />
                      </div>
                    </div>

                    <Button 
                      type="submit" 
                      className="w-full gap-2 h-12 bg-success hover:bg-success/90 text-white font-bold" 
                      disabled={isLoading || (isSignUp && (isDuplicate || isCheckingDuplicate))}
                    >
                      {isLoading ? (
                        <Loader2 className="h-5 w-5 animate-spin" />
                      ) : (
                        <>
                          <CheckCircle2 className="h-5 w-5" />
                          {isSignUp ? 'Become a Supporter' : 'Sign In & Continue'}
                        </>
                      )}
                    </Button>
                  </form>

                  <div className="mt-6 text-center text-sm">
                    {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
                    <button
                      type="button"
                      onClick={() => setIsSignUp(!isSignUp)}
                      className="text-success hover:text-success/80 font-medium transition-colors"
                    >
                      {isSignUp ? 'Sign In' : 'Sign Up'}
                    </button>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
