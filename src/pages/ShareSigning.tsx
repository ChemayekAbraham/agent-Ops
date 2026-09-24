import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SignaturePad } from '@/components/shared/SignaturePad';
import ScreenLoader from '@/components/common/ScreenLoader';
import { CheckCircle2, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import ShareAgreementPreview from '@/components/executive/shares/ShareAgreementPreview';
import { fmtShareDate } from '@/components/executive/shares/shareAgreementTemplate';

type State = 'loading' | 'auth_required' | 'invalid' | 'wrong_account' | 'expired' | 'ready' | 'done';

interface Snapshot {
  reference_id: string; amount: number; shares: number; company_ownership_percent: number;
  prefill_name: string | null; prefill_phone: string | null; prefill_email: string | null;
}

export default function ShareSigning() {
  const { requestId } = useParams();
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [state, setState] = useState<State>('loading');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [name, setName] = useState('');
  const [sig, setSig] = useState('');
  const [busy, setBusy] = useState(false);
  const today = fmtShareDate(new Date());

  useEffect(() => {
    if (authLoading) return;
    if (!user) { setState('auth_required'); return; }
    (async () => {
      const { data, error } = await supabase.rpc('share_onboarding_get' as any, { p_id: requestId, p_token: token });
      if (error) { setState('invalid'); return; }
      const d = data as any;
      setState(d.state);
      if (d.state === 'ready' || d.state === 'done') {
        setSnap(d);
        setName(d.shareholder_name || d.prefill_name || '');
      }
    })();
  }, [authLoading, user, requestId, token]);

  const preview = useMemo(() => snap && ({
    participantName: name, participantSignature: sig || null, participantDate: sig ? today : '',
    referenceId: snap.reference_id, amount: Number(snap.amount), shares: Number(snap.shares),
    companyOwnershipPercent: Number(snap.company_ownership_percent),
  }), [snap, name, sig, today]);

  const submit = async () => {
    setBusy(true);
    const { error } = await supabase.rpc('share_onboarding_submit' as any, {
      p_id: requestId, p_token: token, p_name: name.trim(), p_signature: sig,
    });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    setState('done');
  };

  if (state === 'loading' || authLoading) return <ScreenLoader />;
  const redirect = `${window.location.pathname}${window.location.search}`;
  const notices: Partial<Record<State, [JSX.Element, string, string, { label: string; to: string }?]>> = {
    auth_required: [<ShieldCheck className="h-8 w-8 text-primary" />, 'Sign in to sign your agreement',
      'For your security, sign in with the account these shares were created for. New here? Use "Forgot password" with your email to set a password.',
      { label: 'Sign in', to: `/auth?redirect=${encodeURIComponent(redirect)}` }],
    wrong_account: [<ShieldAlert className="h-8 w-8 text-destructive" />, 'These shares belong to another account',
      'Sign out and sign back in with the account the email was sent to.', { label: 'Back to sign in', to: '/auth' }],
    invalid: [<ShieldAlert className="h-8 w-8 text-destructive" />, 'This link is no longer valid', 'Please contact partnership@welile.com for a fresh link.'],
    expired: [<ShieldAlert className="h-8 w-8 text-destructive" />, 'This link has expired', 'Please contact partnership@welile.com for a fresh link.'],
    done: [<CheckCircle2 className="h-8 w-8 text-primary" />, 'Thank you — agreement signed',
      'Welile Partner Operations will countersign, and you will receive the final agreement by email.', { label: 'Go to dashboard', to: '/dashboard' }],
  };
  const n = notices[state];
  if (n) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md"><CardContent className="space-y-4 p-6 text-center">
          <div className="flex justify-center">{n[0]}</div>
          <h1 className="text-xl font-semibold">{n[1]}</h1>
          <p className="text-sm text-muted-foreground">{n[2]}</p>
          {n[3] && <Button className="w-full" onClick={() => navigate(n[3]!.to)}>{n[3].label}</Button>}
        </CardContent></Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto grid max-w-6xl gap-4 p-3 sm:p-6 lg:grid-cols-[1fr_340px]">
        <div className="order-2 lg:order-1">{preview && <ShareAgreementPreview data={preview} />}</div>
        <Card className="order-1 h-fit lg:sticky lg:top-6 lg:order-2"><CardContent className="space-y-3 p-4">
          <h1 className="text-lg font-semibold">Review & sign agreement</h1>
          <p className="text-xs text-muted-foreground">
            {snap?.reference_id} • UGX {Number(snap?.amount ?? 0).toLocaleString('en-US')} • {Number(snap?.shares ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} shares
          </p>
          <div><Label>Full legal name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          {snap?.prefill_phone && <div><Label>Phone</Label><Input value={snap.prefill_phone} readOnly /></div>}
          {snap?.prefill_email && <div><Label>Email</Label><Input value={snap.prefill_email} readOnly /></div>}
          <div><Label>Date</Label><Input value={today} readOnly /></div>
          <div><Label>Signature</Label><SignaturePad onChange={setSig} /></div>
          <Button className="w-full" disabled={busy || name.trim().length < 3 || !sig} onClick={submit}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Sign & submit
          </Button>
        </CardContent></Card>
      </div>
    </div>
  );
}
