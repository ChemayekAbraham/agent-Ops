// Centralized Welile SMS support footer.
//
// Every outbound SMS platform-wide must end with the standard support-contact
// footer. The line is composed from `SUPPORT_PHONE` (env var, single source of
// truth) with a stable default fallback so a missing env var never drops the
// footer.
//
// `appendSupportFooter` is idempotent: if the message already ends with (or
// contains) the footer, it is returned unchanged. This lets us apply it
// centrally in the SMS sender without worrying about callers that composed
// their own footer.

import { isSignupPromptSuppressed, looksLikeOtpMessage } from "./smsSignupPrompt.ts";

export const DEFAULT_SUPPORT_PHONE = "0748747134";

export function getSupportPhone(): string {
  const v = (Deno.env.get("SUPPORT_PHONE") ?? "").trim();
  return v || DEFAULT_SUPPORT_PHONE;
}

export function getSupportFooter(): string {
  return `For assistance, contact Welile Support on ${getSupportPhone()}.`;
}

// ── Sign-up prompt ────────────────────────────────────────────────────────
// Every non-OTP SMS also invites the recipient to join the platform. The URL
// is the in-house short link `welileapp.com/wjoin` which resolves to
// /join?r=<referrer> (see the `short_links` row with code `wjoin`), so taps are
// attributed and click-counted by the existing shortener.
export const DEFAULT_SIGNUP_SHORT_URL = "welileapp.com/wjoin";

export function getSignupShortUrl(): string {
  const v = (Deno.env.get("SIGNUP_SHORT_URL") ?? "").trim();
  return v || DEFAULT_SIGNUP_SHORT_URL;
}

export function getSignupPrompt(): string {
  return `Not on Welile yet? Sign up: ${getSignupShortUrl()}`;
}

function withSignupPrompt(message: string): string {
  if (isSignupPromptSuppressed()) return message;
  if (looksLikeOtpMessage(message)) return message;
  const prompt = getSignupPrompt();
  const url = getSignupShortUrl();
  // Idempotent: skip when the message already carries the join link.
  if (message.includes(url)) return message;
  const trimmed = message.replace(/\s+$/g, "");
  if (!trimmed) return prompt;
  return `${trimmed}\n${prompt}`;
}

export function appendSupportFooter(message: string): string {
  const msg = String(message ?? "");
  const footer = getSupportFooter();
  // Idempotent: any prior "contact Welile Support on <number>" mention wins.
  if (/contact\s+Welile\s+Support\s+on\s+\d/i.test(msg)) {
    return withSignupPrompt(msg.trimEnd());
  }
  const trimmed = msg.replace(/\s+$/g, "");
  if (!trimmed) return withSignupPrompt(footer);
  return withSignupPrompt(`${trimmed}\n\n${footer}`);
}
