import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Loader2, ShieldCheck } from 'lucide-react';
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

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-5">
      <div className="w-full max-w-sm space-y-5 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
          <ShieldCheck className="h-7 w-7 text-primary" />
        </div>

        {!peek ? (
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
        ) : !peek.ok && !done ? (
          <div className="space-y-2">
            <h1 className="text-lg font-semibold text-foreground">This link can't be used</h1>
            <p className="text-sm text-muted-foreground">{peek.error}</p>
          </div>
        ) : done ? (
          <div className="space-y-2">
            <h1 className="text-lg font-semibold text-foreground">
              {!done.ok ? "That didn't work" : done.action === 'reject' ? 'Device signed out' : 'Device kept signed in'}
            </h1>
            <p className="text-sm text-muted-foreground">
              {!done.ok
                ? done.error
                : done.action === 'reject'
                  ? "We've signed that device out of your account. Tip: if someone else may know your password, change it from Settings in the Welile app."
                  : "Thanks. We won't ask about this device again."}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <h1 className="text-lg font-semibold text-foreground">
                {isReject ? 'Sign this device out?' : 'Keep this device signed in?'}
              </h1>
              <p className="text-sm text-muted-foreground">
                {isReject
                  ? "You said you don't recognise this sign-in. Confirm and we'll sign the device out of your account."
                  : 'You said this sign-in was you. Confirm and we will trust this device.'}
              </p>
            </div>
            {device ? (
              <div className="flex items-center gap-3 rounded-xl border p-3 text-left">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <DeviceOsIcon icon={device.icon} className="h-6 w-6" />
                </div>
                <div className="min-w-0 text-sm">
                  <p className="font-semibold text-foreground">{device.label}</p>
                  {when ? <p className="text-muted-foreground">{when} (EAT)</p> : null}
                  {device.location ? <p className="text-muted-foreground">Near {device.location}</p> : null}
                </div>
              </div>
            ) : null}
            <Button className="w-full" variant={isReject ? 'destructive' : 'default'} onClick={confirm} disabled={busy}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {isReject ? 'Yes, sign it out' : 'Yes, keep it'}
            </Button>
          </div>
        )}

        <Link to="/" className="block text-xs text-muted-foreground underline">
          Go to Welile
        </Link>
      </div>
    </div>
  );
}
