import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { CheckCircle2, Clock3, Loader2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';

type PageState = 'waiting' | 'sending' | 'sent' | 'error';

async function readFailure(error: unknown): Promise<string> {
  try {
    const context = (error as { context?: { json?: () => Promise<Record<string, unknown>> } })?.context;
    const body = await context?.json?.();
    if (typeof body?.message === 'string') return body.message;
  } catch { /* use fallback below */ }
  return 'We could not send a new code. Please try again.';
}

function formatKampala(value: string): string {
  return new Intl.DateTimeFormat('en-UG', {
    timeZone: 'Africa/Kampala',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value));
}

export default function ResendCashDepositCode() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const depositRequestId = params.get('deposit');
  const started = useRef(false);
  const [state, setState] = useState<PageState>('waiting');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (authLoading || started.current) return;
    if (!depositRequestId) {
      setState('error');
      setMessage('This resend link is incomplete. Please use the latest email from Welile.');
      return;
    }
    if (!user) {
      const destination = `/cash-deposit/resend?deposit=${encodeURIComponent(depositRequestId)}`;
      navigate(`/auth?redirect=${encodeURIComponent(destination)}`, { replace: true });
      return;
    }

    started.current = true;
    setState('sending');
    void (async () => {
      const { data, error } = await supabase.functions.invoke('finops-cash-deposit-resend', {
        body: { deposit_request_id: depositRequestId, account_resend: true },
      });
      if (error) {
        setState('error');
        setMessage(await readFailure(error));
        return;
      }
      setState('sent');
      const expiry = typeof data?.expires_at === 'string' ? formatKampala(data.expires_at) : null;
      setMessage(expiry ? `Your new code works until ${expiry}.` : 'Your new code has been sent.');
    })();
  }, [authLoading, depositRequestId, navigate, user]);

  return (
    <>
      <Helmet>
        <title>Resend Cash Deposit Code | Welile</title>
        <meta name="description" content="Securely resend your Welile cash deposit verification code." />
        <link rel="canonical" href="https://welileapp.com/cash-deposit/resend" />
      </Helmet>
      <main className="min-h-screen bg-muted/30 p-4 flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock3 className="h-5 w-5 text-primary" /> Cash deposit code
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {(state === 'waiting' || state === 'sending') && (
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
                {authLoading ? 'Checking your account…' : 'Sending a new code…'}
              </div>
            )}
            {state === 'sent' && (
              <div className="space-y-4 text-center">
                <CheckCircle2 className="mx-auto h-12 w-12 text-success" />
                <div>
                  <p className="font-semibold">New code sent</p>
                  <p className="mt-1 text-sm text-muted-foreground">{message}</p>
                </div>
                <Button className="w-full" onClick={() => navigate('/dashboard')}>Return to Welile</Button>
              </div>
            )}
            {state === 'error' && (
              <div className="space-y-4 text-center">
                <ShieldAlert className="mx-auto h-12 w-12 text-destructive" />
                <div>
                  <p className="font-semibold">Code not resent</p>
                  <p className="mt-1 text-sm text-muted-foreground">{message}</p>
                </div>
                <Button variant="outline" className="w-full" onClick={() => navigate('/dashboard')}>Return to Welile</Button>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </>
  );
}