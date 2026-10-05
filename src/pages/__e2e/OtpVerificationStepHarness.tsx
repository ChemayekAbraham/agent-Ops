/**
 * Dev-only preview harness that renders the real `OtpVerificationStep` with
 * MOCKED props — no edge function is called and no SMS is ever sent.
 *
 * Lets us iterate on the verifying / success / error motion on localhost
 * without touching the live Supabase project.
 *
 * Mounted at `/__e2e/otp-verification-step` ONLY when `import.meta.env.DEV`
 * is true — so it never ships in production builds.
 *
 * Verify is simulated: typing 6 digits triggers `onVerifyOtp`, which walks
 * loading (1.8s) -> verified, or -> error when the code is 000000.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { OtpVerificationStep } from '@/components/auth/OtpVerificationStep';

type Sim = {
  otpSent: boolean;
  otpVerified: boolean;
  otpLoading: boolean;
  otpError: string | null;
  sendStatus: 'idle' | 'pending' | 'accepted' | 'failed';
  cooldownSeconds: number;
};

const FRESH: Sim = {
  otpSent: false,
  otpVerified: false,
  otpLoading: false,
  otpError: null,
  sendStatus: 'idle',
  cooldownSeconds: 0,
};

const VERIFY_MS = 1800;

export default function OtpVerificationStepHarness() {
  const [sim, setSim] = useState<Sim>(FRESH);
  const timers = useRef<number[]>([]);
  const cooldownTimer = useRef<number>();

  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  const clearAll = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    if (cooldownTimer.current) window.clearInterval(cooldownTimer.current);
  }, []);

  useEffect(() => clearAll, [clearAll]);

  const startCooldown = (seconds: number) => {
    if (cooldownTimer.current) window.clearInterval(cooldownTimer.current);
    setSim((s) => ({ ...s, cooldownSeconds: seconds }));
    cooldownTimer.current = window.setInterval(() => {
      setSim((s) => {
        const next = Math.max(0, s.cooldownSeconds - 1);
        if (next === 0 && cooldownTimer.current) window.clearInterval(cooldownTimer.current);
        return { ...s, cooldownSeconds: next };
      });
    }, 1000);
  };

  const send = () => {
    clearAll();
    setSim({ ...FRESH, otpLoading: true });
    later(() => {
      setSim({ ...FRESH, otpSent: true, sendStatus: 'accepted' });
      startCooldown(60);
    }, 600);
  };

  // Mirrors the real hook: loading on, then verified or an error string.
  const verify = (otp: string) => {
    setSim((s) => ({ ...s, otpLoading: true, otpError: null }));
    later(() => {
      if (otp === '000000') {
        setSim((s) => ({ ...s, otpLoading: false, otpError: 'Invalid or expired code' }));
      } else {
        setSim((s) => ({ ...s, otpLoading: false, otpVerified: true }));
      }
    }, VERIFY_MS);
  };

  const reset = () => {
    clearAll();
    setSim(FRESH);
  };

  // Jump straight to a state without typing.
  const jump = (patch: Partial<Sim>) => {
    clearAll();
    setSim({ ...FRESH, otpSent: true, sendStatus: 'accepted', ...patch });
  };

  return (
    <main className="min-h-screen bg-background text-foreground p-4 flex flex-col items-center gap-6">
      <h1 className="text-lg font-semibold">OtpVerificationStep — dev preview (mocked, no SMS)</h1>

      <div className="flex flex-wrap justify-center gap-2" data-testid="otp-harness-controls">
        <Button size="sm" variant="outline" onClick={reset}>Reset</Button>
        <Button size="sm" variant="outline" onClick={() => jump({})}>Idle (code sent)</Button>
        <Button size="sm" variant="outline" onClick={() => jump({ otpLoading: true })}>Verifying</Button>
        <Button size="sm" variant="outline" onClick={() => jump({ otpVerified: true })}>Verified</Button>
        <Button size="sm" variant="outline" onClick={() => jump({ otpError: 'Invalid or expired code' })}>Error</Button>
      </div>

      <p className="text-xs text-muted-foreground text-center max-w-sm">
        Click the send button, then type any 6 digits to see verifying → success.
        Type <span className="font-mono">000000</span> to see the error path.
        Resize to 320px to check narrow dialogs.
      </p>

      <div className="w-full max-w-sm rounded-xl border bg-card p-4" data-testid="otp-harness-card">
        <OtpVerificationStep
          phone="0759229748"
          otpSent={sim.otpSent}
          otpVerified={sim.otpVerified}
          otpLoading={sim.otpLoading}
          otpError={sim.otpError}
          sendStatus={sim.sendStatus}
          cooldownSeconds={sim.cooldownSeconds}
          onSendOtp={send}
          onVerifyOtp={verify}
          onResendOtp={send}
        />
      </div>

      <pre className="text-[11px] text-muted-foreground" data-testid="otp-harness-state">
        {JSON.stringify(sim)}
      </pre>
    </main>
  );
}
