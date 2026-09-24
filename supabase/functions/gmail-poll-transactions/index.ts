import "../_shared/smsFooterInterceptor.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { logDepositDecision } from '../_shared/depositDecisionAudit.ts';
import { resolvePayoutDebitTarget, logProxyFallbackAudit } from '../_shared/partnership-emails.ts';
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";
import { resolveOwnedRecipientEmail } from "../_shared/ownedRecipientEmail.ts";
import {
  toLast9,
  resolveUsersByKnownPhone,
  resolveUniqueUserByKnownPhone,
  learnDepositNumber,
  resolveUniqueUserByKnownName,
  normalizeDepositorName,
} from "../_shared/depositNumberLearning.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GATEWAY_URL = 'https://connector-gateway.lovable.dev/google_mail/gmail/v1';

// Capture every recent email that mentions money in any common form.
// We deliberately keep this VERY broad: any UGX/USh/Shs token, any digit
// sequence with a thousands separator, common provider words, and any
// forwarded SMS. Filtering happens downstream by the parser (`parsed`
// flag) so nothing useful is missed at the Gmail layer.
const GMAIL_QUERY = [
  '(',
  'UGX OR USh OR UShs OR Shs OR "USh." OR "Ush" OR "shs."',
  'OR MoMo OR "Mobile Money" OR "Airtel Money" OR MTN OR Airtel OR Stanbic OR Centenary OR DFCU OR Equity OR Absa OR "Stanbic Bank"',
  'OR "TID" OR "Txn ID" OR "Transaction ID" OR "Trans ID" OR "Receipt" OR "Reference" OR "Confirmation"',
  'OR "received" OR "deposited" OR "credited" OR "withdrawn" OR "paid" OR "sent" OR "debited"',
  'OR subject:"SMS from" OR subject:"SMS Forwarder" OR from:smsforwarder OR "Forwarded SMS"',
  ') newer_than:30d',
].join(' ');

function b64urlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const b64 = (input + pad).replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

function extractPlainBody(payload: any): string {
  if (!payload) return '';
  if (payload.body?.data) return b64urlDecode(payload.body.data);
  const parts: any[] = payload.parts ?? [];
  // Prefer text/plain
  for (const p of parts) {
    if (p.mimeType === 'text/plain' && p.body?.data) return b64urlDecode(p.body.data);
  }
  // Fallback: strip HTML
  for (const p of parts) {
    if (p.mimeType === 'text/html' && p.body?.data) {
      return b64urlDecode(p.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    }
  }
  // Recurse into multipart
  for (const p of parts) {
    const inner = extractPlainBody(p);
    if (inner) return inner;
  }
  return '';
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function buildDedupKey(p: {
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
function extractBankBeneficiary(text: string): {
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

function parseTransaction(text: string): {
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
    const phoneCp = t.match(/\b(?:from|to|by)\s+((?:\+?256|0)\d{9})\b/);
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

/**
 * Gmail gateway fetch with automatic exponential-backoff retry on
 * authentication-class failures (401 Unauthenticated / 403 insufficient-
 * scope / network blips). The connector gateway can transiently return
 * 401 immediately after a token refresh; a short retry loop avoids
 * surfacing those as user-visible errors.
 *
 * Backoff schedule: 500ms, 1500ms, 4500ms (3 retries → 4 total attempts).
 * Non-auth errors (e.g. 4xx parse errors, 5xx server errors other than
 * 502/503/504) fail fast.
 */
async function gmailFetch(path: string, init?: RequestInit) {
  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  const GOOGLE_MAIL_API_KEY = Deno.env.get('GOOGLE_MAIL_API_KEY');
  if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY is not configured');
  if (!GOOGLE_MAIL_API_KEY) throw new Error('GOOGLE_MAIL_API_KEY is not configured (Gmail not connected)');

  const MAX_ATTEMPTS = 4;
  const BASE_DELAY_MS = 500;
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${GATEWAY_URL}${path}`, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          'X-Connection-Api-Key': GOOGLE_MAIL_API_KEY,
        },
      });
      const body = await res.text();
      if (res.ok) {
        try { return JSON.parse(body); } catch { return body; }
      }

      const isAuth = res.status === 401 || res.status === 403;
      const isTransient = res.status === 502 || res.status === 503 || res.status === 504 || res.status === 429;
      const retryable = isAuth || isTransient;

      const err = new Error(`Gmail ${path} [${res.status}]: ${body}`);
      if (!retryable || attempt === MAX_ATTEMPTS) {
        // Persistent auth failure → raise a FinOps alert so ingestion
        // outages surface immediately instead of silently piling up.
        if (isAuth) {
          await raiseGmailAuthAlert(res.status, body, path).catch((e) =>
            console.warn('[gmailFetch] failed to raise auth alert:', e),
          );
        }
        throw err;
      }

      lastErr = err;
      const delay = BASE_DELAY_MS * Math.pow(3, attempt - 1); // 500, 1500, 4500
      const jitter = Math.floor(Math.random() * 200);
      console.warn(
        `[gmailFetch] attempt ${attempt}/${MAX_ATTEMPTS} failed (${res.status}) — retrying in ${delay + jitter}ms: ${path}`,
      );
      await new Promise((r) => setTimeout(r, delay + jitter));
    } catch (e) {
      // Network-level failure (TypeError / fetch error) — retry as transient
      if (attempt === MAX_ATTEMPTS || (e instanceof Error && e.message.startsWith('Gmail '))) {
        throw e;
      }
      lastErr = e;
      const delay = BASE_DELAY_MS * Math.pow(3, attempt - 1);
      console.warn(`[gmailFetch] network attempt ${attempt}/${MAX_ATTEMPTS} failed — retrying in ${delay}ms`, e);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr ?? new Error(`Gmail ${path}: exhausted retries`);
}

// Fixed sentinel subject_id so repeated failures upsert onto the same
// alert row (deposit_match_alerts has UNIQUE(alert_type, subject_id)).
const GMAIL_AUTH_ALERT_SUBJECT_ID = '00000000-0000-0000-0000-000000000001';

async function raiseGmailAuthAlert(status: number, body: string, path: string) {
  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const severity = status === 401 ? 'critical' : 'high';
    const message =
      status === 401
        ? 'Gmail OAuth token expired or unauthorized — Gmail ingestion is HALTED. Reconnect Gmail (google_mail connector) immediately.'
        : 'Gmail API returned 403 (insufficient scope). Confirm gmail.readonly scope is granted on the connector.';
    await admin
      .from('deposit_match_alerts')
      .upsert(
        {
          alert_type: 'gmail_auth_failure',
          subject_id: GMAIL_AUTH_ALERT_SUBJECT_ID,
          subject_label: 'Gmail API auth failure',
          severity,
          age_minutes: 0,
          details: {
            http_status: status,
            gmail_path: path,
            response_body: body?.slice(0, 2000) ?? null,
            message,
            observed_at: new Date().toISOString(),
          },
          notified_at: null,
          resolved_at: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'alert_type,subject_id' },
      );
  } catch (e) {
    console.warn('[raiseGmailAuthAlert] insert failed:', e);
  }
}

// Visibility backstop: any outbound send that we RECOGNISED as a registered
// merchant float phone but did not (or could not) auto-credit must leave a
// FinOps-visible row. "Detected but withheld" must never look identical to
// "never happened".
async function raiseMerchantFloatAlert(
  supabase: ReturnType<typeof createClient>,
  opts: {
    gmailRowId: string;
    agentId: string | null;
    amount: number | null;
    transactionId: string | null;
    counterparty: string | null;
    reason: string;
    severity?: 'low' | 'medium' | 'high' | 'critical';
    ageMinutes?: number;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await supabase.from('deposit_match_alerts').upsert(
      {
        alert_type: 'merchant_float_uncredited',
        subject_id: opts.gmailRowId,
        subject_label: 'Merchant float send detected but not credited',
        user_id: opts.agentId,
        amount: opts.amount,
        transaction_reference: opts.transactionId,
        age_minutes: Math.max(0, Math.round(opts.ageMinutes ?? 0)),
        severity: opts.severity ?? 'high',
        details: {
          reason: opts.reason,
          counterparty: opts.counterparty,
          agent_id: opts.agentId,
          observed_at: new Date().toISOString(),
          ...(opts.extra ?? {}),
        },
        resolved_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'alert_type,subject_id' },
    );
  } catch (e) {
    console.warn('[raiseMerchantFloatAlert] upsert failed:', e);
  }
}

// Visibility for the fuzzy name-match tier: an MTN "received" receipt whose
// exact name match found nothing, but a looser token match found exactly one
// plausible profile. Never auto-credited — just surfaced as a one-click
// confirm for Financial Ops instead of disappearing into "no_user_match"
// with no lead at all. Deliberately its own alert_type (not
// 'email_receipt_unmatched') so the unrelated detect_deposit_match_failures()
// sweep can never clobber the candidate suggestion in `details`.
async function raisePossibleUserMatchAlert(
  supabase: ReturnType<typeof createClient>,
  opts: {
    gmailRowId: string;
    amount: number | null;
    transactionId: string | null;
    rawName: string;
    candidateUserId: string;
    candidateName: string | null;
  },
): Promise<void> {
  try {
    await supabase.from('deposit_match_alerts').upsert(
      {
        alert_type: 'email_receipt_possible_match',
        subject_id: opts.gmailRowId,
        subject_label: opts.rawName,
        user_id: opts.candidateUserId,
        amount: opts.amount,
        transaction_reference: opts.transactionId,
        age_minutes: 0,
        severity: 'warning',
        details: {
          raw_name: opts.rawName,
          candidate_user_id: opts.candidateUserId,
          candidate_full_name: opts.candidateName,
          reason: 'name_fuzzy_match_needs_confirmation',
          observed_at: new Date().toISOString(),
        },
        resolved_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'alert_type,subject_id' },
    );
  } catch (e) {
    console.warn('[raisePossibleUserMatchAlert] upsert failed:', e);
  }
}

// Token-based near-match for MTN "received" names when the exact ilike match
// found nothing. MTN's SIM-registered name often differs slightly from the
// platform profile (reordered names, a middle initial, a shop name) — this
// requires every token of the SMS name to appear somewhere in a profile's
// full_name (order-independent), and returns candidates ONLY when the result
// is small enough to be a real signal, not a coincidence.
async function resolveFuzzyNameCandidates(
  supabase: ReturnType<typeof createClient>,
  rawName: string,
): Promise<Array<{ id: string; full_name: string | null; phone: string | null; email: string | null }>> {
  const tokens = rawName
    .split(' ')
    .map((t) => t.replace(/[^A-Za-z]/g, ''))
    .filter((t) => t.length >= 2)
    .slice(0, 4);
  if (tokens.length < 2) return [];

  let query = supabase.from('profiles').select('id, full_name, phone, email');
  for (const tok of tokens) {
    query = query.ilike('full_name', `%${tok}%`);
  }
  const { data } = await query.limit(5);
  return (data ?? []) as any;
}

// Sweep: resolve any open 'email_receipt_possible_match' alert whose row has
// since been linked to a deposit (claimed by the payer, or hand-linked by
// Financial Ops) — mirrors the other sweeps below. Bounded to keep the poll
// cheap; a few stragglers just get picked up next tick.
async function resolvePossibleUserMatchAlerts(
  supabase: ReturnType<typeof createClient>,
): Promise<void> {
  const { data: openAlerts } = await supabase
    .from('deposit_match_alerts')
    .select('id, subject_id')
    .eq('alert_type', 'email_receipt_possible_match')
    .is('resolved_at', null)
    .limit(50);
  if (!openAlerts?.length) return;

  const { data: linkedRows } = await supabase
    .from('gmail_transactions')
    .select('id')
    .in('id', openAlerts.map((a: any) => a.subject_id))
    .not('linked_deposit_request_id', 'is', null);
  const linkedIds = new Set((linkedRows ?? []).map((r: any) => r.id));
  if (!linkedIds.size) return;

  const toResolve = openAlerts.filter((a: any) => linkedIds.has(a.subject_id)).map((a: any) => a.id);
  if (!toResolve.length) return;

  await supabase
    .from('deposit_match_alerts')
    .update({ resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .in('id', toResolve);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    // Debug mode: return per-message diagnostics without writing to DB.
    const url = new URL(req.url);
    let debug = url.searchParams.get('debug') === '1';
    if (!debug) {
      try {
        const body = await req.clone().json();
        if (body && (body.debug === true || body.debug === 1)) debug = true;
      } catch { /* no body */ }
    }

    // ── Backfill mode: re-run the MoMo withdrawal auto-approver over
    // recently-ingested outbound emails. Useful when the auto-approve
    // logic was deployed AFTER an email was already saved (dedup would
    // otherwise skip it forever). Safe to call repeatedly — each match
    // is gated server-side by `approve-withdrawal` (insufficient funds
    // / already-settled requests are rejected).
    let backfill = url.searchParams.get('backfill') === '1';
    let backfillHours = Number(url.searchParams.get('hours') ?? '48');
    if (!backfill) {
      try {
        const body = await req.clone().json();
        if (body?.backfill === true || body?.backfill === 1) backfill = true;
        if (body?.hours) backfillHours = Number(body.hours);
      } catch { /* no body */ }
    }
    if (backfill) {
      const sinceIso = new Date(
        Date.now() - Math.max(1, Math.min(168, backfillHours)) * 3600 * 1000,
      ).toISOString();
      const { data: rows, error: rowsErr } = await supabase
        .from('gmail_transactions')
        .select('id, gmail_message_id, transaction_id, amount, direction, channel, counterparty, internal_date, parsed, snippet, subject, raw_body')
        .eq('direction', 'out')
        .in('channel', ['mtn_momo', 'airtel_money'])
        .gte('internal_date', sinceIso)
        .order('internal_date', { ascending: false })
        .limit(200);
      if (rowsErr) {
        return new Response(JSON.stringify({ ok: false, error: rowsErr.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      let attempted = 0;
      const report: any[] = [];
      for (const r of rows ?? []) {
        const parsedRow = (r as any).parsed ?? {};
        // Re-derive the recipient phone from the stored email text when the
        // saved counterparty is null (older rows parsed before the MTN
        // "to NAME, 256XXXXXXXXX" recipient fix).
        let counterparty = r.counterparty ?? parsedRow.counterparty ?? null;
        if (!counterparty) {
          const body = `${(r as any).snippet ?? ''} ${(r as any).raw_body ?? ''}`;
          const reTo = body.match(/\bto\b[^.\n]{0,80}?[,\s(]\s*((?:\+?256|0)\d{8,9})\b/i);
          if (reTo) counterparty = reTo[1];
        }
        const parsed = {
          amount: r.amount ?? parsedRow.amount ?? null,
          direction: r.direction ?? parsedRow.direction ?? null,
          channel: r.channel ?? parsedRow.channel ?? null,
          counterparty,
          transaction_id: r.transaction_id ?? parsedRow.transaction_id ?? null,
          snippet: (r as any).snippet ?? null,
          subject: (r as any).subject ?? null,
        } as ReturnType<typeof parseTransaction>;
        attempted += 1;
        try {
          await tryAutoApproveMomoWithdrawal(supabase, {
            parsed,
            gmailMessageId: r.gmail_message_id,
          });
          report.push({ id: r.id, gmail: r.gmail_message_id, amount: parsed.amount, channel: parsed.channel, cp: parsed.counterparty });
        } catch (e) {
          report.push({ id: r.id, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return new Response(JSON.stringify({
        ok: true, mode: 'backfill', since: sinceIso, scanned: rows?.length ?? 0, attempted, report,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── Reparse mode: re-run parseTransaction over the STORED raw email
    // text for rows that previously failed to parse (parsed=false) or that
    // are missing an amount. Backfills rows ingested before a parser fix —
    // e.g. the "<AMOUNT> UGX was sent to" bank-payout shape that older
    // parser builds left with amount=null / parsed=false, making them
    // invisible to totals and the auto-debit engine. Safe to re-run.
    let reparse = url.searchParams.get('reparse') === '1';
    let reparseLimit = Number(url.searchParams.get('limit') ?? '500');
    if (!reparse) {
      try {
        const body = await req.clone().json();
        if (body?.reparse === true || body?.reparse === 1) reparse = true;
        if (body?.limit) reparseLimit = Number(body.limit);
      } catch { /* no body */ }
    }
    if (reparse) {
      const { data: rows, error: rowsErr } = await supabase
        .from('gmail_transactions')
        .select('id, subject, snippet, raw_body, amount, transaction_id, direction, channel, counterparty, fee, balance, parsed')
        .or('parsed.eq.false,amount.is.null')
        .order('internal_date', { ascending: false })
        .limit(Math.max(1, Math.min(2000, reparseLimit)));
      if (rowsErr) {
        return new Response(JSON.stringify({ ok: false, error: rowsErr.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      let updated = 0; let unchanged = 0;
      const report: any[] = [];
      for (const r of rows ?? []) {
        // `snippet` is Gmail's truncated preview of the SAME text as `raw_body`.
        // Joining both duplicates the message — the snippet's cut-off tail
        // immediately followed by the body's start creates spurious
        // cross-boundary matches (e.g. "...to" + "You have sent..." reads as
        // "to You have sent", which the counterparty regex then captures
        // instead of the real recipient). Use snippet only when raw_body is empty.
        const combined = `${(r as any).subject ?? ''}\n${(r as any).raw_body || (r as any).snippet || ''}`;
        const p = parseTransaction(combined);
        const newAmount = p.amount ?? (r as any).amount ?? null;
        const newTid = p.transaction_id ?? (r as any).transaction_id ?? null;
        const newDirection = p.direction ?? (r as any).direction ?? null;
        const newChannel = p.channel ?? (r as any).channel ?? null;
        const newCounterparty = p.counterparty ?? (r as any).counterparty ?? null;
        const newFee = p.fee ?? (r as any).fee ?? null;
        const newBalance = p.balance ?? (r as any).balance ?? null;
        const isParsed = !!(newAmount || newTid);
        const changed = newAmount !== (r as any).amount
          || newTid !== (r as any).transaction_id
          || isParsed !== (r as any).parsed;
        if (!changed) { unchanged += 1; continue; }
        const { error: upErr } = await supabase
          .from('gmail_transactions')
          .update({
            amount: newAmount,
            transaction_id: newTid,
            direction: newDirection,
            channel: newChannel,
            counterparty: newCounterparty,
            fee: newFee,
            balance: newBalance,
            parsed: isParsed,
          })
          .eq('id', (r as any).id);
        if (upErr) {
          report.push({ id: (r as any).id, error: upErr.message });
          continue;
        }
        updated += 1;
        report.push({ id: (r as any).id, amount: newAmount, tid: newTid, direction: newDirection, parsed: isParsed });
      }
      return new Response(JSON.stringify({
        ok: true, mode: 'reparse', scanned: rows?.length ?? 0, updated, unchanged, report,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { data: state } = await supabase
      .from('gmail_poll_state').select('*').eq('id', 1).maybeSingle();

    // ── Timestamp watermark, defensively clamped ───────────────────────────
    // `internalDate` is sender-influenced: some banks/URA stamp EAT wall-clock
    // as UTC, which lands ~3h in the FUTURE. The old monotonic cutoff accepted
    // that value and then discarded every subsequent (correctly dated) email as
    // `older_than_last_poll` — a single message could blackhole intake for
    // hours while every tick still reported `ok`.
    //
    // Two guards:
    //   1. Never ADVANCE the cutoff past now + FUTURE_SKEW_MS.
    //   2. Never TRUST a stored cutoff that is already in the future (self-heals
    //      a poisoned gmail_poll_state row without any backfill).
    //
    // The durable de-dup guard is ID-based, not time-based: every message is
    // checked against gmail_transactions.gmail_message_id (and transaction_id /
    // dedup_hash) before insert, so clamping the timestamp cutoff cannot cause
    // duplicates — it only widens the scan window. Long-term the timestamp
    // cutoff should be replaced entirely by a Gmail `historyId` watermark
    // (users.history.list), with the ID checks below as the safety net.
    const FUTURE_SKEW_MS = 2 * 60 * 1000;
    const pollNowMs = Date.now();
    const maxAcceptableMs = pollNowMs + FUTURE_SKEW_MS;
    const storedLastMs: number = Number(state?.last_internal_date_ms ?? 0);
    const lastMs: number = storedLastMs > maxAcceptableMs ? 0 : storedLastMs;
    if (storedLastMs > maxAcceptableMs) {
      console.warn(
        `[gmail-poll] stored cutoff ${new Date(storedLastMs).toISOString()} is in the future ` +
        `(now ${new Date(pollNowMs).toISOString()}) — ignoring it for this tick and re-anchoring to real time.`,
      );
    }

    // ── Same-second grace window ───────────────────────────────────────────
    // internalDate has 1-second resolution and Gmail's list index lags
    // delivery by a few seconds. On 2026-09-23 a tick at 11:06:00 ingested a
    // message stamped 11:05:52 and moved the cutoff there; a 3-message IFTTT
    // thread stamped the SAME second only became listable afterwards, and the
    // next tick dropped all three as `older_than_last_poll` — silently, since
    // that skip is never logged. One was a tenant's direct rent payment
    // (TID157162005754), another a UGX 1M deposit. So only skip messages
    // meaningfully older than the cutoff; the ID checks below keep the wider
    // window duplicate-free (handover 121).
    const CUTOFF_GRACE_MS = 10 * 60 * 1000;

    // ── Rescan mode: re-list a past window, bypassing the time cutoff ──────
    // `backfill` / `reparse` only revisit rows already in gmail_transactions,
    // so a message the cutoff dropped could never be recovered. Rescan lists
    // Gmail for [rescan_from, rescan_to) and runs every message through the
    // normal path (ID / TID / dedup_hash checks still apply, so already-
    // ingested messages are skipped). Combine with debug=1 for a dry run.
    // Never moves the stored cutoff backwards (newestMs starts at lastMs).
    let rescanFrom = url.searchParams.get('rescan_from');
    let rescanTo = url.searchParams.get('rescan_to');
    if (!rescanFrom) {
      try {
        const body = await req.clone().json();
        if (body?.rescan_from) rescanFrom = String(body.rescan_from);
        if (body?.rescan_to) rescanTo = String(body.rescan_to);
      } catch { /* no body */ }
    }
    const rescanFromMs = rescanFrom ? Date.parse(rescanFrom) : NaN;
    const rescanToMs = rescanTo ? Date.parse(rescanTo) : pollNowMs;
    // Bounded like `backfill`: at most 48h per call, and no further back than
    // the 7-day auto-credit window (+1 day) — this endpoint is reachable with
    // the anon key, so a rescan must stay a cheap, idempotent operation.
    const rescan = Number.isFinite(rescanFromMs) && Number.isFinite(rescanToMs)
      && rescanFromMs < rescanToMs
      && rescanToMs - rescanFromMs <= 48 * 3600 * 1000
      && rescanFromMs >= pollNowMs - 8 * 24 * 3600 * 1000;
    if (rescanFrom && !rescan) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid rescan_from / rescan_to (max 48h window, within the last 8 days)' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const skipBeforeMs = rescan ? 0 : (lastMs ? lastMs - CUTOFF_GRACE_MS : 0);

    // List recent matching messages
    const messages: { id: string; threadId: string }[] = [];
    if (rescan) {
      const q = `${GMAIL_QUERY} after:${Math.floor(rescanFromMs / 1000)} before:${Math.ceil(rescanToMs / 1000)}`;
      let pageToken: string | undefined;
      for (let page = 0; page < 5; page++) {
        const list = await gmailFetch(
          `/users/me/messages?maxResults=100&q=${encodeURIComponent(q)}` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''),
        );
        messages.push(...(list?.messages ?? []));
        pageToken = list?.nextPageToken;
        if (!pageToken) break;
      }
    } else {
      const list = await gmailFetch(
        `/users/me/messages?maxResults=50&q=${encodeURIComponent(GMAIL_QUERY)}`,
      );
      messages.push(...(list?.messages ?? []));
    }

    let inserted = 0; let newestMs = lastMs;
    /** Advance the cutoff only with sane, non-future timestamps. */
    const advanceCutoff = (ms: number) => {
      if (!ms || !Number.isFinite(ms)) return;
      if (ms > maxAcceptableMs) {
        console.warn(`[gmail-poll] ignoring future-dated internalDate ${new Date(ms).toISOString()} for the cutoff`);
        return;
      }
      if (ms > newestMs) newestMs = ms;
    };
    const debugReport: any[] = [];
    for (const m of messages) {
      const { data: existing } = await supabase
        .from('gmail_transactions').select('id').eq('gmail_message_id', m.id).maybeSingle();
      if (existing) {
        if (debug) debugReport.push({ id: m.id, decision: 'skipped', reason: 'already_in_db' });
        continue;
      }

      const full = await gmailFetch(`/users/me/messages/${m.id}?format=full`);
      const internalMs = Number(full?.internalDate ?? 0);
      const headers: { name: string; value: string }[] = full?.payload?.headers ?? [];
      const h = (n: string) => headers.find((x) => x.name?.toLowerCase() === n.toLowerCase())?.value ?? null;
      const fromRaw = h('From') ?? '';
      const fromMatch = fromRaw.match(/^\s*"?([^"<]*)"?\s*<?([^>]*)>?\s*$/);
      const fromName = fromMatch?.[1]?.trim() || null;
      const fromEmail = (fromMatch?.[2]?.trim() || fromRaw).toLowerCase() || null;
      const subject = h('Subject');
      const snippet = full?.snippet ?? null;
      const body = extractPlainBody(full?.payload);
      // `snippet` is Gmail's truncated preview of the SAME text as `body`.
      // Joining both duplicates the message — the snippet's cut-off tail
      // immediately followed by the body's start creates spurious
      // cross-boundary matches (e.g. "...to" + "You have sent..." reads as
      // "to You have sent", which the counterparty regex then captures
      // instead of the real recipient). Use snippet only when body is empty.
      const combined = [subject, body || snippet].filter(Boolean).join('\n');
      const parsed = parseTransaction(combined);

      // ── Guard: never ingest our OWN cash-deposit code-notification emails ──
      // cash-deposit-request-code sends "Cash deposit code NNNN — UGX X from <name>"
      // to weliletenants@gmail.com. If we ingest that outgoing email it gets
      // mis-read as an INCOMING deposit and self-matched to the very deposit it
      // was meant to verify — auto-crediting the wallet before the user enters
      // the code. Skip these entirely so they can never enter the matcher pool.
      const isSelfCashCodeEmail =
        (fromEmail === 'weliletenants@gmail.com') &&
        /^cash deposit code\b/i.test(String(subject ?? '').trim());
      if (isSelfCashCodeEmail) {
        if (debug) debugReport.push({ id: m.id, decision: 'skipped', reason: 'self_cash_code_notification', from: fromEmail, subject });
        await logDepositDecision(supabase, {
          source: 'poller',
          decision: 'skipped',
          reason: 'self_cash_code_notification',
          metadata: { gmail_message_id: m.id, from: fromEmail, subject },
        });
        advanceCutoff(internalMs);
        continue;
      }

      // ── Guard: never treat our own report/digest emails as transactions ──
      // weliletenants@gmail.com and info@welile.com send Welile's own
      // automated digests (Partner Ops / Merchant Cash-Out / Tenant Products
      // & Services / Agent Daily Report, etc). Their bodies contain large
      // statistical numbers (receivable totals, portfolio counts) that the
      // generic amount/direction parser below was misreading as a single
      // outbound cash transaction -- e.g. two different-day "Tenant Products
      // & Services" reports both parsed to an identical, bogus
      // UGX 359,185,000 "transfer" that appears nowhere in either report.
      // weliletenants@gmail.com has never carried a real bank/telecom
      // transaction (confirmed: 0 of 3,556 ingested rows); info@welile.com
      // carries both these digests AND real "Receipt: your withdrawal of
      // UGX X has been paid" notices, so it needs an allow-list rather than
      // a blanket skip.
      const isInternalReportEmail =
        fromEmail === 'weliletenants@gmail.com' ||
        (fromEmail === 'info@welile.com' &&
          !/^receipt:\s*your withdrawal of ugx/i.test(String(subject ?? '').trim()));
      if (isInternalReportEmail) {
        if (debug) debugReport.push({ id: m.id, decision: 'skipped', reason: 'internal_report_digest', from: fromEmail, subject });
        advanceCutoff(internalMs);
        continue;
      }

      if (skipBeforeMs && internalMs && internalMs < skipBeforeMs) {
        if (debug) debugReport.push({
          id: m.id, decision: 'skipped', reason: 'older_than_last_poll',
          internal_date: new Date(internalMs).toISOString(),
          last_cutoff: new Date(lastMs).toISOString(),
          from: fromEmail, subject,
        });
        continue;
      }
      // Inside the grace window (or a rescan) a message may already have been
      // judged a TID/dedup_hash duplicate on an earlier tick. Skip it quietly
      // so the wider window doesn't re-write gmail_dedup_audit every minute.
      if (rescan || (lastMs && internalMs && internalMs <= lastMs)) {
        const { data: judged } = await supabase
          .from('gmail_dedup_audit').select('id').eq('gmail_message_id', m.id).limit(1).maybeSingle();
        if (judged) {
          if (debug) debugReport.push({ id: m.id, decision: 'skipped', reason: 'already_judged_duplicate' });
          continue;
        }
      }
      advanceCutoff(internalMs);

      const isParsed = !!(parsed.amount || parsed.transaction_id);
      const internalDateObj = internalMs ? new Date(internalMs) : null;
      const dedupHash = (parsed.transaction_id || parsed.amount)
        ? await sha256Hex(buildDedupKey({
            transaction_id: parsed.transaction_id,
            from_email: fromEmail,
            amount: parsed.amount,
            internal_date: internalDateObj,
            counterparty: parsed.counterparty,
          }))
        : null;

      // Skip if a row with the same transaction_id or dedup_hash already exists.
      if (parsed.transaction_id || dedupHash) {
        const orParts: string[] = [];
        if (parsed.transaction_id) orParts.push(`transaction_id.eq.${parsed.transaction_id}`);
        if (dedupHash) orParts.push(`dedup_hash.eq.${dedupHash}`);
        const { data: dup } = await supabase
          .from('gmail_transactions')
          .select('id, transaction_id, dedup_hash, counterparty, counterparty_name')
          .or(orParts.join(','))
          .limit(1)
          .maybeSingle();
        if (dup) {
          const reason = (parsed.transaction_id && (dup as any).transaction_id?.toLowerCase() === parsed.transaction_id.toLowerCase())
            ? 'transaction_id_match'
            : 'dedup_hash_match';

          // ── Enrich-on-duplicate ─────────────────────────────────────────
          // MTN sometimes sends TWO receipt emails for the same transaction
          // seconds apart in different templates — one with only the payer's
          // name (e.g. the phone-less "Message: Till:" shape), one with
          // "(NAME) 256XXXXXXXXX". Poll/arrival order isn't guaranteed, so
          // the phone-bearing version can land AFTER the name-only one is
          // already stored — and used to be discarded here outright,
          // permanently losing the one signal that would let the matcher use
          // an exact phone lookup instead of a fragile name fallback (this is
          // exactly what happened to a real Otai deposit: the stored row had
          // no phone, and the wrongly-discarded duplicate did). If this
          // duplicate's parsed counterparty is phone-shaped and the stored
          // row's isn't, patch the stored row with the better identity data.
          // Deliberately NOT re-running the matcher here — the original
          // message may already have been auto-credited (correctly or not)
          // by the time its duplicate arrives, and re-matching/re-crediting
          // needs an RPC-backed reversal path, not a blind in-place credit.
          const phoneShape = /^(?:\+?256|0)\d{9}$/;
          const incomingIsPhone = !!parsed.counterparty && phoneShape.test(parsed.counterparty);
          const existingCp = (dup as any).counterparty as string | null | undefined;
          const existingIsPhone = !!existingCp && phoneShape.test(existingCp);
          let enriched = false;
          if (incomingIsPhone && !existingIsPhone) {
            const { error: enrichErr } = await supabase
              .from('gmail_transactions')
              .update({
                counterparty: parsed.counterparty,
                counterparty_name: (parsed as any).counterparty_name ?? (dup as any).counterparty_name ?? existingCp ?? null,
              })
              .eq('id', (dup as any).id);
            enriched = !enrichErr;
          }

          if (debug) {
            debugReport.push({ id: m.id, decision: 'skipped', reason, from: fromEmail, subject, enriched });
          } else {
            await supabase.from('gmail_dedup_audit').insert({
              gmail_message_id: m.id,
              dedup_hash: dedupHash,
              matched_transaction_id: (dup as any).transaction_id ?? null,
              matched_row_id: (dup as any).id,
              reason,
              from_email: fromEmail,
              subject: subject ?? null,
              snippet: snippet ?? null,
              internal_date: internalMs ? new Date(internalMs).toISOString() : null,
            });
          }
          await logDepositDecision(supabase, {
            source: 'poller',
            decision: 'skipped',
            reason,
            amount: parsed.amount ?? null,
            metadata: {
              gmail_message_id: m.id,
              from: fromEmail,
              subject,
              matched_transaction_id: (dup as any).transaction_id ?? null,
              matched_row_id: (dup as any).id,
              enriched,
            },
          });
          continue;
        }
      }

      const reasons: string[] = [];
      if (!parsed.amount) reasons.push('no_amount_detected');
      if (!parsed.transaction_id) reasons.push('no_transaction_id_detected');
      if (!parsed.direction) reasons.push('no_direction_keyword');
      if (parsed.channel === 'other') reasons.push('channel_unknown');

      if (debug) {
        debugReport.push({
          id: m.id,
          decision: isParsed ? 'would_insert_parsed' : 'would_insert_unparsed',
          from: fromEmail,
          from_name: fromName,
          subject,
          snippet: snippet?.slice(0, 160) ?? null,
          internal_date: internalMs ? new Date(internalMs).toISOString() : null,
          extracted: {
            amount: parsed.amount ?? null,
            transaction_id: parsed.transaction_id ?? null,
            direction: parsed.direction ?? null,
            channel: parsed.channel ?? null,
            counterparty: parsed.counterparty ?? null,
            fee: parsed.fee ?? null,
            balance: parsed.balance ?? null,
            tx_date: parsed.tx_date ?? null,
            tx_time: parsed.tx_time ?? null,
          },
          parser_notes: reasons,
        });
        continue; // do not write in debug mode
      }

      const { error } = await supabase.from('gmail_transactions').insert({
        gmail_message_id: m.id,
        gmail_thread_id: m.threadId,
        from_email: fromEmail,
        from_name: fromName,
        subject,
        snippet,
        raw_body: body?.slice(0, 8000) ?? null,
        amount: parsed.amount ?? null,
        transaction_id: parsed.transaction_id ?? null,
        tx_date: parsed.tx_date ?? null,
        tx_time: parsed.tx_time ?? null,
        parsed: isParsed,
        internal_date: internalMs ? new Date(internalMs).toISOString() : null,
        direction: parsed.direction ?? null,
        channel: parsed.channel ?? null,
        counterparty: parsed.counterparty ?? null,
        counterparty_name: (parsed as any).counterparty_name ?? null,
        fee: parsed.fee ?? null,
        balance: parsed.balance ?? null,
        dedup_hash: dedupHash,
      });
      if (!error) inserted++;
      else if ((error as any)?.code === '23505') {
        // Race: another poll inserted this row between our check and insert. Safe to ignore.
      }
      if (!error) {
        await logDepositDecision(supabase, {
          source: 'poller',
          decision: isParsed ? 'ingested_parsed' : 'ingested_unparsed',
          reason: isParsed ? null : (reasons.join(',') || 'unparsed'),
          amount: parsed.amount ?? null,
          metadata: {
            gmail_message_id: m.id,
            from: fromEmail,
            subject,
            transaction_id: parsed.transaction_id ?? null,
            direction: parsed.direction ?? null,
            channel: parsed.channel ?? null,
          },
        });
      }

      // ── Auto-credit operational float ───────────────────────────────
      // If this is a parsed INCOMING MTN/Airtel MoMo receipt whose
      // counterparty (sender) phone matches a known platform user, create
      // an `operational_float` deposit_request on their behalf and run it
      // through approve-deposit with system_auto_credit so the user opens
      // the app to find the money already in their Operational Float
      // wallet — no need to type anything.
      if (!error && isParsed) {
        try {
          await tryAutoCreditOperationalFloat(supabase, {
            parsed,
            fromEmail,
            internalMs,
            gmailMessageId: m.id,
            subject,
            snippet,
            rawBody: body ?? null,
          });
        } catch (e) {
          console.warn('[gmail-poll] auto-credit failed (non-fatal):', e);
        }
        // Thank the MoMo sender and invite them to open a free Welile Wallet.
        // Fires for any parsed INCOMING MTN/Airtel receipt whose sender phone
        // we can read — independent of whether they're a known user.
        try {
          await tryThankSenderMomoSignupSms(supabase, {
            parsed,
            internalMs,
            text: combined,
          });
        } catch (e) {
          console.warn('[gmail-poll] sender thank-you SMS failed (non-fatal):', e);
        }
        try {
          await tryAutoApproveMomoWithdrawal(supabase, {
            parsed,
            gmailMessageId: m.id,
          });
        } catch (e) {
          console.warn('[gmail-poll] auto-approve withdrawal failed (non-fatal):', e);
        }
        try {
          await tryAutoApproveBankBatch(supabase, {
            parsed,
            gmailMessageId: m.id,
          });
        } catch (e) {
          console.warn('[gmail-poll] auto-approve bank batch failed (non-fatal):', e);
        }
        // Event-driven auto-debit: the instant a parsed OUTGOING payout email
        // matches a known recipient with available balance, charge it against
        // their wallet automatically — no dependency on a manual CFO click in
        // the Financial Ops panel.
        try {
          await tryAutoDebitPayout(supabase, {
            parsed,
            internalMs,
            gmailMessageId: m.id,
          });
        } catch (e) {
          console.warn('[gmail-poll] auto-debit payout failed (non-fatal):', e);
        }
      }
    }

    if (!debug) {
      await supabase.from('gmail_poll_state').upsert({
        id: 1,
        last_internal_date_ms: newestMs || lastMs,
        last_polled_at: new Date().toISOString(),
        last_status: 'ok',
        last_error: null,
      });
    }

    // ── Recovery sweep: approve any deposits already linked to a Gmail row
    // but still pending. This catches races where the email arrived after
    // submit (linked by the late-link path above or the nightly relink job)
    // but `approve-deposit` was never invoked — so the agent's float never
    // showed up. Bounded to 25 rows per tick to keep the poll cheap.
    if (!debug) {
      try {
        await sweepLinkedPendingDeposits(supabase);
      } catch (e) {
        console.warn('[gmail-poll] linked-pending sweep failed (non-fatal):', e);
      }
      // Backstop #2: outbound sends to a registered merchant float phone that
      // never got a receipt at all (silent-gap net, Rule 3 independent).
      try {
        await sweepUnlinkedMerchantFloatSends(supabase);
      } catch (e) {
        console.warn('[gmail-poll] unlinked merchant float sweep failed (non-fatal):', e);
      }
      try {
        await resolvePossibleUserMatchAlerts(supabase);
      } catch (e) {
        console.warn('[gmail-poll] possible-user-match alert resolve sweep failed (non-fatal):', e);
      }
    }

    return new Response(JSON.stringify({
      ok: true, scanned: messages.length, inserted,
      query: GMAIL_QUERY,
      rescan: rescan ? { from: new Date(rescanFromMs).toISOString(), to: new Date(rescanToMs).toISOString() } : undefined,
      last_cutoff: lastMs ? new Date(lastMs).toISOString() : null,
      debug: debug ? debugReport : undefined,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase.from('gmail_poll_state').upsert({
      id: 1, last_polled_at: new Date().toISOString(), last_status: 'error', last_error: msg,
    });
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ── Helper: auto-credit operational float for matched user ───────────
async function tryAutoCreditOperationalFloat(
  supabase: ReturnType<typeof createClient>,
  args: {
    parsed: ReturnType<typeof parseTransaction>;
    fromEmail: string | null;
    internalMs: number;
    gmailMessageId: string;
    subject?: string | null;
    snippet?: string | null;
    rawBody?: string | null;
  },
): Promise<void> {
  return await _tryAutoCreditOperationalFloat(supabase, args);
}

// ── Helper: event-driven auto-debit of outgoing payout emails ────────
// ── Audit helper: record an auto-debit match attempt (incl. near-misses) ─
// Writes one row to `email_payout_match_attempts` referencing the source
// email (`email_id`, `email_transaction_id`) and — when known — the matched
// wallet (via metadata) so Financial Ops has a full attempt trail. Failures
// to log are swallowed so auditing never blocks a real debit.
async function logPayoutMatchAttempt(
  supabase: ReturnType<typeof createClient>,
  rec: {
    emailId: string | null;
    emailTid: string | null;
    emailAmount: number | null;
    debitedAmount?: number | null;
    recipientPhoneEmail?: string | null;
    recipientPhoneTarget?: string | null;
    paymentMethod?: string | null;
    outcome: string;
    errorMessage?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const emailAmount = rec.emailAmount != null ? Number(rec.emailAmount) : null;
    const debited = rec.debitedAmount != null ? Number(rec.debitedAmount) : null;
    await supabase.from('email_payout_match_attempts').insert({
      operator_id: null, // system auto-debit — no human operator
      withdrawal_id: null, // email→wallet debit, not tied to a withdrawal_request
      email_id: rec.emailId,
      email_transaction_id: rec.emailTid,
      email_amount: emailAmount,
      withdrawal_amount: debited,
      amount_delta:
        emailAmount != null && debited != null ? emailAmount - debited : null,
      recipient_phone_email: rec.recipientPhoneEmail ?? null,
      recipient_phone_target: rec.recipientPhoneTarget ?? null,
      payment_method: rec.paymentMethod ?? null,
      outcome: rec.outcome,
      error_message: rec.errorMessage ?? null,
      metadata: { source: 'auto_debit_poll', ...(rec.metadata ?? {}) },
    });
  } catch (e) {
    console.warn('[gmail-poll] payout match-attempt log failed (non-fatal):', e);
  }
}

// ── Helper: event-driven auto-debit of outgoing payout emails ────────
// When a parsed OUTGOING payout email (bank "sent to NAME", MTN/Airtel
// "sent to PHONE") matches exactly one known platform user who has
// withdrawable balance, debit their wallet automatically via the
// cfo-direct-credit system path. No manual click required.
//
// Every meaningful decision point below is recorded in
// `email_payout_match_attempts` (including near-misses) so Financial Ops can
// audit why a payout email did or did not auto-debit a wallet.
async function tryAutoDebitPayout(
  supabase: ReturnType<typeof createClient>,
  args: {
    parsed: ReturnType<typeof parseTransaction>;
    internalMs: number;
    gmailMessageId: string;
  },
): Promise<void> {
  const { parsed, internalMs, gmailMessageId } = args;

  // Eligibility gates
  if (parsed.direction !== 'out') return;
  if (!parsed.amount || parsed.amount <= 0) return;
  // Only act on recent payouts (mirror the 7-day window used elsewhere).
  if (internalMs && internalMs < Date.now() - 7 * 24 * 3600 * 1000) return;

  // Locate the row we just inserted so every gate below (including the silent
  // skips) can be recorded against the source email.
  const { data: gmailRow } = await supabase
    .from('gmail_transactions')
    // snippet + raw_body are needed by the bank-rail match below: the masked
    // beneficiary account lives in the message text, not on `parsed`.
    .select('id, from_name, from_email, subject, snippet, raw_body')
    .eq('gmail_message_id', gmailMessageId)
    .maybeSingle();
  if (!gmailRow?.id) return;

  // The parser stores the recipient in `counterparty`: a phone for MTN/Airtel
  // payouts, a NAME for bank payouts.
  const cp = (parsed.counterparty ?? '').toString().trim();

  // ── Rule 1: reconciled-TID skip list ─────────────────────────────────
  // If this TID has already been accounted for (e.g. CFO stamped it on a
  // float delivery / withdrawal / landlord payout), never auto-debit.
  if (parsed.transaction_id) {
    const tidNorm = String(parsed.transaction_id).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (tidNorm) {
      const { data: reconciled } = await supabase
        .from('ledger_reconciled_tids')
        .select('id, source')
        .eq('tid_normalized', tidNorm)
        .maybeSingle();
      if (reconciled?.id) {
        console.log(
          `[gmail-poll] auto-debit skip: TID ${parsed.transaction_id} already reconciled via ${reconciled.source}`,
        );
        await logPayoutMatchAttempt(supabase, {
          emailId: gmailRow.id,
          emailTid: parsed.transaction_id ?? null,
          emailAmount: parsed.amount ?? null,
          recipientPhoneEmail: cp || null,
          paymentMethod: parsed.channel ?? null,
          outcome: 'skipped_reconciled_tid',
          metadata: {
            gmail_message_id: gmailMessageId,
            reconciled_source: reconciled.source ?? null,
            reason: 'TID already stamped in ledger_reconciled_tids; nothing auto-posted for this email.',
          },
        });
        return;
      }
    }
  }

  // ── Merchant float delivery, BANK rail (runs BEFORE the phone rail) ──
  // Bank-rail counterpart of the float_phone match below. An outbound bank
  // transfer to a desk's registered `bank_account_number` is a float
  // DELIVERY to that desk, exactly like an outbound MoMo send to its
  // float_phone.
  //
  // Bank emails mask the account to first digit + last four
  // ("1********7076" for 1046202587076), so the match keys on
  // (first digit, length, last 4). A partial unique index on those three
  // guarantees at most one ACTIVE desk can match; we still assert it here
  // and refuse to credit on ambiguity rather than guessing a desk.
  //
  // NOTE: this deliberately does NOT fire on the MoMo→bank leg. MTN's
  // "transferred UGX X to EQUITY BANK LIMITED" carries no beneficiary name
  // and no account number, so it cannot be attributed to a desk from the
  // message. Only the receiving bank's own notification names the account.
  {
    // snippet is Gmail's truncated preview of the same text as raw_body —
    // join only whichever is present to avoid the duplicate-boundary
    // collision described above (use snippet only when raw_body is empty).
    const bank = extractBankBeneficiary(
      [gmailRow.subject, (gmailRow as any).raw_body || (gmailRow as any).snippet]
        .filter(Boolean).join(' '),
    );
    // Require the "sent to <NAME> <masked account>" shape, not merely SOME
    // masked account in the body. An inbound Equity receipt carries the
    // SENDER's masked account ("received ... from JOSEPH LUKODDA 1****5062")
    // and the company's own account; crediting float off either would be
    // wrong. `direction !== 'out'` already gates those out at the top of this
    // function, but this makes the block correct on its own terms rather than
    // dependent on a caller-side check.
    if (bank?.accountTail && bank.beneficiaryName) {
      const { data: bankDesks } = await supabase
        .from('cashout_agents')
        .select('agent_id, bank_account_number, bank_account_name, bank_name, label')
        .eq('is_active', true)
        .not('bank_account_number', 'is', null)
        .filter('bank_account_number', 'like', `${bank.accountFirst}%${bank.accountTail}`);

      // Re-check the full key in JS: PostgREST `like` cannot express the
      // length component, and a tail-only match is not specific enough to
      // move money on.
      const matches = (bankDesks ?? []).filter((d: any) => {
        const acct = String(d.bank_account_number ?? '');
        return acct.length === bank.accountLen &&
               acct.startsWith(bank.accountFirst) &&
               acct.endsWith(bank.accountTail);
      });

      if (matches.length === 1) {
        const desk = matches[0] as any;
        console.log(
          `[gmail-poll] outbound bank transfer to registered desk account ` +
          `${bank.accountFirst}***${bank.accountTail} → crediting float for agent=${desk.agent_id}`,
        );
        try {
          await creditMerchantFloatFromOutboundSms(supabase, {
            agentId: String(desk.agent_id),
            parsed,
            gmailMessageId,
            internalMs,
            providerOverride: String(desk.bank_name ?? 'bank').toLowerCase(),
          });
          await logPayoutMatchAttempt(supabase, {
            emailId: gmailRow.id,
            emailTid: parsed.transaction_id ?? null,
            emailAmount: parsed.amount ?? null,
            recipientPhoneEmail: bank.beneficiaryName ?? null,
            recipientPhoneTarget: String(desk.bank_account_number ?? ''),
            paymentMethod: 'bank',
            outcome: 'merchant_float_credited',
            metadata: {
              gmail_message_id: gmailMessageId,
              agent_id: desk.agent_id,
              desk_label: desk.label ?? null,
              matched_account_tail: bank.accountTail,
              beneficiary_name_in_email: bank.beneficiaryName ?? null,
              registered_account_name: desk.bank_account_name ?? null,
              reason: 'Outbound bank transfer matched a registered merchant desk bank account; routed as a float credit.',
            },
          });
        } catch (e) {
          await logPayoutMatchAttempt(supabase, {
            emailId: gmailRow.id,
            emailTid: parsed.transaction_id ?? null,
            emailAmount: parsed.amount ?? null,
            recipientPhoneEmail: bank.beneficiaryName ?? null,
            paymentMethod: 'bank',
            outcome: 'merchant_float_credit_failed',
            errorMessage: e instanceof Error ? e.message : String(e),
            metadata: { gmail_message_id: gmailMessageId, agent_id: desk.agent_id },
          });
        }
        return;
      }

      if (matches.length > 1) {
        // Should be unreachable while the unique index holds. Never guess.
        console.warn(
          `[gmail-poll] bank account ${bank.accountFirst}***${bank.accountTail} matched ` +
          `${matches.length} active desks — refusing to auto-credit`,
        );
        await logPayoutMatchAttempt(supabase, {
          emailId: gmailRow.id,
          emailTid: parsed.transaction_id ?? null,
          emailAmount: parsed.amount ?? null,
          recipientPhoneEmail: bank.beneficiaryName ?? null,
          paymentMethod: 'bank',
          outcome: 'bank_account_ambiguous',
          metadata: {
            gmail_message_id: gmailMessageId,
            matched_account_tail: bank.accountTail,
            candidate_agent_ids: matches.map((m: any) => m.agent_id),
            reason: 'Masked bank account resolved to more than one active desk; no credit posted.',
          },
        });
        return;
      }

      console.log(
        `[gmail-poll] outbound bank transfer to ${bank.accountFirst}***${bank.accountTail}: ` +
        `no registered merchant desk account`,
      );
      await logPayoutMatchAttempt(supabase, {
        emailId: gmailRow.id,
        emailTid: parsed.transaction_id ?? null,
        emailAmount: parsed.amount ?? null,
        recipientPhoneEmail: bank.beneficiaryName ?? null,
        paymentMethod: 'bank',
        outcome: 'bank_account_no_match',
        metadata: {
          gmail_message_id: gmailMessageId,
          matched_account_tail: bank.accountTail,
          beneficiary_name_in_email: bank.beneficiaryName ?? null,
          reason: 'Beneficiary account is not registered to any active desk; continued to the debit path.',
        },
      });
    }
  }

  // ── Merchant float delivery (runs BEFORE Rule 3) ─────────────────────
  // Company money sent to a registered `cashout_agents.float_phone` is a
  // FLOAT CREDIT to that agent, never a debit. Rule 3 is an emergency stop
  // for the generic auto-DEBIT engine, so it must not gate this credit.
  if (cp) {
    const cpDigits = cp.replace(/[^0-9]/g, '');
    if (cpDigits.length >= 9) {
      const cpLast9 = cpDigits.slice(-9);
      const { data: floatAgent } = await supabase
        .from('cashout_agents')
        .select('agent_id, float_phone')
        .eq('is_active', true)
        .ilike('float_phone', `%${cpLast9}`)
        .limit(1)
        .maybeSingle();
      if (floatAgent?.agent_id) {
        console.log(
          `[gmail-poll] outbound SMS to merchant float_phone ${cp} → crediting float for agent=${floatAgent.agent_id}`,
        );
        try {
          await creditMerchantFloatFromOutboundSms(supabase, {
            agentId: String(floatAgent.agent_id),
            parsed,
            gmailMessageId,
            internalMs,
          });
          await logPayoutMatchAttempt(supabase, {
            emailId: gmailRow.id,
            emailTid: parsed.transaction_id ?? null,
            emailAmount: parsed.amount ?? null,
            recipientPhoneEmail: cp,
            recipientPhoneTarget: String(floatAgent.float_phone ?? ''),
            paymentMethod: parsed.channel ?? null,
            outcome: 'merchant_float_credited',
            metadata: {
              gmail_message_id: gmailMessageId,
              agent_id: floatAgent.agent_id,
              reason: 'Outbound company send matched a registered merchant float phone; routed as a float credit.',
            },
          });
        } catch (e) {
          await logPayoutMatchAttempt(supabase, {
            emailId: gmailRow.id,
            emailTid: parsed.transaction_id ?? null,
            emailAmount: parsed.amount ?? null,
            recipientPhoneEmail: cp,
            paymentMethod: parsed.channel ?? null,
            outcome: 'merchant_float_credit_failed',
            errorMessage: e instanceof Error ? e.message : String(e),
            metadata: { gmail_message_id: gmailMessageId, agent_id: floatAgent.agent_id },
          });
        }
        return;
      }
      console.log(`[gmail-poll] outbound SMS to ${cp}: no active merchant float_phone match`);
      await logPayoutMatchAttempt(supabase, {
        emailId: gmailRow.id,
        emailTid: parsed.transaction_id ?? null,
        emailAmount: parsed.amount ?? null,
        recipientPhoneEmail: cp,
        paymentMethod: parsed.channel ?? null,
        outcome: 'float_phone_no_match',
        metadata: {
          gmail_message_id: gmailMessageId,
          counterparty_last9: cpLast9,
          reason: 'Recipient number did not match any active cashout_agents.float_phone; continued to the debit path.',
        },
      });
    }
  }

  // ── Rule 3: Welile-payout-source whitelist (emergency stop) ──────────
  // The engine only fires when the sending mailbox / provider looks like a
  // Welile-owned payout line that the CFO has explicitly whitelisted. If
  // the whitelist is empty (default), the auto-DEBIT engine is safely off.
  // Merchant float credits are handled above and are unaffected.
  const { data: whitelistRows } = await supabase
    .from('welile_payout_source_accounts')
    .select('id')
    .eq('is_active', true)
    .limit(1);
  if (!whitelistRows || whitelistRows.length === 0) {
    console.log(
      '[gmail-poll] auto-debit disabled: no active welile_payout_source_accounts whitelisted (Rule 3 emergency stop)',
    );
    await logPayoutMatchAttempt(supabase, {
      emailId: gmailRow.id,
      emailTid: parsed.transaction_id ?? null,
      emailAmount: parsed.amount ?? null,
      recipientPhoneEmail: cp || null,
      paymentMethod: parsed.channel ?? null,
      outcome: 'skipped_emergency_stop',
      metadata: {
        gmail_message_id: gmailMessageId,
        reason: 'Rule 3 emergency stop: no active welile_payout_source_accounts whitelisted, so auto-debit is off.',
      },
    });
    return;
  }

  // Idempotency: never debit the same email twice. A prior auto-debit (or a
  // manual route) leaves a row in email_routing_history for this gmail row.
  const { data: existingRoute } = await supabase
    .from('email_routing_history')
    .select('id')
    .eq('gmail_transaction_id', gmailRow.id)
    .limit(1)
    .maybeSingle();
  if (existingRoute?.id) return;

  // ── Double-debit guard: skip when a withdrawal request already consumed
  // this payout ────────────────────────────────────────────────────────
  // The poll runs `tryAutoApproveMomoWithdrawal` / `tryAutoApproveBankBatch`
  // BEFORE this helper. Those approve a pending withdrawal_request using THIS
  // email's transaction id as `fin_ops_reference`, which ALREADY debits the
  // recipient's wallet via approve-withdrawal. Without this guard we would
  // debit the very same wallet a second time for the same payout. Treat any
  // withdrawal stamped with this email's reference (and not rejected) as
  // having fully consumed the email.
  const settledRefs = new Set<string>();
  if (parsed.transaction_id) settledRefs.add(String(parsed.transaction_id).trim().toUpperCase());
  settledRefs.add(`MOMO-${gmailMessageId.slice(0, 12)}`.toUpperCase());
  if (settledRefs.size > 0) {
    const { data: settledRows } = await supabase
      .from('withdrawal_requests')
      .select('id, status, fin_ops_reference')
      .in('fin_ops_reference', Array.from(settledRefs));
    const consumed = (settledRows ?? []).some(
      (r: any) => !['rejected', 'cancelled', 'failed', 'expired'].includes(String(r.status)),
    );
    if (consumed) {
      console.log(
        `[gmail-poll] auto-debit skip: payout ${parsed.transaction_id ?? gmailMessageId} already settled a withdrawal request — not double-debiting`,
      );
      await logPayoutMatchAttempt(supabase, {
        emailId: gmailRow.id,
        emailTid: parsed.transaction_id ?? null,
        emailAmount: parsed.amount ?? null,
        recipientPhoneEmail: (parsed.counterparty ?? '').toString().trim() || null,
        paymentMethod: parsed.channel ?? null,
        outcome: 'skipped_double_debit',
        metadata: {
          gmail_message_id: gmailMessageId,
          reason: 'A withdrawal request already consumed this payout email; skipped to avoid double-debit.',
        },
      });
      return;
    }
  }

  // ── Resolve the recipient ────────────────────────────────────────────
  if (!cp) return;

  let profile: { id: string; full_name: string | null; phone: string | null } | null = null;
  let matchMethod: 'phone' | 'name' = 'phone';

  const phoneDigits = cp.replace(/[^0-9]/g, '');
  const looksLikePhone = /\d/.test(cp) && phoneDigits.length >= 9;

  if (looksLikePhone) {
    // Consolidated lookup: profile phone, mobile-money number AND numbers
    // previously learned from a positive identification. Requires exactly one
    // owner to avoid charging the wrong wallet.
    const hit = await resolveUniqueUserByKnownPhone(supabase, phoneDigits.slice(-9));
    if (hit) {
      profile = { id: hit.user_id, full_name: hit.full_name, phone: hit.phone } as any;
      matchMethod = 'phone';
    }
  } else {
    // Name match: require ≥ 2 word tokens and EXACTLY one matching profile.
    const rawName = cp.replace(/\s+/g, ' ').trim();
    const tokens = rawName.split(' ').filter((t) => t.length > 1);
    if (/[A-Za-z]/.test(rawName) && tokens.length >= 2) {
      const { data: nameMatches } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .ilike('full_name', rawName)
        .limit(2);
      if (nameMatches && nameMatches.length === 1 && nameMatches[0]?.id) {
        profile = nameMatches[0] as any;
        matchMethod = 'name';
      }
    }
  }

  if (!profile?.id) {
    console.log(`[gmail-poll] auto-debit: no unique recipient for "${cp}" — leaving for manual review`);
    await logPayoutMatchAttempt(supabase, {
      emailId: gmailRow.id,
      emailTid: parsed.transaction_id ?? null,
      emailAmount: parsed.amount ?? null,
      recipientPhoneEmail: cp || null,
      paymentMethod: parsed.channel ?? null,
      outcome: 'no_recipient_match',
      metadata: {
        gmail_message_id: gmailMessageId,
        counterparty: cp,
        looks_like_phone: looksLikePhone,
        reason: 'No unique platform user matched the payout recipient; left for manual review.',
      },
    });
    return;
  }

  // ── Resolve WHOSE wallet to debit (user, or managed-proxy fallback) ───
  // If the matched user has insufficient balance but has an active, approved,
  // MANAGED proxy agent, the proxy agent's wallet is debited instead (the user
  // is skipped). Otherwise the user is debited (full or partial). Always
  // clamped to the strict available balance so the ledger never blocks.
  const target = await resolvePayoutDebitTarget(supabase, profile, parsed.amount);
  if (!target) {
    console.warn(
      `[gmail-poll] auto-debit skip: neither ${profile.full_name} nor any managed proxy has available balance for UGX ${parsed.amount.toLocaleString()}`,
    );
    await logPayoutMatchAttempt(supabase, {
      emailId: gmailRow.id,
      emailTid: parsed.transaction_id ?? null,
      emailAmount: parsed.amount ?? null,
      recipientPhoneEmail: cp || null,
      recipientPhoneTarget: profile.phone ?? null,
      paymentMethod: parsed.channel ?? null,
      outcome: 'insufficient_balance',
      metadata: {
        gmail_message_id: gmailMessageId,
        match_method: matchMethod,
        matched_user_id: profile.id,
        matched_user_name: profile.full_name,
        reason: 'Recipient matched but neither the user nor a managed proxy had available balance to cover the payout.',
      },
    });
    return;
  }

  // ── Rule 2: merchant-agent debit block (defense-in-depth) ────────────
  // The DB trigger `trg_block_merchant_agent_auto_debit` also enforces
  // this, but skipping here avoids a noisy failed ledger insert.
  const { data: isMerchant } = await supabase.rpc('is_merchant_agent', {
    p_user_id: target.targetUserId,
  });
  if (isMerchant === true) {
    console.log(
      `[gmail-poll] auto-debit skip: target ${target.targetName} is a merchant agent (Rule 2)`,
    );
    await logPayoutMatchAttempt(supabase, {
      emailId: gmailRow.id,
      emailTid: parsed.transaction_id ?? null,
      emailAmount: parsed.amount ?? null,
      recipientPhoneEmail: cp || null,
      recipientPhoneTarget: target.targetPhone ?? null,
      paymentMethod: parsed.channel ?? null,
      outcome: 'skipped_merchant_agent',
      metadata: {
        gmail_message_id: gmailMessageId,
        match_method: matchMethod,
        target_user_id: target.targetUserId,
        target_user_name: target.targetName,
        rule: 'rule_2_merchant_agent_debit_block',
      },
    });
    return;
  }

  // ── Rule 4: payout-intent reconciliation ─────────────────────────────
  // Only auto-debit when a Welile-side payout intent expected this
  // transaction: a pending/approved withdrawal_request, or a scheduled
  // landlord_payout, matched by TID.
  if (parsed.transaction_id) {
    const tid = String(parsed.transaction_id);
    const [{ data: wr }, { data: lp }] = await Promise.all([
      supabase
        .from('withdrawal_requests')
        .select('id')
        .eq('fin_ops_reference', tid)
        .limit(1),
      supabase
        .from('landlord_payouts')
        .select('id')
        .or(`external_reference.eq.${tid},finops_momo_reference.eq.${tid}`)
        .limit(1),
    ]);
    const hasIntent = (wr && wr.length > 0) || (lp && lp.length > 0);
    if (!hasIntent) {
      console.log(
        `[gmail-poll] auto-debit skip: no payout intent found for TID ${tid} (Rule 4)`,
      );
      await logPayoutMatchAttempt(supabase, {
        emailId: gmailRow.id,
        emailTid: tid,
        emailAmount: parsed.amount ?? null,
        recipientPhoneEmail: cp || null,
        recipientPhoneTarget: target.targetPhone ?? null,
        paymentMethod: parsed.channel ?? null,
        outcome: 'no_payout_intent',
        metadata: {
          gmail_message_id: gmailMessageId,
          match_method: matchMethod,
          target_user_id: target.targetUserId,
          rule: 'rule_4_payout_intent_required',
        },
      });
      return;
    }
  }

  const debitAmt = target.debitAmount;
  const isPartial = target.isPartial;
  const viaProxy = target.viaProxy;

  const reason =
    `Auto-debit (${matchMethod} match) — outgoing payment email from ` +
    `${gmailRow.from_name || gmailRow.from_email || 'provider'}` +
    `${parsed.transaction_id ? ` TID ${parsed.transaction_id}` : ''} charged against ` +
    `${target.targetName}'s wallet` +
    `${viaProxy ? ` (managed proxy for ${target.proxyForName ?? 'partner'}, who had insufficient balance)` : ''}.` +
    `${isPartial ? ` Partial: ${debitAmt.toLocaleString()}/${parsed.amount.toLocaleString()} (wallet drained to zero).` : ''}`;

  // ── Post the debit through cfo-direct-credit's system path ────────────
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  let referenceId: string | null = null;
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/cfo-direct-credit`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'apikey': serviceKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        system_auto_debit: true,
        target_user_id: target.targetUserId,
        amount: debitAmt,
        reason,
        operation: 'debit',
        wallet_category: 'wallet_transfer',
        platform_category: 'wallet_transfer',
        financial_impact: 'neutral',
        category_label: 'Email charge → Withdrawable (auto)',
        recipient_type: 'user',
        sub_category: parsed.transaction_id ?? null,
        // Idempotency keys: guarantee at-most-once debit even if the backlog
        // sweep races this poller on the same email. gmail_message_id is
        // always present, so no-TID emails are still protected.
        gmail_transaction_id: gmailRow.id,
        gmail_message_id: gmailMessageId,
        email_tid: parsed.transaction_id ?? null,
      }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || (out as any)?.error) {
      console.warn('[gmail-poll] auto-debit cfo-direct-credit failed:', res.status, JSON.stringify(out).slice(0, 300));
      await logPayoutMatchAttempt(supabase, {
        emailId: gmailRow.id,
        emailTid: parsed.transaction_id ?? null,
        emailAmount: parsed.amount ?? null,
        debitedAmount: debitAmt,
        recipientPhoneEmail: cp || null,
        recipientPhoneTarget: target.targetPhone ?? null,
        paymentMethod: parsed.channel ?? null,
        outcome: 'debit_failed',
        errorMessage: `cfo-direct-credit ${res.status}: ${JSON.stringify((out as any)?.error ?? out).slice(0, 300)}`,
        metadata: {
          gmail_message_id: gmailMessageId,
          match_method: matchMethod,
          target_user_id: target.targetUserId,
          target_user_name: target.targetName,
          via_proxy: viaProxy,
          is_partial: isPartial,
        },
      });
      return;
    }
    referenceId = (out as any)?.reference_id ?? null;
    console.log(
      `[gmail-poll] auto-debited UGX ${debitAmt.toLocaleString()} from ${target.targetName} ` +
      `(${matchMethod}${viaProxy ? ', via managed proxy' : ''}) tid=${parsed.transaction_id ?? 'n/a'} ref=${referenceId}`,
    );
  } catch (e) {
    console.warn('[gmail-poll] auto-debit cfo-direct-credit invoke failed:', e);
    await logPayoutMatchAttempt(supabase, {
      emailId: gmailRow.id,
      emailTid: parsed.transaction_id ?? null,
      emailAmount: parsed.amount ?? null,
      debitedAmount: debitAmt,
      recipientPhoneEmail: cp || null,
      recipientPhoneTarget: target.targetPhone ?? null,
      paymentMethod: parsed.channel ?? null,
      outcome: 'debit_failed',
      errorMessage: `invoke error: ${e instanceof Error ? e.message : String(e)}`,
      metadata: {
        gmail_message_id: gmailMessageId,
        match_method: matchMethod,
        target_user_id: target.targetUserId,
        target_user_name: target.targetName,
        via_proxy: viaProxy,
        is_partial: isPartial,
      },
    });
    return;
  }

  // ── Success: record the completed auto-debit match ────────────────────
  await logPayoutMatchAttempt(supabase, {
    emailId: gmailRow.id,
    emailTid: parsed.transaction_id ?? null,
    emailAmount: parsed.amount ?? null,
    debitedAmount: debitAmt,
    recipientPhoneEmail: cp || null,
    recipientPhoneTarget: target.targetPhone ?? null,
    paymentMethod: parsed.channel ?? null,
    outcome: isPartial ? 'debited_partial' : 'debited',
    metadata: {
      gmail_message_id: gmailMessageId,
      match_method: matchMethod,
      target_user_id: target.targetUserId,
      target_user_name: target.targetName,
      via_proxy: viaProxy,
      proxy_for_user_id: target.proxyForUserId ?? null,
      proxy_for_name: target.proxyForName ?? null,
      is_partial: isPartial,
      ledger_reference_id: referenceId,
    },
  });

  // Record the routing so the panel shows the row as auto-debited and the
  // idempotency guard above blocks any re-run.
  try {
    await supabase.from('email_routing_history').insert({
      gmail_transaction_id: gmailRow.id,
      gmail_message_id: gmailMessageId,
      transaction_id: parsed.transaction_id ?? null,
      from_email: gmailRow.from_email,
      from_name: gmailRow.from_name,
      subject: gmailRow.subject,
      amount: debitAmt,
      route: 'withdrawable_debit',
      target_user_id: target.targetUserId,
      target_user_name: target.targetName,
      target_user_phone: target.targetPhone,
      reason: `DEBIT (auto, ${matchMethod}${viaProxy ? `, via managed proxy for ${target.proxyForName ?? 'partner'}` : ''}${isPartial ? `, partial ${debitAmt.toLocaleString()}/${parsed.amount.toLocaleString()}` : ''}): ${reason}`,
      ledger_reference_id: referenceId,
      routed_by: target.targetUserId,
      routed_by_name: 'System Auto-Debit',
      sms_sent: false,
      sms_error: null,
    });
  } catch (e) {
    console.warn('[gmail-poll] auto-debit routing-history insert failed (non-fatal):', e);
  }

  // ── Audit: user skipped (insufficient balance) → managed proxy debited ──
  if (viaProxy && target.proxyForUserId) {
    await logProxyFallbackAudit(supabase, {
      actorId: null, // system auto-debit
      source: 'auto_poll',
      gmailTransactionId: gmailRow.id ?? null,
      gmailMessageId: gmailMessageId ?? null,
      emailTid: parsed.transaction_id ?? null,
      skippedUserId: target.proxyForUserId,
      skippedUserName: target.proxyForName,
      proxyUserId: target.targetUserId,
      proxyUserName: target.targetName,
      requestedAmount: parsed.amount,
      debitedAmount: debitAmt,
      isPartial,
      ledgerReferenceId: referenceId,
    });
  }
}

// ── Helper: auto-credit operational float for matched user (impl) ─────
// ── Helper: credit a merchant agent's float from an outbound company SMS ──
// The company physically sends MoMo/Airtel money to the agent's registered
// `cashout_agents.float_phone`. The forwarded "You have sent ..." email is
// therefore a float DELIVERY to that agent. Mirrors the inbound auto-credit
// path (insert deposit → link gmail row → approve-deposit → notify), minus
// identity resolution: the agent is already known.
async function creditMerchantFloatFromOutboundSms(
  supabase: ReturnType<typeof createClient>,
  args: {
    agentId: string;
    parsed: ReturnType<typeof parseTransaction>;
    gmailMessageId: string;
    internalMs: number;
    /** Bank-rail callers pass the bank name; channel alone cannot distinguish
     *  a bank transfer from an Airtel send, and the provider is recorded on
     *  the delivery row and in the ledger description. */
    providerOverride?: string;
  },
): Promise<void> {
  const { agentId, parsed, gmailMessageId, internalMs, providerOverride } = args;
  if (!parsed.amount || parsed.amount <= 0) {
    await logDepositDecision(supabase, {
      source: 'matcher',
      decision: 'failed',
      reason: 'merchant_float_invalid_amount',
      amount: parsed.amount ?? null,
      actor_id: agentId,
      metadata: { gmail_message_id: gmailMessageId },
    });
    return;
  }

  // 1. Locate the gmail row + idempotency guard.
  const { data: gmailRow } = await supabase
    .from('gmail_transactions')
    .select('id, linked_deposit_request_id')
    .eq('gmail_message_id', gmailMessageId)
    .maybeSingle();
  if (!gmailRow?.id) {
    await logDepositDecision(supabase, {
      source: 'matcher',
      decision: 'failed',
      reason: 'merchant_float_gmail_row_missing',
      amount: parsed.amount ?? null,
      actor_id: agentId,
      metadata: { gmail_message_id: gmailMessageId },
    });
    return;
  }
  if (gmailRow.linked_deposit_request_id) {
    console.log(`[gmail-poll] merchant float credit skip: email ${gmailMessageId} already linked to a deposit`);
    // Withheld, not silent: if the linked deposit is still pending, the money
    // is detected but uncredited — make that visible to FinOps.
    const { data: linkedDep } = await supabase
      .from('deposit_requests')
      .select('id, status')
      .eq('id', gmailRow.linked_deposit_request_id)
      .maybeSingle();
    if (linkedDep && String((linkedDep as any).status) === 'pending') {
      await raiseMerchantFloatAlert(supabase, {
        gmailRowId: String(gmailRow.id),
        agentId,
        amount: parsed.amount ?? null,
        transactionId: parsed.transaction_id ?? null,
        counterparty: (parsed as any).counterparty ?? null,
        reason: 'Email already linked to a deposit that is still pending — awaiting the linked-pending retry sweep.',
        severity: 'medium',
        extra: { deposit_request_id: (linkedDep as any).id, stage: 'already_linked_pending' },
      });
    }
    return;
  }

  // 2. Agent profile.
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, phone, full_name, email')
    .eq('id', agentId)
    .maybeSingle();
  if (!profile?.id) {
    console.warn(`[gmail-poll] merchant float credit: no profile for agent ${agentId}`);
    return;
  }

  const provider = providerOverride
    ?? (parsed.channel === 'mtn_momo' ? 'mtn' : 'airtel');

  // 3. Record merchant float delivery via RPC.
  const { data: rpcData, error: rpcErr } = await supabase.rpc('record_merchant_float_delivery', {
    p_tid: parsed.transaction_id,
    p_agent_user_id: profile.id,
    p_amount: parsed.amount,
    p_provider: provider,
    p_gmail_transaction_id: gmailRow.id,
    p_occurred_at: internalMs ? new Date(internalMs).toISOString() : new Date().toISOString(),
  });

  if (rpcErr) {
    console.warn('[gmail-poll] merchant float RPC error:', rpcErr);
    await logDepositDecision(supabase, {
      source: 'matcher',
      decision: 'failed',
      reason: 'merchant_float_rpc_error',
      amount: parsed.amount ?? null,
      actor_id: profile.id,
      metadata: { gmail_message_id: gmailMessageId, error: rpcErr.message },
    });
    return;
  }

  const reason = (rpcData as any)?.reason;
  if (reason !== 'credited' && reason !== 'already_reconciled' && reason !== 'already_recorded') {
    await logDepositDecision(supabase, {
      source: 'matcher',
      decision: 'failed',
      reason: `merchant_float_rpc_${reason}`,
      amount: parsed.amount ?? null,
      actor_id: profile.id,
      metadata: { gmail_message_id: gmailMessageId, rpc_result: rpcData },
    });
    return;
  }

  if (reason === 'credited') {
    await logDepositDecision(supabase, {
      source: 'matcher',
      decision: 'auto_credited',
      reason: 'merchant_float_rpc_credited',
      amount: parsed.amount ?? null,
      actor_id: profile.id,
      metadata: { gmail_message_id: gmailMessageId },
    });
  }

  await supabase
    .from('gmail_transactions')
    .update({
      auto_match_method: 'merchant_float_sms_rpc',
      auto_matched_at: new Date().toISOString(),
    })
    .eq('id', gmailRow.id);

  // 6. Notify the agent (same SMS + email receipt as the inbound path).
  try {
    const { data: walletRow } = await supabase
      .from('wallets')
      .select('float_balance')
      .eq('user_id', profile.id)
      .maybeSingle();
    const newFloat = Number(walletRow?.float_balance ?? 0);
    const firstName = (profile.full_name ?? '').split(' ')[0] || 'there';
    const fmt = (n: number) => `UGX ${Math.round(n).toLocaleString('en-UG')}`;
    if (profile.phone) {
      const msg =
        `Welile: Hi ${firstName}, ${fmt(parsed.amount!)} from ${provider.toUpperCase()} ` +
        `(TID ${parsed.transaction_id}) was auto-credited to your Operational Float. ` +
        `New float balance: ${fmt(newFloat)}.`;
      await sendSmsViaAfricasTalking(profile.phone, msg);
    }
    // Ownership guard: never email a float receipt to an address that is
    // shared with (or owned by) another account. See ownedRecipientEmail.ts.
    const recipientEmail = await resolveOwnedRecipientEmail(
      supabase,
      profile.id,
      'gmail-poll-transactions',
    );
    if (recipientEmail) {
      const fnUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/send-transactional-email`;
      const sk = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const providerLabel = provider === 'mtn' ? 'MTN MoMo' : 'Airtel Money';
      const nowDate = new Date(internalMs || Date.now()).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kampala',
      });
      await fetch(fnUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sk}`,
          'apikey': sk,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          templateName: 'operational-float-credit',
          recipientEmail,
          idempotencyKey: `op-float-credit-${gmailMessageId}`,
          templateData: {
            partner_name: profile.full_name || firstName,
            transaction_id: parsed.transaction_id,
            amount: parsed.amount,
            currency: 'UGX',
            date: nowDate,
            source: providerLabel,
            new_float_balance: newFloat,
          },
        }),
      });
    }
  } catch (e) {
    console.warn('[gmail-poll] merchant float notification failed (non-fatal):', e);
  }
}

async function _tryAutoCreditOperationalFloat(
  supabase: ReturnType<typeof createClient>,
  args: {
    parsed: ReturnType<typeof parseTransaction>;
    fromEmail: string | null;
    internalMs: number;
    gmailMessageId: string;
    subject?: string | null;
    snippet?: string | null;
    rawBody?: string | null;
  },
): Promise<void> {
  const { parsed, internalMs, gmailMessageId } = args;
  const { subject = null, snippet = null, rawBody = null } = args;

  // Eligibility gates
  if (!parsed.amount || parsed.amount <= 0) return;
  if (!parsed.transaction_id) return;
  if (parsed.direction !== 'in') return;
  if (parsed.channel !== 'mtn_momo' && parsed.channel !== 'airtel_money') return;

  // Only credit receipts within the last 7 days (matches approve-deposit gate).
  if (internalMs && internalMs < Date.now() - 7 * 24 * 3600 * 1000) return;

  // Extract a phone from counterparty (parser already captures phone shape).
  const cp = (parsed.counterparty ?? '').toString();
  const phoneMatch = cp.match(/(?:\+?256|0)?\d{9,12}/);

  let profile: { id: string; phone: string | null; full_name: string | null; email?: string | null } | null = null;
  let matchMethod: 'phone' | 'name' = 'phone';
  // Track which last-9 phone actually resolved the user and where it was
  // found (the sender/counterparty field vs anywhere in the email body).
  // A body match is the "possible user (≈60%)" signal surfaced in the
  // Financial-Ops UI — we now auto-credit it too, but only when it points
  // to exactly ONE known user, to avoid mis-crediting.
  let matchedPhoneLast9: string | null = null;
  let phoneSource: 'counterparty' | 'body' | null = null;
  // Audit detail for name-fallback matching: candidate pool, chosen
  // tie-breaker, last-seen timestamps, and confidence breakdown. Surfaced
  // in the Auto-Credit Review queue so ops can judge each best-guess.
  let nameMatchAudit: {
    raw_name: string;
    total_candidates: number;
    candidates: Array<{
      id: string;
      full_name: string | null;
      phone_last4: string | null;
      has_phone: boolean;
      last_sign_in_at: string | null;
      last_sign_in_ms: number;
      selected: boolean;
    }>;
    tiebreaker: string;
    tiebreaker_pool: 'with-phone' | 'all' | 'single' | null;
    confidence: 'high' | 'medium' | 'low';
    confidence_score: number;
    confidence_reasons: string[];
  } | null = null;

  // Every Ugandan mobile number visible ANYWHERE in this email. Computed up
  // front because it feeds both the body-phone fallback below and the
  // number-learning hook after a high-confidence name match.
  const emailLast9Set = new Set<string>();
  {
    const hay = `${cp}\n${subject ?? ''}\n${snippet ?? ''}\n${rawBody ?? ''}`;
    for (const t of hay.match(/(?:\+?256|0)?7\d{8}/g) ?? []) {
      const d = toLast9(t);
      if (d) emailLast9Set.add(d);
    }
  }

  if (phoneMatch) {
    const last9 = toLast9(phoneMatch[0]);
    if (last9) {
      // Consolidated lookup across profile phone, mobile-money number and
      // numbers learned from earlier positive identifications.
      const hit = await resolveUniqueUserByKnownPhone(supabase, last9);
      if (hit) {
        profile = { id: hit.user_id, phone: hit.phone, full_name: hit.full_name, email: hit.email } as any;
        matchedPhoneLast9 = last9;
        phoneSource = 'counterparty';
      }
    }
  }

  // ── Body-phone fallback (the UI "possible user ≈60%" signal) ─────────
  // The counterparty field only carries the sender phone for some providers.
  // When it didn't resolve a user, scan the WHOLE email (counterparty +
  // subject + snippet + body) for Ugandan mobile numbers (last-9 begins
  // with 7) and auto-credit only when every phone found points to the SAME
  // single known user. Uniqueness is required so an unrelated number printed
  // elsewhere in the email can never mis-credit someone.
  if (!profile) {
    if (emailLast9Set.size > 0) {
      const found = new Map<string, { id: string; phone: string | null; full_name: string | null; email?: string | null; last9: string }>();
      for (const last9 of emailLast9Set) {
        for (const h of await resolveUsersByKnownPhone(supabase, last9)) {
          if (!found.has(h.user_id)) {
            found.set(h.user_id, {
              id: h.user_id, phone: h.phone, full_name: h.full_name, email: h.email, last9,
            });
          }
        }
      }
      if (found.size === 1) {
        const only = Array.from(found.values())[0];
        profile = { id: only.id, phone: only.phone, full_name: only.full_name, email: only.email };
        matchMethod = 'phone';
        matchedPhoneLast9 = only.last9;
        phoneSource = 'body';
        console.log(`[gmail-poll] body-phone fallback matched last9=${only.last9} → user=${only.id}`);
      } else if (found.size > 1) {
        console.log(`[gmail-poll] body-phone fallback ambiguous (${found.size} users) — skipping auto-credit`);
        await logDepositDecision(supabase, {
          source: 'matcher',
          decision: 'skipped',
          reason: 'body_phone_ambiguous',
          amount: parsed.amount ?? null,
          metadata: { gmail_message_id: gmailMessageId, match_count: found.size },
        });
      }
    }
  }

  // ── MTN MoMo fallback ────────────────────────────────────────────
  // Reached only when the phone (now correctly extracted from the
  // "(NAME) 256XXXXXXXXX" shape above, or from the body-phone scan) didn't
  // resolve to a known user — e.g. a third party depositing on someone
  // else's behalf, or a first-time payer. Try a strict name match — only
  // accept when EXACTLY one profile matches, to avoid mis-crediting on
  // common names. Prefer the name captured alongside the phone
  // (counterparty_name); fall back to counterparty itself for any other
  // MTN shape that still puts a bare name there.
  if (!profile && parsed.channel === 'mtn_momo') {
    const rawName = ((parsed as any).counterparty_name ?? cp).replace(/\s+/g, ' ').trim();
    // Must look like a real human name (≥ 2 words, ≥ 4 chars total, letters)
    if (rawName && /[A-Za-z]/.test(rawName) && rawName.split(' ').filter(Boolean).length >= 2 && rawName.length >= 4) {
      const { data: nameMatches } = await supabase
        .from('profiles')
        .select('id, phone, full_name, email')
        .ilike('full_name', rawName)
        .limit(10);
      if (nameMatches && nameMatches.length === 1 && nameMatches[0]?.id) {
        profile = nameMatches[0] as any;
        matchMethod = 'name';
        const only = nameMatches[0] as any;
        const onlyDigits = (only.phone ?? '').replace(/\D/g, '');
        nameMatchAudit = {
          raw_name: rawName,
          total_candidates: 1,
          candidates: [{
            id: only.id,
            full_name: only.full_name ?? null,
            phone_last4: onlyDigits.length >= 4 ? onlyDigits.slice(-4) : null,
            has_phone: onlyDigits.length >= 9,
            last_sign_in_at: null,
            last_sign_in_ms: 0,
            selected: true,
          }],
          tiebreaker: 'unique-name-match',
          tiebreaker_pool: 'single',
          confidence: 'high',
          confidence_score: 0.95,
          confidence_reasons: ['exactly one profile matched the sender name'],
        };
        console.log(`[gmail-poll] MTN name-fallback matched "${rawName}" → user=${profile.id}`);
      } else if (nameMatches && nameMatches.length > 1) {
        // Tie-breaker 1: prefer profiles that actually have a phone on file.
        const withPhone = nameMatches.filter((p: any) => (p.phone ?? '').replace(/\D/g, '').length >= 9);
        let winner: any = null;
        let tiebreaker = '';
        let tiebreakerPool: 'with-phone' | 'all' | 'single' | null = null;
        const lastSeen: { id: string; ts: number; iso: string | null }[] = [];
        if (withPhone.length === 1) {
          winner = withPhone[0];
          tiebreaker = 'only-profile-with-phone';
          tiebreakerPool = 'with-phone';
        } else {
          // Tie-breaker 2: pick the most recently active auth user (within 30d
          // and strictly newer than every other candidate by ≥ 24h).
          const pool = withPhone.length > 1 ? withPhone : nameMatches;
          tiebreakerPool = withPhone.length > 1 ? 'with-phone' : 'all';
          // Best-guess: pick the most recently active auth user among the
          // same-named candidates. Ops can reverse via Email Transactions
          // if it turns out to be the wrong user.
          for (const p of pool) {
            try {
              const { data: u } = await (supabase as any).auth.admin.getUserById(p.id);
              const t = u?.user?.last_sign_in_at ? new Date(u.user.last_sign_in_at).getTime() : 0;
              lastSeen.push({ id: p.id, ts: t, iso: u?.user?.last_sign_in_at ?? null });
            } catch {
              lastSeen.push({ id: p.id, ts: 0, iso: null });
            }
          }
          lastSeen.sort((a, b) => b.ts - a.ts);
          const top = lastSeen[0];
          if (top) {
            winner = pool.find((p: any) => p.id === top.id) ?? null;
            tiebreaker = top.ts > 0 ? 'most-recent-active' : 'first-candidate';
          }
        }
        if (winner?.id) {
          profile = winner;
          matchMethod = 'name';
          // Confidence: 'low' for first-candidate (no signal), 'medium' for
          // most-recent-active, 'high' for only-profile-with-phone.
          let confidence: 'high' | 'medium' | 'low' = 'low';
          let confidenceScore = 0.3;
          const reasons: string[] = [];
          if (tiebreaker === 'only-profile-with-phone') {
            confidence = 'high';
            confidenceScore = 0.85;
            reasons.push('only one of the same-named profiles has a phone on file');
          } else if (tiebreaker === 'most-recent-active') {
            const top = lastSeen[0];
            const second = lastSeen[1];
            const gapDays = top && second ? (top.ts - second.ts) / 86400000 : 0;
            if (gapDays >= 7) {
              confidence = 'medium';
              confidenceScore = 0.65;
              reasons.push(`winner active ${gapDays.toFixed(1)}d more recently than runner-up`);
            } else {
              confidence = 'low';
              confidenceScore = 0.4;
              reasons.push(`winner active only ${gapDays.toFixed(1)}d more recently than runner-up`);
            }
          } else {
            reasons.push('no last-sign-in signal — picked first candidate');
          }
          const lsMap = new Map(lastSeen.map(l => [l.id, l]));
          nameMatchAudit = {
            raw_name: rawName,
            total_candidates: nameMatches.length,
            candidates: nameMatches.map((p: any) => {
              const digits = (p.phone ?? '').replace(/\D/g, '');
              const ls = lsMap.get(p.id);
              return {
                id: p.id,
                full_name: p.full_name ?? null,
                phone_last4: digits.length >= 4 ? digits.slice(-4) : null,
                has_phone: digits.length >= 9,
                last_sign_in_at: ls?.iso ?? null,
                last_sign_in_ms: ls?.ts ?? 0,
                selected: p.id === winner.id,
              };
            }),
            tiebreaker,
            tiebreaker_pool: tiebreakerPool,
            confidence,
            confidence_score: confidenceScore,
            confidence_reasons: reasons,
          };
          console.log(`[gmail-poll] MTN name-fallback resolved "${rawName}" (${nameMatches.length} matches) via ${tiebreaker} → user=${winner.id}`);
        } else {
          console.log(`[gmail-poll] MTN name-fallback ambiguous for "${rawName}" (${nameMatches.length} matches, no clear winner) — skipping auto-credit`);
          await logDepositDecision(supabase, {
            source: 'matcher',
            decision: 'skipped',
            reason: 'name_match_ambiguous',
            amount: parsed.amount ?? null,
            metadata: { gmail_message_id: gmailMessageId, raw_name: rawName, match_count: nameMatches.length },
          });
        }
      } else {
        // ── Learned-name tier ─────────────────────────────────────────────
        // No EXACT profile match (the payer is a third party depositing on
        // someone else's behalf — their name will never be in `profiles` at
        // all). Before falling back to the weak fuzzy-suggestion tier, check
        // whether Financial Ops has already confirmed this exact name by
        // hand before. `resolveUniqueUserByKnownName` only ever returns a hit
        // while the name is UNCONTESTED — the instant this same name is ever
        // manually routed to a second, different user, learnDepositName
        // freezes it project-wide and this tier stops firing for it, so a
        // real name collision can never silently auto-credit the wrong
        // wallet. See `_shared/depositNumberLearning.ts`.
        const learnedHit = await resolveUniqueUserByKnownName(supabase, normalizeDepositorName(rawName));
        if (learnedHit) {
          profile = { id: learnedHit.user_id, phone: learnedHit.phone, full_name: learnedHit.full_name, email: learnedHit.email } as any;
          matchMethod = 'name';
          nameMatchAudit = {
            raw_name: rawName,
            total_candidates: 1,
            candidates: [{
              id: learnedHit.user_id,
              full_name: learnedHit.full_name,
              phone_last4: null,
              has_phone: !!learnedHit.phone,
              last_sign_in_at: null,
              last_sign_in_ms: 0,
              selected: true,
            }],
            tiebreaker: 'learned-name-match',
            tiebreaker_pool: 'single',
            confidence: 'high',
            confidence_score: 0.9,
            confidence_reasons: ['payer name previously confirmed by Financial Ops and never contested'],
          };
          console.log(`[gmail-poll] learned-name match: "${rawName}" → user=${profile.id} (uncontested)`);
        } else {
          // ── Fuzzy/near-match tier ──────────────────────────────────────
          // No EXACT name match at all (nameMatches.length === 0) and no
          // uncontested learned-name hit either. MTN's SIM-registered name
          // often differs slightly from the platform profile — try a
          // looser, order-independent token match, but treat any hit as a
          // SUGGESTION only: never auto-credit off a fuzzy match. This just
          // gives Financial Ops (or the payer) a concrete lead instead of
          // the receipt disappearing into a bare "no_user_match" with
          // nothing to act on.
          const fuzzyCandidates = await resolveFuzzyNameCandidates(supabase, rawName);
          if (fuzzyCandidates.length === 1) {
            const candidate = fuzzyCandidates[0];
            console.log(
              `[gmail-poll] MTN name fuzzy-match (not auto-credited): "${rawName}" ≈ ` +
              `"${candidate.full_name}" user=${candidate.id}`,
            );
            await logDepositDecision(supabase, {
              source: 'matcher',
              decision: 'flagged_for_review',
              reason: 'name_fuzzy_match_needs_confirmation',
              amount: parsed.amount ?? null,
              metadata: {
                gmail_message_id: gmailMessageId,
                raw_name: rawName,
                candidate_user_id: candidate.id,
                candidate_full_name: candidate.full_name,
              },
            });
            const { data: fuzzyGmailRow } = await supabase
              .from('gmail_transactions')
              .select('id')
              .eq('gmail_message_id', gmailMessageId)
              .maybeSingle();
            if (fuzzyGmailRow?.id) {
              await raisePossibleUserMatchAlert(supabase, {
                gmailRowId: String(fuzzyGmailRow.id),
                amount: parsed.amount ?? null,
                transactionId: parsed.transaction_id ?? null,
                rawName,
                candidateUserId: candidate.id,
                candidateName: candidate.full_name,
              });
            }
          } else {
            await logDepositDecision(supabase, {
              source: 'matcher',
              decision: 'skipped',
              reason: fuzzyCandidates.length > 1 ? 'name_fuzzy_ambiguous' : 'name_no_match',
              amount: parsed.amount ?? null,
              metadata: { gmail_message_id: gmailMessageId, raw_name: rawName, candidate_count: fuzzyCandidates.length },
            });
          }
        }
      }
    }
  }

  if (!profile?.id) {
    await logDepositDecision(supabase, {
      source: 'matcher',
      decision: 'skipped',
      reason: 'no_user_match',
      amount: parsed.amount ?? null,
      metadata: { gmail_message_id: gmailMessageId, parsed_tid: parsed.transaction_id ?? null },
    });
    return;
  }

  // Find the gmail_transactions row we just wrote so we can link it.
  const { data: gmailRow } = await supabase
    .from('gmail_transactions')
    .select('id, linked_deposit_request_id')
    .eq('gmail_message_id', gmailMessageId)
    .maybeSingle();
  if (!gmailRow?.id) return;
  if (gmailRow.linked_deposit_request_id) return; // already linked

  // ── Learn the depositor's number from a HIGH-confidence name match ────
  // MTN "received" emails usually carry only a name. When such an email DID
  // also contain exactly one Ugandan number, and the name match was
  // high-confidence (exact unique name, or the only same-named profile with a
  // phone), remember that number so the NEXT deposit resolves at the cheap
  // phone step. Medium/low-confidence tiebreakers are best-guesses and are
  // deliberately never learned from.
  if (
    matchMethod === 'name' &&
    nameMatchAudit?.confidence === 'high' &&
    emailLast9Set.size === 1
  ) {
    await learnDepositNumber(supabase, {
      userId: profile.id,
      phone: Array.from(emailLast9Set)[0],
      source: 'name_match_auto',
      gmailTransactionId: gmailRow.id,
      createdBy: null,
      notes: `name match: ${nameMatchAudit.tiebreaker}`,
    });
  }



  // Idempotency / late-arriving-email fix:
  // If the user ALREADY submitted a deposit_request with this TID (typical
  // flow: agent types the TID before the MoMo receipt has hit our Gmail
  // inbox), there are two cases:
  //   1) That deposit is already approved/processed → nothing to do, return.
  //   2) That deposit is still `pending` because `try_link_gmail_for_deposit`
  //      ran before this email row existed. The nightly relink cron would
  //      eventually catch it, but the agent expects their float to appear
  //      instantly. So: link this gmail row to that pending deposit and run
  //      approve-deposit immediately (same path the relink job uses).
  const tidDigits = parsed.transaction_id.replace(/[^0-9]/g, '');
  if (tidDigits) {
    const { data: existingDep } = await supabase
      .from('deposit_requests')
      .select('id, status, amount, user_id, provider')
      .eq('user_id', profile.id)
      .not('status', 'in', '(rejected,cancelled,failed)')
      .neq('provider', 'cash_deposit') // cash-code deposits credit ONLY via the receipt code
      .filter('transaction_id', 'ilike', `%${tidDigits}`)
      .limit(1)
      .maybeSingle();
    if (existingDep?.id) {
      if (String(existingDep.status) !== 'pending') return;
      if (Number(existingDep.amount) !== Number(parsed.amount)) {
        console.warn(
          `[gmail-poll] late-link skipped: amount mismatch dep=${existingDep.id} ` +
          `dep_amount=${existingDep.amount} email_amount=${parsed.amount}`,
        );
        await logDepositDecision(supabase, {
          source: 'matcher',
          decision: 'skipped',
          reason: 'late_link_amount_mismatch',
          deposit_request_id: existingDep.id,
          amount: parsed.amount ?? null,
          metadata: { gmail_message_id: gmailMessageId, dep_amount: Number(existingDep.amount), email_amount: Number(parsed.amount) },
        });
        return;
      }
      // Link gmail row → existing pending deposit so approve-deposit re-verification passes.
      await supabase
        .from('gmail_transactions')
        .update({
          linked_deposit_request_id: existingDep.id,
          auto_matched_at: new Date().toISOString(),
          auto_match_method: 'late_email_tid_match',
        })
        .eq('id', gmailRow.id);

      // Stamp the deposit's audit so the user-facing "Will auto-credit when
      // your receipt arrives" panel flips to ✅ instead of staying pending.
      await supabase
        .from('deposit_requests')
        .update({
          auto_match_audit: {
            checked_at: new Date().toISOString(),
            normalized_tid: tidDigits,
            raw_tid: parsed.transaction_id,
            outcome: 'linked',
            source: 'gmail_poll_late_link',
            note: 'Mobile-money receipt arrived after deposit was submitted; matched and auto-credited.',
          },
        } as any)
        .eq('id', existingDep.id)
        .eq('status', 'pending'); // never overwrite a row a human already reviewed

      // Fire approve-deposit (same system_auto_credit path used below).
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/approve-deposit`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${serviceKey}`,
            'apikey': serviceKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            deposit_request_id: existingDep.id,
            action: 'approve',
            auto_approved: true,
            auto_match_method: 'late_email_tid_match',
            system_auto_credit: true,
          }),
        });
        if (!res.ok) {
          const txt = await res.text();
          console.warn('[gmail-poll] late-link approve-deposit non-200:', res.status, txt.slice(0, 300));
          await logDepositDecision(supabase, {
            source: 'matcher',
            decision: 'failed',
            reason: 'late_link_approve_non_200',
            deposit_request_id: existingDep.id,
            amount: parsed.amount ?? null,
            metadata: { gmail_message_id: gmailMessageId, status: res.status, body: txt.slice(0, 300), auto_match_method: 'late_email_tid_match' },
          });
        } else {
          console.log(
            `[gmail-poll] late-link auto-credited existing pending deposit user=${profile.id} ` +
            `dep=${existingDep.id} amt=${parsed.amount} tid=${parsed.transaction_id}`,
          );
          await logDepositDecision(supabase, {
            source: 'matcher',
            decision: 'auto_credited',
            reason: 'late_email_tid_match',
            deposit_request_id: existingDep.id,
            amount: parsed.amount ?? null,
            actor_id: profile.id,
            metadata: { gmail_message_id: gmailMessageId, tid: parsed.transaction_id ?? null },
          });
        }
      } catch (e) {
        console.warn('[gmail-poll] late-link approve-deposit invoke failed:', e);
        await logDepositDecision(supabase, {
          source: 'matcher',
          decision: 'failed',
          reason: 'late_link_approve_invoke_error',
          deposit_request_id: existingDep.id,
          amount: parsed.amount ?? null,
          metadata: { gmail_message_id: gmailMessageId, error: String(e) },
        });
      }
      return;
    }
  }

  const provider = parsed.channel === 'mtn_momo' ? 'mtn' : 'airtel';

  // ── Direct tenant rent payment (2026-09-06 tenant-ops meeting, item #7) ──
  // 090777 / 4380664 are Welile's own MTN/Airtel merchant tills — the SAME
  // destination every self-deposit already targets, so a tenant paying rent
  // directly here produces an email indistinguishable from a normal
  // self-deposit at this point in the pipeline: no pre-existing
  // deposit_requests row (checked above), a resolved profile, a real TID.
  // Try attributing it to the tenant's responsible agent + rent balance
  // BEFORE falling through to the default "credit the sender's own
  // operational float" path below, since that default is simply wrong for a
  // tenant (their payment would vanish into their own wallet with no rent
  // credit and no agent commission). record_direct_tenant_rent_payment
  // itself is the gate: it only succeeds when this profile has an active,
  // outstanding rent request, so a genuine agent/self self-deposit is
  // untouched and falls through exactly as before.
  {
    const { data: directRpc, error: directErr } = await supabase.rpc('record_direct_tenant_rent_payment', {
      p_tid: parsed.transaction_id,
      p_tenant_id: profile.id,
      p_amount: parsed.amount,
      p_provider: provider,
      p_gmail_transaction_id: gmailRow.id,
      p_occurred_at: internalMs ? new Date(internalMs).toISOString() : new Date().toISOString(),
    });

    if (directErr) {
      console.error('[gmail-poll] record_direct_tenant_rent_payment RPC error:', directErr);
      await logDepositDecision(supabase, {
        source: 'matcher',
        decision: 'failed',
        reason: 'direct_tenant_rent_payment_rpc_error',
        amount: parsed.amount ?? null,
        actor_id: profile.id,
        metadata: { gmail_message_id: gmailMessageId, error: directErr.message },
      });
      // Fall through to default handling below — don't drop the receipt.
    } else if (directRpc?.ok) {
      await supabase
        .from('gmail_transactions')
        .update({
          auto_matched_at: new Date().toISOString(),
          auto_match_method: 'direct_tenant_rent_payment',
        })
        .eq('id', gmailRow.id);
      console.log(
        `[gmail-poll] direct tenant rent payment credited tenant=${profile.id} ` +
        `agent=${directRpc.agent_id} amount=${directRpc.amount_applied} reason=${directRpc.reason}`,
      );
      await logDepositDecision(supabase, {
        source: 'matcher',
        decision: 'auto_credited',
        reason: `direct_tenant_rent_payment_${directRpc.reason}`,
        amount: parsed.amount ?? null,
        actor_id: profile.id,
        metadata: { gmail_message_id: gmailMessageId, ...directRpc },
      });
      return;
    } else if (directRpc?.reason === 'amount_exceeds_outstanding') {
      // Unusual (rent nearly settled, or a mistaken overpayment) — surface it
      // rather than silently absorbing it into the tenant's own float below.
      await logDepositDecision(supabase, {
        source: 'matcher',
        decision: 'skipped',
        reason: 'direct_tenant_rent_payment_amount_exceeds_outstanding',
        amount: parsed.amount ?? null,
        actor_id: profile.id,
        metadata: { gmail_message_id: gmailMessageId, ...directRpc },
      });
    }
    // Any other reason (no_active_rent_request / no_outstanding_balance /
    // no_responsible_agent / already_reconciled / already_recorded) means
    // this genuinely isn't a direct rent payment — fall through unchanged.
  }

  const auditMeta = {
    source: 'gmail_auto_credit',
    gmail_message_id: gmailMessageId,
    match_method: matchMethod,
    matched_phone_last9: matchedPhoneLast9,
    phone_source: phoneSource,
    matched_name: matchMethod === 'name' ? cp : null,
    provider,
    parsed_amount: parsed.amount,
    parsed_tid: parsed.transaction_id,
    internal_date: internalMs ? new Date(internalMs).toISOString() : null,
    created_at: new Date().toISOString(),
    // Enhanced audit: candidate pool + tie-breaker + confidence for the
    // name-fallback path. Null when matched on phone (deterministic).
    name_match: nameMatchAudit,
    tiebreaker: nameMatchAudit?.tiebreaker ?? null,
    // Counterparty phone = deterministic (high). Body phone = the "possible
    // user ≈60%" signal, still unique-matched but recorded as medium so ops
    // can spot-check it in the Auto-Credit Review queue.
    confidence: nameMatchAudit?.confidence
      ?? (matchMethod === 'phone' ? (phoneSource === 'body' ? 'medium' : 'high') : null),
    confidence_score: nameMatchAudit?.confidence_score
      ?? (matchMethod === 'phone' ? (phoneSource === 'body' ? 0.6 : 1) : null),
  };

  // Create the deposit as pending — approve-deposit will flip it.
  const { data: newDep, error: depErr } = await supabase
    .from('deposit_requests')
    .insert({
      user_id: profile.id,
      agent_id: profile.id,
      amount: parsed.amount,
      status: 'pending',
      provider,
      transaction_id: parsed.transaction_id,
      transaction_date: internalMs ? new Date(internalMs).toISOString() : new Date().toISOString(),
      deposit_purpose: 'operational_float',
      auto_approved: true,
      auto_match_audit: auditMeta,
      notes: nameMatchAudit?.tiebreaker === 'learned-name-match'
        ? `[auto] Created from incoming Gmail MoMo receipt — payer name "${cp}" previously confirmed by Financial Ops (uncontested); credited to Operational Float.`
        : '[auto] Created from incoming Gmail MoMo receipt — phone matched a known user; credited to Operational Float.',
    })
    .select('id')
    .single();
  if (depErr || !newDep?.id) {
    console.warn('[gmail-poll] auto-credit: could not insert deposit_request', depErr);
    await logDepositDecision(supabase, {
      source: 'matcher',
      decision: 'failed',
      reason: 'deposit_insert_failed',
      amount: parsed.amount ?? null,
      actor_id: profile.id,
      metadata: { gmail_message_id: gmailMessageId, error: depErr?.message ?? null, match_method: matchMethod },
    });
    return;
  }

  // Link gmail row → deposit so approve-deposit re-verification succeeds.
  await supabase
    .from('gmail_transactions')
    .update({ linked_deposit_request_id: newDep.id })
    .eq('id', gmailRow.id);

  // Invoke approve-deposit with system_auto_credit to credit the float wallet.
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/approve-deposit`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'apikey': serviceKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        deposit_request_id: newDep.id,
        action: 'approve',
        auto_approved: true,
        auto_match_method: 'gmail_phone+tid+amount',
        system_auto_credit: true,
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.warn('[gmail-poll] approve-deposit non-200:', res.status, txt.slice(0, 300));
      await logDepositDecision(supabase, {
        source: 'matcher',
        decision: 'failed',
        reason: 'approve_non_200',
        deposit_request_id: newDep.id,
        amount: parsed.amount ?? null,
        actor_id: profile.id,
        metadata: { gmail_message_id: gmailMessageId, status: res.status, body: txt.slice(0, 300), match_method: matchMethod },
      });
      return;
    } else {
      console.log(`[gmail-poll] auto-credited float for user=${profile.id} dep=${newDep.id} amt=${parsed.amount}`);
      // ── Float-routing review flag ──────────────────────────────────────
      // Deposits auto-credit to Operational Float for everyone (FLOAT-ALWAYS).
      // When the recipient holds the `agent` role but has never acted as a
      // collecting agent, that routing is very likely wrong — this is what led
      // to funds being swept back out of a funder's Float days later with no
      // notice. Flag it for operator reclassification instead of leaving it
      // silent. Money routing itself is unchanged.
      let floatRoutingReview = false;
      try {
        const [{ data: agentRole }, { count: collections }, { count: rentReqs }] = await Promise.all([
          supabase.from('user_roles').select('role').eq('user_id', profile.id).eq('role', 'agent').maybeSingle(),
          supabase.from('agent_collections').select('id', { count: 'exact', head: true }).eq('agent_id', profile.id),
          supabase.from('rent_requests').select('id', { count: 'exact', head: true }).eq('agent_id', profile.id),
        ]);
        floatRoutingReview = !!agentRole && (collections ?? 0) === 0 && (rentReqs ?? 0) === 0;
        if (floatRoutingReview) {
          console.warn(
            `[gmail-poll] float-routing review: user=${profile.id} holds agent role with no ` +
            `collections or rent requests; dep=${newDep.id} may belong in Withdrawable.`,
          );
        }
      } catch (_) {
        // Best-effort classification only.
      }
      await logDepositDecision(supabase, {
        source: 'matcher',
        decision: 'auto_credited',
        reason: 'gmail_phone+tid+amount',
        deposit_request_id: newDep.id,
        amount: parsed.amount ?? null,
        actor_id: profile.id,
        metadata: {
          gmail_message_id: gmailMessageId,
          match_method: matchMethod,
          provider,
          float_routing_review: floatRoutingReview,
          float_routing_reason: floatRoutingReview
            ? 'agent_role_without_agent_activity'
            : 'float_always',
        },
      });
    }
  } catch (e) {
    console.warn('[gmail-poll] approve-deposit invoke failed:', e);
    await logDepositDecision(supabase, {
      source: 'matcher',
      decision: 'failed',
      reason: 'approve_invoke_error',
      deposit_request_id: newDep.id,
      amount: parsed.amount ?? null,
      actor_id: profile.id,
      metadata: { gmail_message_id: gmailMessageId, error: String(e) },
    });
    return;
  }

  // ── Notify the user via SMS ────────────────────────────────────
  // Tell them their Operational Float wallet was just topped up and what
  // the new balance is, so they don't have to open the app to confirm.
  try {
    if (!profile.phone) return;
    const { data: walletRow } = await supabase
      .from('wallets')
      .select('float_balance')
      .eq('user_id', profile.id)
      .maybeSingle();
    const newFloat = Number(walletRow?.float_balance ?? 0);
    const firstName = (profile.full_name ?? '').split(' ')[0] || 'there';
    const fmt = (n: number) => `UGX ${Math.round(n).toLocaleString('en-UG')}`;
    const msg =
      `Welile: Hi ${firstName}, ${fmt(parsed.amount!)} from ${provider.toUpperCase()} ` +
      `(TID ${parsed.transaction_id}) was auto-credited to your Operational Float. ` +
      `New float balance: ${fmt(newFloat)}.`;
    await sendSmsViaAfricasTalking(profile.phone, msg);

    // Also email the receipt if we have an email on file.
    // Ownership guard: never email a float receipt to an address that is
    // shared with (or owned by) another account. See ownedRecipientEmail.ts.
    const recipientEmail = await resolveOwnedRecipientEmail(
      supabase,
      profile.id,
      'gmail-poll-transactions',
    );
    if (recipientEmail) {
      try {
        const fnUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/send-transactional-email`;
        const sk = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const providerLabel = provider === 'mtn' ? 'MTN MoMo' : 'Airtel Money';
        const nowDate = new Date(internalMs || Date.now()).toLocaleString('en-GB', {
          day: '2-digit', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kampala',
        });
        await fetch(fnUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${sk}`,
            'apikey': sk,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            templateName: 'operational-float-credit',
            recipientEmail,
            idempotencyKey: `op-float-credit-${gmailMessageId}`,
            templateData: {
              partner_name: profile.full_name || firstName,
              transaction_id: parsed.transaction_id,
              amount: parsed.amount,
              currency: 'UGX',
              date: nowDate,
              source: providerLabel,
              new_float_balance: newFloat,
            },
          }),
        });
      } catch (e) {
        console.warn('[gmail-poll] auto-credit email failed (non-fatal):', e);
      }
    }
  } catch (e) {
    console.warn('[gmail-poll] auto-credit SMS failed (non-fatal):', e);
  }
}

// ── SMS helper (Africa's Talking) ────────────────────────────────────
function formatPhoneIntl(phone: string): string {
  const d = phone.replace(/[^0-9]/g, '');
  if (d.startsWith('256')) return `+${d}`;
  if (d.startsWith('0')) return `+256${d.slice(1)}`;
  if (d.length === 9) return `+256${d}`;
  return `+${d}`;
}

// ── Helper: thank a MoMo sender and invite them to open a Welile Wallet ──
// Whenever someone sends money to us via MTN MoMo or Airtel Money, text the
// SENDING number a professional thank-you plus a one-tap link to open a free
// Welile Wallet with any phone number. Skips numbers that already belong to a
// Welile user (they receive their own credit notification instead).
function extractSenderPhoneFromText(text: string): string | null {
  if (!text) return null;
  // Prefer a phone that appears right after "from" (the sender), e.g.
  // "received UGX 9,999 from +256700000000" / "from 0700000000" / "(0700...)".
  const near = text.match(/\bfrom\b[^0-9+]{0,20}(\+?256\d{9}|0\d{9}|\d{9})\b/i);
  if (near?.[1]) return near[1];
  // Fallback: a parenthesised sender phone like "JOHN DOE (0700123456)".
  const paren = text.match(/\((\+?256\d{9}|0\d{9})\)/);
  if (paren?.[1]) return paren[1];
  return null;
}

async function tryThankSenderMomoSignupSms(
  supabase: ReturnType<typeof createClient>,
  args: {
    parsed: ReturnType<typeof parseTransaction>;
    internalMs: number;
    text: string;
  },
): Promise<void> {
  const { parsed, internalMs, text } = args;

  // Eligibility: parsed INCOMING MoMo receipt with a real amount, recent.
  if (!parsed.amount || parsed.amount <= 0) return;
  if (parsed.direction !== 'in') return;
  if (parsed.channel !== 'mtn_momo' && parsed.channel !== 'airtel_money') return;
  if (internalMs && internalMs < Date.now() - 7 * 24 * 3600 * 1000) return;

  // Load the editable SMS template from system_config. Wording, link, address,
  // website and support email can be changed from Financial Ops without a
  // redeploy. Fall back to sane defaults if the row is missing/unreadable.
  const tpl = await loadMomoSignupSmsTemplate(supabase);
  if (!tpl.enabled) return;

  // Find the sender's phone — first from the parsed counterparty, then from
  // the raw email text. Without a phone we have no one to text.
  const cp = (parsed.counterparty ?? '').toString();
  const cpPhone = cp.match(/(?:\+?256|0)?\d{9,12}/);
  const rawPhone = cpPhone?.[0] ?? extractSenderPhoneFromText(text);
  if (!rawPhone) return;
  const digits = rawPhone.replace(/[^0-9]/g, '');
  const last9 = digits.length >= 9 ? digits.slice(-9) : null;
  if (!last9) return;

  // Resolve whether this sender is already a Welile user so we can tailor the
  // call-to-action: existing users get a "log in" nudge, new senders get a
  // "sign up" invite. Either way, every depositor phone seen in the extracted
  // emails gets a link back to the platform.
  let existingUser: { id: string; full_name: string | null } | null = null;
  try {
    // Same consolidated lookup as the matcher: profile phone, mobile-money
    // number, or a previously learned deposit number.
    const hit = await resolveUniqueUserByKnownPhone(supabase, last9);
    existingUser = hit ? { id: hit.user_id, full_name: hit.full_name } : null;
  } catch (_e) {
    existingUser = null;
  }

  // Dedup: never text the same phone this invite more than once per 24h, so a
  // depositor who sends several receipts in a day is not spammed.
  try {
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: recent } = await supabase
      .from('sms_delivery_log')
      .select('id')
      .eq('source', 'momo_deposit_invite')
      .ilike('recipient_phone', `%${last9}`)
      .gte('created_at', dayAgo)
      .limit(1)
      .maybeSingle();
    if (recent) return;
  } catch (_e) {
    // Non-fatal — if the dedup check fails, still allow the send.
  }

  const providerLabel = parsed.channel === 'mtn_momo' ? 'MTN MoMo' : 'Airtel Money';
  const amount = `UGX ${Math.round(parsed.amount).toLocaleString('en-UG')}`;
  const thankYou = tpl.thank_you_text
    .replace(/\{amount\}/gi, amount)
    .replace(/\{provider\}/gi, providerLabel);
  // Existing users → log in; new senders → sign up.
  const cta = existingUser
    ? 'Log in to view your wallet, transactions and balance:'
    : tpl.signup_prompt;
  const msg = [
    `WELILE: ${thankYou}`.trim(),
    `${cta} ${tpl.signup_link}`.trim(),
    tpl.address.trim(),
    [tpl.support_email, tpl.website].filter(Boolean).join(' | ').trim(),
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  const sent = await sendSmsViaAfricasTalking(rawPhone, msg);

  // Log every invite send so Financial Ops can audit which depositor phones
  // were nudged (and catch silent failures).
  try {
    await supabase.from('sms_delivery_log').insert({
      recipient_phone: formatPhoneIntl(rawPhone),
      recipient_user_id: existingUser?.id ?? null,
      recipient_name: existingUser?.full_name ?? null,
      message: msg,
      status: sent ? 'sent' : 'failed',
      provider: 'africastalking',
      source: 'momo_deposit_invite',
      reference_id: parsed.transaction_id ?? null,
      error: sent ? null : 'africastalking send returned not-ok',
    });
  } catch (e) {
    console.warn('[gmail-poll] deposit-invite SMS log failed (non-fatal):', e);
  }
}

// Default thank-you SMS template — mirrors the system_config seed so the SMS
// still works if the config row is ever missing.
type MomoSignupSmsTemplate = {
  enabled: boolean;
  thank_you_text: string;
  signup_prompt: string;
  signup_link: string;
  address: string;
  website: string;
  support_email: string;
};

const DEFAULT_MOMO_SIGNUP_SMS: MomoSignupSmsTemplate = {
  enabled: true,
  thank_you_text: 'Thank you for sending {amount} via {provider}. Create your free Welile account to manage this money.',
  signup_prompt: 'Access your dashboard to view your wallet, transactions, and account details:',
  signup_link: 'https://welileapp.com/ZQhyGb',
  address: '',
  website: '',
  support_email: '',
};

async function loadMomoSignupSmsTemplate(
  supabase: ReturnType<typeof createClient>,
): Promise<MomoSignupSmsTemplate> {
  try {
    const { data } = await supabase
      .from('system_config')
      .select('value')
      .eq('key', 'momo_sender_signup_sms')
      .maybeSingle();
    const v = (data?.value ?? {}) as Partial<MomoSignupSmsTemplate>;
    // Safety net: force the canonical public domain even if a stale
    // system_config row still references the legacy host. legacy-domain-guard-allow
    const rawLink = (v.signup_link ?? DEFAULT_MOMO_SIGNUP_SMS.signup_link).toString();
    const signup_link = rawLink.replace(
      /https?:\/\/(www\.)?welilereceipts?\.com/gi,
      'https://welileapp.com',
    );
    return {
      enabled: v.enabled !== false,
      thank_you_text: (v.thank_you_text ?? DEFAULT_MOMO_SIGNUP_SMS.thank_you_text).toString(),
      signup_prompt: (v.signup_prompt ?? DEFAULT_MOMO_SIGNUP_SMS.signup_prompt).toString(),
      signup_link,
      address: (v.address ?? DEFAULT_MOMO_SIGNUP_SMS.address).toString(),
      website: (v.website ?? DEFAULT_MOMO_SIGNUP_SMS.website).toString(),
      support_email: (v.support_email ?? DEFAULT_MOMO_SIGNUP_SMS.support_email).toString(),
    };
  } catch (_e) {
    return DEFAULT_MOMO_SIGNUP_SMS;
  }
}

async function sendSmsViaAfricasTalking(phone: string, message: string): Promise<boolean> {
  if (await attemptYoolaPrimary(phone, message, { source: "gmail-poll-transactions" })) return true;
  const apiKey = Deno.env.get('AFRICASTALKING_API_KEY');
  const username = Deno.env.get('AFRICASTALKING_USERNAME');
  if (!apiKey || !username) {
    console.warn('[gmail-poll] AT credentials missing — skipping SMS');
    return false;
  }
  const isSandbox = username.toLowerCase() === 'sandbox';
  const url = isSandbox
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        apiKey,
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        username, from: "WELILE",
        to: formatPhoneIntl(phone),        message,
      }).toString(),
    });
    const txt = await res.text();
    let data: any = null;
    try { data = JSON.parse(txt); } catch { /* ignore */ }
    const recipients = data?.SMSMessageData?.Recipients ?? [];
    const ok = recipients.some((r: any) => r.statusCode === 101 || r.statusCode === 100);
    console.log(`[gmail-poll] SMS ${ok ? 'sent' : 'failed'} to ${formatPhoneIntl(phone)} (status ${res.status})`);
    return ok;
  } catch (e) {
    console.warn('[gmail-poll] SMS send error:', e);
    return false;
  }
}

// ── Recovery sweep: deposits already linked to a Gmail receipt but still
// pending. Invokes approve-deposit (system_auto_credit path) which is the
// only function allowed to flip status + credit the float wallet.
async function sweepLinkedPendingDeposits(
  supabase: ReturnType<typeof createClient>,
): Promise<void> {
  // Find up to 25 gmail rows that are linked to a still-pending deposit.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const { data: rows, error } = await supabase
    .from('gmail_transactions')
    .select('id, linked_deposit_request_id, amount, transaction_id, internal_date, direction, parsed')
    .not('linked_deposit_request_id', 'is', null)
    .eq('parsed', true)
    // Include OUTBOUND ("sent to") company float-delivery SMS: those are
    // the rows behind merchant float credits, and excluding them left
    // orphaned pending float receipts stuck forever.
    .in('direction', ['in', 'credit', 'out', 'debit'])
    .gte('internal_date', sevenDaysAgo)
    .order('internal_date', { ascending: false })
    .limit(100);
  if (error || !rows?.length) return;

  const depIds = Array.from(
    new Set(rows.map((r: any) => r.linked_deposit_request_id).filter(Boolean)),
  );
  if (!depIds.length) return;

  const { data: deps } = await supabase
    .from('deposit_requests')
    .select('id, status, amount, user_id, transaction_id, provider')
    .in('id', depIds)
    .eq('status', 'pending')
    .in('provider', ['mtn', 'airtel'])
    .limit(25);
  if (!deps?.length) return;

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // Responses that mean "this money is already safely credited elsewhere" —
  // never a loss, never worth a critical alert. Confirmed against production:
  // 14 of 15 open 'linked_pending_sweep_failed' alerts (2026-09-15 audit) were
  // exactly this race — the immediate on-ingestion credit path won, and this
  // sweep's own stale 'pending' read then retried the same deposit moments
  // later, which the ledger's duplicate-TID guard correctly refused. The
  // refusal was safe; treating it as 'critical' was the bug, and it drowned
  // out the one genuinely stuck deposit (pending since 2026-08-17) in noise.
  const BENIGN_DUPLICATE_RE = /already credited|duplicate tid|no duplicate needed/i;

  for (const dep of deps) {
    // Re-verify amount + provider before kicking approve-deposit.
    const match = rows.find(
      (r: any) =>
        r.linked_deposit_request_id === (dep as any).id &&
        Number(r.amount) === Number((dep as any).amount),
    );
    if (!match) continue;

    // Narrow the race window: re-read status immediately before calling.
    // If another path (the immediate on-ingestion credit, or a human) has
    // already moved this deposit off 'pending' since the batch SELECT above,
    // there is nothing for this sweep to do — resolve any stale alert and move on.
    const { data: freshDep } = await supabase
      .from('deposit_requests')
      .select('status')
      .eq('id', (dep as any).id)
      .maybeSingle();
    if (freshDep && String(freshDep.status) !== 'pending') {
      await supabase
        .from('deposit_match_alerts')
        .update({ resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('alert_type', 'merchant_float_uncredited')
        .eq('subject_id', (match as any).id)
        .is('resolved_at', null);
      continue;
    }

    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/approve-deposit`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serviceKey}`,
          'apikey': serviceKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          deposit_request_id: (dep as any).id,
          action: 'approve',
          auto_approved: true,
          auto_match_method: 'linked_pending_sweep',
          system_auto_credit: true,
        }),
      });
      if (!res.ok) {
        const txt = await res.text();
        const isBenignDuplicate = BENIGN_DUPLICATE_RE.test(txt);
        console.warn(
          `[gmail-poll] sweep approve-deposit non-200 dep=${(dep as any).id} status=${res.status} ` +
          `benign_duplicate=${isBenignDuplicate} body=${txt.slice(0, 200)}`,
        );
        await logDepositDecision(supabase, {
          source: 'poller',
          decision: isBenignDuplicate ? 'skipped' : 'failed',
          reason: isBenignDuplicate ? 'sweep_already_credited_elsewhere' : 'sweep_approve_non_200',
          deposit_request_id: (dep as any).id,
          amount: Number((dep as any).amount),
          actor_id: (dep as any).user_id,
          metadata: { status: res.status, body: txt.slice(0, 300), auto_match_method: 'linked_pending_sweep' },
        });
        if (isBenignDuplicate) {
          // Already safely credited via another path — clear any open alert
          // instead of adding a new false-positive "critical" one.
          await supabase
            .from('deposit_match_alerts')
            .update({ resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('alert_type', 'merchant_float_uncredited')
            .eq('subject_id', (match as any).id)
            .is('resolved_at', null);
          continue;
        }
        await raiseMerchantFloatAlert(supabase, {
          gmailRowId: String((match as any).id),
          agentId: String((dep as any).user_id ?? '') || null,
          amount: Number((dep as any).amount),
          transactionId: (dep as any).transaction_id ?? null,
          counterparty: null,
          reason: `Linked-pending retry could not credit this receipt (approve-deposit HTTP ${res.status}).`,
          severity: 'critical',
          extra: { stage: 'linked_pending_sweep_failed', deposit_request_id: (dep as any).id },
        });
      } else {
        console.log(
          `[gmail-poll] sweep auto-credited linked-pending deposit dep=${(dep as any).id} ` +
          `amt=${(dep as any).amount} user=${(dep as any).user_id}`,
        );
        await logDepositDecision(supabase, {
          source: 'poller',
          decision: 'auto_credited',
          reason: 'linked_pending_sweep',
          deposit_request_id: (dep as any).id,
          amount: Number((dep as any).amount),
          actor_id: (dep as any).user_id,
          metadata: { auto_match_method: 'linked_pending_sweep' },
        });
        try {
          await supabase
            .from('deposit_match_alerts')
            .update({ resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('alert_type', 'merchant_float_uncredited')
            .eq('subject_id', (match as any).id)
            .is('resolved_at', null);
        } catch (_e) { /* non-fatal */ }
      }
    } catch (e) {
      console.warn('[gmail-poll] sweep approve-deposit invoke failed:', e);
      await logDepositDecision(supabase, {
        source: 'poller',
        decision: 'failed',
        reason: 'sweep_approve_invoke_error',
        deposit_request_id: (dep as any).id,
        amount: Number((dep as any).amount),
        actor_id: (dep as any).user_id,
        metadata: { error: String(e) },
      });
    }
  }
}

// ── Recovery sweep #2: OUTBOUND company sends to a registered merchant
// float phone that never got a linked deposit receipt at all. Self-healing
// net for any silent gap in the credit chain; independent of Rule 3.
async function sweepUnlinkedMerchantFloatSends(
  supabase: ReturnType<typeof createClient>,
): Promise<void> {
  // Deliberately SHORT window: this is a self-healing net for fresh gaps,
  // not a mass historical backfill. Anything older than this is a finance
  // decision and must be credited deliberately by FinOps.
  const windowStart = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  const { data: rows, error } = await supabase
    .from('gmail_transactions')
    .select('id, gmail_message_id, amount, transaction_id, counterparty, channel, internal_date, direction')
    .is('linked_deposit_request_id', null)
    .eq('parsed', true)
    .in('direction', ['out', 'debit'])
    .gte('internal_date', windowStart)
    .not('counterparty', 'is', null)
    .order('internal_date', { ascending: false })
    .limit(100);
  if (error || !rows?.length) return;

  // Idempotency: never re-credit a TID the ledger already reconciled.
  const tids = Array.from(
    new Set((rows as any[]).map((r) => r.transaction_id).filter(Boolean).map(String)),
  );
  const reconciled = new Set<string>();
  if (tids.length) {
    const { data: recRows } = await supabase
      .from('ledger_reconciled_tids')
      .select('tid_normalized')
      .in('tid_normalized', tids);
    for (const rr of (recRows ?? []) as any[]) reconciled.add(String(rr.tid_normalized));
  }

  const { data: agents } = await supabase
    .from('cashout_agents')
    .select('agent_id, float_phone')
    .eq('is_active', true)
    .not('float_phone', 'is', null);
  if (!agents?.length) return;

  const byLast9 = new Map<string, string>();
  for (const a of agents as any[]) {
    const d = String(a.float_phone ?? '').replace(/[^0-9]/g, '');
    if (d.length >= 9) byLast9.set(d.slice(-9), String(a.agent_id));
  }

  let handled = 0;
  for (const r of rows as any[]) {
    if (handled >= 10) break;
    const digits = String(r.counterparty ?? '').replace(/[^0-9]/g, '');
    if (digits.length < 9) continue;
    const agentId = byLast9.get(digits.slice(-9));
    if (!agentId) continue;
    if (!r.amount || Number(r.amount) <= 0) continue;
    if (r.transaction_id && reconciled.has(String(r.transaction_id))) continue;
    handled += 1;

    const ageMinutes = r.internal_date
      ? (Date.now() - new Date(r.internal_date).getTime()) / 60000
      : 0;
    console.log(
      `[gmail-poll] orphan merchant float send row=${r.id} agent=${agentId} amt=${r.amount} → flagged for FinOps (no auto-credit)`,
    );
    // DETECT + FLAG ONLY. This backstop deliberately does NOT credit: money
    // moving forward is handled live by creditMerchantFloatFromOutboundSms and
    // by the linked-pending retry sweep. Retroactive crediting of historical
    // sends is a finance decision, not an automation decision, so the sweep
    // only makes the gap visible and leaves the money alone.
    await raiseMerchantFloatAlert(supabase, {
      gmailRowId: String(r.id),
      agentId,
      amount: Number(r.amount),
      transactionId: r.transaction_id ?? null,
      counterparty: r.counterparty ?? null,
      reason: 'Outbound send to a registered merchant float phone has no linked receipt and was NOT auto-credited. FinOps review required.',
      severity: 'high',
      ageMinutes,
      extra: { stage: 'unlinked_backstop_detected_no_credit', auto_credited: false },
    });
  }
}
// ── Helper: auto-approve a pending MoMo withdrawal request when an outgoing
// MTN/Airtel email matches the recipient phone + amount + provider on a
// pending withdrawal_request. Runs the request through approve-withdrawal
// using the service-role system_caller path so the user's wallet is debited,
// the request flips to 'completed', and a withdrawal-success email is sent.
async function tryAutoApproveMomoWithdrawal(
  supabase: ReturnType<typeof createClient>,
  args: {
    parsed: ReturnType<typeof parseTransaction>;
    gmailMessageId: string;
  },
): Promise<void> {
  const { parsed, gmailMessageId } = args;
  if (!parsed.amount || parsed.amount <= 0) return;
  if (parsed.direction !== 'out') return;
  if (parsed.channel !== 'mtn_momo' && parsed.channel !== 'airtel_money') return;

  const provider = parsed.channel === 'mtn_momo' ? 'mtn' : 'airtel';

  // Normalize any UG phone shape ("+256 7XX XXX XXX", "256-7XXXXXXXX",
  // "07XX XXX XXX", "7XXXXXXXX", with parentheses or dashes) to a single
  // canonical 12-digit form (256XXXXXXXXX) plus its last-9 tail.
  const normalizeUgPhone = (raw: string | null | undefined): { full: string; last9: string } | null => {
    if (!raw) return null;
    const d = String(raw).replace(/\D+/g, '');
    if (!d) return null;
    let full = d;
    if (full.startsWith('00256')) full = full.slice(2);          // 00256… → 256…
    if (full.startsWith('2560')) full = '256' + full.slice(4);   // 2560XXX… → 256XXX…
    if (full.length === 9 && full.startsWith('7')) full = '256' + full;
    else if (full.length === 10 && full.startsWith('07')) full = '256' + full.slice(1);
    else if (full.length === 12 && full.startsWith('256')) { /* ok */ }
    else if (full.length > 12 && full.endsWith(full.slice(-9)) && full.slice(-9).startsWith('7')) {
      full = '256' + full.slice(-9);
    } else if (full.length < 9) {
      return null;
    } else {
      full = '256' + full.slice(-9);
    }
    const last9 = full.slice(-9);
    if (last9.length !== 9 || !last9.startsWith('7')) return null;
    return { full, last9 };
  };

  // Search the counterparty AND the raw subject/snippet so we still catch
  // recipients that the parser put elsewhere (or that arrived with odd
  // spacing/punctuation around the digits).
  const hay = [
    parsed.counterparty,
    (parsed as any).snippet,
    (parsed as any).subject,
  ].filter(Boolean).join(' ');
  const phoneCandidates = new Set<string>();
  for (const m of hay.matchAll(/(?:\+?256|00256|0)?[\s\-().]*7\d[\s\-().]*\d{3}[\s\-().]*\d{3,4}/g)) {
    const norm = normalizeUgPhone(m[0]);
    if (norm) phoneCandidates.add(norm.full);
  }
  if (phoneCandidates.size === 0) return;
  const candFull = Array.from(phoneCandidates);
  const candLast9 = candFull.map((p) => p.slice(-9));

  // Find pending withdrawal requests (mobile-money path) for this provider.
  const { data: candidates, error } = await supabase
    .from('withdrawal_requests')
    .select('id, user_id, agent_id, proxy_partner_id, amount, status, mobile_money_number, mobile_money_provider, payout_method')
    .in('status', ['pending', 'requested', 'manager_approved'])
    .eq('amount', parsed.amount)
    .order('created_at', { ascending: true })
    .limit(50);
  if (error || !candidates?.length) return;

  // Two-pass match: prefer an exact 12-digit hit, then fall back to last-9.
  const matchByFull = candidates.find((wr: any) => {
    const prov = String(wr.mobile_money_provider ?? '').toLowerCase();
    if (prov && !prov.includes(provider)) return false;
    const wrNorm = normalizeUgPhone(wr.mobile_money_number);
    return !!wrNorm && candFull.includes(wrNorm.full);
  });
  const matchByLast9 = matchByFull ?? candidates.find((wr: any) => {
    const prov = String(wr.mobile_money_provider ?? '').toLowerCase();
    if (prov && !prov.includes(provider)) return false;
    const wrNorm = normalizeUgPhone(wr.mobile_money_number);
    return !!wrNorm && candLast9.includes(wrNorm.last9);
  });
  const match = matchByLast9;
  if (!match) {
    console.log(`[gmail-poll] no withdrawal match provider=${provider} phones=[${candFull.join(',')}] amount=${parsed.amount}`);
    return;
  }
  const matchedNorm = normalizeUgPhone(match.mobile_money_number)!;
  const matchKind = matchByFull ? 'full' : 'last9';
  // Proxy rows are funded by the proxy AGENT's wallet, not the requester
  // (partner). For those we must NOT force the debit onto the requester —
  // let approve-withdrawal route the debit to the assigned proxy agent.
  const isProxyRow = !!(match as any).proxy_partner_id;
  console.log(`[gmail-poll] auto-approving wr=${match.id} provider=${provider} phone=${matchedNorm.full} (${matchKind}) amount=${parsed.amount} proxy=${isProxyRow}`);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const reference = parsed.transaction_id || `MOMO-${gmailMessageId.slice(0, 12)}`;
  const paymentMethod = provider === 'mtn' ? 'mtn_momo' : 'airtel_money';

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/approve-withdrawal`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        withdrawal_id: match.id,
        reference,
        payment_method: paymentMethod,
        system_caller: true,
        // Consume the requester's "reserved against pending requests" hold
        // and debit their wallet directly — the cash left via their MoMo #.
        // EXCEPTION: proxy withdrawals are funded by the proxy agent's wallet,
        // so we omit force_requester_debit and let approve-withdrawal route
        // the debit to the assigned proxy agent.
        force_requester_debit: !isProxyRow,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      console.warn(`[gmail-poll] approve-withdrawal failed wr=${match.id} status=${res.status} body=${text.slice(0, 200)}`);
      return;
    }
    console.log(`[gmail-poll] withdrawal auto-approved wr=${match.id}`);

    // Audit + system event
    try {
      await supabase.from('audit_logs').insert({
        action_type: 'withdrawal_momo_auto_approved',
        table_name: 'withdrawal_requests',
        record_id: match.id,
        reason: `Auto-approved by gmail-poll matching ${provider.toUpperCase()} email — phone=${matchedNorm.full} (${matchKind}) amount=${parsed.amount} txid=${reference}`.slice(0, 500),
        new_data: {
          provider,
          phone_full: matchedNorm.full,
          phone_last9: matchedNorm.last9,
          match_kind: matchKind,
          amount: parsed.amount,
          gmail_message_id: gmailMessageId,
          reference,
        },
      });
    } catch (e) {
      console.warn('[gmail-poll] audit_logs insert failed (non-fatal):', e);
    }
    try {
      await supabase.from('system_events').insert({
        event_type: 'withdrawal.momo.auto_approved',
        related_entity_type: 'withdrawal_request',
        related_entity_id: match.id,
        user_id: match.user_id,
        metadata: {
          withdrawal_id: match.id,
          user_id: match.user_id,
          provider,
          phone_full: matchedNorm.full,
          phone_last9: matchedNorm.last9,
          match_kind: matchKind,
          amount: parsed.amount,
          reference,
          gmail_message_id: gmailMessageId,
        },
      });
    } catch (e) {
      console.warn('[gmail-poll] system_events insert failed (non-fatal):', e);
    }
  } catch (e) {
    console.warn('[gmail-poll] approve-withdrawal invoke threw:', e);
  }
}

// ── Helper: auto-approve a BATCH of pending bank_transfer withdrawal requests
// when an outbound Equity Bank email to "SKYBUBBLES TRADING AND INVESTMENT
// LIMITED" arrives. The operator settles many bank-payout requests with a
// single lump-sum Equity transfer, so we look for a set of pending
// bank_transfer WRs whose amounts add up exactly to the email's total and
// approve them all using that one email as the bank reference.
//
// This is the bank-rail counterpart of `tryAutoApproveMomoWithdrawal`. Proxy
// agent withdrawals (where `user_id` = partner, `agent_id` = proxy) are
// included automatically because we never filter by initiator — the WR row
// is matched on payout_method + amount + status only.
async function tryAutoApproveBankBatch(
  supabase: ReturnType<typeof createClient>,
  args: {
    parsed: ReturnType<typeof parseTransaction>;
    gmailMessageId: string;
  },
): Promise<void> {
  const { parsed, gmailMessageId } = args;
  if (!parsed.amount || parsed.amount <= 0) return;
  if (parsed.direction !== 'out') return;
  if (parsed.channel !== 'bank') return;

  const hay = `${(parsed as any).subject ?? ''} ${(parsed as any).snippet ?? ''} ${parsed.counterparty ?? ''}`;
  if (!/skybubbles/i.test(hay)) return;

  const totalAmount = Number(parsed.amount);
  const reference = (parsed.transaction_id || '').trim().toUpperCase()
    || `BANK-${gmailMessageId.slice(0, 12)}`.toUpperCase();

  // Idempotency: if we already processed this Gmail message, bail out.
  try {
    const { data: prior } = await supabase
      .from('audit_logs')
      .select('id')
      .eq('action_type', 'withdrawal_bank_batch_auto_approved')
      .contains('new_data', { gmail_message_id: gmailMessageId })
      .limit(1);
    if (prior && prior.length > 0) {
      console.log(`[gmail-poll] bank batch already processed for gmail=${gmailMessageId}`);
      return;
    }
  } catch { /* non-fatal */ }

  // Pull pending bank-payout withdrawal requests across the full approval
  // pipeline. Same statuses the MoMo path accepts, since proxy agent bank
  // payouts can sit in 'manager_approved' / 'cfo_approved' / 'coo_approved'
  // waiting on FinOps to push the cash.
  const { data: pending, error } = await supabase
    .from('withdrawal_requests')
    .select('id, user_id, amount, status, payout_method, created_at, agent_id, proxy_partner_id, linked_party')
    .in('payout_method', ['bank_transfer', 'bank'])
    .in('status', ['pending', 'requested', 'manager_approved', 'cfo_approved', 'coo_approved'])
    .order('created_at', { ascending: true })
    .limit(200);
  if (error || !pending?.length) {
    console.log(`[gmail-poll] no pending bank WRs for SKYBUBBLES batch amount=${totalAmount}`);
    return;
  }

  // Try the most likely batch shapes in order:
  //  1. ALL currently-pending bank WRs sum to the email amount
  //  2. All bank WRs created today (UTC) sum to the email amount
  //  3. All bank WRs created yesterday (UTC) sum (covers late-evening batches)
  const sumOf = (rows: any[]) => rows.reduce((acc, r) => acc + Number(r.amount || 0), 0);

  const startOfDay = (offsetDays: number) => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return d.getTime();
  };
  const todayMs = startOfDay(0);
  const tomorrowMs = startOfDay(1);
  const yesterdayMs = startOfDay(-1);

  const candidates: Array<{ label: string; rows: any[] }> = [
    { label: 'all_pending', rows: pending },
    {
      label: 'today',
      rows: pending.filter((r: any) => {
        const t = new Date(r.created_at).getTime();
        return t >= todayMs && t < tomorrowMs;
      }),
    },
    {
      label: 'yesterday',
      rows: pending.filter((r: any) => {
        const t = new Date(r.created_at).getTime();
        return t >= yesterdayMs && t < todayMs;
      }),
    },
  ];

  let chosen: { label: string; rows: any[] } | null = null;
  for (const c of candidates) {
    if (c.rows.length === 0) continue;
    if (sumOf(c.rows) === totalAmount) {
      chosen = c;
      break;
    }
  }

  if (!chosen) {
    console.log(
      `[gmail-poll] SKYBUBBLES batch ${totalAmount} did NOT match any pending bank WR set ` +
        `(all_pending=${sumOf(pending)}/${pending.length} rows). Skipping auto-approve.`,
    );
    return;
  }

  console.log(
    `[gmail-poll] SKYBUBBLES batch matched scope=${chosen.label} ` +
      `count=${chosen.rows.length} total=${totalAmount} ref=${reference}`,
  );

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const approved: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];

  // Each WR gets a unique reference (batchRef + index) so the duplicate-
  // reference safeguard in approve-withdrawal does not reject siblings of
  // the same physical bank transfer.
  for (let i = 0; i < chosen.rows.length; i++) {
    const wr = chosen.rows[i];
    const perRowRef = `${reference}-${i + 1}`;
    // Proxy bank payouts (where `proxy_partner_id`/`linked_party` is set, or
    // `agent_id` differs from the requester) are FUNDED by the proxy agent's
    // wallet — not the partner who owns the WR row. For those we must NOT
    // force the debit onto the requester; we let approve-withdrawal route the
    // debit to the assigned proxy agent (same policy as the MoMo path). Plain
    // (non-proxy) bank WRs keep force_requester_debit so the requester's
    // reserved hold is consumed and their wallet is debited directly.
    const isProxyRow = !!(
      (wr as any).proxy_partner_id ||
      ((wr as any).linked_party && (wr as any).linked_party !== wr.user_id) ||
      ((wr as any).agent_id && (wr as any).agent_id !== wr.user_id)
    );
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/approve-withdrawal`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          withdrawal_id: wr.id,
          reference: perRowRef,
          payment_method: 'bank_transfer',
          system_caller: true,
          force_requester_debit: !isProxyRow,
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        console.warn(
          `[gmail-poll] bank batch approve failed wr=${wr.id} status=${res.status} body=${text.slice(0, 200)}`,
        );
        failed.push({ id: wr.id, reason: `${res.status}:${text.slice(0, 120)}` });
        continue;
      }
      approved.push(wr.id);
    } catch (e) {
      console.warn(`[gmail-poll] bank batch approve threw wr=${wr.id}`, e);
      failed.push({ id: wr.id, reason: String((e as Error).message ?? e).slice(0, 120) });
    }
  }

  // Single audit + system event row for the whole batch (also serves as the
  // idempotency marker for the next poll cycle).
  try {
    await supabase.from('audit_logs').insert({
      action_type: 'withdrawal_bank_batch_auto_approved',
      table_name: 'withdrawal_requests',
      record_id: chosen.rows[0].id,
      reason: `Auto-approved SKYBUBBLES bank batch — scope=${chosen.label} approved=${approved.length}/${chosen.rows.length} total=${totalAmount} ref=${reference}`.slice(0, 500),
      new_data: {
        gmail_message_id: gmailMessageId,
        bank_reference: reference,
        scope: chosen.label,
        total_amount: totalAmount,
        approved_ids: approved,
        failed: failed,
        approved_count: approved.length,
        attempted_count: chosen.rows.length,
      },
    });
  } catch (e) {
    console.warn('[gmail-poll] bank batch audit_logs insert failed (non-fatal):', e);
  }
  try {
    await supabase.from('system_events').insert({
      event_type: 'withdrawal.bank_batch.auto_approved',
      related_entity_type: 'withdrawal_request',
      related_entity_id: chosen.rows[0].id,
      metadata: {
        gmail_message_id: gmailMessageId,
        bank_reference: reference,
        scope: chosen.label,
        total_amount: totalAmount,
        approved_ids: approved,
        failed: failed,
      },
    });
  } catch (e) {
    console.warn('[gmail-poll] bank batch system_events insert failed (non-fatal):', e);
  }
}
