/**
 * Pure extraction helpers for the Gmail transaction email pipeline.
 * Lifted out of `EmailTransactionsPanel.tsx` so they can be unit-tested
 * against real MTN / Airtel / Equity Bank email shapes without pulling
 * in the whole React component.
 */

export interface EmailRowLike {
  from_email?: string | null;
  from_name?: string | null;
  subject?: string | null;
  snippet?: string | null;
  counterparty?: string | null;
  transaction_id?: string | null;
}

/**
 * Normalize Ugandan-style phone numbers to the canonical `256XXXXXXXXX`
 * (12-digit) form so the lookup hits regardless of whether the email
 * printed "+256…", "0772…", or "256772…".
 */
export function normalizeUgPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 9 && digits.startsWith('7')) return `256${digits}`;
  if (digits.length === 10 && digits.startsWith('07')) return `256${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('256')) return digits;
  if (digits.length === 13 && digits.startsWith('2560')) return `256${digits.slice(4)}`;
  return null;
}

/** Pull every plausible Uganda mobile number out of the email row. */
export function extractPhones(r: EmailRowLike): string[] {
  const hay = `${r.from_email ?? ''} ${r.from_name ?? ''} ${r.subject ?? ''} ${r.snippet ?? ''} ${r.counterparty ?? ''} ${r.transaction_id ?? ''}`;
  const out = new Set<string>();
  const re = /(?:\+?256|0)\s*7\d{2}[\s-]?\d{3}[\s-]?\d{3}/g;
  const matches = hay.match(re) ?? [];
  for (const m of matches) {
    const norm = normalizeUgPhone(m);
    if (norm) out.add(norm);
  }
  return Array.from(out);
}

/** Phones that appear immediately after the word "from" (deposit sender). */
export function extractFromPhones(r: EmailRowLike): string[] {
  const hay = `${r.subject ?? ''} ${r.snippet ?? ''} ${r.counterparty ?? ''}`;
  const out = new Set<string>();
  const re = /\bfrom\s+(?:\+?256|0)\s*7\d{2}[\s-]?\d{3}[\s-]?\d{3}/gi;
  const matches = hay.match(re) ?? [];
  for (const m of matches) {
    const norm = normalizeUgPhone(m);
    if (norm) out.add(norm);
  }
  return Array.from(out);
}

/** Phones that appear immediately after the word "to" (payout recipient). */
export function extractToPhones(r: EmailRowLike): string[] {
  const hay = `${r.subject ?? ''} ${r.snippet ?? ''} ${r.counterparty ?? ''}`;
  const out = new Set<string>();
  const re = /\bto\s+(?:\+?256|0)\s*7\d{2}[\s-]?\d{3}[\s-]?\d{3}/gi;
  const matches = hay.match(re) ?? [];
  for (const m of matches) {
    const norm = normalizeUgPhone(m);
    if (norm) out.add(norm);
  }
  return Array.from(out);
}

/** Transaction id / reference normalised for an in-list query. */
export function extractReferences(r: EmailRowLike): string[] {
  const out = new Set<string>();
  if (r.transaction_id) out.add(r.transaction_id.trim().toUpperCase());
  return Array.from(out);
}

// Provider / banking words that look like proper nouns but never identify a
// real recipient. Used to filter out false positives from the name extractor.
const NAME_STOPWORDS = new Set([
  'MTN', 'AIRTEL', 'EQUITY', 'STANBIC', 'CENTENARY', 'DFCU', 'ABSA', 'BANK',
  'MOMO', 'MOBILE', 'MONEY', 'WALLET', 'ACCOUNT', 'UGX', 'USD', 'KES', 'TZS',
  'REF', 'REFERENCE', 'TRANSACTION', 'TXN', 'TID', 'CONFIRMATION',
  'SUCCESSFUL', 'COMPLETED', 'DEAR', 'CUSTOMER', 'CLIENT', 'PAID', 'SENT',
  'RECEIVED', 'FROM', 'TO', 'YOU', 'YOUR', 'HAVE', 'HAS', 'BEEN', 'WAS',
  'CHARGE', 'FEE', 'TAX', 'BALANCE', 'AMOUNT', 'DATE', 'TIME', 'NEW',
  'PAYBILL', 'TILL', 'AGENT', 'MERCHANT', 'POS', 'ATM', 'EFT', 'RTGS',
  'SWIFT', 'CASH', 'WITHDRAW', 'WITHDRAWAL', 'DEPOSIT', 'PAYMENT', 'PURCHASE',
]);

/**
 * Pull a clean uppercase candidate name out of a free-form match. Returns
 * null when the capture is dominated by provider/banking stopwords.
 */
function cleanName(raw: string): string | null {
  const tokens = raw
    .replace(/[^A-Za-z'’\- ]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const kept = tokens.filter((t) => !NAME_STOPWORDS.has(t.toUpperCase()) && t.length > 1);
  if (kept.length < 2) return null;
  // Cap at 4 tokens so we don't drag a whole sentence into the lookup.
  return kept.slice(0, 4).map((t) => t.toUpperCase()).join(' ');
}

function extractDirectionalNames(r: EmailRowLike, keyword: 'to' | 'from'): string[] {
  const hay = `${r.subject ?? ''} ${r.snippet ?? ''} ${r.counterparty ?? ''}`;
  const out = new Set<string>();
  // Capitalized / uppercase words right after "to" or "from".
  const re = new RegExp(
    `\\b${keyword}\\s+((?:[A-Z][A-Za-z'’\\-]{1,}\\.?\\s+){1,3}[A-Z][A-Za-z'’\\-]{1,})`,
    'g',
  );
  for (const m of hay.matchAll(re)) {
    const cleaned = cleanName(m[1]);
    if (cleaned) out.add(cleaned);
  }
  return Array.from(out);
}

/** Recipient names after "to" (money-out payouts). */
export function extractToNames(r: EmailRowLike): string[] {
  return extractDirectionalNames(r, 'to');
}

/** Sender names after "from" (money-in deposits). */
export function extractFromNames(r: EmailRowLike): string[] {
  return extractDirectionalNames(r, 'from');
}