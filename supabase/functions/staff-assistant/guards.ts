// Deterministic post-generation checks on the model's answer and draft card text for Zoe (My Space Staff Assistant).
// The model cannot talk its way past these: if a check fails, the answer or draft is discarded.

const BANNED_TERMS = /\b(loans?|lenders?|roi|interest)\b/i;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Ugandan local or international phone numbers (07xx..., +2567..., 2567...).
// Note: masked phones like "+256 7•• ••• 123" do not match this regex because of the bullet characters.
const PHONE_RE = /(?:\+?256|0)\s*7\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/g;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
// Year-month period code e.g. 2026-10
const YEAR_MONTH_RE = /\b20[23]\d-(?:0[1-9]|1[0-2])\b/g;
// HH:MM or HH:MM:SS time tokens e.g. 07:30, 09:00, 23:59:59
const TIME_RE = /\b(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/g;
// Compact shorthand figures like "1.2M", "48.5M", "850K", "1.48B", "1.5k"
const SHORTHAND_RE = /\b(\d+(?:,\d{3})*(?:\.\d+)?)\s*([kmbKMB])\b/g;
// Percentages like "84.5%", "100%", "12%"
const PERCENT_RE = /\b(\d+(?:\.\d+)?)\s*%/g;
// Decimal numbers like "84.5", "1,234.56"
const DECIMAL_RE = /\b\d{1,3}(?:,\d{3})*\.\d+|\b\d+\.\d+\b/g;
// Integer numbers with or without commas (supports digits adjacent to underscores inside JSON keys like expiring_within_30_days)
const INTEGER_RE = /\d{1,3}(?:,\d{3})+|\d+/g;

export const SYSTEM_PROMPT_LEAK_RE =
  /You are Zoe, Welile's read-only staff assistant|You are Zoe, the Welile My Space Staff Assistant|NON-NEGOTIABLE RULES \(enforced by server|SCOPE_CHECK_PROMPT|SUPABASE_SERVICE[_]ROLE[_]KEY|LOVABLE[_]API[_]KEY|SECURITY DEFINER|<UNTRUSTED_TOOL_DATA/i;

export const DIRECT_PROMPT_INJECTION_RE =
  /ignore (all |any )?(previous|prior) instructions|print your (full )?system prompt|reveal your (system prompt|instructions|hidden rules)|developer mode|jailbreak|what is your LOVABLE[_]API[_]KEY|SUPABASE_SERVICE[_]ROLE[_]KEY|show the raw sql of/i;

export const WRITE_MUTATION_INTENT_RE =
  /\b(approve|reject|disburse|credit|debit|transfer|delete|update|modify|edit|reset)\b.*\b(requisition|wallet|balance|ledger|payslip|salary|advance|rent plan|landlord|payout)\b/i;

export function containsPromptOrSecretLeak(text: string): boolean {
  return SYSTEM_PROMPT_LEAK_RE.test(text);
}

export function isDirectPromptInjection(text: string): boolean {
  return DIRECT_PROMPT_INJECTION_RE.test(text);
}

export function isWriteMutationIntent(text: string): boolean {
  return WRITE_MUTATION_INTENT_RE.test(text);
}

function canonPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.startsWith("0") ? `256${digits.slice(1)}` : digits;
}

function phonesIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(PHONE_RE)) out.add(canonPhone(m[0]));
  return out;
}

function isoDatesIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(ISO_DATE_RE)) out.add(m[0]);
  return out;
}

const WORD_NUMBERS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fourteen: 14,
  thirty: 30,
  sixty: 60,
  ninety: 90,
};

export interface AllowedNumbersPool {
  exactNumbers: Set<number>;
  rawFloats: number[];
}

/**
 * Extracts a string Set of all numeric tokens present in `rawText` (including JSON numbers,
 * integers with/without commas, decimals, and rounded forms) for deterministic calculator verification.
 */
export function extractNumbers(rawText: string): Set<string> {
  const pool = buildAllowedNumbersPool([rawText], "");
  const out = new Set<string>();
  for (const n of pool.exactNumbers) {
    out.add(String(n));
    out.add(String(Math.round(n)));
    out.add(String(Math.round(n * 10) / 10));
    out.add(String(Math.round(n * 100) / 100));
  }
  return out;
}

/**
 * Extract all numeric values from tool outputs and the user's message.
 * Also includes array lengths inside JSON tool outputs so row counts are always grounded,
 * and derives ratios/percentages when a tool returns numerator + denominator counts.
 */
function buildAllowedNumbersPool(toolOutputs: readonly string[], userMessage: string): AllowedNumbersPool {
  const exactNumbers = new Set<number>([0, 1]);
  const rawFloats: number[] = [0, 1];

  const addNum = (n: number) => {
    if (!Number.isFinite(n)) return;
    rawFloats.push(n);
    exactNumbers.add(n);
    exactNumbers.add(Math.round(n));
    exactNumbers.add(Number(n.toFixed(1)));
    exactNumbers.add(Number(n.toFixed(2)));
    // If n is a ratio in [0, 1], also register its percentage 0..100
    if (n > 0 && n <= 1) {
      const pct = n * 100;
      rawFloats.push(pct);
      exactNumbers.add(Math.round(pct));
      exactNumbers.add(Number(pct.toFixed(1)));
      exactNumbers.add(Number(pct.toFixed(2)));
    }
  };

  const walkJson = (val: unknown) => {
    if (typeof val === "number") {
      addNum(val);
      return;
    }
    if (typeof val === "string") {
      for (const m of val.matchAll(DECIMAL_RE)) {
        addNum(Number(m[0].replace(/,/g, "")));
      }
      for (const m of val.matchAll(INTEGER_RE)) {
        addNum(Number(m[0].replace(/,/g, "")));
      }
      return;
    }
    if (Array.isArray(val)) {
      addNum(val.length);
      for (const item of val) walkJson(item);
      return;
    }
    if (val && typeof val === "object") {
      const obj = val as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        for (const m of k.matchAll(INTEGER_RE)) {
          addNum(Number(m[0].replace(/,/g, "")));
        }
        walkJson(v);
      }
    }
  };

  for (const raw of toolOutputs) {
    try {
      const parsed = JSON.parse(raw);
      walkJson(parsed);
    } catch {
      // Fallback regex scan if not pure JSON
    }
    const scrubbed = raw.replace(UUID_RE, " ");
    for (const m of scrubbed.matchAll(DECIMAL_RE)) {
      addNum(Number(m[0].replace(/,/g, "")));
    }
    for (const m of scrubbed.matchAll(INTEGER_RE)) {
      addNum(Number(m[0].replace(/,/g, "")));
    }
  }

  const userScrubbed = userMessage.replace(UUID_RE, " ");
  for (const m of userScrubbed.matchAll(SHORTHAND_RE)) {
    const base = Number(m[1].replace(/,/g, ""));
    const mult = m[2].toLowerCase() === "b" ? 1e9 : m[2].toLowerCase() === "m" ? 1e6 : 1e3;
    addNum(base);
    addNum(base * mult);
  }
  for (const m of userScrubbed.matchAll(DECIMAL_RE)) {
    addNum(Number(m[0].replace(/,/g, "")));
  }
  for (const m of userScrubbed.matchAll(INTEGER_RE)) {
    addNum(Number(m[0].replace(/,/g, "")));
  }
  for (const [word, num] of Object.entries(WORD_NUMBERS)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(userMessage)) {
      addNum(num);
    }
  }

  // Also allow simple pairwise ratios (a / b * 100) for small sets of tool figures so legitimate percentages pass
  const boundedFloats = rawFloats.filter((x) => x > 0).slice(0, 60);
  for (let i = 0; i < boundedFloats.length; i++) {
    for (let j = 0; j < boundedFloats.length; j++) {
      if (i === j) continue;
      const a = boundedFloats[i];
      const b = boundedFloats[j];
      if (a <= b && b > 0) {
        const pct = (a / b) * 100;
        exactNumbers.add(Math.round(pct));
        exactNumbers.add(Number(pct.toFixed(1)));
        exactNumbers.add(Number(pct.toFixed(2)));
      }
    }
  }

  return { exactNumbers, rawFloats };
}

/**
 * Strip structural non-data tokens from an answer or draft before scanning for numbers:
 * - Trailing `Source: ... · Period: ...` citation line
 * - UUIDs, ISO dates (`YYYY-MM-DD`), year-month codes (`YYYY-MM`), `HH:MM` times, phones, masked phones (`+256 7•• ••• 412`)
 * - Reference codes like `WEL-STF-019`, `TSK-401`, `TCK-112`, `REQ-2026-214`, `A1`, `A5`, `A10`, `A21`, `A22`, `LC1`, `v2`
 * - Markdown numbered list prefixes (`1. `, `2) `) at the start of a line
 * - Fixed domain bucket/label ranges (`1-7`, `8-14`, `15-30`, `31-60`, `61-90`, `31_60`, `First 7 Days`, `week-1`)
 */
function scrubStructuralTokens(text: string): string {
  return text
    .replace(/\n*Source:\s*[^\n]+$/im, " ")
    .replace(UUID_RE, " ")
    .replace(ISO_DATE_RE, " ")
    .replace(YEAR_MONTH_RE, " ")
    .replace(TIME_RE, " ")
    .replace(PHONE_RE, " ")
    .replace(/\+?256\s*7[•*xX\d\s-]{6,14}\b/g, " ")
    .replace(/\b[A-Z]{2,5}-[A-Z0-9-]+\b/g, " ")
    .replace(/\b(?:A1|A5|A10|A19|A21|A22|L1|L9|X4|LC1|AAL1|AAL2|v\d+)\b/gi, " ")
    .replace(/\b(?:1[-_]7|8[-_]14|15[-_]30|31[-_]60|61[-_]90|90_plus)\b/gi, " ")
    .replace(/\bfirst\s+7\s+days\b/gi, " ")
    .replace(/\bweek[-_\s]?1\b/gi, " ")
    .replace(/^\s*\d+[.)]\s+/gm, " ");
}

function matchesShorthand(base: number, unit: string, pool: AllowedNumbersPool): boolean {
  const mult = unit === "b" ? 1e9 : unit === "m" ? 1e6 : 1e3;
  const expanded = base * mult;
  if (
    pool.exactNumbers.has(expanded) ||
    pool.exactNumbers.has(Math.round(expanded)) ||
    pool.exactNumbers.has(base)
  ) {
    return true;
  }
  // Check if any tool figure rounds to `base` in that unit (e.g. 1,234,567 -> "1.2M" or "1.23M")
  for (const actual of pool.rawFloats) {
    if (actual <= 0) continue;
    const scaled = actual / mult;
    if (
      Math.abs(scaled - base) <= 0.051 ||
      Number(scaled.toFixed(1)) === Number(base.toFixed(1)) ||
      Number(scaled.toFixed(2)) === Number(base.toFixed(2)) ||
      Math.round(scaled) === base
    ) {
      return true;
    }
  }
  return false;
}

function matchesDecimalOrPercent(val: number, pool: AllowedNumbersPool): boolean {
  if (
    pool.exactNumbers.has(val) ||
    pool.exactNumbers.has(Number(val.toFixed(1))) ||
    pool.exactNumbers.has(Number(val.toFixed(2)))
  ) {
    return true;
  }
  for (const actual of pool.rawFloats) {
    if (
      Math.abs(actual - val) <= 0.051 ||
      Number(actual.toFixed(1)) === Number(val.toFixed(1)) ||
      Number(actual.toFixed(2)) === Number(val.toFixed(2))
    ) {
      return true;
    }
  }
  return false;
}

export type GuardResult =
  | { ok: true }
  | {
      ok: false;
      reason: "terminology" | "prompt_leak" | "uuid" | "phone" | "date" | "figure";
    };

/**
 * Verify that `answer`:
 *  1. uses mandatory Welile regulatory terminology (no "loan", "lender", "ROI", "interest");
 *  2. leaks no system prompt or secret marker;
 *  3. leaks no UUID that wasn't in a tool output;
 *  4. includes no unmasked phone number unless that exact phone was in a tool output;
 *  5. invents no ISO date (`YYYY-MM-DD`) that wasn't in a tool output or the user's message;
 *  6. invents no number — checking every count (including < 1,000), percentage, decimal, and
 *     "1.2M"/"850K"/"1.48B"-style shorthand figure against tool outputs and the user's message.
 */
export function checkAnswer(
  answer: string,
  toolOutputs: string[],
  userMessage: string,
): GuardResult {
  if (BANNED_TERMS.test(answer)) return { ok: false, reason: "terminology" };
  if (containsPromptOrSecretLeak(answer)) return { ok: false, reason: "prompt_leak" };

  const joinedTools = toolOutputs.join("\n").toLowerCase();

  for (const m of answer.matchAll(UUID_RE)) {
    if (!joinedTools.includes(m[0].toLowerCase())) return { ok: false, reason: "uuid" };
  }

  const allowedPhones = phonesIn(joinedTools);
  for (const p of phonesIn(answer)) {
    if (!allowedPhones.has(p)) return { ok: false, reason: "phone" };
  }

  // Strip the trailing Source · Period line before checking dates/numbers in the body
  const bodyWithoutSourceFooter = answer.replace(/\n*Source:\s*[^\n]+$/im, " ");

  const allowedDates = isoDatesIn(joinedTools);
  for (const d of isoDatesIn(userMessage)) allowedDates.add(d);
  for (const d of isoDatesIn(bodyWithoutSourceFooter)) {
    if (!allowedDates.has(d)) return { ok: false, reason: "date" };
  }

  const pool = buildAllowedNumbersPool(toolOutputs, userMessage);
  let scrubbed = scrubStructuralTokens(bodyWithoutSourceFooter);

  // 1. Check compact shorthand figures ("1.2M", "850K", "1.48B")
  for (const m of scrubbed.matchAll(SHORTHAND_RE)) {
    const base = Number(m[1].replace(/,/g, ""));
    const unit = m[2].toLowerCase();
    if (!Number.isFinite(base) || !matchesShorthand(base, unit, pool)) {
      return { ok: false, reason: "figure" };
    }
  }
  scrubbed = scrubbed.replace(SHORTHAND_RE, " ");

  // 2. Check percentages ("84.5%", "15%")
  for (const m of scrubbed.matchAll(PERCENT_RE)) {
    const pct = Number(m[1]);
    if (!Number.isFinite(pct) || !matchesDecimalOrPercent(pct, pool)) {
      return { ok: false, reason: "figure" };
    }
  }
  scrubbed = scrubbed.replace(PERCENT_RE, " ");

  // 3. Check decimal figures ("12.5", "1,234.56")
  for (const m of scrubbed.matchAll(DECIMAL_RE)) {
    const dec = Number(m[0].replace(/,/g, ""));
    if (!Number.isFinite(dec) || !matchesDecimalOrPercent(dec, pool)) {
      return { ok: false, reason: "figure" };
    }
  }
  scrubbed = scrubbed.replace(DECIMAL_RE, " ");

  // 4. Check all integers and counts (including < 1000)
  for (const m of scrubbed.matchAll(INTEGER_RE)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    // Allow calendar years 2020..2035 when mentioned alongside month names (e.g. "October 2026")
    if (n >= 2020 && n <= 2035 && allowedDates.size > 0) {
      const yearStr = String(n);
      if ([...allowedDates].some((d) => d.startsWith(yearStr))) continue;
    }
    if (!pool.exactNumbers.has(n) && !pool.exactNumbers.has(Math.round(n))) {
      return { ok: false, reason: "figure" };
    }
  }

  return { ok: true };
}

/**
 * Run the exact same terminology, leak, UUID, phone, date, and number checks
 * on AI-written draft card text (`subject`, `message`, `title`, `note`, `custom_message`).
 */
export function checkDraftCardText(
  fields: ReadonlyArray<string | null | undefined>,
  toolOutputs: string[],
  userMessage: string,
): GuardResult {
  for (const field of fields) {
    if (!field || !field.trim()) continue;
    const res = checkAnswer(field, toolOutputs, userMessage);
    if (!res.ok) return res;
  }
  return { ok: true };
}
