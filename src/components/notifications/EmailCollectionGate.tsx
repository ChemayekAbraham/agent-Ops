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
import { ArrowRight, FileText, Loader2, Mail, ShieldCheck } from 'lucide-react';
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
  const [formError, setFormError] = useState<string | null>(null);
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
    setFormError(null);
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
      const message = e instanceof Error ? e.message : 'Could not send the code';
      setFormError(message);
      toast.error(message);
    }
  };

  const submitCode = async () => {
    setFormError(null);
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
      const message = e instanceof Error ? e.message : 'Could not confirm the code';
      setFormError(message);
      toast.error(message);
    }
  };

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) dismiss(); }}>
      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-md gap-0 overflow-y-auto rounded-2xl p-0 max-h-[calc(100dvh-2rem)]">
        <div className="border-b border-primary/15 bg-primary/5 px-6 pb-5 pt-6">
          <DialogHeader className="space-y-3 text-left">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              {step === 'email' ? <Mail className="h-6 w-6" aria-hidden="true" /> : <ShieldCheck className="h-6 w-6" aria-hidden="true" />}
            </div>
            <DialogTitle className="pr-5 text-xl leading-tight">
              {step === 'email' ? 'Add your email address' : 'Check your inbox'}
            </DialogTitle>
            <DialogDescription className="text-sm leading-relaxed">
              {step === 'email'
                ? 'We do not have an email address that can reach you. Add one for receipts, statements and account notices.'
                : 'Enter the 6-digit code we emailed you to confirm the address is yours.'}
            </DialogDescription>
          </DialogHeader>
        </div>
        <div className="space-y-5 px-6 py-5">
          <ol aria-label="Email verification progress" className="flex items-center gap-3 text-xs">
            <li aria-current={step === 'email' ? 'step' : undefined} className="flex items-center gap-2 text-primary">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 font-semibold">1</span> Email address
            </li>
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
            <li aria-current={step === 'code' ? 'step' : undefined} className={step === 'code' ? 'flex items-center gap-2 text-primary' : 'flex items-center gap-2 text-muted-foreground'}>
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted font-semibold">2</span> Confirm
            </li>
          </ol>
          {step === 'email' ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="collection-email" className="text-sm font-medium">Email address</Label>
                <Input id="collection-email" type="email" autoComplete="email" value={email}
                  onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" className="h-12 rounded-lg text-base" />
                <p className="text-xs leading-relaxed text-muted-foreground">We will send a 6-digit code to this address.</p>
              </div>
              {formError && <p role="alert" className="break-words text-sm text-destructive">{formError}</p>}
              <Button onClick={sendCode} disabled={sending || !email.trim()} className="h-12 w-full gap-2 rounded-lg">
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />} {sending ? 'Sending code…' : 'Send code'}
              </Button>
              <Button variant="ghost" onClick={dismiss} className="h-10 w-full rounded-lg text-muted-foreground">Not now</Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-3 border-b border-border pb-4">
                <Mail className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <div className="min-w-0"><p className="text-xs text-muted-foreground">Code sent to</p><p className="break-all text-sm font-medium">{sentTo}</p></div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="collection-email-code" className="text-sm font-medium">6-digit code</Label>
                <Input id="collection-email-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000" className="h-14 rounded-lg text-center font-mono text-2xl" aria-invalid={!!formError} />
                {attemptsLeft !== null && <p className="text-xs text-muted-foreground">{attemptsLeft} attempt(s) left.</p>}
              </div>
              {formError && <p role="alert" className="break-words text-sm text-destructive">{formError}</p>}
              <Button onClick={submitCode} disabled={confirming || code.length !== 6} className="h-12 w-full gap-2 rounded-lg">
                {confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} {confirming ? 'Confirming…' : 'Confirm email'}
              </Button>
              <Button variant="ghost" onClick={() => { setStep('email'); setCode(''); setChallengeId(null); setFormError(null); }} disabled={confirming} className="h-10 w-full rounded-lg text-muted-foreground">Use a different address</Button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-border px-6 py-4 text-xs text-muted-foreground">
          <FileText className="h-4 w-4 shrink-0" aria-hidden="true" /> Receipts, statements and account notices
        </div>
      </DialogContent>
    </Dialog>
  );
}
