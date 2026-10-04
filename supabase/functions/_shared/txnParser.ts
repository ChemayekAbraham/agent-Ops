// Shared MoMo / bank SMS-email transaction parser. Extracted VERBATIM from
// gmail-poll-transactions so the Gmail poller and sms-forwarder-ingest parse
// identically. Do not fork: change it here and both intake paths follow.

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function buildDedupKey(p: {
  transaction_id?: string | null; from_email?: string | null;
  amount?: number | null; internal_date?: Date | null; counterparty?: string | null;
}): string {
  const minute = p.internal_date
    ? `${p.internal_date.getUTCFullYear()}-${String(p.internal_date.getUTCMonth()+1).padStart(2,'0')}-${String(p.internal_date.getUTCDate()).padStart(2,'0')} ${String(p.internal_date.getUTCHours()).padStart(2,'0')}:${String(p.internal_date.getUTCMinutes()).padStart(2,'0')}`
    : '';
  return [
    (p.transaction_id ?? '').toLowerCase(),
    p.from_email ?? '',
    p.amount ?? '',
    minute,
    p.counterparty ?? '',
  ].join('|');
}

// ---- SMS-style transaction parser (mirrors src/utils/smsParser.ts) ----
const MONTH_MAP: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};
const AMT = String.raw`(?:UGX|USh|UShs?|Shs?|Ush\.)?\s*\.?\s*([\d][\d,]*(?:\.\d+)?)`;
const toInt = (raw: string) => {
  const n = Math.round(parseFloat(raw.replace(/,/g, '')));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
function normDate(raw: string): string | undefined {
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2,'0')}-${iso[3].padStart(2,'0')}`;
  const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (dmy) { let [,d,m,y]=dmy; if (y.length===2) y=`20${y}`; return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`; }
  return undefined;
}
// ── Helper: pull the beneficiary account out of a bank notification ──
// Banks mask the account, revealing the first digit and the last four:
//   "7400000.00 UGX was sent to BAYO MERCY 1********7542 at Equity on ..."
// Returns the match key used against cashout_agents.bank_account_number,
// plus the beneficiary name for the audit trail. Returns null when the text
// has no masked account — notably every MTN/Airtel → bank SMS, which names
// only the receiving BANK ("to EQUITY BANK LIMITED") and never the account,
// and so can never be attributed to a desk.
export function extractBankBeneficiary(text: string): {
  accountFirst: string;
  accountTail: string;
  accountLen: number;
  maskedAccount: string;
  beneficiaryName?: string;
} | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ');
  // A masked account is a leading digit, a run of mask characters, then the
  // last four digits. Accept *, x, X and the bullet/•-style masks banks use.
  const m = t.match(/(\d)([*xX•·]{3,})(\d{4})/);
  if (!m) return null;
  const accountFirst = m[1];
  const accountTail = m[3];
  const maskedAccount = m[0];
  const accountLen = 1 + m[2].length + 4;

  // Beneficiary name sits between "sent to" and the masked account. Slice on
  // the match index rather than building a regex out of `maskedAccount` —
  // the mask is full of regex metacharacters (`*`) and interpolating it
  // produces an invalid pattern ("Nothing to repeat").
  let beneficiaryName: string | undefined;
  const before = t.slice(0, m.index ?? 0);
  const nameM = before.match(/\bsent\s+to\s+(.{2,80}?)\s*$/i);
  if (nameM) beneficiaryName = nameM[1].trim().replace(/[,;:]+$/, '') || undefined;

  return { accountFirst, accountTail, accountLen, maskedAccount, beneficiaryName };
}

export function parseTransaction(text: string): {
  amount?: number; fee?: number; balance?: number; transaction_id?: string;
  tx_date?: string; tx_time?: string; direction?: string; channel?: string; counterparty?: string;
  counterparty_name?: string;
} {
  const out: any = {};
  if (!text) return out;
  const t = text.replace(/\s+/g, ' ').trim();

  // STRONG MTN MoMo markers win before any body-only token logic. Outbound
  // MoMo→bank transfers mention the receiving bank ("EQUITY BANK LIMITED") in
  // the body, which used to mis-classify them as channel='bank' and hide them
  // from MTN reconciliation. The MTN sender/subject signature is authoritative.
  const strongMtn = /mtnmobmoney|mtn\s?mob\s?money|mtn\s*mobile\s*money|mtn\s*momo|y'?ello|\bmomopay\b|mm\s?transaction\s?id/i.test(t);
  if (strongMtn) out.channel = 'mtn_momo';
  else if (/\bmomo\b|\bmtn\b/i.test(t)) out.channel = 'mtn_momo';
  else if (/airtel\s?money|\bairtel\b|airtelmoney|\btid\b/i.test(t)) out.channel = 'airtel_money';
  else if (/\bbank\b|stanbic|centenary|dfcu|equity|absa|stanchart|standard chartered|housing finance|kcb|ncba|baroda|tropical|ecobank|orient|finance trust|opportunity bank|post bank|cairo bank/i.test(t)) out.channel = 'bank';
  else out.channel = 'other';


  // Airtel Money agent terminology: "You have deposited UGX X ... Mobile
  // Number: 07XX" means the AGENT pushed cash OUT to a customer mobile
  // wallet — it's a payout, not an incoming credit. Match this BEFORE the
  // generic "deposited" → 'in' rule so it wins.
  const airtelAgentPayout = /you\s+have\s+deposited\s+ugx[\s\d,.]+.*\bmobile\s+number\s*[:\-]?\s*(?:\+?256|0)?\d{6,}/i.test(t);
  // Bank-style outbound payouts (Equity/Stanbic/Centenary etc) phrase it as
  // "<AMOUNT> UGX was sent to <RECIPIENT>". The boilerplate disclaimer in the
  // same email almost always contains "If you have received this message by
  // error", which falsely triggers the generic 'in' rule. Detect the explicit
  // bank payout shape FIRST so the disclaimer cannot flip direction.
  const bankOutboundPayout = /\bugx\s*was\s+sent\s+to\b/i.test(t)
    || /\bwas\s+sent\s+to\s+[A-Z]/.test(t)
    || /\byou\s+(?:have\s+)?(?:sent|paid|transferred)\b/i.test(t);
  if (airtelAgentPayout) out.direction = 'out';
  else if (bankOutboundPayout) out.direction = 'out';
  else if (/\b(received|deposited|credited|you have received|payment received|recd from|cash in|deposit of)\b/i.test(t)) out.direction = 'in';
  else if (/\b(sent|paid|withdrawn|withdrew|debited|cash out|transferred to|payment to|purchase of|bought)\b/i.test(t)) out.direction = 'out';
  else if (/\b(charge|fee|fees|tax|levy)\b/i.test(t) && !/charge\s*[:\-]?\s*(?:ugx)?\s*0\b/i.test(t)) out.direction = 'charge';

  // For the airtel agent payout shape, the "Mobile Number:" field is the
  // recipient — surface it as the counterparty so the routing UI can match
  // to a user/proxy wallet.
  if (airtelAgentPayout) {
    const mob = t.match(/mobile\s+number\s*[:\-]?\s*((?:\+?256|0)?\d{6,})/i);
    if (mob) out.counterparty = mob[1];
  }

  // MTN MoMo outbound "sent to NAME (07XXXXXXXX)" — capture the recipient
  // phone in counterparty so the withdrawal auto-approver can match it
  // against a pending withdrawal_request.mobile_money_number.
  if (out.direction === 'out' && !airtelAgentPayout) {
    const mtnTo = t.match(/\bto\b[^()]{0,80}?\(\s*((?:\+?256|0)\d{8,9})\s*\)/i)
      // "sent UGX 900000 to NELSON MUGUME, 256789536301 on ..." — phone sits
      // after the recipient NAME and a comma/space, not in parentheses.
      || t.match(/\bto\b[^.\n]{0,80}?[,\s(]\s*((?:\+?256|0)\d{8,9})\b/i)
      || t.match(/\bto\s+((?:\+?256|0)\d{8,9})\b/i);
    if (mtnTo) out.counterparty = mtnTo[1];
  }

  // Sum every fee/charge/tax/excise/commission/VAT/stamp-duty component
  // mentioned in the body so totals reflect the FULL cost the provider
  // (MTN / Airtel / Equity Bank / etc.) deducted, not just the first label.
  // Each unique (label, value, position) match contributes once.
  {
    const feeLabel = String.raw`(?:Transaction\s+Fee|Service\s+Fee|Bank\s+Fee|Bank\s+Charge|Withdraw(?:al)?\s+Fee|Charges?|Fees?|Excise(?:\s+Duty)?|VAT|Tax(?:es)?|Levy|Levies|Commission|Stamp\s+Duty)`;
    const feeRe = new RegExp(feeLabel + String.raw`\s*[:.\-]?\s*` + AMT, 'gi');
    let feeSum = 0;
    const seen = new Set<number>();
    for (const m of t.matchAll(feeRe)) {
      const n = toInt(m[1]);
      if (n === undefined || n <= 0) continue;
      const idx = m.index ?? -1;
      if (seen.has(idx)) continue;
      seen.add(idx);
      feeSum += n;
    }
    if (feeSum > 0) out.fee = feeSum;
  }
  // Providers phrase the running balance in several ways and MTN inserts filler
  // words between the label and the figure — "New balance is: UGX 6381255." —
  // so allow optional "is / is now / now / of / stands at" plus a MoMoPay-style
  // label. Without this the row lands with balance=null and the Phone Money
  // card silently stays pinned to an older SMS.
  const balM = t.match(
    new RegExp(
      String.raw`(?:New\s+MoMoPay\s+balance|MoMoPay\s+balance|New\s+balance|Balance|Bal)` +
        String.raw`\s*(?:is\s+now|is|now|of|stands\s+at)?\s*[:.\-]?\s*` +
        AMT,
      'i',
    ),
  );
  if (balM) out.balance = toInt(balM[1]);

  const verbAmt = t.match(new RegExp(String.raw`(?:received|deposited|credited|sent|paid|withdrew|withdrawn|debited|payment of|amount of|sum of|of)\s+(?:UGX|USh|UShs?|Shs?)?\s*\.?\s*([\d][\d,]*(?:\.\d+)?)`, 'i'));
  if (verbAmt) out.amount = toInt(verbAmt[1]);
  if (out.amount === undefined) {
    // Capture currency-tagged amounts written with the currency on EITHER
    // side of the number. Banks (Equity / Stanbic / Centenary) phrase
    // payouts as "4000000.00 UGX was sent to NAME" — the currency token
    // comes AFTER the number, so a prefix-only pattern (UGX 5000) misses
    // them entirely and the row ends up with amount=null / parsed=false.
    const prefixRe = /(?:UGX|USh|UShs|Shs)\s*\.?\s*([\d,]+(?:\.\d+)?)/gi;
    // The leading negative lookbehind prevents matching digits that are glued
    // to a preceding letter/digit — e.g. an Airtel "SMS2Email" body of the form
    // "TID148696910218 UGX 2,400,000" where the transaction-id digits sit
    // directly before " UGX". Without it the TID is mistaken for a suffix-
    // currency amount and surfaces as a multi-billion-shilling transaction.
    const suffixRe = /(?<![A-Za-z0-9])([\d][\d,]*(?:\.\d+)?)\s*(?:UGX|USh|UShs|Shs)\b/gi;
    const skipRe = /(bal(?:ance)?|charge|fee|fees|tax|levy|new\s*balance)\s*[:.\-]?\s*$/i;
    const cands: { n: number; idx: number }[] = [];
    for (const m of t.matchAll(prefixRe)) {
      const n = toInt(m[1]); if (n === undefined) continue;
      cands.push({ n, idx: m.index ?? 0 });
    }
    for (const m of t.matchAll(suffixRe)) {
      const n = toInt(m[1]); if (n === undefined) continue;
      cands.push({ n, idx: m.index ?? 0 });
    }
    cands.sort((a, b) => a.idx - b.idx);
    let firstAmt: number | undefined; let chosen: number | undefined;
    for (const c of cands) {
      if (firstAmt === undefined) firstAmt = c.n;
      const lookback = t.slice(Math.max(0, c.idx - 16), c.idx);
      if (skipRe.test(lookback)) continue;
      if (out.fee && c.n === out.fee) continue;
      if (out.balance && c.n === out.balance) continue;
      chosen = c.n; break;
    }
    out.amount = chosen ?? firstAmt;
  }

  const mtnId = t.match(/(?:^|[^A-Z])ID[:\s.#-]+(\d{8,18})\b/i);
  const airtel = t.match(/\bTID[\s.:#-]*(\d{4,18})\b/i);
  const mtnLegacy = t.match(/\bMP[A-Z0-9]{8,}\b/i);
  const flutter = t.match(/\b(?:FLW|FW)[A-Z0-9]{6,}\b/i);
  // Require the bank-ref token to contain at least one digit so the plain
  // English word "Reference" (REF + "erence") is NOT mistaken for a ref id.
  // The actual ref value after "Reference:" is captured by `generic` below.
  const bankRef = t.match(/\b(?:FT|TXN|CR|DR|TRF|REF)(?=[A-Z0-9]*[0-9])[A-Z0-9]{6,}\b/i);
  const generic = t.match(/\b(?:Txn\s?ID|Transaction\s?ID|Trans\s?ID|Ref(?:erence)?|Receipt(?:\s?No)?|Confirmation)[:\s#]*([A-Z0-9-]{4,})\b/i);
  if (mtnId) out.transaction_id = mtnId[1];
  else if (airtel) out.transaction_id = `TID${airtel[1]}`;
  else if (mtnLegacy) out.transaction_id = mtnLegacy[0].toUpperCase();
  else if (flutter) out.transaction_id = flutter[0].toUpperCase();
  else if (bankRef) out.transaction_id = bankRef[0].toUpperCase();
  else if (generic) out.transaction_id = generic[1].toUpperCase();

  // Filter junk transaction IDs (common stop-words / too short / no digits)
  if (out.transaction_id) {
    const cleaned = out.transaction_id.trim();
    const stop = new Set(['FROM','TO','BY','REF','TXN','TRANS','RECEIPT','REFERENCE','CONFIRMATION','TXNID','TRANSID','OF','THE','YOUR','THIS','THAT','WITH','SENT','PAID','RECEIVED']);
    if (cleaned.length < 6 || stop.has(cleaned.toUpperCase()) || !/[0-9]/.test(cleaned)) {
      delete out.transaction_id;
    } else {
      out.transaction_id = cleaned;
    }
  }

  // Bank credit alerts (Equity etc.) phrase the sender as
  // "from NAME <masked account> to your <bank> account" — the masked account
  // (a leading digit, a run of mask chars, then 4 digits) sits where the
  // generic lookahead tokens below expect punctuation/currency/a phone
  // number, so without this alternative the sender name — including the
  // "WELILE TECHNOLOGIES LIMITED" shape that identifies our own outbound
  // payouts echoing back into this inbox — was never captured.
  // MTN's "received" credit template phrases the sender as
  // "from (NAME) 256XXXXXXXXX" — the name sits inside parens directly
  // followed by the phone. The char right after "from " is "(", not
  // [A-Z], so the generic name-capture below never matches this shape at
  // all, and the plain-phone fallback below IT requires the phone
  // immediately after "from ", not after "(NAME) " — so both silently
  // failed and every receipt in this shape parsed with counterparty=null,
  // even though the phone was sitting right there in the body. Capture the
  // phone into counterparty (what the matcher keys on for an exact lookup)
  // and the name into counterparty_name (used only as a fallback signal
  // when the phone doesn't resolve to a known user).
  const nameParenPhone = !out.counterparty
    && t.match(/\b(?:from|to|by)\s*\(\s*([A-Za-z][A-Za-z'.\- ]{1,58}?)\s*\)\s*((?:\+?256|0)\d{9})\b/i);
  if (nameParenPhone) {
    out.counterparty = nameParenPhone[2];
    out.counterparty_name = nameParenPhone[1].trim();
  }

  const cpMatch = !out.counterparty && t.match(/\b(?:from|to|by)\s+([A-Z][A-Za-z'.\- ]{1,40}?)(?=\s+(?:on|at|UGX|USh|Shs|Bal|ID|TID|Ref|\.|,|256|\+256|0\d{9}|\d[*xX•·]{3,}\d{4}))/);
  if (cpMatch) out.counterparty = cpMatch[1].trim();
  if (!out.counterparty) {
    // Airtel's inbound shape is "RECEIVED. TID… UGX 21445 from 752251576" —
    // a bare 9-digit subscriber number with no 0/256 prefix. Requiring the
    // prefix left every one of these with counterparty=null, so a payer who
    // never submitted a deposit request could only be matched by the looser
    // body scan (handover 127). The bare form is accepted after "from" only,
    // so outbound "to …" shapes (which feed the payout auto-debit) are
    // unchanged.
    const phoneCp = t.match(/\b(?:from|to|by)\s+((?:\+?256|0)\d{9})\b/)
      || t.match(/\bfrom\s+(7\d{8})\b/);
    if (phoneCp) out.counterparty = phoneCp[1];
  }

  const numericDate = t.match(/\b(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/);
  if (numericDate) { const n = normDate(numericDate[1]); if (n) out.tx_date = n; }
  if (!out.tx_date) {
    const named = t.match(/\b(\d{1,2})[\s/-](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s/-](\d{2,4})\b/i);
    if (named) {
      const mm = MONTH_MAP[named[2].slice(0,3).toLowerCase()];
      if (mm) { const y = named[3].length === 2 ? `20${named[3]}` : named[3]; out.tx_date = `${y}-${mm}-${named[1].padStart(2,'0')}`; }
    }
  }

  const timeMatch = t.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s?(AM|PM)?\b/i);
  if (timeMatch) {
    let hh = parseInt(timeMatch[1], 10); const mm = parseInt(timeMatch[2], 10);
    const ampm = timeMatch[3]?.toUpperCase();
    if (ampm === 'PM' && hh < 12) hh += 12;
    if (ampm === 'AM' && hh === 12) hh = 0;
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      out.tx_time = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
    }
  }
  return out;
}
