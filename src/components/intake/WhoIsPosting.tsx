import { useState } from 'react';
import { Loader2, ShieldCheck, User, Users } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useOtpVerification } from '@/hooks/useOtpVerification';
import { toUgandaE164 } from '@/lib/ugandaPhone';
import { becomeAgent } from '@/lib/intakeRpc';

/**
 * Anyone can post a rent request. The first screen, for users who are not agents:
 * "Who is this rent request for?" Me → the tenant self-apply flow; Someone else →
 * become_agent, then the agent intake. PHONE_REQUIRED: confirm the phone by SMS code
 * first, then continue; AGENT_ROLE_DISABLED: the message, nothing else.
 */
export function WhoIsPosting({ onMe, onAgent }: { onMe: () => void; onAgent: () => void }) {
  const { user } = useAuth();
  const otp = useOtpVerification();
  const [stage, setStage] = useState<'choose' | 'working' | 'phone' | 'refused'>('choose');
  const [message, setMessage] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const someoneElse = async () => {
    setStage('working');
    setMessage(null);
    const res = await becomeAgent();
    if (!('code' in res)) { onAgent(); return; }
    if (res.code === 'PHONE_REQUIRED') { setStage('phone'); setMessage(res.message); return; }
    setStage(res.code === 'AGENT_ROLE_DISABLED' ? 'refused' : 'choose');
    setMessage(res.message);
  };

  const sendCode = async () => {
    const e164 = toUgandaE164(phone);
    if (!e164) { setMessage('Type your phone number, like 0783 123 456.'); return; }
    setMessage(null);
    await otp.sendOtp(e164, { category: 'phone_collection' });
  };

  const confirm = async () => {
    const e164 = toUgandaE164(phone);
    if (!e164 || code.trim().length !== 6) { setMessage('Type the 6-digit code from the SMS.'); return; }
    setBusy(true);
    setMessage(null);
    try {
      if (!(await otp.verifyOtp(e164, code.trim(), { category: 'phone_collection' }))) { setMessage(otp.otpError || 'That code did not work. Try again.'); return; }
      const now = new Date().toISOString();
      const { error } = await supabase.from('profiles')
        .update({ phone: e164, phone_verified: true, phone_verified_at: now } as never)
        .eq('id', user!.id);
      if (error) { setMessage(error.message); return; }
      await someoneElse();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-6" data-testid="who-is-posting">
      <h2 className="font-display text-xl font-bold">Who is this rent request for?</h2>
      {stage === 'phone' ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4" data-testid="confirm-phone">
          <p className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-primary" /> Confirm your phone number first</p>
          <p className="text-sm text-muted-foreground">We send a code by SMS. Then you can post for the tenant.</p>
          <input aria-label="Your phone number" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
            placeholder="0783 123 456" className="h-11 rounded-xl border border-border bg-background px-3 text-base outline-none focus:border-primary" />
          {!otp.otpSent ? (
            <button type="button" onClick={() => void sendCode()} disabled={otp.otpLoading || otp.cooldownSeconds > 0}
              className="h-11 rounded-xl bg-primary font-semibold text-primary-foreground disabled:opacity-60">
              {otp.otpLoading ? 'Sending…' : 'Send code'}
            </button>
          ) : (
            <>
              <input aria-label="Code from the SMS" inputMode="numeric" maxLength={6} value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="6-digit code" className="h-11 rounded-xl border border-border bg-background px-3 text-base tracking-widest outline-none focus:border-primary" />
              <button type="button" onClick={() => void confirm()} disabled={busy || otp.otpLoading}
                className="flex h-11 items-center justify-center gap-2 rounded-xl bg-primary font-semibold text-primary-foreground disabled:opacity-60">
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Confirm and continue
              </button>
            </>
          )}
        </div>
      ) : stage === 'refused' ? null : (
        <div className="grid grid-cols-2 gap-3">
          <button type="button" onClick={onMe} disabled={stage === 'working'}
            className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-card p-3 font-semibold disabled:opacity-60">
            <User className="h-6 w-6 text-primary" /> Me
          </button>
          <button type="button" onClick={() => void someoneElse()} disabled={stage === 'working'}
            className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-card p-3 font-semibold disabled:opacity-60">
            {stage === 'working' ? <Loader2 className="h-6 w-6 animate-spin text-primary" /> : <Users className="h-6 w-6 text-primary" />} Someone else
          </button>
        </div>
      )}
      {message && <p className={stage === 'refused' ? 'rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm' : 'text-sm text-destructive'} role="alert">{message}</p>}
    </div>
  );
}
