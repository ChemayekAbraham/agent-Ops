import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, MailX, CheckCircle2, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Helmet } from 'react-helmet-async';

type Status = 'validating' | 'valid' | 'invalid' | 'already' | 'submitting' | 'success' | 'error';

export default function Unsubscribe() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [status, setStatus] = useState<Status>('validating');
  const [errorMsg, setErrorMsg] = useState<string>('');

  useEffect(() => {
    if (!token) {
      setStatus('invalid');
      return;
    }
    (async () => {
      try {
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
        const supabaseAnonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
        const res = await fetch(
          `${supabaseUrl}/functions/v1/handle-email-unsubscribe?token=${encodeURIComponent(token)}`,
          { headers: { apikey: supabaseAnonKey } }
        );
        const data = await res.json();
        if (data.valid) setStatus('valid');
        else if (data.reason === 'already_unsubscribed') setStatus('already');
        else setStatus('invalid');
      } catch (e: any) {
        setStatus('error');
        setErrorMsg(e?.message || 'Network error');
      }
    })();
  }, [token]);

  const confirm = async () => {
    if (!token) return;
    setStatus('submitting');
    const { data, error } = await supabase.functions.invoke('handle-email-unsubscribe', {
      body: { token },
    });
    if (error) {
      setStatus('error');
      setErrorMsg(error.message);
      return;
    }
    if ((data as any)?.success) setStatus('success');
    else if ((data as any)?.reason === 'already_unsubscribed') setStatus('already');
    else setStatus('error');
  };

  return (
    <>
      <Helmet>
        <link rel="canonical" href="https://welileapp.com/unsubscribe" />
        <meta property="og:url" content="https://welileapp.com/unsubscribe" />
      </Helmet>
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MailX className="h-5 w-5 text-primary" />
            Email Preferences
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === 'validating' && (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Verifying your link…
            </div>
          )}

          {status === 'valid' && (
            <>
              <p className="text-sm text-muted-foreground">
                Click below to confirm you want to unsubscribe from Welile emails.
                You'll stop receiving marketing and notification emails.
              </p>
              <Button onClick={confirm} className="w-full">Confirm Unsubscribe</Button>
            </>
          )}

          {status === 'submitting' && (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Processing…
            </div>
          )}

          {status === 'success' && (
            <div className="flex items-start gap-2 text-sm">
              <CheckCircle2 className="h-5 w-5 text-success shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">You're unsubscribed.</p>
                <p className="text-muted-foreground">We won't send you further emails.</p>
              </div>
            </div>
          )}

          {status === 'already' && (
            <div className="flex items-start gap-2 text-sm">
              <CheckCircle2 className="h-5 w-5 text-success shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Already unsubscribed.</p>
                <p className="text-muted-foreground">No further action needed.</p>
              </div>
            </div>
          )}

          {(status === 'invalid' || status === 'error') && (
            <div className="flex items-start gap-2 text-sm">
              <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Link invalid or expired.</p>
                <p className="text-muted-foreground">{errorMsg || 'Please use the link from a recent email.'}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
    </>
  );
}