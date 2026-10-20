import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
    <AlertDialog open onOpenChange={() => { /* an answer is required */ }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>New sign-in to your account</AlertDialogTitle>
          <AlertDialogDescription>
            Your account was signed in to on a device it hasn't used before. Do you know this device?
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex items-start gap-3 rounded-xl border p-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-muted">
            <DeviceOsIcon icon={device.icon} className="h-6 w-6" />
          </div>
          <div className="min-w-0 space-y-0.5 text-sm">
            <p className="font-semibold text-foreground">{device.label}</p>
            <p className="text-muted-foreground">{when} (EAT)</p>
            {device.location ? <p className="text-muted-foreground">Near {device.location}</p> : null}
            {device.ip ? <p className="text-xs text-muted-foreground">IP {device.ip}</p> : null}
          </div>
        </div>

        {pending.length > 1 ? (
          <p className="text-xs text-muted-foreground">{pending.length - 1} more new sign-in(s) after this one.</p>
        ) : null}

        <AlertDialogFooter className="gap-2 sm:gap-2">
          <Button variant="destructive" onClick={() => answer(false)} disabled={busy !== null}>
            {busy === 'reject' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            I don't know this device
          </Button>
          <Button onClick={() => answer(true)} disabled={busy !== null}>
            {busy === 'trust' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            I know this device
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
