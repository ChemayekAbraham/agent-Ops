/**
 * Reads a pasted MTN / Airtel "money received" message for the Financial Ops
 * Manual Float Credit panel: TID, amount, deposit date/time and the sender's
 * name. Amount/TID/date/time come from the shared `parseSMS`; this wrapper only
 * adds what that panel needs on top.
 *
 * The TID is returned in the exact form `ledger_reconciled_tids` stores
 * (digits for MTN and Airtel — no "TID" prefix, no stray punctuation), because
 * the manual-credit lock is an exact string match: "TID157…" or "157….",
 * would slip past it and allow a second credit for the same money.
 */
import { parseSMS } from '@/utils/smsParser';
import type { PersonNameParts } from '@/lib/authValidation';

export interface FloatCreditMessage {
  tid?: string;
  amount?: number;
  /** "YYYY-MM-DDTHH:mm" for <input type="datetime-local">, Kampala wall-clock. */
  depositedAtLocal?: string;
  /** True when the message carried a date but no time, or neither. */
  timeMissing: boolean;
  nameParts?: PersonNameParts;
  /** Phone of the sender when the message shows one (never used as a name). */
  senderPhone?: string;
  channel?: 'mtn_momo' | 'airtel_money' | 'bank' | 'other';
  /** "out" means the paste is a money-SENT message — not a float deposit. */
  direction?: 'in' | 'out' | 'charge';
}

/** Same normalisation the manual-credit TID lock needs; safe for any TID. */
export function normaliseFloatTid(raw: string): string {
  const compact = (raw || '').replace(/[^A-Za-z0-9]/g, '');
  const airtel = compact.match(/^TID(\d{4,})$/i);
  return airtel ? airtel[1] : compact;
}

function toNameParts(raw: string): PersonNameParts | undefined {
  const words = raw
    .replace(/[^A-Za-z'\- ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  if (words.length < 2) return undefined;
  return {
    firstName: words[0],
    otherNames: words.slice(1, -1).join(' '),
    lastName: words[words.length - 1],
  };
}

function extractSenderName(t: string): string | undefined {
  // MTN: "from (ALLAN MABZNGO) 256766749975"
  const paren = t.match(/\bfrom\s+\(\s*([A-Za-z][A-Za-z'.\- ]{1,60}?)\s*\)/i);
  if (paren) return paren[1];
  // MTN / bank: "from SHAKIRAH NAKIMBUGWE at 2026-…", "from JOHN DOE 2567…", "from JOHN DOE."
  const plain = t.match(
    /\bfrom\s+([A-Za-z][A-Za-z'.\- ]{1,60}?)(?=\s+(?:at|on|\(|\+?256|0\d{9}|\d{9}\b|ref|reference|Transaction|TID|UGX)|[.,]|$)/i,
  );
  return plain ? plain[1] : undefined;
}

export function parseFloatCreditMessage(text: string): FloatCreditMessage {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  const out: FloatCreditMessage = { timeMissing: true };
  if (!t) return out;

  const p = parseSMS(t);
  out.channel = p.channel;
  out.direction = p.direction;
  out.amount = p.amount;
  if (p.transactionId) out.tid = normaliseFloatTid(p.transactionId);

  if (p.date && p.time) {
    out.depositedAtLocal = `${p.date}T${p.time}`;
    out.timeMissing = false;
  } else if (p.date) {
    out.depositedAtLocal = `${p.date}T00:00`;
  }

  const name = extractSenderName(t);
  if (name) out.nameParts = toNameParts(name);

  const phone = t.match(/\bfrom\s+(?:\([^)]*\)\s*)?((?:\+?256|0)?\d{9})\b/i);
  if (phone) out.senderPhone = phone[1];

  return out;
}
