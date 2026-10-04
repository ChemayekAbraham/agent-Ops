import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { BellOff, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Helmet } from 'react-helmet-async';

type Status = 'idle' | 'submitting' | 'success' | 'error';

export default function StopSms() {
  const [params] = useSearchParams();
  const [phone, setPhone] = useState(params.get('p') || '');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const submit = async () => {
    const trimmed = phone.trim();
    if (trimmed.replace(/\D/g, '').length < 9) {
      setStatus('error');
      setErrorMsg('Please enter a valid phone number.');
      return;
    }
    setStatus('submitting');
    const { data, error } = await supabase.functions.invoke('sms-opt-out', {
      body: { phone: trimmed },
    });
    if (error) {
      setStatus('error');
      setErrorMsg(error.message || 'Something went wrong. Please try again.');
      return;
    }
    if ((data as any)?.success) setStatus('success');
    else {
      setStatus('error');
      setErrorMsg((data as any)?.error || 'Something went wrong. Please try again.');
    }
  };

  return (
    <>
      <Helmet>
        <link rel="canonical" href="https://welileapp.com/stop-sms" />
        <meta property="og:url" content="https://welileapp.com/stop-sms" />
      </Helmet>
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BellOff className="h-5 w-5 text-primary" />
            Stop Welile SMS
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === 'success' ? (
            <div className="flex flex-col items-center text-center gap-3 py-4">
              <CheckCircle2 className="h-10 w-10 text-primary" />
              <p className="text-sm text-muted-foreground">
                You've been unsubscribed. This number will no longer receive Welile's
                daily messages. You can still reach us anytime on WhatsApp{' '}
                <a href="https://wa.me/256748747134" className="underline">+256 748747134</a>.
              </p>
              <p className="text-xs text-muted-foreground">
                Changed your mind?{' '}
                <a
                  href={`/resume-sms?p=${encodeURIComponent(phone.trim())}`}
                  className="underline text-primary"
                >
                  Resume daily messages
                </a>
              </p>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Enter your phone number below to stop receiving Welile's daily SMS updates.
              </p>
              <div className="space-y-2">
                <Label htmlFor="phone">Phone number</Label>
                <Input
                  id="phone"
                  inputMode="tel"
                  placeholder="e.g. 0704825473"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
              {status === 'error' && (
                <div className="flex items-center gap-2 text-sm text-destructive">
                  <AlertTriangle className="h-4 w-4" /> {errorMsg}
                </div>
              )}
              <Button onClick={submit} className="w-full" disabled={status === 'submitting'}>
                {status === 'submitting' ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Stopping…</>
                ) : (
                  'Stop messages'
                )}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
    </>
  );
}
