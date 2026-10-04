import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Lock, ShieldAlert, Store, User } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { cleanPhoneNumber } from '@/lib/phoneUtils';
import welileLogo from '@/assets/welile-contract-logo.png';

/** Where a verified Merchant Agent lands. */
export const MERCHANT_DASHBOARD_PATH = '/dashboard/agent';

/**
 * Only these destinations may be reached from the `redirect` query param.
 * Query params are never trusted: anything else falls back to the merchant
 * dashboard, and the merchant privilege itself is always re-read from the
 * database after authentication.
 */
const ALLOWED_REDIRECT_PREFIXES = ['/dashboard/agent', '/agent/', '/merchant-agent'];

export function sanitizeMerchantRedirect(raw: string | null): string {
  if (!raw) return MERCHANT_DASHBOARD_PATH;
  let value = raw.trim();
  // Reject anything that is not a same-origin absolute path.
  if (!value.startsWith('/') || value.startsWith('//')) return MERCHANT_DASHBOARD_PATH;
  // `/merchant` and `/merchant/login` mean "the merchant surface" — resolve
  // them to the dashboard so we never bounce back into the login screen.
  const [pathOnly] = value.split('?');
  if (pathOnly === '/merchant' || pathOnly === '/merchant/' || pathOnly === '/merchant/login') {
    return MERCHANT_DASHBOARD_PATH;
  }
  const allowed = ALLOWED_REDIRECT_PREFIXES.some(
    (p) => pathOnly === p || pathOnly.startsWith(p),
  );
  if (!allowed) return MERCHANT_DASHBOARD_PATH;
  return value;
}

/**
 * Merchant Login deep link — `/merchant/login?redirect=/dashboard/agent`
 * (also mounted at `/merchant`).
 *
 * Behaviour, by design:
 *  - Always renders the merchant login form. Never the welcome/landing page,
 *    never onboarding, never role selection.
 *  - Already authenticated → skip the form, verify merchant privileges in the
 *    database, and go straight to the merchant dashboard.
 *  - Authenticated but NOT a merchant → explicit "Merchant access not enabled"
 *    state. The dashboard is never rendered.
 *  - Expired session → the form is shown again; the intended destination is
 *    preserved in the URL and honoured after login.
 *
 * It reuses the existing Supabase auth (`useAuth().signIn`), the existing
 * session handling, and the existing merchant role source of truth
 * (`cashout_agents.is_active`, guarded by RLS so a user can only read their
 * own row). Route-level protection on the dashboard remains in force — this
 * page is a convenience entry point, not the security boundary.
 */
export default function MerchantLogin() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user, loading, signIn, signOut } = useAuth();

  const redirectTo = useMemo(() => sanitizeMerchantRedirect(params.get('redirect')), [params]);

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const verifiedRef = useRef(false);

  /** Authoritative, post-authentication merchant check (database, not URL). */
  const verifyMerchantAccess = useCallback(async (userId: string) => {
    const { data, error } = await supabase
      .from('cashout_agents')
      .select('id, is_active')
      .eq('agent_id', userId)
      .eq('is_active', true)
      .maybeSingle();
    if (error) return false;
    return !!data;
  }, []);

  // Already authenticated (or just signed in): verify then route.
  useEffect(() => {
    if (loading || !user?.id || verifiedRef.current) return;
    verifiedRef.current = true;
    setChecking(true);
    (async () => {
      const ok = await verifyMerchantAccess(user.id);
      setChecking(false);
      if (ok) {
        navigate(redirectTo, { replace: true });
      } else {
        setAccessDenied(true);
      }
    })();
  }, [user?.id, loading, redirectTo, navigate, verifyMerchantAccess]);

  // Session lost/expired while on this page → back to the form.
  useEffect(() => {
    if (!loading && !user?.id) {
      verifiedRef.current = false;
      setAccessDenied(false);
    }
  }, [loading, user?.id]);

  /** Merchant agents sign in with phone or email — resolve to the auth email. */
  const resolveEmails = async (input: string): Promise<string[]> => {
    const value = input.trim();
    if (value.includes('@')) return [value.toLowerCase()];
    const last9 = cleanPhoneNumber(value).replace(/\D/g, '').slice(-9);
    if (last9.length < 9) return [];
    const candidates: string[] = [];
    try {
      const { data } = await supabase.rpc('get_email_by_phone', {
        phone_variants: [`0${last9}`, `256${last9}`, last9],
      });
      for (const row of (data ?? []) as { email: string }[]) {
        if (row?.email) candidates.push(row.email.toLowerCase());
      }
    } catch {
      /* fall through to the deterministic merchant auth email */
    }
    const synthetic = `${last9}@welile.agent`;
    if (!candidates.includes(synthetic)) candidates.push(synthetic);
    return candidates;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier.trim() || !password) {
      toast.error('Enter your phone or email and your password.');
      return;
    }
    setSubmitting(true);
    try {
      const emails = await resolveEmails(identifier);
      if (emails.length === 0) {
        toast.error('Enter a valid phone number or email address.');
        return;
      }
      let lastError: string | null = null;
      for (const email of emails) {
        const { error } = await signIn(email, password);
        if (!error) {
          verifiedRef.current = false; // let the effect run the DB check
          return;
        }
        lastError = error.message;
      }
      toast.error(lastError || 'Could not sign you in. Check your details and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const busy = loading || checking;

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Helmet>
        <title>Merchant Login | Welile</title>
        <meta
          name="description"
          content="Sign in to the Welile Merchant Agent portal to process payouts and view your merchant dashboard."
        />
        <meta name="robots" content="noindex" />
      </Helmet>

      <Card className="w-full max-w-sm p-6 rounded-3xl space-y-5">
        <div className="text-center space-y-2">
          <img src={welileLogo} alt="Welile" className="h-10 mx-auto" />
          <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary">
            <Store className="h-3.5 w-3.5" /> Merchant Agent portal
          </div>
          <h1 className="text-xl font-bold">Merchant login</h1>
          <p className="text-xs text-muted-foreground">
            Sign in with the phone number or email registered for your merchant account.
          </p>
        </div>

        {busy ? (
          <div className="py-10 flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="text-sm">Checking your merchant access…</p>
          </div>
        ) : accessDenied ? (
          <div className="space-y-4 text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
              <ShieldAlert className="h-6 w-6 text-destructive" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-bold">Merchant access not enabled</p>
              <p className="text-xs text-muted-foreground">
                This account is signed in, but it is not an active Welile Merchant Agent. Ask the
                Welile team to enable merchant access, then open this link again.
              </p>
            </div>
            <Button
              variant="outline"
              className="w-full h-11 rounded-xl"
              onClick={async () => {
                await signOut();
                verifiedRef.current = false;
                setAccessDenied(false);
              }}
            >
              Sign in with a different account
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Phone or email</Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-9 h-11 rounded-xl"
                  placeholder="0700 000 000"
                  autoComplete="username"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-9 h-11 rounded-xl"
                  type="password"
                  placeholder="••••••••"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </div>
            <Button type="submit" disabled={submitting} className="w-full h-11 rounded-xl font-bold">
              {submitting ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
              Sign in to merchant dashboard
            </Button>
            <button
              type="button"
              className="w-full text-xs text-muted-foreground underline"
              onClick={() => navigate('/auth?forgot=1')}
            >
              Forgot your password?
            </button>
          </form>
        )}
      </Card>
    </div>
  );
}