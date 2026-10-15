// Centralized Welile SMS support footer.
//
// Both boilerplate lines are deliberately short (~45 chars together incl.
// newlines): Yoola bills per 160-char segment (70 with unicode), and the old
// ~97-char boilerplate pushed most messages into a second or third segment.
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
  return `Help: ${getSupportPhone()}`;
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
  return `Join Welile: ${getSignupShortUrl()}`;
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
  const withPrompt = `${trimmed}\n${prompt}`;
  // The join line is the lowest-value text on the message: when it would push
  // the SMS past one segment it is dropped, never the message or the footer.
  if (withPrompt.length > SMS_SEGMENT_CHARS) return message;
  return withPrompt;
}

export const SMS_SEGMENT_CHARS = 160;

// Characters outside GSM-7 force the whole message into 70-char segments.
// Swap the common ones for ASCII equivalents (meaning unchanged).
const GSM_REPLACEMENTS: Array<[RegExp, string]> = [
  [/[‘’‛]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—]/g, "-"],
  [/…/g, "..."],
  [/[•·]/g, "*"],
  [/×/g, "x"],
  [/→/g, "->"],
  [/ /g, " "],
  [/[✓✔]/g, "OK"],
];

export function toGsmSafe(message: string): string {
  let out = message;
  for (const [re, rep] of GSM_REPLACEMENTS) out = out.replace(re, rep);
  return out;
}

export function appendSupportFooter(message: string): string {
  const msg = toGsmSafe(String(message ?? ""));
  const footer = getSupportFooter();
  // Idempotent: any prior support-number mention wins. Matches the short
  // "Help: <number>" footer and the legacy "contact Welile Support on <number>".
  if (/(contact\s+Welile\s+Support\s+on|\bHelp:)\s*\d/i.test(msg)) {
    return withSignupPrompt(msg.trimEnd());
  }
  const trimmed = msg.replace(/\s+$/g, "");
  if (!trimmed) return withSignupPrompt(footer);
  return withSignupPrompt(`${trimmed}\n${footer}`);
}
