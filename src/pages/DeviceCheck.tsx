import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Clock, KeyRound, Loader2, MapPin, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { DeviceOsIcon } from '@/components/auth/DeviceOsIcon';
import type { DeviceIconKey } from '@/hooks/useNewDeviceSignIns';

/**
 * /device-check?t=… — opened from the "New sign-in" email's buttons.
 *
 * Opening the page changes nothing (mail scanners open links by themselves);
 * the answer is applied only when the person presses confirm. No sign-in
 * needed: the single-use token is the proof. Logic: device-alert-email-action.
 * Styling is Gemini's to refine.
 */
type Device = { icon: DeviceIconKey; label: string; location: string | null; signed_in_at?: string };
type Peek = { ok: boolean; action?: 'trust' | 'reject'; device?: Device; error?: string };

async function call(action: 'peek' | 'confirm', token: string): Promise<Peek> {
  try {
    const { data, error } = await supabase.functions.invoke('device-alert-email-action', { body: { action, token } });
    if (data) return data as Peek;
    const ctx = (error as { context?: Response } | null)?.context;
    if (ctx && typeof ctx.json === 'function') return (await ctx.clone().json()) as Peek;
  } catch {
    /* fall through */
  }
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

export default function DeviceCheck() {
  const [params] = useSearchParams();
  const token = params.get('t') ?? '';
  const [peek, setPeek] = useState<Peek | null>(null);
  const [done, setDone] = useState<Peek | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setPeek({ ok: false, error: "This link isn't valid." });
      return;
    }
    call('peek', token).then(setPeek);
  }, [token]);

  const confirm = async () => {
    setBusy(true);
    setDone(await call('confirm', token));
    setBusy(false);
  };

  const device = (done?.device ?? peek?.device) as Device | undefined;
  const isReject = peek?.action === 'reject';
  const when = device?.signed_in_at
    ? new Date(device.signed_in_at).toLocaleString('en-UG', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' })
    : null;

  const header = (title: string, tone: 'primary' | 'destructive' = 'primary') => (
    <div className={`flex items-center gap-3 border-b px-5 pb-4 pt-5 text-left ${tone === 'destructive' ? 'border-destructive/20 bg-destructive/10' : 'border-primary/15 bg-primary/10'}`}>
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full shadow-sm ${tone === 'destructive' ? 'bg-destructive text-destructive-foreground' : 'bg-primary text-primary-foreground'}`}>
        {tone === 'destructive' ? <ShieldAlert className="h-5 w-5" aria-hidden="true" /> : <ShieldCheck className="h-5 w-5" aria-hidden="true" />}
      </div>
      <h1 className="min-w-0 break-words text-base font-semibold leading-tight text-foreground sm:text-lg">{title}</h1>
    </div>
  );

  return (
    <div className="flex min-h-screen items-center justify-center overflow-x-hidden bg-background p-3 sm:p-5">
      <div className="w-full max-w-md space-y-4">
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-lg">
          {!peek ? (
            <>
              {header('Checking this link')}
              <div className="flex justify-center px-5 py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" />
              </div>
            </>
          ) : !peek.ok && !done ? (
            <>
              {header("This link can't be used", 'destructive')}
              <p className="px-5 py-4 text-sm text-muted-foreground">{peek.error}</p>
            </>
          ) : done ? (
            <>
              {header(
                !done.ok ? "That didn't work" : done.action === 'reject' ? 'Device signed out' : 'Device kept signed in',
                !done.ok ? 'destructive' : 'primary',
              )}
              <div className="space-y-3 px-5 py-4">
                {done.ok && done.action === 'reject' ? (
                  <>
                    <p className="flex items-start gap-2 text-sm text-foreground">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                      <span>We've signed that device out of your account.</span>
                    </p>
                    <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
                      <KeyRound className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      <span>Tip: if someone else may know your password, change it from Settings in the Welile app.</span>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {!done.ok ? done.error : "Thanks. We won't ask about this device again."}
                  </p>
                )}
              </div>
            </>
          ) : (
            <>
              {header(isReject ? 'Sign this device out?' : 'Keep this device signed in?', isReject ? 'destructive' : 'primary')}
              <div className="space-y-4 px-5 py-4">
                <p className="text-sm text-muted-foreground">
                  {isReject
                    ? "You said you don't recognise this sign-in. Confirm and we'll sign the device out of your account."
                    : 'You said this sign-in was you. Confirm and we will trust this device.'}
                </p>
                {device ? (
                  <div className="flex items-center gap-4 rounded-2xl border border-border bg-background p-4 text-left shadow-sm">
                    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-muted text-foreground">
                      <DeviceOsIcon icon={device.icon} className="h-9 w-9" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="break-words text-base font-semibold text-foreground">{device.label}</p>
                      {when ? (
                        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                          <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span className="min-w-0 break-words">{when} (EAT)</span>
                        </p>
                      ) : null}
                      {device.location ? (
                        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                          <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span className="min-w-0 break-words">Near {device.location}</span>
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
              <div className="border-t border-border px-5 py-4">
                <Button className="h-11 w-full" variant={isReject ? 'destructive' : 'default'} onClick={confirm} disabled={busy}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {isReject ? 'Yes, sign it out' : 'Yes, keep it'}
                </Button>
              </div>
            </>
          )}
        </div>

        <Link to="/" className="block text-center text-xs text-muted-foreground underline">
          Go to Welile
        </Link>
      </div>
    </div>
  );
}
