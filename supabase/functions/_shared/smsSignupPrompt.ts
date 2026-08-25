// Per-process opt-out switch for the platform-wide SMS sign-up prompt.
//
// Authentication / OTP messages must NEVER carry marketing copy: they are
// time-critical, must stay in one SMS segment, and a second link next to a
// verification code is a phishing-shaped pattern.
//
// Each OTP-sending edge function calls `suppressSignupPrompt()` at module load
// (side-effect import is enough). The footer decorator reads the flag and skips
// the prompt for every send in that isolate.

const FLAG = "__welile_sms_signup_prompt_suppressed__";

export function suppressSignupPrompt(): void {
  (globalThis as any)[FLAG] = true;
}

export function isSignupPromptSuppressed(): boolean {
  return (globalThis as any)[FLAG] === true;
}

// Content backstop: even if a new OTP function forgets to opt out, anything
// that looks like a code / credential delivery is skipped.
const OTP_CONTENT_RE =
  /(verification\s+code|reset\s+code|temporary\s+password|deposit\s+code|one[-\s]?time\s+(code|password)|\bOTP\b)/i;

export function looksLikeOtpMessage(message: string): boolean {
  return OTP_CONTENT_RE.test(String(message ?? ""));
}
