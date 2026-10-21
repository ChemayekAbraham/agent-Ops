import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { ArrowRight, Mail, Loader2, Save, ShieldCheck } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { z } from 'zod';
import { useEmailVerification } from '@/hooks/useEmailVerification';

interface Props {
  /** Self-edit mode: the user proves they own the address before it is adopted.
   *  Agent mode: agent updates the profile email field of a managed user.
   */
  mode: 'self' | 'agent';
  userId: string;
  currentEmail: string;
  onSaved?: (newEmail: string) => void;
}

const EmailSchema = z.string().trim().email().max(255);

/**
 * Self mode no longer writes `profiles.email` from the browser.
 *
 * It used to call auth.updateUser() and then write the profile immediately,
 * without waiting for the confirmation link — so the column recorded a claim,
 * not a verified mailbox. Now the address is adopted server-side, inside
 * confirm_email_verification(), only once the emailed code comes back.
 *
 * The markup below deliberately reuses the existing field idiom; the visual
 * treatment of the two-step flow is Gemini's call.
 */
export default function EmailEditor({ mode, userId, currentEmail, onSaved }: Props) {
  const [email, setEmail] = useState(currentEmail);
  const [saving, setSaving] = useState(false);

  const [step, setStep] = useState<'email' | 'code'>('email');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const { requestCode, confirmCode, sending, confirming, attemptsLeft } = useEmailVerification();

  const sendCode = async () => {
    setFormError(null);
    const parsed = EmailSchema.safeParse(email);
    if (!parsed.success) { toast.error('Enter a valid email address'); return; }
    if (parsed.data.toLowerCase() === currentEmail.trim().toLowerCase()) {
      toast.info('Email unchanged');
      return;
    }
    try {
      const res = await requestCode(parsed.data);
      setChallengeId(res.challengeId);
      setSentTo(parsed.data.toLowerCase());
      setStep('code');
      setCode('');
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
      toast.success('Email confirmed');
      if (!res.authSynced) {
        toast.warning('Your sign-in address was not updated', {
          description: 'Keep using your old details to sign in. Support has been notified.',
        });
      }
      setStep('email');
      setChallengeId(null);
      setCode('');
      onSaved?.(res.email);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not confirm the code';
      setFormError(message);
      toast.error(message);
    }
  };

  /** Agent mode is unchanged: it edits a managed user's profile field only. */
  const saveAsAgent = async () => {
    const parsed = EmailSchema.safeParse(email);
    if (!parsed.success) { toast.error('Enter a valid email address'); return; }
    if (parsed.data === currentEmail) { toast.info('Email unchanged'); return; }
    setSaving(true);
    const { error } = await supabase.from('profiles').update({ email: parsed.data }).eq('id', userId);
    if (error) { toast.error('Failed: ' + error.message); setSaving(false); return; }
    const { data: { user: actor } } = await supabase.auth.getUser();
    if (actor) {
      await supabase.from('agent_managed_user_actions').insert({
        agent_id: actor.id, user_id: userId, action_type: 'email_updated',
        details: { from: currentEmail, to: parsed.data },
      });
    }
    toast.success('Email updated');
    onSaved?.(parsed.data);
    setSaving(false);
  };

  const resetToEmailStep = () => {
    setFormError(null);
    setStep('email');
    setCode('');
    setChallengeId(null);
  };

  if (mode === 'agent') return (
    <Card className="border-border/40 rounded-2xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2"><Mail className="h-4 w-4 text-primary" /> Email Address</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Email</Label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" className="h-11 rounded-xl" />
        </div>
        <Button onClick={saveAsAgent} disabled={saving || sending || !email.trim()} className="w-full gap-2 h-11 rounded-xl text-sm font-bold">
          {saving || sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Email
        </Button>
      </CardContent>
    </Card>
  );

  return (
    <Card className="overflow-hidden rounded-2xl border-border/40">
      <CardHeader className="border-b border-border bg-primary/5 pb-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><Mail className="h-5 w-5" aria-hidden="true" /></span>
          <div>
            <CardTitle className="text-base">Email address</CardTitle>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">For receipts, statements and account notices</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        <p className="text-xs font-medium text-primary">Step {step === 'email' ? '1' : '2'} of 2 · {step === 'email' ? 'Email address' : 'Confirm your address'}</p>
        {step === 'email' ? (
          <div className="space-y-2">
            <Label htmlFor="profile-email" className="text-sm font-medium">Email address</Label>
            <Input id="profile-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" className="h-12 rounded-lg text-base" />
            <p className="text-xs leading-relaxed text-muted-foreground">We will email you a 6-digit code to confirm the address is yours.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="min-w-0 border-b border-border pb-3"><p className="text-xs text-muted-foreground">Code sent to</p><p className="break-all text-sm font-medium">{sentTo}</p></div>
            <div className="space-y-2">
              <Label htmlFor="profile-email-code" className="text-sm font-medium">6-digit code</Label>
              <Input id="profile-email-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" className="h-14 rounded-lg text-center font-mono text-2xl" aria-invalid={!!formError} />
              {attemptsLeft !== null && <p className="text-xs text-muted-foreground">{attemptsLeft} attempt(s) left.</p>}
            </div>
          </div>
        )}
        {formError && <p role="alert" className="break-words text-sm text-destructive">{formError}</p>}
        <Button onClick={step === 'email' ? sendCode : submitCode} disabled={step === 'email' ? sending || !email.trim() : confirming || code.length !== 6} className="h-12 w-full gap-2 rounded-lg">
          {sending || confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : step === 'email' ? <ArrowRight className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
          {step === 'email' ? sending ? 'Sending code…' : 'Send code' : confirming ? 'Confirming…' : 'Confirm email'}
        </Button>
        {step === 'code' && <Button variant="ghost" onClick={resetToEmailStep} disabled={confirming} className="h-10 w-full rounded-lg text-muted-foreground">Use a different address</Button>}
      </CardContent>
    </Card>
  );
}
