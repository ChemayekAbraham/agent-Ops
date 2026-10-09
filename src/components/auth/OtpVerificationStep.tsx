import { useContext, useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { OTPInputContext } from 'input-otp';
import { Button } from '@/components/ui/button';
import { InputOTP } from '@/components/ui/input-otp';
import { Loader2, CheckCircle2, RefreshCw, ShieldCheck, AlertCircle, Smartphone } from 'lucide-react';
import { cn } from '@/lib/utils';

const OTP_LENGTH = 6;

interface OtpVerificationStepProps {
  phone: string;
  otpSent: boolean;
  otpVerified: boolean;
  otpLoading: boolean;
  otpError: string | null;
  /** Gateway-acceptance status of the most recent send (optional). */
  sendStatus?: 'idle' | 'pending' | 'accepted' | 'failed';
  /** Seconds remaining before another send is allowed (driven by the hook). */
  cooldownSeconds?: number;
  onSendOtp: () => void;
  onVerifyOtp: (otp: string) => void;
  onResendOtp: () => void;
  /** When provided, shows a "Change" link so the user can fix a wrong number. */
  onChangeNumber?: () => void;
}

/** "0701234473" -> "070 ••• 473" — enough to recognise the number, not to leak it. */
function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return phone;
  return `${digits.slice(0, 3)} ••• ${digits.slice(-3)}`;
}

function OtpDigitBox({ index, hasError, reduceMotion }: { index: number; hasError: boolean; reduceMotion: boolean }) {
  const { slots } = useContext(OTPInputContext);
  const { char, isActive, hasFakeCaret } = slots[index];

  return (
    <motion.div
      initial={reduceMotion ? false : { rotateX: -90, opacity: 0 }}
      animate={{ rotateX: 0, opacity: 1 }}
      transition={{ delay: reduceMotion ? 0 : index * 0.06, type: 'spring', stiffness: 260, damping: 20 }}
      style={{ transformPerspective: 400 }}
      className={cn(
        'relative flex h-12 w-10 items-center justify-center rounded-lg border-2 bg-background text-lg font-semibold transition-colors sm:w-11',
        hasError
          ? 'border-destructive bg-destructive/10 text-destructive'
          : isActive
            ? 'border-primary ring-2 ring-primary/30'
            : char
              ? 'border-primary/60'
              : 'border-input',
      )}
    >
      {char && (
        <motion.span
          key={char}
          initial={reduceMotion ? false : { scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 500, damping: 20 }}
        >
          {char}
        </motion.span>
      )}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-5 w-px animate-caret-blink bg-foreground duration-1000" />
        </div>
      )}
    </motion.div>
  );
}

function SendingAnimation({ phone, reduceMotion }: { phone: string; reduceMotion: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 py-2" role="status" aria-live="polite">
      <div className="relative flex w-48 items-center justify-between">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10">
          <ShieldCheck className="h-5 w-5 text-primary" />
        </div>
        {!reduceMotion && (
          <motion.div
            className="absolute left-10 top-1/2 -mt-3 rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-primary-foreground"
            initial={{ x: 0, opacity: 0 }}
            animate={{ x: [0, 72, 72], opacity: [0, 1, 0] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
          >
            SMS
          </motion.div>
        )}
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10">
          <Smartphone className="h-5 w-5 text-primary" />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Sending code to <span className="font-medium text-foreground">{maskPhone(phone)}</span>…
      </p>
    </div>
  );
}

function SuccessBurst({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <div className="relative flex h-10 w-10 items-center justify-center">
      {!reduceMotion && (
        <motion.span
          className="absolute inset-0 rounded-full bg-emerald-500/40"
          initial={{ scale: 1, opacity: 0.7 }}
          animate={{ scale: 2, opacity: 0 }}
          transition={{ duration: 0.9, ease: 'easeOut' }}
        />
      )}
      <motion.div
        className="relative flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500"
        initial={reduceMotion ? false : { scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 15 }}
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="white" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
          <motion.path
            d="M5 12.5l4.5 4.5L19 7.5"
            initial={reduceMotion ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ delay: 0.2, duration: 0.4, ease: 'easeOut' }}
          />
        </svg>
      </motion.div>
    </div>
  );
}

export function OtpVerificationStep({
  phone,
  otpSent,
  otpVerified,
  otpLoading,
  otpError,
  sendStatus,
  cooldownSeconds = 0,
  onSendOtp,
  onVerifyOtp,
  onResendOtp,
  onChangeNumber,
}: OtpVerificationStepProps) {
  const reduceMotion = !!useReducedMotion();
  const [otp, setOtp] = useState('');
  const [shakeKey, setShakeKey] = useState(0);
  const [showError, setShowError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // True once a full code has been submitted, so a later error (not a resend
  // failure) is what triggers the shake-and-clear.
  const submittedRef = useRef(false);

  // A failed verification: shake, clear the boxes, and put the cursor back.
  useEffect(() => {
    if (!otpError || !otpSent || otpVerified) {
      setShowError(false);
      return;
    }
    setShowError(true);
    if (submittedRef.current) {
      submittedRef.current = false;
      setShakeKey((k) => k + 1);
      setOtp('');
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [otpError, otpSent, otpVerified]);

  const handleResend = () => {
    // Guard against overlapping sends — the cooldown owns the timing.
    if (cooldownSeconds > 0 || otpLoading) return;
    setOtp('');
    submittedRef.current = false;
    onResendOtp();
  };

  const handleOtpChange = (value: string) => {
    setOtp(value);
    if (value.length === OTP_LENGTH) {
      submittedRef.current = true;
      onVerifyOtp(value);
    }
  };

  if (otpVerified) {
    return (
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-3 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20"
        role="status"
      >
        <SuccessBurst reduceMotion={reduceMotion} />
        <span className="text-sm text-emerald-600 dark:text-emerald-400 font-medium">
          Phone verified successfully
        </span>
      </motion.div>
    );
  }

  if (!otpSent) {
    if (otpLoading) {
      return <SendingAnimation phone={phone} reduceMotion={reduceMotion} />;
    }
    return (
      <Button
        type="button"
        onClick={onSendOtp}
        disabled={!phone}
        className="w-full gap-2 h-12 rounded-xl !text-white font-bold border-0 !bg-red-600 hover:!bg-red-700 animate-[pulse-red_1.2s_ease-in-out_infinite] shadow-lg"
      >
        <ShieldCheck className="h-4 w-4" />
        Verify Phone Number via SMS
      </Button>
    );
  }

  const filled = otp.length / OTP_LENGTH;

  return (
    <div className="space-y-3">
      <div className="text-center">
        <p className="text-sm text-muted-foreground">
          Enter the 6-digit code sent to <span className="font-medium text-foreground">{maskPhone(phone)}</span>
          {onChangeNumber && (
            <button type="button" onClick={onChangeNumber} className="ml-2 text-xs text-primary hover:underline">
              Change
            </button>
          )}
        </p>
      </div>

      {sendStatus === 'pending' && (
        <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Confirming the code was accepted by the network…
        </div>
      )}

      {sendStatus === 'accepted' && (
        <div className="flex items-center justify-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-3 w-3" />
          SMS network accepted it. If it does not arrive, resend will try another route.
        </div>
      )}

      {sendStatus === 'failed' && !otpError && (
        <div className="flex items-center justify-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="h-3 w-3" />
          The network rejected the code. Try resending.
        </div>
      )}

      <motion.div
        key={shakeKey}
        className="flex justify-center"
        animate={shakeKey > 0 && !reduceMotion ? { x: [0, -10, 10, -8, 8, -4, 4, 0] } : { x: 0 }}
        transition={{ duration: 0.45 }}
      >
        <InputOTP
          ref={inputRef}
          maxLength={OTP_LENGTH}
          value={otp}
          onChange={handleOtpChange}
          disabled={otpLoading}
          autoFocus
          autoComplete="one-time-code"
          inputMode="numeric"
          containerClassName="gap-1.5"
        >
          <div className="flex items-center gap-1.5">
            {Array.from({ length: OTP_LENGTH }, (_, i) => (
              <OtpDigitBox key={i} index={i} hasError={showError} reduceMotion={reduceMotion} />
            ))}
          </div>
        </InputOTP>
      </motion.div>

      <div className="mx-auto h-1 w-40 overflow-hidden rounded-full bg-muted" aria-hidden>
        <motion.div
          className="h-full rounded-full bg-primary"
          animate={{ width: `${filled * 100}%` }}
          transition={{ type: 'spring', stiffness: 200, damping: 25 }}
        />
      </div>

      {otpLoading && (
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          Verifying...
        </div>
      )}

      {otpError && (
        <motion.p
          initial={reduceMotion ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-sm text-destructive text-center"
          role="alert"
        >
          {otpError}
        </motion.p>
      )}

      <div className="text-center">
        <button
          type="button"
          onClick={handleResend}
          disabled={cooldownSeconds > 0 || otpLoading}
          className="text-xs text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
        >
          {cooldownSeconds > 0 ? (
            <span className="flex items-center gap-1 justify-center">
              <RefreshCw className="h-3 w-3" />
              Resend available in {cooldownSeconds}s
            </span>
          ) : (
            <span className="flex items-center gap-1 justify-center">
              <RefreshCw className="h-3 w-3" />
              Resend code
            </span>
          )}
        </button>
        {cooldownSeconds > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            If this SMS does not arrive, request another once the timer ends.
          </p>
        )}
      </div>
    </div>
  );
}
