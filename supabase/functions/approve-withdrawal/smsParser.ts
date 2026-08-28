/**
 * SMS / email transaction parser.
 *
 * Pure, dependency-free extractor used by the "Paste from SMS" button in
 * `DepositFlow` AND by the gmail-poll-transactions edge function. Given
 * the raw text of a MoMo / Airtel Money / bank confirmation message,
 * pulls out every field we know how to recover.
 *
 * Any field that can't be confidently parsed is left undefined — the
 * caller must hard-block submission until the required ones are set.
 *
 * A mirror of this module lives at `src/utils/smsParser.ts` (Deno edge
 * functions bundle only their own directory, so the two copies can't
 * share an import) — keep the two in sync.
 */

export type TxDirection = 'in' | 'out' | 'charge';
export type TxChannel = 'mtn_momo' | 'airtel_money' | 'bank' | 'other';

export interface ParsedSMS {
  amount?: number;          // primary transaction amount in UGX
  fee?: number;             // charge/fee in UGX
  balance?: number;         // post-transaction balance in UGX
  transactionId?: string;
  date?: string;            // YYYY-MM-DD
  time?: string;            // HH:MM 24h
  direction?: TxDirection;
  channel?: TxChannel;
  counterparty?: string;    // name or phone of the other party
}

// ─── helpers ─────────────────────────────────────────────────────────────
const MONTH_MAP: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function normaliseDate(raw: string): string | undefined {
  const trimmed = raw.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const dmy = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (dmy) {
    let [, d, m, y] = dmy;
    if (y.length === 2) y = `20${y}`;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return undefined;
}

function normaliseNamedDate(d: string, mon: string, y: string): string | undefined {
  const mm = MONTH_MAP[mon.slice(0, 3).toLowerCase()];
  if (!mm) return undefined;
  const yyyy = y.length === 2 ? `20${y}` : y;
  return `${yyyy}-${mm}-${d.padStart(2, '0')}`;
}

function normaliseTime(raw: string): string | undefined {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s?(AM|PM)?$/i);
  if (!m) return undefined;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ampm = m[3]?.toUpperCase();
  if (ampm === 'PM' && hh < 12) hh += 12;
  if (ampm === 'AM' && hh === 12) hh = 0;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return undefined;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function toInt(raw: string): number | undefined {
  const n = Math.round(parseFloat(raw.replace(/,/g, '')));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ─── shared field extractors (used by parseSMS AND parsePayoutConfirmationSms) ──
/** YYYY-MM-DD, or undefined if no date pattern is found/valid. */
export function extractDate(t: string): string | undefined {
  const numericDate = t.match(/\b(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/);
  if (numericDate) {
    const norm = normaliseDate(numericDate[1]);
    if (norm) return norm;
  }
  const named = t.match(/\b(\d{1,2})[\s/-](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s/-](\d{2,4})\b/i);
  if (named) {
    const norm = normaliseNamedDate(named[1], named[2], named[3]);
    if (norm) return norm;
  }
  return undefined;
}

/** HH:MM 24h, or undefined if no time pattern is found/valid. */
export function extractTime(t: string): string | undefined {
  const timeMatch = t.match(/\b(\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM)?)\b/i);
  if (!timeMatch) return undefined;
  return normaliseTime(timeMatch[1]);
}

/**
 * The recipient/sender phone number as shown in the SMS, if any. Checked in
 * order: right after "from"/"to"/"by" (the counterparty), in parentheses
 * after a name ("JOHN DOE (0700123456)"), then any Uganda-shaped number
 * anywhere in the text.
 */
export function extractPhone(t: string): string | undefined {
  const afterVerb = t.match(/\b(?:from|to|by)\s+((?:\+?256|0)\d{9})\b/);
  if (afterVerb) return afterVerb[1];
  const parens = t.match(/\(\s*((?:\+?256|0)\d{9})\s*\)/);
  if (parens) return parens[1];
  const anywhere = t.match(/\b((?:\+?256|0)\d{9})\b/);
  return anywhere ? anywhere[1] : undefined;
}

// Currency token covering every common Ugandan spelling/spacing seen on MoMo,
// Airtel Money and bank SMS: UGX, USh, UShs, U.Sh, U.Shs, UGShs, Shs, Sh,
// Ush. — case-insensitive at the call sites. Keep this shared so amount, fee
// and balance extraction all recognise the same set.
const CUR = String.raw`(?:UGX|UG\.?Shs?|U\.?Shs?|U\.?Sh\.?|Shs?|Ush\.?)`;
// Trailing currency form ("50,000/=", "50,000 UGX", "50,000/-").
const CUR_SUFFIX = String.raw`(?:${CUR}|/[=-])`;
// One amount token: optional currency prefix, digits with commas, optional decimals.
const AMT = String.raw`${CUR}?\s*\.?\s*([\d][\d,]*(?:\.\d+)?)`;

// ─── main parser ─────────────────────────────────────────────────────────
export function parseSMS(text: string): ParsedSMS {
  const out: ParsedSMS = {};
  if (!text) return out;
  const t = text.replace(/\s+/g, ' ').trim();
  const lower = t.toLowerCase();

  // ── Channel (heuristic) ────────────────────────────────────────────
  if (/\bmomo\b|mtn mobile money|mtn momo|\bmtn\b/i.test(t)) out.channel = 'mtn_momo';
  else if (/airtel money|\bairtel\b|\btid\b/i.test(t)) out.channel = 'airtel_money';
  else if (/\bbank\b|stanbic|centenary|dfcu|equity|absa|stanchart|standard chartered|housing finance|citibank|kcb|ncba|baroda|tropical|ecobank|orient|finance trust|opportunity bank|post bank|cairo bank/i.test(t))
    out.channel = 'bank';
  else out.channel = 'other';

  // ── Direction ──────────────────────────────────────────────────────
  if (/\b(received|deposited|credited|you have received|payment received|recd from|cash in|deposit of)\b/i.test(t))
    out.direction = 'in';
  else if (/\b(sent|paid|withdrawn|withdrew|debited|cash out|transferred to|payment to|purchase of|bought)\b/i.test(t))
    out.direction = 'out';
  else if (/\b(charge|fee|fees|tax|levy)\b/i.test(t) && !/charge\s*[:\-]?\s*(?:ugx)?\s*0\b/i.test(t))
    out.direction = 'charge';

  // ── Fee (extract before main amount so we can exclude it) ──────────
  const feeMatch = t.match(new RegExp(String.raw`(?:Charge|Fee|Fees|Tax|Levy)\s*[:.\-]?\s*` + AMT, 'i'));
  if (feeMatch) out.fee = toInt(feeMatch[1]);

  // ── Balance (post-tx) ──────────────────────────────────────────────
  const balMatch = t.match(new RegExp(String.raw`(?:New\s+balance|Balance|Bal)\s*[:.\-]?\s*` + AMT, 'i'));
  if (balMatch) out.balance = toInt(balMatch[1]);

  // ── Primary amount ─────────────────────────────────────────────────
  // Strategy: prefer an amount that follows a strong verb (received/sent/paid/
  // deposited/withdrawn/of). Fall back to the first currency-prefixed amount
  // that is NOT the fee or balance we already extracted.
  const verbAmt = t.match(new RegExp(
    String.raw`(?:received|deposited|credited|sent|paid|withdrew|withdrawn|debited|transferred|payment of|amount of|sum of|of)\s+` + AMT,
    'i',
  ));
  if (verbAmt) out.amount = toInt(verbAmt[1]);

  if (out.amount === undefined) {
    // First try currency-prefixed amounts, then amounts with a trailing
    // currency/"/=" suffix — always skipping fee/balance/charge tokens.
    const amountRe = new RegExp(String.raw`${CUR}\s*\.?\s*([\d][\d,]*(?:\.\d+)?)`, 'gi');
    const skipRe = /(bal(?:ance)?|charge|fee|fees|tax|levy|new\s*balance)\s*[:.\-]?\s*$/i;
    let firstAmt: number | undefined; let chosen: number | undefined;
    for (const m of t.matchAll(amountRe)) {
      const n = toInt(m[1]); if (n === undefined) continue;
      if (firstAmt === undefined) firstAmt = n;
      const lookback = t.slice(Math.max(0, (m.index ?? 0) - 16), m.index ?? 0);
      if (skipRe.test(lookback)) continue;
      if (out.fee && n === out.fee) continue;
      if (out.balance && n === out.balance) continue;
      chosen = n; break;
    }
    // Trailing-currency form as a secondary fallback.
    if (chosen === undefined && firstAmt === undefined) {
      const suffixRe = new RegExp(String.raw`([\d][\d,]*(?:\.\d+)?)\s*${CUR_SUFFIX}`, 'gi');
      for (const m of t.matchAll(suffixRe)) {
        const n = toInt(m[1]); if (n === undefined) continue;
        if (firstAmt === undefined) firstAmt = n;
        if (out.fee && n === out.fee) continue;
        if (out.balance && n === out.balance) continue;
        chosen = n; break;
      }
    }
    out.amount = chosen ?? firstAmt;
  }

  // ── Transaction ID (provider-specific then generic) ────────────────
  // MTN MoMo "ID: 4047…" / "Financial Transaction Id: 4047…" (optional label
  // words in front, then the digit id).
  const mtnId = t.match(/(?:^|[^A-Za-z])(?:Financial\s+)?(?:Transaction\s+)?ID[:\s.#-]+(\d{8,18})\b/i);
  const airtel = t.match(/\bTID[\s.:#-]*(\d{4,18})\b/i);                     // Airtel "TID 1465…"
  const mtnLegacy = t.match(/\bMP[A-Z0-9]{8,}\b/i);                          // legacy "MP…"
  const flutter = t.match(/\b(?:FLW|FW)[A-Z0-9]{6,}\b/i);                    // Flutterwave
  const bankRef = t.match(/\b(?:FT|TXN|CR|DR|TRF|REF)[A-Z0-9]{6,}\b/i);      // bank refs
  // Generic labelled refs. Allow connective filler ("number", "no", "code",
  // "id", "is") between the label and the value so "Reference number 5647…"
  // captures the value, not the filler word.
  const generic = t.match(/\b(?:Txn\s?ID|Transaction\s?ID|Trans\.?\s?ID|Ref(?:erence)?|Receipt(?:\s?No)?|Confirmation(?:\s?code)?)(?:\s+(?:number|no|code|id|is))?[:\s#.\-]*([A-Za-z0-9][A-Za-z0-9-]{3,})\b/i);
  // A real transaction reference always carries at least one digit — this
  // rejects false positives like the English word "Reference" matching a
  // bank-ref prefix, or a filler word being captured generically.
  const hasDigit = (s: string | undefined) => !!s && /\d/.test(s);
  if (mtnId) out.transactionId = mtnId[1];
  else if (airtel) out.transactionId = `TID${airtel[1]}`;
  else if (mtnLegacy) out.transactionId = mtnLegacy[0].toUpperCase();
  else if (flutter) out.transactionId = flutter[0].toUpperCase();
  else if (bankRef && hasDigit(bankRef[0])) out.transactionId = bankRef[0].toUpperCase();
  else if (generic && hasDigit(generic[1])) out.transactionId = generic[1].toUpperCase();

  // ── Counterparty (name + optional phone) ───────────────────────────
  // "from <NAME> (256...)", "to <NAME> 256...", "from 256..."
  const cpMatch = t.match(/\b(?:from|to|by)\s+([A-Z][A-Za-z'.\- ]{1,40}?)(?=\s+(?:on|at|UGX|USh|Shs|Bal|ID|TID|Ref|\.|,|256|\+256|0\d{9}))/);
  if (cpMatch) out.counterparty = cpMatch[1].trim();
  if (!out.counterparty) {
    const phoneCp = t.match(/\b(?:from|to|by)\s+((?:\+?256|0)\d{9})\b/);
    if (phoneCp) out.counterparty = phoneCp[1];
  }

  // ── Date / Time ────────────────────────────────────────────────────
  out.date = extractDate(t);
  out.time = extractTime(t);

  // Fallback direction inference if verbs missing
  if (!out.direction && out.amount) {
    if (/\bdeposit|top.?up\b/i.test(lower)) out.direction = 'in';
    else if (/\bwithdrawal|purchase|airtime|data bundle\b/i.test(lower)) out.direction = 'out';
  }

  return out;
}

/**
 * Focused payout-confirmation parser.
 *
 * Merchant agents paste their raw "you have sent…" MoMo/bank SMS after paying
 * a customer. Amount and transaction ID (TID / bank reference) are the
 * hard-block-critical fields and keep their own dedicated logic below (a
 * payout SMS's amount is picked as the LARGEST currency-prefixed figure,
 * which differs from parseSMS's verb-then-first-non-fee strategy — do not
 * merge these). Date, time and phone are supporting evidence for the
 * proof-of-payment image cross-check (never a hard block on their own) and
 * are pulled via the same shared extractors parseSMS uses, so the UI stays
 * simple and a valid paste is never rejected just because one of them looks
 * odd.
 */
export interface ParsedPayoutSMS {
  amount?: number;
  transactionId?: string;
  date?: string;
  time?: string;
  phone?: string;
}

export function parsePayoutConfirmationSms(text: string): ParsedPayoutSMS {
  const out: ParsedPayoutSMS = {};
  if (!text) return out;
  const t = text.replace(/\s+/g, ' ').trim();
  out.date = extractDate(t);
  out.time = extractTime(t);
  out.phone = extractPhone(t);

  // ── Transaction ID (same provider order as parseSMS) ─────────────────
  const mtnId = t.match(/(?:^|[^A-Za-z])(?:Financial\s+)?(?:Transaction\s+)?ID[:\s.#-]+(\d{8,18})\b/i);
  const airtel = t.match(/\bTID[\s.:#-]*(\d{4,18})\b/i);
  const mtnLegacy = t.match(/\bMP[A-Z0-9]{8,}\b/i);
  const flutter = t.match(/\b(?:FLW|FW)[A-Z0-9]{6,}\b/i);
  const bankRef = t.match(/\b(?:FT|TXN|CR|DR|TRF|REF)[A-Z0-9]{6,}\b/i);
  const generic = t.match(/\b(?:Txn\s?ID|Transaction\s?ID|Trans\.?\s?ID|Ref(?:erence)?|Receipt(?:\s?No)?|Confirmation(?:\s?code)?)(?:\s+(?:number|no|code|id|is))?[:\s#.\-]*([A-Za-z0-9][A-Za-z0-9-]{3,})\b/i);
  const hasDigit = (s: string | undefined) => !!s && /\d/.test(s);
  if (mtnId) out.transactionId = mtnId[1];
  else if (airtel) out.transactionId = `TID${airtel[1]}`;
  else if (mtnLegacy) out.transactionId = mtnLegacy[0].toUpperCase();
  else if (flutter) out.transactionId = flutter[0].toUpperCase();
  else if (bankRef && hasDigit(bankRef[0])) out.transactionId = bankRef[0].toUpperCase();
  else if (generic && hasDigit(generic[1])) out.transactionId = generic[1].toUpperCase();

  // ── Amount ─────────────────────────────────────────────────────────
  // For an outgoing payout SMS the sent amount is usually the largest
  // currency-prefixed number that is NOT labelled as a fee/charge/balance.
  // We intentionally do NOT extract fee/balance/counterparty.
  const CUR = String.raw`(?:UGX|UG\.?Shs?|U\.?Shs?|U\.?Sh\.?|Shs?|Ush\.?)`;
  const CUR_SUFFIX = String.raw`(?:${CUR}|/[=-])`;
  const AMT = String.raw`${CUR}?\s*\.?\s*([\d][\d,]*(?:\.\d+)?)`;

  function toInt(raw: string): number | undefined {
    const n = Math.round(parseFloat(raw.replace(/,/g, '')));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  // Strong verb first: "sent 50,000", "paid UGX 50,000", etc.
  const verbAmt = t.match(new RegExp(
    String.raw`(?:sent|paid|withdrew|withdrawn|debited|transferred|payment of|amount of|sum of|of)\s+` + AMT,
    'i',
  ));
  if (verbAmt) {
    out.amount = toInt(verbAmt[1]);
  }

  if (out.amount === undefined) {
    // Pick the largest currency-prefixed amount, ignoring fee/balance labels.
    const amountRe = new RegExp(String.raw`${CUR}\s*\.?\s*([\d][\d,]*(?:\.\d+)?)`, 'gi');
    const skipRe = /(bal(?:ance)?|charge|fee|fees|tax|levy|new\s*balance)\s*[:.\-]?\s*$/i;
    let largest = 0;
    for (const m of t.matchAll(amountRe)) {
      const n = toInt(m[1]); if (n === undefined) continue;
      const lookback = t.slice(Math.max(0, (m.index ?? 0) - 16), m.index ?? 0);
      if (skipRe.test(lookback)) continue;
      if (n > largest) largest = n;
    }
    if (largest > 0) out.amount = largest;
  }

  if (out.amount === undefined) {
    // Trailing-currency fallback: "50,000/-", "50,000 UGX".
    const suffixRe = new RegExp(String.raw`([\d][\d,]*(?:\.\d+)?)\s*${CUR_SUFFIX}`, 'gi');
    let largest = 0;
    for (const m of t.matchAll(suffixRe)) {
      const n = toInt(m[1]); if (n === undefined) continue;
      if (n > largest) largest = n;
    }
    if (largest > 0) out.amount = largest;
  }

  return out;
}
