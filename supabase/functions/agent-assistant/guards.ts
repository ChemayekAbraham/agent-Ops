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

export type GuardResult = { ok: true } | { ok: false; reason: "uuid" | "phone" | "figure" | "terminology" };

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

export function checkAnswer(answer: string, toolOutputs: string[], userMessage: string): GuardResult {
  if (BANNED_TERMS.test(answer)) return { ok: false, reason: "terminology" };

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
