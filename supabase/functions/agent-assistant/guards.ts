/**
 * Output guard: the last line of defence between the model and the user. It runs on the model's
 * final answer and checks it against what the tools actually returned. If anything fails, the
 * answer is withheld and a canned message is sent instead.
 *
 *   - no UUIDs or phone numbers that did not come from a tool result (leak check);
 *   - every figure of 1,000 or more must appear in a tool result or the user's own message
 *     (the model must not invent or compute money);
 *   - regulatory terminology: no "loan", "lender", "ROI", "interest".
 */

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PHONE = /(?:\+256|\b256|\b0)[\s-]?[1-9]\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/g;
const ISO_DATE_G = /\b\d{4}-\d{2}-\d{2}\b/g;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const BANNED_TERMS = /\b(loans?|lenders?|roi|interest)\b/i;

export type GuardResult =
  | { ok: true }
  | { ok: false; reason: "uuid" | "phone" | "figure" | "terminology" | "admin_trail" | "signature_claim" };

/**
 * Partner persona only: a missing partnership-agreement document is not a missing contract (most
 * partners accepted the Welile terms online), so the assistant must never tell a partner they did not
 * sign, have not signed, or hold an unsigned agreement.
 */
const SIGNATURE_CLAIM = /\b(?:haven['’]?t|have\s+not|hasn['’]?t|has\s+not|didn['’]?t|did\s+not|never|not\s+yet)\s+(?:formally\s+)?sign(?:ed)?\b|\bnot\s+(?:been\s+)?signed\b|\bunsigned\b/i;

/**
 * Partner persona only: a partner never sees reversals, corrections or adjustments, so the assistant
 * must not mention them, hint at them, or say there are none (that would be a false assurance, because
 * the tools deliberately leave them out).
 */
const ADMIN_TRAIL_TERMS = /\b(revers(?:e|ed|es|ing|al|als)|corrections?|corrected|adjust(?:ment|ments|ed)|admin(?:istrative)?\s+(?:correction|adjustment|edit|change)s?)\b/i;

function numericSet(texts: string[]): Set<number> {
  const out = new Set<number>();
  for (const text of texts) {
    for (const m of text.replace(ISO_DATE_G, " ").matchAll(NUMBER)) {
      const n = Number(m[0].replace(/,/g, ""));
      if (Number.isFinite(n)) out.add(n);
    }
  }
  return out;
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

/**
 * The significant digits of a Ugandan number: +256701111222, 256701111222 and 0701 111 222 are the
 * same person, so all compare as 701111222. Lets the assistant restate a number in the local format.
 */
function nationalDigits(s: string): string {
  return digitsOnly(s).replace(/^256/, "").replace(/^0/, "");
}

/** What to tell the model when its draft fails the guard, so its one retry can fix the problem. */
export const RETRY_NOTE: Record<Exclude<GuardResult, { ok: true }>["reason"], string> = {
  terminology:
    'Your draft used a banned word. Never write "loan", "lender", "ROI" or "interest". Say "Rent Plan", "Supporter" and "Returns", and "no extra charges" instead of "no interest". If the user used the banned word, do not repeat it: answer using the approved words.',
  signature_claim:
    "Your draft said or implied the partner did not sign. Never say that: a missing document is not a missing contract. Call get_partner_contract and use its state: if they accepted the Welile terms online, say so (version and latest date) and list their portfolio terms; if an agreement is awaiting Welile's countersignature, say that; only if nothing is on record say you cannot find an agreement on the account yet. Offer to pass it to support if they expect a separate signed copy.",
  admin_trail:
    "Your draft mentioned reversals, corrections or adjustments. Never mention them, never say there are none, and never guess. Say you can show their top-ups, renewals, Returns and wallet activity as they appear on the account, give the figures you do have, and offer to pass the question to support.",
  figure:
    "Your draft contained a money figure that is not in the tool results. Use only figures copied exactly from the tool results, and do no arithmetic. If a figure is not available, say you do not have it.",
  uuid: "Your draft contained an id that is not in the tool results. Do not include ids.",
  phone: "Your draft contained a phone number that is not in the tool results. Do not include phone numbers.",
};

/** Repairs banned wording (used only when the retry still fails); never touches figures or ids. */
export function cleanTerms(text: string): string {
  return text
    .replace(/\bno interest\b/gi, "no extra charges")
    .replace(/\binterest\b/gi, "charges")
    .replace(/\bloans\b/gi, "Rent Plans")
    .replace(/\bloan\b/gi, "Rent Plan")
    .replace(/\blenders\b/gi, "Supporters")
    .replace(/\blender\b/gi, "Supporter")
    .replace(/\broi\b/gi, "Returns");
}

/** Cuts at the last sentence end within max characters; if there is none, at the last space. */
export function trimToSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf(".\n"));
  if (end > max * 0.5) return head.slice(0, end + 1).trim();
  const space = head.lastIndexOf(" ");
  return (space > 0 ? head.slice(0, space) : head).trim();
}

export function checkAnswer(
  answer: string,
  toolOutputs: string[],
  userMessage: string,
  opts: { hideAdminTrail?: boolean; noSignatureClaims?: boolean } = {},
): GuardResult {
  if (BANNED_TERMS.test(answer)) return { ok: false, reason: "terminology" };
  if (opts.hideAdminTrail && ADMIN_TRAIL_TERMS.test(answer)) return { ok: false, reason: "admin_trail" };
  if (opts.noSignatureClaims && SIGNATURE_CLAIM.test(answer)) return { ok: false, reason: "signature_claim" };

  const sources = [...toolOutputs, userMessage];
  const haystack = sources.join("\n").toLowerCase();

  for (const m of answer.matchAll(UUID)) {
    if (!haystack.includes(m[0].toLowerCase())) return { ok: false, reason: "uuid" };
  }

  const sourceDigits = digitsOnly(sources.join(" "));
  for (const m of answer.matchAll(PHONE)) {
    if (!sourceDigits.includes(nationalDigits(m[0]))) return { ok: false, reason: "phone" };
  }

  // Phone numbers were just verified above; they are not money, so keep them out of the figure check.
  const known = numericSet(sources);
  for (const m of answer.replace(PHONE, " ").replace(ISO_DATE_G, " ").replace(UUID, " ").matchAll(NUMBER)) {
    const raw = m[0];
    const n = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 1000) continue;
    // A bare four-digit number in the plausible-year range is a year, not money.
    if (!raw.includes(",") && !raw.includes(".") && n >= 1990 && n <= 2100) continue;
    if (!known.has(n)) return { ok: false, reason: "figure" };
  }

  return { ok: true };
}
