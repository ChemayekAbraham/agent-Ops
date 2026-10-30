import { useState } from 'react';
import { Loader2, ShieldAlert, Clock, MapPin, Globe } from 'lucide-react';
import { toast } from 'sonner';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { useNewDeviceSignIns } from '@/hooks/useNewDeviceSignIns';
import { DeviceOsIcon } from './DeviceOsIcon';

/**
 * "Someone signed in to your account" — shown on the owner's trusted devices
 * until they answer for each new device. The new device keeps working until
 * then; "I don't know this device" signs it out and sends a password tip.
 *
 * Logic: useNewDeviceSignIns / device-sign-in-alert. Not dismissible without an
 * answer, by design. Styling is Gemini's to refine.
 */
export default function NewDeviceSignInDialog() {
  const { user } = useAuth();
  const { pending, respond } = useNewDeviceSignIns(user?.id);
  const [busy, setBusy] = useState<'trust' | 'reject' | null>(null);

  const device = pending[0];
  if (!user?.id || !device) return null;

  const when = new Date(device.signed_in_at).toLocaleString('en-UG', {
    timeZone: 'Africa/Kampala',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const answer = async (trust: boolean) => {
    if (busy) return;
    setBusy(trust ? 'trust' : 'reject');
    const { error } = await respond(device.device_fp, trust);
    setBusy(null);
    if (error) return;
    toast.success(trust ? 'Device kept signed in' : 'Device signed out — consider changing your password');
  };

  return (
    // Plain portal (not Radix): other app dialogs opened alongside used to
    // claim the top layer and swallow taps on these buttons.
    createPortal(
    <div className="pointer-events-auto fixed inset-0 z-[2147483000] flex items-center justify-center bg-background/80 p-3 backdrop-blur-sm" role="presentation">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="new-device-title"
        aria-describedby="new-device-desc"
        className="pointer-events-auto w-[calc(100vw-1.5rem)] max-w-md overflow-hidden rounded-2xl border border-border bg-background shadow-lg"
      >
        <div className="border-b border-primary/15 bg-primary/10 px-5 pb-4 pt-5">
          <div className="space-y-2 text-left">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
                <ShieldAlert className="h-5 w-5" aria-hidden="true" />
              </div>
              <h2 id="new-device-title" className="font-semibold text-base leading-tight sm:text-lg">New sign-in to your account</h2>
            </div>
            <p id="new-device-desc" className="text-sm text-muted-foreground">
              Your account was signed in to on a device it hasn't used before. Do you know this device?
            </p>
          </div>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div className="flex items-center gap-4 rounded-2xl border border-border bg-card p-4 shadow-sm">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-muted text-foreground">
              <DeviceOsIcon icon={device.icon} className="h-9 w-9" />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="break-words text-base font-semibold text-foreground">{device.label}</p>
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 break-words">{when} (EAT)</span>
              </p>
              {device.location ? (
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 break-words">Near {device.location}</span>
                </p>
              ) : null}
              {device.ip ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Globe className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 break-all font-mono">IP {device.ip}</span>
                </p>
              ) : null}
            </div>
          </div>

          {pending.length > 1 ? (
            <p className="text-center text-xs text-muted-foreground">{pending.length - 1} more new sign-in(s) after this one.</p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 border-t border-border px-5 py-4">
          <Button type="button" className="w-full touch-manipulation" onClick={() => answer(true)} disabled={busy !== null}>
            {busy === 'trust' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            I know this device
          </Button>
          <Button type="button" variant="destructive" className="w-full touch-manipulation" onClick={() => answer(false)} disabled={busy !== null}>
            {busy === 'reject' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            I don't know this device
          </Button>
        </div>
      </div>
    </div>,
    document.body,
    )
  );
}
