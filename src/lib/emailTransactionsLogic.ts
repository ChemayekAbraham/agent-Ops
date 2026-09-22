/**
 * Pure, framework-free logic for the Financial Ops "Email Transactions" panel:
 * row shape, channel-inference heuristics, auto-credit gate mirroring, and
 * timezone helpers. No React, no Supabase — relocated verbatim out of
 * `EmailTransactionsPanel.tsx` (see docs/HANDOVER for the refactor note) so
 * the panel component can be rebuilt visually without touching this logic.
 */

export interface GmailTx {
  id: string;
  gmail_message_id: string;
  from_email: string | null;
  from_name: string | null;
  subject: string | null;
  snippet: string | null;
  amount: number | null;
  transaction_id: string | null;
  parsed: boolean;
  internal_date: string | null;
  direction: string | null;
  channel: string | null;
  counterparty: string | null;
  /** Payer's real name, kept distinct from `counterparty` once a till/merchant
   *  row is phone-enriched (see gmail-poll-transactions' enrich-on-duplicate
   *  step) — at that point `counterparty` holds the resolved phone, not the
   *  name. Routing must read this field for the name-learning path, never
   *  `counterparty`, or it teaches the matcher the phone string as a "name". */
  counterparty_name: string | null;
  fee: number | null;
  balance: number | null;
  linked_deposit_request_id: string | null;
  auto_matched_at: string | null;
}

export interface PollState {
  last_polled_at: string | null;
  last_status: string | null;
  last_error: string | null;
}

export const fmtUgx = (n: number | null) =>
  n === null || n === undefined ? '—' : `UGX ${Math.round(n).toLocaleString()}`;

/**
 * Mirror of the parser's skip-reason logic in `gmail-poll-transactions`.
 * A Gmail row is treated as "unparsed / skipped" when it never produced a
 * usable amount (parsed=false, or amount is null). This recomputes the exact
 * reason(s) the parser would have logged, straight from the stored columns,
 * so Financial Ops can see WHY each row was skipped without re-running the
 * edge function.
 */
export function isUnparsedRow(r: { parsed: boolean; amount: number | null }): boolean {
  return !r.parsed || r.amount === null || r.amount === undefined;
}

export function parseFailureReasons(r: {
  amount: number | null;
  transaction_id: string | null;
  direction: string | null;
  channel: string | null;
}): string[] {
  const reasons: string[] = [];
  if (r.amount === null || r.amount === undefined || !Number.isFinite(r.amount) || (r.amount as number) <= 0) {
    reasons.push('No amount detected in the email body');
  }
  if (!r.transaction_id) reasons.push('No transaction ID / reference detected');
  if (!r.direction) reasons.push('No direction keyword (money in / out / charge)');
  if (!r.channel || r.channel === 'other') reasons.push('Channel could not be identified');
  if (reasons.length === 0) reasons.push('Did not match any known transaction format');
  return reasons;
}

/**
 * Client-side mirror of the auto-credit eligibility gates in the
 * `gmail-poll-transactions` edge function (`_tryAutoCreditOperationalFloat`).
 * It reproduces — from the stored row columns — exactly which gate the poller
 * would have failed, so Financial Ops can see WHY an incoming email was not
 * automatically credited to a wallet without reading edge-function logs.
 *
 * Keep in lock-step with the edge function gates:
 *   1. amount > 0
 *   2. a transaction id / reference is present
 *   3. direction === 'in'
 *   4. channel is MTN MoMo or Airtel Money
 *   5. receipt is within the last 7 days
 *   6. exactly one depositing user could be resolved (phone last-9 or unique name)
 */
export interface AutoCreditGate {
  label: string;
  ok: boolean;
  reason: string;
}

export function autoCreditGateReport(args: {
  amount: number | null;
  transactionId: string | null;
  direction: string | null;
  channel: string | null;
  internalDate: string | null;
  hasUserMatch: boolean;
  matchCount: number;
  isConfidentMatch: boolean;
}): AutoCreditGate[] {
  const { amount, transactionId, direction, channel, internalDate, hasUserMatch, matchCount, isConfidentMatch } = args;
  const gates: AutoCreditGate[] = [];

  gates.push({
    label: 'Amount detected',
    ok: amount !== null && amount !== undefined && Number.isFinite(amount) && (amount as number) > 0,
    reason: 'No positive money amount was parsed from the email.',
  });

  gates.push({
    label: 'Transaction reference',
    ok: !!transactionId,
    reason: 'No transaction ID / reference was found in the email.',
  });

  gates.push({
    label: 'Incoming money',
    ok: direction === 'in',
    reason: direction
      ? `Direction is "${direction}" — auto-credit only runs for incoming money.`
      : 'No direction (money in / out) could be determined.',
  });

  const okChannel = channel === 'mtn_momo' || channel === 'airtel_money';
  gates.push({
    label: 'MoMo / Airtel channel',
    ok: okChannel,
    reason: channel && channel !== 'other'
      ? `Channel is "${channel.replace(/_/g, ' ')}" — auto-credit only runs for MTN MoMo or Airtel Money.`
      : 'Channel is not MTN MoMo or Airtel Money (as parsed at import).',
  });

  const ms = internalDate ? new Date(internalDate).getTime() : 0;
  const fresh = ms > 0 && ms >= Date.now() - 7 * 24 * 3600 * 1000;
  gates.push({
    label: 'Within last 7 days',
    ok: fresh,
    reason: ms > 0
      ? 'Email is older than 7 days — outside the auto-credit window.'
      : 'Email has no reliable date to check the 7-day window.',
  });

  const uniqueUser = hasUserMatch && (isConfidentMatch || matchCount === 1);
  gates.push({
    label: 'Single depositing user',
    ok: uniqueUser,
    reason: !hasUserMatch
      ? "No depositing user could be matched from the sender's phone or name."
      : `Multiple possible users matched (${matchCount}) with no clear winner — too ambiguous to auto-credit safely.`,
  });

  return gates;
}

/**
 * Convert a wall-clock date+time string (e.g. "2026-05-18", "00:00:00") interpreted
 * in the given IANA timezone into a UTC epoch ms. Uses Intl.DateTimeFormat to
 * discover the zone's offset at that instant — no dependency on date-fns-tz.
 */
export function zonedWallClockToUtcMs(dateStr: string, timeStr: string, tz: string): number {
  const naiveUtc = new Date(`${dateStr}T${timeStr}Z`).getTime();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = fmt.formatToParts(new Date(naiveUtc));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offsetMs = asUtc - naiveUtc;
  return naiveUtc - offsetMs;
}

/** Format an instant as "yyyy-MM-dd" in the given timezone. */
export function dateKeyInTz(d: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(d); // en-CA gives YYYY-MM-DD
}

export const TIMEZONE_OPTIONS = [
  'Africa/Kampala',
  'Africa/Nairobi',
  'Africa/Lagos',
  'Africa/Johannesburg',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Dubai',
  'Asia/Singapore',
  'UTC',
];

/**
 * A bank "you have received X from WELILE TECHNOLOGIES LIMITED" email is the
 * bank's own echo of a payout WE already sent out (e.g. to a merchant's or
 * landlord's personal Equity account) — landing in the same shared inbox that
 * also receives real inbound deposits to Welile's account. It is NOT new
 * money arriving; the corresponding debit already happened when the payout
 * was made. Treating it like an ordinary "in" row would double-count it in
 * totals and invite an operator to credit it to a wallet a second time.
 * Matches on `counterparty` (once the parser extracts it) and falls back to
 * the raw snippet so older rows ingested before that extraction existed are
 * still caught.
 */
export function isWelileOutboundEcho(r: GmailTx): boolean {
  if (r.channel !== 'bank' || r.direction !== 'in') return false;
  return /welile\s*tech/i.test(`${r.counterparty ?? ''} ${r.snippet ?? ''}`);
}

/**
 * Validate a parsed Gmail transaction row against its own raw email text.
 * A row is considered "flagged" (excluded from totals) when any of:
 *   - parsed=true but amount is null / non-finite / ≤ 0
 *   - parsed=true but no direction was extracted (can't classify in/out)
 *   - the parsed amount cannot be located inside the subject/snippet
 *     (means the parser & email disagree)
 * Returns { valid: true } for unparsed rows (they never count toward totals).
 */
export function validateGmailTx(r: GmailTx): { valid: boolean; reason?: string } {
  if (!r.parsed) return { valid: true };
  if (r.amount === null || r.amount === undefined || !Number.isFinite(r.amount) || r.amount <= 0) {
    return { valid: false, reason: 'Parsed flag set but amount is missing or non-positive' };
  }
  if (!r.direction) {
    return { valid: false, reason: 'Missing direction (in / out / charge) — cannot classify' };
  }
  // Cross-check: the parsed amount should appear (with or without commas/decimals)
  // somewhere in the subject or snippet. Tolerate small rounding by matching
  // the integer part only.
  const haystack = `${r.subject ?? ''}\n${r.snippet ?? ''}`.replace(/[,\s]/g, '');
  if (haystack.length > 0) {
    const intPart = Math.round(r.amount).toString();
    if (!haystack.includes(intPart)) {
      return { valid: false, reason: `Parsed amount ${intPart} not found in email body` };
    }
  }
  return { valid: true };
}

/**
 * Extract the cash-deposit receipt code from a "Cash deposit code …" email.
 * These emails are generated when a user starts a CASH deposit: the body and
 * subject carry a short Receipt code (e.g. `8829`) which is stored verbatim as
 * the matching `deposit_requests.transaction_id`. The generic MoMo-TID matcher
 * skips short references to avoid spurious collisions, so these legitimate
 * cash codes need their own exact-match path. Returns the trimmed code or null.
 */
export function extractCashReceiptCode(r: GmailTx): string | null {
  const hay = `${r.subject ?? ''}\n${r.snippet ?? ''}`;
  // Prefer the explicit "Receipt code: 8829" label (REQUIRE the colon — the
  // body also says "read the receipt code back to them", and a colon-less
  // match would wrongly capture the word "back"), then the subject form
  // "Cash deposit code 8829 — UGX …".
  const candidates: Array<string | undefined> = [
    hay.match(/Receipt\s*code\s*:\s*([A-Za-z0-9-]{3,})/i)?.[1],
    hay.match(/Cash\s*deposit\s*code\s+([A-Za-z0-9-]{3,})/i)?.[1],
  ];
  for (const raw of candidates) {
    const code = (raw ?? '').trim();
    // Real receipt codes always contain at least one digit; this rejects
    // stray prose words ("back", "verified") that follow the label.
    if (code.length >= 3 && /\d/.test(code)) return code;
  }
  return null;
}

/**
 * localStorage-backed cache of derived channel results, keyed by the most
 * stable identifier available on the row (transaction id / receipt number,
 * falling back to the gmail message id). The cache lets future loads — and
 * future poll inserts — reuse the same classification without re-running
 * the heuristic, and lets a manual fix (if we ever expose one) stick.
 */
export const CHANNEL_CACHE_KEY = 'gmail_channel_cache_v2';

export const EXPANDED_ROWS_KEY = 'email_expanded_rows_v1';

/**
 * Confidence levels for an inferred channel:
 *   - 'authoritative' — the DB already classified this row; no heuristic ran.
 *   - 'high'   — a brand keyword matched (e.g. "MTN", "Stanbic", "RCT-...").
 *               These are very unlikely to be wrong.
 *   - 'medium' — a known id prefix matched (e.g. "MP" / "AP" mobile money
 *               refs, "FT"/"TRF"/"RTGS" bank wire refs). The id shape is
 *               distinctive but not as unambiguous as a brand name.
 *   - 'low'    — only a generic reference-number phrase ("Reference No.",
 *               "Bank Ref", "SWIFT") was found anywhere in the email. Worth
 *               showing, but flag for review.
 */
export type ChannelConfidence = 'authoritative' | 'high' | 'medium' | 'low';

export interface ChannelResult {
  channel: string;
  confidence: ChannelConfidence;
  /** Short human-readable description of what matched. */
  signal: string;
  /** Stable id of the rule that fired (e.g. 'rct_id_prefix'). */
  rule?: string;
  /** Which field on the row the match was found in. */
  source?: 'transaction_id' | 'subject' | 'snippet' | 'from' | 'body' | 'parser';
  /** The exact substring that matched, for display in the tooltip. */
  match?: string;
}

/** Numeric score (0–100) for compact display alongside the badge. */
export function confidenceScore(c: ChannelConfidence): number {
  return c === 'authoritative' ? 100 : c === 'high' ? 90 : c === 'medium' ? 70 : 45;
}

export function channelCacheKey(r: GmailTx): string | null {
  const id = (r.transaction_id ?? '').trim();
  if (id) return `tx:${id.toLowerCase()}`;
  if (r.gmail_message_id) return `msg:${r.gmail_message_id}`;
  return null;
}

export type ChannelCacheEntry = ChannelResult;

export function readChannelCache(): Record<string, ChannelCacheEntry> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(CHANNEL_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, ChannelCacheEntry>) : {};
  } catch {
    return {};
  }
}

export function writeChannelCache(cache: Record<string, ChannelCacheEntry>): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(CHANNEL_CACHE_KEY, JSON.stringify(cache)); } catch {}
}

/**
 * Ordered list of channel-inference rules. The first matching rule wins.
 * Each rule declares which field to probe so the tooltip can show *why* the
 * channel was inferred (e.g. "Matched MP/FTI MoMo prefix on the transaction
 * id: MP240518…").
 */
export type RuleSource = 'transaction_id' | 'subject' | 'snippet' | 'from' | 'body';
export interface ChannelRule {
  id: string;
  channel: string;
  confidence: ChannelConfidence;
  signal: string;
  source: RuleSource;
  pattern: RegExp;
}

export const CHANNEL_RULES: ChannelRule[] = [
  // Receipt numbers — Welile cash receipts use the RCT prefix.
  { id: 'rct_id_prefix',     channel: 'cash_receipt',  confidence: 'high',   signal: 'RCT receipt id prefix',        source: 'transaction_id', pattern: /^rct[-_]?\d+/i },
  { id: 'rct_body',          channel: 'cash_receipt',  confidence: 'medium', signal: 'RCT receipt number in body',   source: 'body',           pattern: /\brct[-_]?\d{3,}\b/i },
  // Cash deposits — "Cash deposit code 8829" / "Receipt code: 8829" emails carry
  // no provider brand, so without these they fall through to 'other' and never
  // appear under Cash in the channel breakdown.
  { id: 'cash_deposit_code', channel: 'cash_receipt',  confidence: 'high',   signal: 'Cash deposit code phrase',     source: 'body',           pattern: /\bcash\s*deposit\s*code\b/i },
  { id: 'cash_deposit',      channel: 'cash_receipt',  confidence: 'high',   signal: 'Cash deposit phrase',          source: 'body',           pattern: /\bcash\s*deposit\b/i },
  { id: 'receipt_code',      channel: 'cash_receipt',  confidence: 'medium', signal: 'Receipt code label',           source: 'body',           pattern: /\breceipt\s*code\b/i },
  // Mobile money — brand keywords (high) vs id prefix only (medium).
  { id: 'mtn_brand',         channel: 'mtn_momo',      confidence: 'high',   signal: 'MTN/MoMo brand keyword',       source: 'body',           pattern: /\b(mtn|momo|mobile money)\b/i },
  { id: 'mtn_id_prefix',     channel: 'mtn_momo',      confidence: 'medium', signal: 'MP/FTI/CI MoMo id prefix',      source: 'transaction_id', pattern: /^(mp|fti|ci)\d+/i },
  { id: 'airtel_brand',      channel: 'airtel_money',  confidence: 'high',   signal: 'Airtel brand keyword',         source: 'body',           pattern: /\bairtel\b/i },
  { id: 'airtel_id_prefix',  channel: 'airtel_money',  confidence: 'medium', signal: 'AP/AM Airtel id prefix',       source: 'transaction_id', pattern: /^(ap|am)\d+/i },
  // Banks — brand keywords are always high confidence.
  { id: 'stanbic_brand',     channel: 'stanbic',       confidence: 'high',   signal: 'Stanbic brand keyword',        source: 'body',           pattern: /\bstanbic\b/i },
  { id: 'centenary_brand',   channel: 'centenary',     confidence: 'high',   signal: 'Centenary brand keyword',      source: 'body',           pattern: /\b(centenary|cente)\b/i },
  { id: 'dfcu_brand',        channel: 'dfcu',          confidence: 'high',   signal: 'DFCU brand keyword',           source: 'body',           pattern: /\bdfcu\b/i },
  { id: 'equity_brand',      channel: 'equity_bank',   confidence: 'high',   signal: 'Equity Bank brand keyword',    source: 'body',           pattern: /\bequity\b/i },
  { id: 'absa_brand',        channel: 'absa',          confidence: 'high',   signal: 'Absa/Barclays brand keyword',  source: 'body',           pattern: /\b(absa|barclays)\b/i },
  { id: 'stanchart_brand',   channel: 'stanchart',     confidence: 'high',   signal: 'Standard Chartered keyword',   source: 'body',           pattern: /\b(stanchart|standard chartered)\b/i },
  // Generic bank reference patterns.
  { id: 'bank_ref_id_prefix',channel: 'bank_transfer', confidence: 'medium', signal: 'FT/TRF/RTGS bank ref prefix',  source: 'transaction_id', pattern: /^(ft|trf|txn|ref|wire|rtgs|eft)[-_/]?[a-z0-9]+/i },
  { id: 'bank_ref_phrase',   channel: 'bank_transfer', confidence: 'low',    signal: 'Generic bank reference phrase',source: 'body',           pattern: /\b(bank\s*ref(erence)?|reference\s*(no|number|#)|rtgs|swift)\b/i },
  // Last-resort: a bare "cash" keyword still belongs under Cash rather than 'other'.
  { id: 'cash_keyword',      channel: 'cash_receipt',  confidence: 'low',    signal: 'Cash keyword',                 source: 'body',           pattern: /\bcash\b/i },
];

/**
 * User-defined channel rules. These are layered on top of CHANNEL_RULES (and
 * evaluated first) so a manual fix from the UI permanently re-classifies any
 * future row that matches the same pattern. Persisted in localStorage as
 * plain strings; the pattern is stored as a regex source string + flags.
 */
export const USER_RULES_KEY = 'gmail_channel_user_rules_v1';
export interface StoredUserRule {
  id: string;
  channel: string;
  confidence: ChannelConfidence;
  signal: string;
  source: RuleSource;
  patternSource: string;
  patternFlags: string;
  createdAt: string;
  /** Optional human-readable note shown in the manage list. */
  note?: string;
}

export function readStoredUserRules(): StoredUserRule[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(USER_RULES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredUserRule[]) : [];
  } catch { return []; }
}
export function writeStoredUserRules(rules: StoredUserRule[]): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(USER_RULES_KEY, JSON.stringify(rules)); } catch {}
}
export function compileUserRule(r: StoredUserRule): ChannelRule | null {
  try {
    return {
      id: r.id, channel: r.channel, confidence: r.confidence,
      signal: r.signal, source: r.source,
      pattern: new RegExp(r.patternSource, r.patternFlags || 'i'),
    };
  } catch { return null; }
}
/** Module-level live cache of compiled user rules, refreshed on save/delete. */
let USER_RULES: ChannelRule[] = readStoredUserRules()
  .map(compileUserRule)
  .filter((x): x is ChannelRule => !!x);
export function refreshUserRules(): void {
  USER_RULES = readStoredUserRules()
    .map(compileUserRule)
    .filter((x): x is ChannelRule => !!x);
}
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Possible-user matching. We scan each transaction email for Uganda mobile
 * numbers and the transaction id, then look those up against `profiles` so
 * the operator can see at a glance which app user the deposit was likely
 * made by.
 */
export interface MatchedUser {
  id: string;
  full_name: string;
  phone: string | null;
  mobile_money_number: string | null;
  matched_on: string; // human-readable signal e.g. "phone 256772…"
}

/** Canonical channel options shown in the correction dialog. */
export const CHANNEL_OPTIONS: string[] = [
  'cash_receipt', 'mtn_momo', 'airtel_money',
  'stanbic', 'centenary', 'dfcu', 'equity_bank', 'absa', 'stanchart',
  'bank_transfer', 'card', 'other',
];

/**
 * Pure heuristic — no cache lookup. Walks `CHANNEL_RULES` in order and
 * returns the first match, capturing the rule id, source field, and the
 * exact matched substring so the UI can explain *why* the channel was
 * inferred. Used as the resolver of last resort.
 */
export function computeChannel(r: GmailTx): ChannelResult {
  if (r.channel && r.channel !== 'other') {
    return { channel: r.channel, confidence: 'authoritative', signal: 'Parser-assigned by the email importer', source: 'parser' };
  }
  const id = (r.transaction_id ?? '').trim();
  const body = `${r.from_email ?? ''} ${r.from_name ?? ''} ${r.subject ?? ''} ${r.snippet ?? ''} ${id}`;
  for (const rule of [...USER_RULES, ...CHANNEL_RULES]) {
    const haystack = rule.source === 'transaction_id' ? id : body;
    if (!haystack) continue;
    const m = haystack.match(rule.pattern);
    if (m) {
      return {
        channel: rule.channel,
        confidence: rule.confidence,
        signal: rule.signal,
        rule: rule.id,
        source: rule.source,
        match: m[0],
      };
    }
  }
  return { channel: 'other', confidence: 'low', signal: 'No matching rule', source: 'body' };
}

/**
 * Best-effort channel resolver. Order of precedence:
 *   1. DB `channel` column (when present and not 'other') — authoritative.
 *   2. Persisted cache hit on the row's transaction id / receipt number
 *      (`channelCacheKey(r)`) — keeps classification stable across reloads
 *      and new poll inserts referencing the same id.
 *   3. Heuristic over transaction id + subject + snippet (`computeChannel`),
 *      with the result written back to the cache when it's not 'other'.
 */
export function deriveChannel(r: GmailTx, cache?: Record<string, ChannelCacheEntry>): ChannelResult {
  if (r.channel && r.channel !== 'other') {
    return { channel: r.channel, confidence: 'authoritative', signal: 'parser-assigned' };
  }
  const key = channelCacheKey(r);
  if (cache && key && cache[key]) return cache[key];
  const computed = computeChannel(r);
  if (cache && key && computed.channel !== 'other') {
    const prev = cache[key];
    if (!prev || prev.channel !== computed.channel || prev.confidence !== computed.confidence) {
      cache[key] = computed;
    }
  }
  return computed;
}
