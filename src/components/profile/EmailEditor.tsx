import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Mail, Loader2, Save, ShieldCheck } from 'lucide-react';
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
  const { requestCode, confirmCode, sending, confirming, attemptsLeft } = useEmailVerification();

  const sendCode = async () => {
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
      toast.error(e instanceof Error ? e.message : 'Could not send the code');
    }
  };

  const submitCode = async () => {
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
      toast.error(e instanceof Error ? e.message : 'Could not confirm the code');
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
    setStep('email');
    setCode('');
    setChallengeId(null);
  };

  return (
    <Card className="border-border/40 rounded-2xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2"><Mail className="h-4 w-4 text-primary" /> Email Address</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {step === 'email' ? (
          <>
            <div className="space-y-1.5">
              <Label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Email</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" className="h-11 rounded-xl" />
              {mode === 'self' && (
                <p className="text-[11px] text-muted-foreground">
                  We will email you a 6-digit code to confirm the address is yours.
                </p>
              )}
            </div>
            <Button
              onClick={mode === 'self' ? sendCode : saveAsAgent}
              disabled={saving || sending || !email.trim()}
              className="w-full gap-2 h-11 rounded-xl text-sm font-bold"
            >
              {saving || sending
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : mode === 'self' ? <ShieldCheck className="h-4 w-4" /> : <Save className="h-4 w-4" />}
              {mode === 'self' ? 'Send code' : 'Save Email'}
            </Button>
          </>
        ) : (
          <>
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
            <Button variant="ghost" onClick={resetToEmailStep} disabled={confirming} className="w-full h-9 rounded-xl text-xs">
              Use a different address
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
