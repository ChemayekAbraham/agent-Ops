import { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, Loader2, MailWarning, MonitorSmartphone } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LiquidToggle } from '@/components/ui/liquid-toggle';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { isUnusableEmail, useTwoFactor } from '@/hooks/useTwoFactor';

/**
 * Two-step verification (2MFA) control.
 *
 * Turning it on signs out every other device and keeps only this one. Any new
 * device that signs in afterwards must enter a code emailed to the account
 * owner before it can reach the dashboard. Accounts without a real email
 * address cannot turn it on.
 */
export default function TwoFactorSection() {
  const { user } = useAuth();
  const { enabled, loading, emailMasked, enable, disable } = useTwoFactor(user?.id);
  const [profileEmail, setProfileEmail] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    supabase
      .from('profiles')
      .select('email')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setProfileEmail((data?.email as string | null) ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const usableEmail = useMemo(() => {
    if (!isUnusableEmail(user?.email)) return user?.email ?? null;
    if (!isUnusableEmail(profileEmail)) return profileEmail;
    return null;
  }, [user?.email, profileEmail]);

  const handleEnable = async () => {
    setBusy(true);
    const { data, error } = await enable();
    setBusy(false);
    setConfirmOpen(false);
    if (error) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signedOut = (data as any)?.devices_signed_out ?? 0;
    toast.success('Two-step verification is on', {
      description:
        signedOut > 0
          ? `${signedOut} other device${signedOut === 1 ? '' : 's'} signed out. Only this device stays logged in.`
          : 'Only this device stays logged in. New devices will need an email code.',
    });
  };

  const handleDisable = async () => {
    setBusy(true);
    const { error } = await disable();
    setBusy(false);
    setDisableOpen(false);
    if (!error) toast.success('Two-step verification is off');
  };

  return (
    <Card className="border-border/40 rounded-2xl">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <div className="min-w-0">
            <CardTitle className="text-sm flex items-center gap-2">
              Two-step verification
              {enabled && (
                <Badge variant="primary" size="sm" className="shrink-0">
                  On
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="text-xs">
              Any new device signing in must enter a code sent to your email before it can use Welile.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!usableEmail ? (
          <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-2.5 py-2 text-xs text-warning">
            <MailWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              You need a real email address on your account before you can turn this on. Add your
              email under Settings → Me → Contact, then come back here.
            </span>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-card px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {enabled ? 'Protection is active' : 'Protect my account'}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                Codes go to {emailMasked ?? usableEmail}
              </p>
            </div>
            {loading || busy ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <LiquidToggle
                checked={enabled}
                variant={enabled ? 'success' : 'default'}
                aria-label="Two-step verification"
                onCheckedChange={(next) => (next ? setConfirmOpen(true) : setDisableOpen(true))}
              />
            )}
          </div>
        )}

        {enabled && (
          <div className="flex items-start gap-2 rounded-lg bg-success/10 px-2.5 py-2 text-xs text-success">
            <MonitorSmartphone className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>This device is verified. New devices will be asked for an email code.</span>
          </div>
        )}
      </CardContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn on two-step verification?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  All your other devices will be signed out immediately. Only this device stays
                  logged in.
                </p>
                <p>
                  Next time you sign in on another phone or computer, we will email a 6-digit code to{' '}
                  <strong>{emailMasked ?? usableEmail}</strong>. You must enter it before you can
                  reach your dashboard.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleEnable();
              }}
              disabled={busy}
            >
              {busy ? 'Turning on…' : 'Turn on & sign out others'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={disableOpen} onOpenChange={setDisableOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off two-step verification?</AlertDialogTitle>
            <AlertDialogDescription>
              New devices will be able to sign in with just your password — no email code. You can
              turn it back on at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep it on</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDisable();
              }}
              disabled={busy}
            >
              {busy ? 'Turning off…' : 'Turn off'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
