import { useCallback, useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Mail, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { useEmailVerification } from '@/hooks/useEmailVerification';
import { needsValidEmail } from '@/lib/emailDeliverability';

/**
 * Asks for a working email address, and keeps asking.
 *
 * Shown only to users whose `profiles.email` cannot receive mail — our own
 * phone-signup placeholders (`<phone>@welile.agent`, `@welile.user`,
 * `@noapp.welile.user`), disposable inboxes, and obvious typos like
 * `gmail.comm`. Anyone already on a real provider, ProtonMail included, never
 * sees it.
 *
 * Dismissal is deliberately weak: it lasts for the browser session only, so
 * the dialog returns next time the app is opened and keeps returning until a
 * verified address is on file. Nothing is paid for completing it — the value
 * is a reachable mailbox, not an incentive.
 *
 * The address is adopted server-side by confirm_email_verification() once the
 * emailed code comes back; this component never writes `profiles.email`.
 */

const DISMISS_KEY = 'welile:email-collection:dismissed-session';

const EmailSchema = z.string().trim().email().max(255);

function wasDismissedThisSession(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function markDismissed() {
  try {
    sessionStorage.setItem(DISMISS_KEY, '1');
  } catch {
    /* private mode / blocked storage — the dialog simply returns sooner */
  }
}

export default function EmailCollectionGate() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState('');
  const { requestCode, confirmCode, sending, confirming, attemptsLeft } = useEmailVerification();

  useEffect(() => {
    let cancelled = false;
    if (!user?.id || wasDismissedThisSession()) return;

    void (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('email')
        .eq('id', user.id)
        .maybeSingle();
      if (cancelled || error || !data) return;
      if (needsValidEmail(data.email)) setOpen(true);
    })();

    return () => { cancelled = true; };
  }, [user?.id]);

  const dismiss = useCallback(() => {
    markDismissed();
    setOpen(false);
  }, []);

  const sendCode = async () => {
    const parsed = EmailSchema.safeParse(email);
    if (!parsed.success) { toast.error('Enter a valid email address'); return; }
    try {
      const res = await requestCode(parsed.data);
      setChallengeId(res.challengeId);
      setSentTo(parsed.data.toLowerCase());
      setCode('');
      setStep('code');
      toast.success('Code sent', {
        description: 'Check ' + parsed.data.toLowerCase() + ' for a 6-digit code.',
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send the code');
    }
  };

  const submitCode = async () => {
    if (!challengeId) return;
    try {
      const res = await confirmCode(challengeId, code);
      toast.success('Email confirmed', { description: res.email });
      if (!res.authSynced) {
        toast.warning('Your sign-in address was not updated', {
          description: 'Keep using your old details to sign in.',
        });
      }
      markDismissed();
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not confirm the code');
    }
  };

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) dismiss(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-primary" /> Add your email address
          </DialogTitle>
          <DialogDescription>
            We do not have an email address that can reach you. Add one so we can
            send receipts, statements and account notices.
          </DialogDescription>
        </DialogHeader>

        {step === 'email' ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Email</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                className="h-11 rounded-xl"
              />
              <p className="text-[11px] text-muted-foreground">
                We will email you a 6-digit code to confirm the address is yours.
              </p>
            </div>
            <Button onClick={sendCode} disabled={sending || !email.trim()} className="w-full gap-2 h-11 rounded-xl text-sm font-bold">
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Send code
            </Button>
            <Button variant="ghost" onClick={dismiss} className="w-full h-9 rounded-xl text-xs">
              Not now
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">6-digit code</Label>
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                className="h-11 rounded-xl text-center tracking-[0.3em]"
              />
              <p className="text-[11px] text-muted-foreground">
                Sent to {sentTo}.{attemptsLeft !== null ? ' ' + attemptsLeft + ' attempt(s) left.' : ''}
              </p>
            </div>
            <Button onClick={submitCode} disabled={confirming || code.length !== 6} className="w-full gap-2 h-11 rounded-xl text-sm font-bold">
              {confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Confirm email
            </Button>
            <Button
              variant="ghost"
              onClick={() => { setStep('email'); setCode(''); setChallengeId(null); }}
              disabled={confirming}
              className="w-full h-9 rounded-xl text-xs"
            >
              Use a different address
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
