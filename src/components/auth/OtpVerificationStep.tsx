import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Loader2, CheckCircle2, RefreshCw, ShieldCheck, AlertCircle } from 'lucide-react';

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
}: OtpVerificationStepProps) {
  const [otp, setOtp] = useState('');

  const handleSend = () => {
    onSendOtp();
  };

  const handleResend = () => {
    // Guard against overlapping sends — the cooldown owns the timing.
    if (cooldownSeconds > 0 || otpLoading) return;
    setOtp('');
    onResendOtp();
  };

  const handleOtpComplete = (value: string) => {
    setOtp(value);
    if (value.length === 6) {
      onVerifyOtp(value);
    }
  };

  if (otpVerified) {
    return (
      <div className="flex items-center gap-2 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
        <CheckCircle2 className="h-5 w-5 text-emerald-500" />
        <span className="text-sm text-emerald-600 dark:text-emerald-400 font-medium">
          Phone verified successfully
        </span>
      </div>
    );
  }

  if (!otpSent) {
    return (
      <Button
        type="button"
        onClick={handleSend}
        disabled={otpLoading || !phone}
        className="w-full gap-2 h-12 rounded-xl !text-white font-bold border-0 !bg-red-600 hover:!bg-red-700 animate-[pulse-red_1.2s_ease-in-out_infinite] shadow-lg"
      >
        {otpLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ShieldCheck className="h-4 w-4" />
        )}
        Verify Phone Number via SMS
      </Button>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-center">
        <p className="text-sm text-muted-foreground">
          Enter the 6-digit code sent to <span className="font-medium text-foreground">{phone}</span>
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

      <div className="flex justify-center">
        <InputOTP maxLength={6} value={otp} onChange={handleOtpComplete}>
          <InputOTPGroup>
            <InputOTPSlot index={0} />
            <InputOTPSlot index={1} />
            <InputOTPSlot index={2} />
            <InputOTPSlot index={3} />
            <InputOTPSlot index={4} />
            <InputOTPSlot index={5} />
          </InputOTPGroup>
        </InputOTP>
      </div>

      {otpLoading && (
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Verifying...
        </div>
      )}

      {otpError && (
        <p className="text-sm text-destructive text-center">{otpError}</p>
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
