// Deterministic post-generation checks on the model's answer for Zoe (My Space Staff Assistant).
// The model cannot talk its way past these: if a check fails, the answer is discarded.

const BANNED_TERMS = /\b(loans?|lenders?|roi|interest)\b/i;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Ugandan local or international phone numbers (07xx..., +2567..., 2567...).
// Note: masked phones like "+256 7•• ••• 123" do not match this regex because of the bullet characters.
const PHONE_RE = /(?:\+?256|0)\s*7\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/g;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const NUMBER_RE = /\b\d{1,3}(?:,\d{3})+|\b\d+\b/g;

function canonPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.startsWith("0") ? `256${digits.slice(1)}` : digits;
}

function phonesIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(PHONE_RE)) out.add(canonPhone(m[0]));
  return out;
}

/** Extract every integer / decimal number (with or without commas) after stripping dates and phones. */
function numbersIn(text: string): Set<number> {
  const scrubbed = text.replace(ISO_DATE_RE, " ").replace(PHONE_RE, " ");
  const out = new Set<number>();
  for (const m of scrubbed.matchAll(NUMBER_RE)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.add(Math.round(n));
  }
  return out;
}

export type GuardResult =
  | { ok: true }
  | { ok: false; reason: "terminology" | "uuid" | "phone" | "figure" };

/**
 * Verify that `answer`:
 *  1. uses mandatory Welile regulatory terminology (no "loan", "lender", "ROI", "interest");
 *  2. leaks no UUID that wasn't in a tool output;
 *  3. includes no unmasked phone number unless that exact phone was in a tool output;
 *  4. invents no money-sized figure (>= 1,000, excluding calendar years 2020–2035) that wasn't
 *     in a tool output or the user's own message.
 */
export function checkAnswer(answer: string, toolOutputs: string[], userMessage: string): GuardResult {
  if (BANNED_TERMS.test(answer)) return { ok: false, reason: "terminology" };

  const joinedTools = toolOutputs.join("\n").toLowerCase();

  for (const m of answer.matchAll(UUID_RE)) {
    if (!joinedTools.includes(m[0].toLowerCase())) return { ok: false, reason: "uuid" };
  }

  const allowedPhones = phonesIn(joinedTools);
  for (const p of phonesIn(answer)) {
    if (!allowedPhones.has(p)) return { ok: false, reason: "phone" };
  }

  const allowed = numbersIn(joinedTools);
  for (const n of numbersIn(userMessage)) allowed.add(n);

  for (const n of numbersIn(answer)) {
    if (n < 1000) continue; // small counts ("3 tasks", "7 days") and list numbers
    if (n >= 2020 && n <= 2035) continue; // calendar years
    if (!allowed.has(n)) return { ok: false, reason: "figure" };
  }

  return { ok: true };
}
