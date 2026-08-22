import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { archivePdfBlob } from '@/lib/pdfVault';
import { ArchivedPdfsDrawer } from '@/components/financial-ops/ArchivedPdfsDrawer';
import { Badge } from '@/components/ui/badge';
import { Mail, RefreshCw, Loader2, CheckCircle2, AlertCircle, Smartphone, Bug, ShieldAlert, Copy, Check, Wifi, WifiOff, ShieldCheck, ShieldQuestion, History, LinkIcon, ChevronDown, ChevronUp, FileDown, FileText, AlertTriangle, Search, X, Pencil, Trash2, Star, Users, ArrowRight, Zap, Undo2, Wallet, HelpCircle, Phone, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { RouteEmailDepositDialog, type EmailRowForRouting, type PrefilledUser } from '@/components/financial-ops/RouteEmailDepositDialog';
import { UserSearchPicker, type UserResult } from '@/components/cfo/UserSearchPicker';
import { BucketTransferLauncher } from '@/components/financial-ops/BucketTransferDialog';
import { BacklogSweepLauncher } from '@/components/financial-ops/BacklogSweepDialog';
import { Info, Inbox, AlertOctagon, Send, Menu } from 'lucide-react';
import { Wrench, Clock } from 'lucide-react';
import { SlidersHorizontal } from 'lucide-react';
import { CalendarRange } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { format } from 'date-fns';
import { useToast } from '@/hooks/use-toast';
import { toast as sonnerToast } from 'sonner';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { normalizeMomoTid } from '@/lib/momoTid';
import { downloadCsv, csvTimestamp } from '@/lib/csvExport';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip as RTooltip, CartesianGrid, Legend, Brush } from 'recharts';
import { DebitBucketAuditSearch } from './DebitBucketAuditSearch';

import { ProxyDebitBreakdownDialog } from './ProxyDebitBreakdownDialog';
import { EmailPeriodComparison } from './EmailPeriodComparison';
import { SwipeableEmailRow, type SwipeAction } from './SwipeableEmailRow';
import { GmailStyleEmailList } from './GmailStyleEmailList';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface GmailTx {
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
  fee: number | null;
  balance: number | null;
  linked_deposit_request_id: string | null;
  auto_matched_at: string | null;
}

interface PollState {
  last_polled_at: string | null;
  last_status: string | null;
  last_error: string | null;
}


const fmtUgx = (n: number | null) =>
  n === null || n === undefined ? '—' : `UGX ${Math.round(n).toLocaleString()}`;

/**
 * Mirror of the parser's skip-reason logic in `gmail-poll-transactions`.
 * A Gmail row is treated as "unparsed / skipped" when it never produced a
 * usable amount (parsed=false, or amount is null). This recomputes the exact
 * reason(s) the parser would have logged, straight from the stored columns,
 * so Financial Ops can see WHY each row was skipped without re-running the
 * edge function.
 */
function isUnparsedRow(r: { parsed: boolean; amount: number | null }): boolean {
  return !r.parsed || r.amount === null || r.amount === undefined;
}

function parseFailureReasons(r: {
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
interface AutoCreditGate {
  label: string;
  ok: boolean;
  reason: string;
}

function autoCreditGateReport(args: {
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
function zonedWallClockToUtcMs(dateStr: string, timeStr: string, tz: string): number {
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
function dateKeyInTz(d: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(d); // en-CA gives YYYY-MM-DD
}

const TIMEZONE_OPTIONS = [
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
 * Validate a parsed Gmail transaction row against its own raw email text.
 * A row is considered "flagged" (excluded from totals) when any of:
 *   - parsed=true but amount is null / non-finite / ≤ 0
 *   - parsed=true but no direction was extracted (can't classify in/out)
 *   - the parsed amount cannot be located inside the subject/snippet
 *     (means the parser & email disagree)
 * Returns { valid: true } for unparsed rows (they never count toward totals).
 */
function validateGmailTx(r: GmailTx): { valid: boolean; reason?: string } {
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
function extractCashReceiptCode(r: GmailTx): string | null {
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
const CHANNEL_CACHE_KEY = 'gmail_channel_cache_v2';

/**
 * Live MTN / Airtel float balances as reported on the most recent
 * balance-carrying email for each channel. Re-reads whenever new mail lands.
 */
function TelecomBalanceStrip({ refreshKey }: { refreshKey: string | null }) {
  const [bal, setBal] = useState<{
    mtn: { amount: number; at: string } | null;
    airtel: { amount: number; at: string } | null;
  }>({ mtn: null, airtel: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pick = async (channel: string, senderToken: string) => {
        const { data } = await (supabase.from('gmail_transactions') as any)
          .select('balance, internal_date, subject')
          .eq('channel', channel)
          .not('balance', 'is', null)
          // Only real forwarded telecom SMS carry a true float balance.
          // Internal Welile report emails (e.g. "Daily Wallet Financial
          // Summary Report") also land in this table and had a bogus
          // "balance" parsed out of their body, which was overriding the
          // genuine MoMoPay figure. Match the telecom sender token — no
          // spaces, so the filter survives URL encoding.
          .ilike('subject', `%${senderToken}%`)
          .order('internal_date', { ascending: false })
          .limit(1);
        const row = Array.isArray(data) ? data[0] : null;
        return row ? { amount: Number(row.balance), at: String(row.internal_date) } : null;
      };
      const [mtn, airtel] = await Promise.all([
        pick('mtn_momo', 'MobMoney'),
        pick('airtel_money', 'AirtelMoney'),
      ]);
      if (!cancelled) setBal({ mtn, airtel });
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const fmt = (n: number) => `UGX ${Math.round(n).toLocaleString()}`;
  const time = (iso: string) => {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString();
  };

  const item = (label: string, tone: string, v: { amount: number; at: string } | null) => (
    <div
      className="flex items-center gap-1.5 rounded-full border bg-muted/40 px-2 py-1"
      title={v ? `${label} balance from the latest email · ${time(v.at)}` : `No ${label} balance found yet`}
    >
      <span className={`h-2 w-2 rounded-full ${tone}`} aria-hidden />
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-xs font-semibold tabular-nums">{v ? fmt(v.amount) : '—'}</span>
    </div>
  );

  const totalAmount = (bal.mtn?.amount ?? 0) + (bal.airtel?.amount ?? 0);
  const totalAt = bal.mtn?.at && bal.airtel?.at
    ? (new Date(bal.mtn.at) > new Date(bal.airtel.at) ? bal.mtn.at : bal.airtel.at)
    : (bal.mtn?.at ?? bal.airtel?.at ?? null);

  return (
    <div className="flex flex-wrap items-center gap-2 shrink-0" aria-label="Latest telecom balances">
      {/* Total is the primary, easy-to-read element */}
      <div
        className="flex flex-col rounded-lg border-2 border-purple-400 bg-purple-100 px-3 py-1.5 shadow-sm dark:border-purple-700 dark:bg-purple-950/60"
        title={totalAt ? `Combined float balance · latest email ${time(totalAt)}` : 'Combined float balance'}
      >
        <span className="text-[10px] font-bold uppercase tracking-wide text-purple-800 dark:text-purple-200">Total float</span>
        <span className="text-base font-extrabold tabular-nums leading-tight text-purple-900 dark:text-purple-100">{fmt(totalAmount)}</span>
      </div>

      {/* Provider breakdown shown as smaller secondary chips */}
      <div className="flex items-center gap-1.5">
        {item('MTN', 'bg-warning', bal.mtn)}
        {item('Airtel', 'bg-destructive', bal.airtel)}
      </div>
    </div>
  );
}
const EXPANDED_ROWS_KEY = 'email_expanded_rows_v1';

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
function confidenceScore(c: ChannelConfidence): number {
  return c === 'authoritative' ? 100 : c === 'high' ? 90 : c === 'medium' ? 70 : 45;
}

function channelCacheKey(r: GmailTx): string | null {
  const id = (r.transaction_id ?? '').trim();
  if (id) return `tx:${id.toLowerCase()}`;
  if (r.gmail_message_id) return `msg:${r.gmail_message_id}`;
  return null;
}

type ChannelCacheEntry = ChannelResult;

function readChannelCache(): Record<string, ChannelCacheEntry> {
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

function writeChannelCache(cache: Record<string, ChannelCacheEntry>): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(CHANNEL_CACHE_KEY, JSON.stringify(cache)); } catch {}
}

/**
 * Ordered list of channel-inference rules. The first matching rule wins.
 * Each rule declares which field to probe so the tooltip can show *why* the
 * channel was inferred (e.g. "Matched MP/FTI MoMo prefix on the transaction
 * id: MP240518…").
 */
type RuleSource = 'transaction_id' | 'subject' | 'snippet' | 'from' | 'body';
interface ChannelRule {
  id: string;
  channel: string;
  confidence: ChannelConfidence;
  signal: string;
  source: RuleSource;
  pattern: RegExp;
}

const CHANNEL_RULES: ChannelRule[] = [
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
const USER_RULES_KEY = 'gmail_channel_user_rules_v1';
interface StoredUserRule {
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

function readStoredUserRules(): StoredUserRule[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(USER_RULES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredUserRule[]) : [];
  } catch { return []; }
}
function writeStoredUserRules(rules: StoredUserRule[]): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(USER_RULES_KEY, JSON.stringify(rules)); } catch {}
}
function compileUserRule(r: StoredUserRule): ChannelRule | null {
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
function refreshUserRules(): void {
  USER_RULES = readStoredUserRules()
    .map(compileUserRule)
    .filter((x): x is ChannelRule => !!x);
}
function escapeRegex(s: string): string {
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

// Phone / reference extraction helpers are defined in a sibling module so
// they can be unit-tested against real provider email shapes.
import {
  normalizeUgPhone,
  extractPhones,
  extractFromPhones,
  extractToPhones,
  extractReferences,
  extractToNames,
  extractFromNames,
} from '@/components/financial-ops/emailExtraction';

/** Canonical channel options shown in the correction dialog. */
const CHANNEL_OPTIONS: string[] = [
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
function computeChannel(r: GmailTx): ChannelResult {
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
function deriveChannel(r: GmailTx, cache?: Record<string, ChannelCacheEntry>): ChannelResult {
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

/**
 * Live feed of transaction confirmation emails extracted from the
 * connected Gmail inbox. A background cron polls every minute; this
 * panel mirrors the table in real time and exposes a manual "Poll now".
 */
export function EmailTransactionsPanel() {
  const { toast } = useToast();
  const [rows, setRows] = useState<GmailTx[]>([]);
  const [state, setState] = useState<PollState | null>(null);
  /**
   * Why the list is empty. A read blocked by row-level security used to look
   * identical to "no emails captured yet" because the loader swallowed the
   * PostgREST error — so staff who can open the page but can't read the table
   * saw a friendly (and wrong) empty state.
   */
  const [loadError, setLoadError] = useState<{ message: string; denied: boolean } | null>(null);

  const [lastSuccessAt, setLastSuccessAt] = useState<string | null>(
    () => (typeof window !== 'undefined' ? localStorage.getItem('gmail_last_success_at') : null)
  );
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  // Date-range filter (inclusive). Defaults to "today" in the operator's
  // timezone so the report opens scoped to today; users can pick any other
  // period (yesterday, 7d, etc.) and the selection is persisted across reloads.
  const initialTz = (() => {
    if (typeof window === 'undefined') return 'Africa/Kampala';
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return localStorage.getItem('gmail_filter_tz') || browserTz || 'Africa/Kampala';
  })();
  const todayKeyInitial = typeof window === 'undefined' ? '' : dateKeyInTz(new Date(), initialTz);
  const [fromDate, setFromDate] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    const saved = localStorage.getItem('gmail_filter_from');
    return saved === null ? todayKeyInitial : saved;
  });
  const [toDate, setToDate] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    const saved = localStorage.getItem('gmail_filter_to');
    return saved === null ? todayKeyInitial : saved;
  });
  useEffect(() => { try { localStorage.setItem('gmail_filter_from', fromDate); } catch {} }, [fromDate]);
  useEffect(() => { try { localStorage.setItem('gmail_filter_to', toDate); } catch {} }, [toDate]);
  // Timezone in which `fromDate`/`toDate` are interpreted and daily buckets are grouped.
  const browserTz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
  const [tz, setTz] = useState<string>(() => {
    if (typeof window === 'undefined') return browserTz || 'Africa/Kampala';
    return localStorage.getItem('gmail_filter_tz') || browserTz || 'Africa/Kampala';
  });
  useEffect(() => { try { localStorage.setItem('gmail_filter_tz', tz); } catch {} }, [tz]);
  // Configurable warning threshold for |net|. Persisted in localStorage. Default 1,000,000 UGX.
  const [netThreshold, setNetThreshold] = useState<number>(() => {
    if (typeof window === 'undefined') return 1_000_000;
    const raw = localStorage.getItem('gmail_net_threshold');
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1_000_000;
  });
  useEffect(() => {
    try { localStorage.setItem('gmail_net_threshold', String(netThreshold)); } catch {}
  }, [netThreshold]);

  // Free-text search across transaction id, bank reference number, receipt
  // number, subject, snippet and counterparty. Persisted in localStorage so
  // the filter survives a page refresh. Whitespace-separated tokens are
  // AND-matched; each token is matched case-insensitively as a substring.
  const [searchQuery, setSearchQuery] = useState<string>(() =>
    typeof window === 'undefined' ? '' : (localStorage.getItem('gmail_filter_search') || '')
  );
  useEffect(() => { try { localStorage.setItem('gmail_filter_search', searchQuery); } catch {} }, [searchQuery]);
  // Gmail's "Show search options" panel — collapsed by default, holds the
  // advanced refinements (From, date window, sort) exactly like Gmail does.
  const [searchOptionsOpen, setSearchOptionsOpen] = useState(false);
  // Dedicated depositor-phone filter — narrows the list to a single phone
  // number in any printed format (0…, 256…, +256…, 7…). Matched against the
  // email counterparty / sender / body and the resolved depositing user's
  // phone. Persisted so the filter survives a refresh.
  const [phoneQuery, setPhoneQuery] = useState<string>(() =>
    typeof window === 'undefined' ? '' : (localStorage.getItem('gmail_filter_phone') || '')
  );
  useEffect(() => { try { localStorage.setItem('gmail_filter_phone', phoneQuery); } catch {} }, [phoneQuery]);
  // Pagination for the Recent emails list. Page size is user-selectable and
  // persisted; current page resets to 1 whenever any filter changes.
  const [pageSize, setPageSize] = useState<number>(() => {
    if (typeof window === 'undefined') return 50;
    const v = Number(localStorage.getItem('gmail_filter_page_size') || '50');
    return [25, 50, 100, 200, 500].includes(v) ? v : 50;
  });
  useEffect(() => { try { localStorage.setItem('gmail_filter_page_size', String(pageSize)); } catch {} }, [pageSize]);
  const [currentPage, setCurrentPage] = useState<number>(1);
  // Rendering mode for the Recent emails list. 'paged' keeps the classic
  // first/prev/next/last controls; 'infinite' grows the visible window as the
  // operator scrolls (sentinel + IntersectionObserver). Persisted so the
  // preference survives reload. The expanded drilldown state is keyed by row
  // id (see `expandedRows`), so it is preserved across page changes AND while
  // more rows stream in during infinite scroll.
  type PaginationMode = 'paged' | 'infinite';
  const [paginationMode, setPaginationMode] = useState<PaginationMode>(() => {
    if (typeof window === 'undefined') return 'paged';
    const v = localStorage.getItem('gmail_pagination_mode');
    if (v === 'infinite' || v === 'paged') return v;
    // First run: phones default to smooth infinite scroll (no tiny pager taps),
    // desktop keeps the classic pager.
    return window.matchMedia?.('(max-width: 639px)').matches ? 'infinite' : 'paged';
  });
  useEffect(() => { try { localStorage.setItem('gmail_pagination_mode', paginationMode); } catch {} }, [paginationMode]);
  // How many rows are currently rendered in infinite-scroll mode. Starts at one
  // page worth and grows by `pageSize` each time the sentinel scrolls into view.
  const [infiniteCount, setInfiniteCount] = useState<number>(pageSize);
  const infiniteSentinelRef = useRef<HTMLDivElement | null>(null);
  // Match-type filter for the Recent emails list. Persisted so it survives reload.
  //   all       → no match filter
  //   confident → at least one reference OR from-phone match
  //   reference → at least one reference / TID match
  //   from      → at least one phone-after-"from" match
  type MatchFilter = 'all' | 'confident' | 'reference' | 'from';
  const [matchFilter, setMatchFilter] = useState<MatchFilter>(() => {
    if (typeof window === 'undefined') return 'all';
    const v = localStorage.getItem('gmail_filter_match') as MatchFilter | null;
    return v && ['all', 'confident', 'reference', 'from'].includes(v) ? v : 'all';
  });
  useEffect(() => { try { localStorage.setItem('gmail_filter_match', matchFilter); } catch {} }, [matchFilter]);

  // Direction filter for the Recent emails list — lets Financial Ops slice
  // the captured Gmail traffic into money-in vs money-out (sends + charges)
  // without leaving the panel. Persisted so it survives reload.
  //   all → no direction filter
  //   in  → only credits (direction = 'in')
  //   out → debits + fees (direction = 'out' or 'charge')
  type DirectionFilter = 'all' | 'in' | 'out';
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>(() => {
    if (typeof window === 'undefined') return 'all';
    const v = localStorage.getItem('gmail_filter_direction') as DirectionFilter | null;
    return v && ['all', 'in', 'out'].includes(v) ? v : 'all';
  });
  useEffect(() => { try { localStorage.setItem('gmail_filter_direction', directionFilter); } catch {} }, [directionFilter]);

  // Focused money-in / money-out view. Tapping one of the two entry tiles opens
  // a dedicated page-style view that shows ONLY those emails: every other
  // narrowing filter is reset so nothing is silently hidden, and a banner with
  // a Back action replaces the tiles.
  const [focusDirection, setFocusDirection] = useState<'in' | 'out' | null>(null);
  // Inside a money-in / money-out focused view, emails render Gmail-style by
  // default; operators can flip to the detailed ops rows for routing actions.
  const [focusView, setFocusView] = useState<'gmail' | 'ops'>('gmail');
  // Gmail-style label rail: collapsed by default on phones, always visible on
  // desktop (mirrors Gmail's hamburger behaviour).
  const [gmailNavOpen, setGmailNavOpen] = useState(false);
  // Keep the focused view honest: if the operator changes the direction chips
  // lower down (or restores a preset), the banner follows or closes.
  useEffect(() => {
    setFocusDirection((cur) => {
      if (directionFilter === 'all') return null;
      return cur === null ? null : directionFilter;
    });
  }, [directionFilter]);

  // "Needs Routing" filter — when on, show only incoming deposits whose money
  // never landed in a wallet (not credited and not routed). Persisted so the
  // operator's triage view survives a refresh.
  const [needsRoutingOnly, setNeedsRoutingOnly] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('gmail_filter_needs_routing') === '1';
  });
  useEffect(() => { try { localStorage.setItem('gmail_filter_needs_routing', needsRoutingOnly ? '1' : '0'); } catch {} }, [needsRoutingOnly]);

  // Debit-breakdown filter — narrows the list by who was charged for an
  // outgoing email (user wallet, proxy agent wallet, or not yet debited).
  // Persisted so the operator's view survives a refresh.
  type DebitFilter = 'all' | 'user_debit' | 'proxy_debit' | 'none';
  const [debitFilter, setDebitFilter] = useState<DebitFilter>(() => {
    if (typeof window === 'undefined') return 'all';
    const v = localStorage.getItem('gmail_filter_debit') as DebitFilter | null;
    return v && ['all', 'user_debit', 'proxy_debit', 'none'].includes(v) ? v : 'all';
  });
  useEffect(() => { try { localStorage.setItem('gmail_filter_debit', debitFilter); } catch {} }, [debitFilter]);

  // Debit-breakdown sort — lets Financial Ops order the visible list by debit
  // metadata (type, amount, or charged name). None = preserve chronological.
  type DebitSort = 'none' | 'debitType' | 'debitAmount' | 'debitName';
  const [debitSort, setDebitSort] = useState<DebitSort>(() => {
    if (typeof window === 'undefined') return 'none';
    const v = localStorage.getItem('gmail_sort_debit') as DebitSort | null;
    return v && ['none', 'debitType', 'debitAmount', 'debitName'].includes(v) ? v : 'none';
  });
  useEffect(() => { try { localStorage.setItem('gmail_sort_debit', debitSort); } catch {} }, [debitSort]);

  // Status filter for the Recent emails list — lets Financial Ops slice the
  // captured traffic by settlement state without reading each row. Persisted.
  //   all          → no status filter
  //   credited     → incoming money already credited or routed to a wallet
  //   needs_routing→ incoming money not yet credited / routed (triage)
  //   unparsed     → rows the parser could not read (no amount / not parsed)
  // 'needs_routing'     → Needs routing 1: money IN that was not auto-credited
  // 'needs_routing_out' → Needs routing 2: money OUT that was not auto-deducted
  //                        from the wallet of the number that was paid out
  type StatusFilter = 'all' | 'credited' | 'needs_routing' | 'needs_routing_out' | 'unparsed';
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => {
    if (typeof window === 'undefined') return 'all';
    const v = localStorage.getItem('gmail_filter_status') as StatusFilter | null;
    return v && ['all', 'credited', 'needs_routing', 'needs_routing_out', 'unparsed'].includes(v) ? v : 'all';
  });
  useEffect(() => { try { localStorage.setItem('gmail_filter_status', statusFilter); } catch {} }, [statusFilter]);

  // Primary sort for the Recent emails list — lets Financial Ops reorder
  // results without touching the filters. Persisted so it survives reload.
  //   newest / oldest      → by email date
  //   amount_high / amount_low → by parsed amount
  //   status               → group by settlement state (needs routing first)
  type SortMode = 'newest' | 'oldest' | 'amount_high' | 'amount_low' | 'status';
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    if (typeof window === 'undefined') return 'newest';
    const v = localStorage.getItem('gmail_sort_mode') as SortMode | null;
    return v && ['newest', 'oldest', 'amount_high', 'amount_low', 'status'].includes(v) ? v : 'newest';
  });
  useEffect(() => { try { localStorage.setItem('gmail_sort_mode', sortMode); } catch {} }, [sortMode]);

  // ---- Filter presets -------------------------------------------------------
  // Operators triage the same handful of views all day (e.g. "Needs routing
  // today", "Big money out"). A preset snapshots every filter/sort control so a
  // single tap on mobile restores the whole view. Stored in localStorage.
  type FilterPreset = {
    id: string;
    name: string;
    searchQuery: string;
    phoneQuery: string;
    directionFilter: DirectionFilter;
    matchFilter: MatchFilter;
    needsRoutingOnly: boolean;
    debitFilter: DebitFilter;
    debitSort: DebitSort;
    statusFilter: StatusFilter;
    sortMode: SortMode;
  };
  const [filterPresets, setFilterPresets] = useState<FilterPreset[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem('gmail_filter_presets');
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? (parsed as FilterPreset[]) : [];
    } catch { return []; }
  });
  const [activePresetId, setActivePresetId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : localStorage.getItem('gmail_filter_preset_active')
  );
  const [presetNameDraft, setPresetNameDraft] = useState('');
  const [presetSaveOpen, setPresetSaveOpen] = useState(false);
  useEffect(() => {
    try { localStorage.setItem('gmail_filter_presets', JSON.stringify(filterPresets)); } catch {}
  }, [filterPresets]);
  useEffect(() => {
    try {
      if (activePresetId) localStorage.setItem('gmail_filter_preset_active', activePresetId);
      else localStorage.removeItem('gmail_filter_preset_active');
    } catch {}
  }, [activePresetId]);

  const currentPresetSnapshot = useCallback((): Omit<FilterPreset, 'id' | 'name'> => ({
    searchQuery, phoneQuery, directionFilter, matchFilter, needsRoutingOnly,
    debitFilter, debitSort, statusFilter, sortMode,
  }), [searchQuery, phoneQuery, directionFilter, matchFilter, needsRoutingOnly, debitFilter, debitSort, statusFilter, sortMode]);

  const savePreset = useCallback(() => {
    const name = presetNameDraft.trim();
    if (!name) return;
    const snap = currentPresetSnapshot();
    setFilterPresets((prev) => {
      const existing = prev.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        setActivePresetId(existing.id);
        return prev.map((p) => (p.id === existing.id ? { ...p, ...snap, name } : p));
      }
      const id = `p_${Date.now().toString(36)}`;
      setActivePresetId(id);
      return [...prev, { id, name, ...snap }].slice(-12);
    });
    setPresetNameDraft('');
    setPresetSaveOpen(false);
    sonnerToast.success(`Preset "${name}" saved`);
  }, [presetNameDraft, currentPresetSnapshot]);

  const applyPreset = useCallback((p: FilterPreset) => {
    setSearchQuery(p.searchQuery ?? '');
    setPhoneQuery(p.phoneQuery ?? '');
    setDirectionFilter(p.directionFilter ?? 'all');
    setMatchFilter(p.matchFilter ?? 'all');
    setNeedsRoutingOnly(Boolean(p.needsRoutingOnly));
    setDebitFilter(p.debitFilter ?? 'all');
    setDebitSort(p.debitSort ?? 'none');
    setStatusFilter(p.statusFilter ?? 'all');
    setSortMode(p.sortMode ?? 'newest');
    setActivePresetId(p.id);
    try { (navigator as any).vibrate?.(10); } catch {}
  }, []);

  const deletePreset = useCallback((id: string) => {
    setFilterPresets((prev) => prev.filter((p) => p.id !== id));
    setActivePresetId((cur) => (cur === id ? null : cur));
  }, []);

  // A preset stops being "active" as soon as the operator tweaks a control.
  useEffect(() => {
    if (!activePresetId) return;
    const p = filterPresets.find((x) => x.id === activePresetId);
    if (!p) return;
    const snap = currentPresetSnapshot();
    const same = (Object.keys(snap) as Array<keyof typeof snap>).every((k) => (p as any)[k] === snap[k]);
    if (!same) setActivePresetId(null);
  }, [activePresetId, filterPresets, currentPresetSnapshot]);

  // Reset pagination whenever any filter that affects the visible list changes.
  useEffect(() => {
    setCurrentPage(1);
    setInfiniteCount(pageSize);
  }, [searchQuery, phoneQuery, fromDate, toDate, tz, pageSize, directionFilter, matchFilter, needsRoutingOnly, debitFilter, debitSort, statusFilter, sortMode]);
  // Reset the infinite window back to one page whenever the operator switches
  // into infinite mode, so it never starts mid-list.
  useEffect(() => {
    if (paginationMode === 'infinite') setInfiniteCount(pageSize);
  }, [paginationMode, pageSize]);

  // Persisted cache of derived channel classifications keyed by transaction id
  // / receipt number (with gmail_message_id as fallback). Loaded once on mount
  // and flushed back to localStorage whenever the heuristic learns a new key,
  // so the same id always resolves to the same channel across reloads and
  // future poll inserts.
  const channelCacheRef = useRef<Record<string, ChannelCacheEntry>>(readChannelCache());
  const flushChannelCache = () => writeChannelCache(channelCacheRef.current);

  // Map of row.id → matched user(s) inferred from phone numbers / refs in
  // the email. Resolved in a background effect against the `profiles` table
  // so the operator can see which app user likely made each deposit.
  const [userMatches, setUserMatches] = useState<Record<string, MatchedUser[]>>({});

  // Routing history for visible rows. Keyed by `row.id`. Each entry is a
  // single re-routing action (forward credit + any reversal legs against an
  // earlier auto-credited user). Loaded in a background effect so routed
  // rows render with a distinct violet marker and a compact inline history.
  interface RoutingHistoryEntry {
    id: string;
    created_at: string;
    route: string;
    reason: string;
    target_user_id: string;
    target_user_name: string | null;
    target_user_phone: string | null;
    routed_by_name: string | null;
    amount: number;
    sms_sent: boolean;
  }
  const [routingHistory, setRoutingHistory] = useState<Record<string, RoutingHistoryEntry[]>>({});
  // Optimistic set of rows routed/charged in this session. A routed row must
  // leave the "needs routing" queue immediately, even before the routing
  // history refetch (or realtime feed) confirms the insert.
  const [justRoutedIds, setJustRoutedIds] = useState<Set<string>>(new Set());

  // Live wallet balances (strict, ledger-derived) for every possible user
  // and every routing-history target shown in the list. Lets Financial Ops
  // see the recipient's current wallet position at a glance before/after
  // routing or reversing a transaction.
  const [userBalances, setUserBalances] = useState<Record<string, number>>({});
  // Managed proxy agent resolved for each possible-user (partner) id, when one
  // exists (active + approved + is_managed_account assignment). Lets the
  // possible-recipient list show whose proxy wallet would be charged when the
  // user can't cover the payout, and opens a per-user proxy debit breakdown.
  interface ManagedProxy { agentId: string; agentName: string | null }
  const [userProxies, setUserProxies] = useState<Record<string, ManagedProxy>>({});
  // Latest 3 wallet ledger entries per possible-user, shown in the tooltip
  // so Financial Ops can see recent activity at a glance before routing.
  interface RecentTx {
    id: string;
    amount: number;
    direction: string;
    category: string;
    description: string | null;
    created_at: string;
  }
  const [userRecentTx, setUserRecentTx] = useState<Record<string, RecentTx[]>>({});
  // Timestamp of the last forced wallet-balance refresh (set after an
  // auto-debit run completes). Drives the visible "Balance refreshed"
  // indicator so Financial Ops knows the figures on screen are post-debit.
  const [balanceRefreshedAt, setBalanceRefreshedAt] = useState<number | null>(null);
  // Per-history-entry busy flag for the Reverse action so the button can
  // show a spinner without blocking other entries.
  const [reverseBusy, setReverseBusy] = useState<Record<string, boolean>>({});
  // Click-to-expand drilldown per email row. When a row id is present in this
  // set its drilldown panel is open, surfacing the linked proxy agent wallet
  // change, the debit reason, and the transaction references in one place.
  // Persisted to localStorage so the drilldown state survives refreshes.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const raw = localStorage.getItem(EXPANDED_ROWS_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed as string[]);
    } catch {}
    return new Set();
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(EXPANDED_ROWS_KEY, JSON.stringify(Array.from(expandedRows)));
    } catch {}
  }, [expandedRows]);
  const toggleRowExpanded = useCallback((id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  /**
   * Already-credited deposits for the currently visible *incoming* emails.
   * The poller (`gmail-poll-transactions`) auto-credits matched recipients
   * and stamps either `gmail_transactions.linked_deposit_request_id` (fast
   * path) or `deposit_requests.auto_match_audit->>gmail_message_id`
   * (fallback). When an email is already linked to a non-terminal
   * deposit_request we MUST NOT credit it again — surfacing this in the
   * list prevents double-credits and tells Financial Ops exactly which
   * user already received the money.
   */
  interface CreditedDeposit {
    deposit_id: string;
    user_id: string;
    user_name: string;
    user_phone: string;
    amount: number;
    status: string;
    auto_approved: boolean | null;
    deposit_purpose: string | null;
    credited_at: string | null;
    /** True when this deposit was matched to the email by its transaction
     *  reference (TID) rather than an explicit gmail link / auto_match_audit. */
    matched_by_tid?: boolean;
    /** The normalized transaction reference that matched, for display. */
    matched_tid?: string | null;
    /** Auto-credit provenance from deposit_requests.auto_match_audit — lets the
     *  row show HOW the wallet was resolved and how confident the matcher was.
     *  phone_source='body' + confidence='medium' is the "possible user ≈60%"
     *  body-phone signal. */
    auto_match_method?: string | null;
    auto_phone_source?: 'counterparty' | 'body' | null;
    auto_confidence?: 'high' | 'medium' | 'low' | null;
    auto_confidence_score?: number | null;
  }
  const [creditedDeposits, setCreditedDeposits] = useState<Record<string, CreditedDeposit[]>>({});

  /**
   * Ledger-only credits. Some incoming money never produces a
   * `deposit_requests` row at all — agent float deposits, CFO direct credits
   * and other ops postings land straight in `general_ledger` while quoting the
   * MoMo / Airtel reference in the description or idempotency key. Those
   * emails were previously stuck under "Needs routing" even though the wallet
   * was already credited, so they never showed up under Credited. Resolved
   * through the ops-only `match_email_ledger_credits` RPC.
   */
  interface LedgerCredit {
    ledger_id: string;
    amount: number;
    category: string | null;
    user_id: string | null;
    user_name: string | null;
    user_phone: string | null;
    created_at: string | null;
  }
  const [ledgerCredits, setLedgerCredits] = useState<Record<string, LedgerCredit[]>>({});

  /**
   * Manual "mark credited / uncredited" audit log loaded from
   * `email_credit_manual_marks`. Bulk actions append immutable rows there;
   * the LATEST mark per gmail_transaction_id is the operative state and
   * overrides the auto-detected `creditedDeposits` mapping so reviewers can
   * force a row to be treated as credited (e.g. settled out-of-band) or
   * uncredited (e.g. reversed manually) without losing history.
   */
  interface ManualMark {
    mark: 'credited' | 'uncredited';
    marked_by: string;
    marked_by_name: string | null;
    reason: string | null;
    created_at: string;
  }
  const [manualMarks, setManualMarks] = useState<Record<string, ManualMark>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  /**
   * Auto-payout matcher: for outgoing money-out emails (MoMo payouts / bank
   * disbursements), look up the pending `withdrawal_requests` row that the
   * email is *settling*. Match is by normalized TID (strongest) or by
   * counterparty/recipient phone + exact amount (fallback). One-click
   * "Auto-approve withdrawal" calls the same `approve-withdrawal` edge
   * function FinOps uses manually, with the email's TID as the
   * `fin_ops_reference`.
   */
  interface WithdrawalMatch {
    id: string;
    user_id: string;
    amount: number;
    status: string;
    mobile_money_number: string | null;
    mobile_money_provider: string | null;
    bank_name: string | null;
    bank_account_number: string | null;
    payout_method: string;
    matched_on: 'reference' | 'phone+amount';
    user_name?: string | null;
  }
  const [withdrawalMatches, setWithdrawalMatches] = useState<Record<string, WithdrawalMatch[]>>({});
  const [autoApproving, setAutoApproving] = useState<Record<string, boolean>>({});

  // ── Invite / login SMS delivery status ────────────────────────────────
  // The gmail poller texts every depositor's phone a link back to the
  // platform (a "sign up" invite for new numbers, a "log in" nudge for
  // existing users) and logs each attempt to `sms_delivery_log` with
  // source='momo_deposit_invite'. We surface that per-row so Financial Ops
  // can see whether the invite/login SMS was sent or failed for each
  // extracted deposit. Keyed by gmail_transactions.id.
  interface InviteSms {
    status: string;
    created_at: string;
    phone: string;
    message: string | null;
    error: string | null;
  }
  const [inviteSms, setInviteSms] = useState<Record<string, InviteSms>>({});

  // Manual channel correction UI. `editingRow` controls the dialog; bumping
  // `rulesVersion` re-renders the list so newly-saved rules / cache overrides
  // take effect immediately on every visible row.
  const [editingRow, setEditingRow] = useState<GmailTx | null>(null);
  const [routingRow, setRoutingRow] = useState<GmailTx | null>(null);
  const [routingSuggestedUser, setRoutingSuggestedUser] = useState<PrefilledUser | null>(null);
  const [routingMode, setRoutingMode] = useState<'credit' | 'debit'>('credit');
  // Per-row user selected via the inline search bar inside an expanded email.
  // Keyed by gmail_transactions.id so multiple rows can keep independent picks.
  const [inlineRouteUsers, setInlineRouteUsers] = useState<Record<string, UserResult>>({});
  // Row whose full status-history drawer is open (null = closed).
  const [historyDrawerRow, setHistoryDrawerRow] = useState<GmailTx | null>(null);
  // Search + route-type filter for the status-history drawer.
  const [historyDrawerQuery, setHistoryDrawerQuery] = useState('');
  const [historyDrawerType, setHistoryDrawerType] = useState<'all' | 'routed' | 'charged' | 'reversed'>('all');
  // Reset drawer filters whenever a different row's history is opened.
  useEffect(() => {
    setHistoryDrawerQuery('');
    setHistoryDrawerType('all');
  }, [historyDrawerRow?.id]);
  // A swipe queues a confirmation step before actually opening the
  // routing/charging dialog, so an accidental swipe can't fire the action.
  // Swipe confirmation gate. `mode` covers the money actions (credit/debit) and
  // the resolve action, so no swipe can process anything without a review step.
  const [pendingSwipe, setPendingSwipe] = useState<{ row: GmailTx; mode: 'credit' | 'debit' | 'resolve' } | null>(null);
  // High-impact actions (wallet charge) additionally require an explicit tick.
  const [swipeAck, setSwipeAck] = useState(false);
  // Batch auto-debit state. `autoDebitBusy` disables the banner button while
  // a batch run is in flight; `autoDebitProgress` drives the inline counter.
  const [autoDebitBusy, setAutoDebitBusy] = useState(false);
  const [autoDebitProgress, setAutoDebitProgress] = useState<{ done: number; total: number; ok: number; failed: number } | null>(null);
  // Per-row auto-debit outcome captured at run time so the row can show the
  // live impact on the matched user's wallet (amount taken + balance left).
  // Keyed by gmail transaction row id.
  const [autoDebitResults, setAutoDebitResults] = useState<
    Record<string, { amount: number; newAvail: number | null; userName: string }>
  >({});
  const [rulesVersion, setRulesVersion] = useState(0);
  const [storedUserRules, setStoredUserRules] = useState<StoredUserRule[]>(() => readStoredUserRules());
  // Mobile-only collapsibles: keep filters & stats hidden by default on small screens
  // so the actual email list lands above the fold. On sm+ they're always expanded.
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  // Mobile-only collapse for the status / debit / sort chip groups. Keeps the
  // email list within reach on a phone instead of six wrapped chip rows.
  const [mobileStatsOpen, setMobileStatsOpen] = useState(false);
  // Selected zoom window on the In-vs-Out daily chart (Brush start/end indices).
  // null = full range. Drives the summary card above the chart.
  const [chartBrush, setChartBrush] = useState<{ start: number; end: number } | null>(null);
  // User-preferred tooltip placement for the stat-card info bubbles. Persisted
  // in localStorage. 'auto' lets Radix pick/flip via avoidCollisions.
  const [tooltipPlacement, setTooltipPlacement] = useState<'auto' | 'top' | 'bottom' | 'left' | 'right'>(() => {
    if (typeof window === 'undefined') return 'auto';
    const v = localStorage.getItem('gmail_tooltip_placement');
    return v === 'top' || v === 'bottom' || v === 'left' || v === 'right' || v === 'auto' ? v : 'auto';
  });
  useEffect(() => {
    try { localStorage.setItem('gmail_tooltip_placement', tooltipPlacement); } catch { /* ignore */ }
  }, [tooltipPlacement]);
  // Radix needs a concrete side; 'auto' falls back to bottom + collision flipping.
  const statTooltipSide = tooltipPlacement === 'auto' ? 'bottom' : tooltipPlacement;
  // Unparsed-email queue: collapsed by default so it never pushes the main
  // list below the fold, but one click surfaces every skipped Gmail row.
  const [unparsedOpen, setUnparsedOpen] = useState(false);
  const persistUserRules = (next: StoredUserRule[]) => {
    writeStoredUserRules(next);
    refreshUserRules();
    setStoredUserRules(next);
    setRulesVersion((v) => v + 1);
  };
  const deleteUserRule = (id: string) => {
    persistUserRules(storedUserRules.filter((r) => r.id !== id));
    toast({ title: 'Rule removed', description: 'Future emails will no longer use this override.' });
  };

  const load = async () => {
    // Build a server-side query that honors the date range and free-text
    // search box so the Recent emails list can reach the FULL history
    // (not just the most-recent 200). When neither a date range nor a
    // search is active we still default to a generous recent window so
    // the page opens fast.
    const fromTsLoad = fromDate ? zonedWallClockToUtcMs(fromDate, '00:00:00', tz) : null;
    const toTsLoad = toDate ? zonedWallClockToUtcMs(toDate, '23:59:59', tz) : null;
    const tokens = searchQuery.split(/\s+/).map((t) => t.trim()).filter(Boolean);
    const probe = tokens.length
      ? tokens.slice().sort((a, b) => b.length - a.length)[0]
      : null;
    // Phone-shaped probes must be narrowed to their trailing 9 digits before
    // they hit the server. MTN/Airtel bodies print numbers in international
    // form ("256783673998"), so a literal ilike on "0783673998" matches
    // nothing and the operator sees an empty Recent emails list even though
    // the email was captured. Last-9 matching covers 0…, 256…, +256… and
    // bare 7… formats in one probe.
    const probeDigits = probe ? probe.replace(/\D/g, '') : '';
    const phoneShapedProbe =
      probe && probeDigits.length >= 9 && probeDigits.length >= probe.length - 2
        ? probeDigits.slice(-9)
        : null;
    const rawProbe = phoneShapedProbe ?? probe;
    const esc = rawProbe ? rawProbe.replace(/[%_,()]/g, (m) => '\\' + m) : null;

    // Each page must be built from a FRESH query builder — reusing the
    // same builder across awaits can stack modifiers in PostgREST.
    const buildQuery = () => {
      let q: any = (supabase.from('gmail_transactions') as any)
        .select('id,gmail_message_id,from_email,from_name,subject,snippet,amount,transaction_id,parsed,internal_date,direction,channel,counterparty,fee,balance,linked_deposit_request_id,auto_matched_at')
        .order('internal_date', { ascending: false, nullsFirst: false });
      // When the operator has typed a search query, IGNORE the date range
      // entirely so the search reaches the full email history. This makes the
      // search box behave like a global "find any email" tool, independent of
      // whatever date filter happens to be set above.
      const searchActiveLoad = tokens.length > 0;
      if (!searchActiveLoad) {
        if (fromTsLoad) q = q.gte('internal_date', new Date(fromTsLoad).toISOString());
        if (toTsLoad) q = q.lte('internal_date', new Date(toTsLoad).toISOString());
      }
      if (esc) {
        q = q.or(
          [
            `transaction_id.ilike.%${esc}%`,
            `subject.ilike.%${esc}%`,
            `snippet.ilike.%${esc}%`,
            `counterparty.ilike.%${esc}%`,
            `from_email.ilike.%${esc}%`,
            `from_name.ilike.%${esc}%`,
          ].join(',')
        );
      }
      return q;
    };

    // Pagination strategy — Supabase enforces a 1000-row hard cap per
    // request, so to reach the FULL history (well beyond 5000) we walk
    // the result set with `.range()` in pages of 1000 until the table
    // is exhausted. Without a filter we stop at one page (1000) to keep
    // the initial paint fast; with any filter/search we keep paging up
    // to a generous safety ceiling so memory can't run away.
    const hasFilter = !!(fromTsLoad || toTsLoad || tokens.length > 0);
    const PAGE = 1000;
    const MAX_ROWS = hasFilter ? 100_000 : PAGE;

    const psPromise = supabase
      .from('gmail_poll_state')
      .select('last_polled_at,last_status,last_error')
      .eq('id', 1)
      .maybeSingle();

    const all: GmailTx[] = [];
    let offset = 0;
    let readError: { message: string; denied: boolean } | null = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const end = offset + PAGE - 1;
      const { data: page, error } = await buildQuery().range(offset, end);
      if (error) {
        // Distinguish "you cannot read this" from "there is nothing to read".
        const code = (error as any)?.code as string | undefined;
        const msg = error.message || 'Unknown error';
        const denied = code === '42501' || /permission denied|row-level security|not authoriz/i.test(msg);
        readError = { message: msg, denied };
        console.error('[EmailTransactionsPanel] gmail_transactions read failed:', code, msg);
        break;
      }
      if (!page || page.length === 0) break;
      all.push(...(page as unknown as GmailTx[]));
      if (page.length < PAGE) break;          // last page
      if (all.length >= MAX_ROWS) break;       // safety ceiling
      offset += PAGE;
    }
    const { data: ps } = await psPromise;
    setLoadError(readError);
    setRows(all);
    setState((ps as PollState) ?? null);

    const psTyped = ps as PollState | null;
    if (psTyped?.last_status === 'ok' && psTyped.last_polled_at) {
      setLastSuccessAt(psTyped.last_polled_at);
      try { localStorage.setItem('gmail_last_success_at', psTyped.last_polled_at); } catch {}
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    const ch = supabase
      .channel('gmail_transactions_feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'gmail_transactions' }, (payload) => {
        setRows((cur) => [payload.new as GmailTx, ...cur].slice(0, 5000));
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  // Re-run the server-side load whenever the date range or search query
  // changes so the Recent emails list can reach the FULL history (not
  // just the latest 200 rows). Debounced for the search box so each
  // keystroke doesn't fire a query.
  useEffect(() => {
    const handle = setTimeout(() => { load(); }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromDate, toDate, searchQuery, tz]);

  // Background load of routing history for the currently visible rows.
  // Also subscribes to inserts so a fresh re-route shows up instantly
  // without requiring a refresh.
  useEffect(() => {
    if (!rows.length) { setRoutingHistory({}); return; }
    let cancelled = false;
    const rowIds = rows.map((r) => r.id);
    const msgIds = rows.map((r) => r.gmail_message_id).filter(Boolean) as string[];
    (async () => {
      const { data, error } = await (supabase.from('email_routing_history') as any)
        .select('id,created_at,route,reason,target_user_id,target_user_name,target_user_phone,routed_by_name,amount,sms_sent,gmail_transaction_id,gmail_message_id')
        .or(
          msgIds.length
            ? `gmail_transaction_id.in.(${rowIds.join(',')}),gmail_message_id.in.(${msgIds.join(',')})`
            : `gmail_transaction_id.in.(${rowIds.join(',')})`
        )
        .order('created_at', { ascending: false })
        .limit(500);
      if (cancelled || error) return;
      const byMsg = new Map<string, string>(); // gmail_message_id → row.id
      for (const r of rows) if (r.gmail_message_id) byMsg.set(r.gmail_message_id, r.id);
      const next: Record<string, RoutingHistoryEntry[]> = {};
      for (const h of (data ?? []) as Array<RoutingHistoryEntry & { gmail_transaction_id: string | null; gmail_message_id: string | null }>) {
        const rid = h.gmail_transaction_id || (h.gmail_message_id ? byMsg.get(h.gmail_message_id) : null);
        if (!rid) continue;
        (next[rid] = next[rid] || []).push(h);
      }
      setRoutingHistory(next);
    })();
    const sub = supabase
      .channel('email_routing_history_feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'email_routing_history' }, (payload) => {
        const h = payload.new as RoutingHistoryEntry & { gmail_transaction_id: string | null; gmail_message_id: string | null };
        const rid = h.gmail_transaction_id || rows.find((r) => r.gmail_message_id === h.gmail_message_id)?.id;
        if (!rid) return;
        setRoutingHistory((cur) => ({ ...cur, [rid]: [h, ...(cur[rid] ?? [])] }));
      })
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(sub); };
  }, [rows]);

  // Background load of invite/login SMS delivery status for the currently
  // visible incoming rows. The poller logs each depositor invite to
  // sms_delivery_log (source='momo_deposit_invite') with reference_id set to
  // the email's transaction reference and recipient_phone in international
  // format. We match back to a row by (1) transaction reference, then
  // (2) sender phone last-9. Realtime inserts keep the badge fresh.
  useEffect(() => {
    const incoming = rows.filter((r) => r.direction === 'in');
    if (!incoming.length) { setInviteSms({}); return; }
    let cancelled = false;
    const last9 = (s: string | null | undefined): string | null => {
      const d = (s ?? '').replace(/[^0-9]/g, '');
      return d.length >= 9 ? d.slice(-9) : null;
    };
    const applyLogs = (
      logs: Array<{ status: string; created_at: string; recipient_phone: string; message: string | null; error: string | null; reference_id: string | null }>,
    ) => {
      const byTid = new Map<string, GmailTx>();
      const byPhone = new Map<string, GmailTx>();
      for (const r of incoming) {
        if (r.transaction_id) byTid.set(r.transaction_id, r);
        const p = last9(r.counterparty);
        if (p && !byPhone.has(p)) byPhone.set(p, r);
      }
      const next: Record<string, InviteSms> = {};
      for (const log of logs) {
        let row: GmailTx | undefined;
        if (log.reference_id && byTid.has(log.reference_id)) row = byTid.get(log.reference_id);
        if (!row) {
          const p = last9(log.recipient_phone);
          if (p && byPhone.has(p)) row = byPhone.get(p);
        }
        if (!row) continue;
        // Keep only the most recent attempt per row (logs are newest-first).
        if (!next[row.id]) {
          next[row.id] = {
            status: log.status,
            created_at: log.created_at,
            phone: log.recipient_phone,
            message: log.message,
            error: log.error,
          };
        }
      }
      return next;
    };
    (async () => {
      const { data, error } = await (supabase.from('sms_delivery_log') as any)
        .select('status,created_at,recipient_phone,message,error,reference_id')
        .eq('source', 'momo_deposit_invite')
        .order('created_at', { ascending: false })
        .limit(500);
      if (cancelled || error) return;
      setInviteSms(applyLogs((data ?? []) as any));
    })();
    const sub = supabase
      .channel('momo_deposit_invite_sms_feed')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'sms_delivery_log', filter: 'source=eq.momo_deposit_invite' },
        (payload) => {
          const log = payload.new as any;
          setInviteSms((cur) => ({ ...cur, ...applyLogs([log]) }));
        },
      )
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(sub); };
  }, [rows]);

  // Persist a one-time, regulator-safe audit entry whenever an email is
  // detected as already credited purely via its transaction reference (TID).
  // Idempotent: skips any (gmail_transaction, deposit) pair already logged so
  // the recurring credited-detection effect doesn't spam duplicate rows.
  const recordTidAutoCreditAudit = async (
    pairs: Array<{
      gmail_transaction_id: string;
      deposit_request_id: string;
      amount: number;
      tid: string | null;
      user_name: string;
      status: string;
    }>,
  ): Promise<void> => {
    if (!pairs.length) return;
    try {
      const gtxIds = Array.from(new Set(pairs.map((p) => p.gmail_transaction_id)));
      const { data: existing } = await (supabase.from('email_match_audit_log') as any)
        .select('gmail_transaction_id, deposit_request_id')
        .eq('action', 'tid_auto_credited')
        .in('gmail_transaction_id', gtxIds);
      const seen = new Set<string>(
        ((existing ?? []) as Array<{ gmail_transaction_id: string | null; deposit_request_id: string | null }>)
          .map((e) => `${e.gmail_transaction_id}|${e.deposit_request_id}`),
      );
      const fresh = pairs.filter((p) => !seen.has(`${p.gmail_transaction_id}|${p.deposit_request_id}`));
      if (!fresh.length) return;
      const { data: auth } = await supabase.auth.getUser();
      const actorId = auth?.user?.id ?? null;
      const actorEmail = auth?.user?.email ?? null;
      const insertRows = fresh.map((p) => ({
        gmail_transaction_id: p.gmail_transaction_id,
        deposit_request_id: p.deposit_request_id,
        action: 'tid_auto_credited',
        matcher_type: 'tid',
        match_score: 100,
        amount: p.amount,
        actor_id: actorId,
        actor_email: actorEmail,
        notes: 'Already Credited — No Routing Needed (matched by transaction reference / TID).',
        signals: {
          normalized_tid: p.tid,
          recipient: p.user_name,
          deposit_status: p.status,
          detection: 'tid_reference_match',
        },
      }));
      await (supabase.from('email_match_audit_log') as any).insert(insertRows);
    } catch {
      // Best-effort audit; never block the UI on a logging failure.
    }
  };

  // Background load of "already-credited" deposit links for visible incoming
  // rows. Uses the same two-step resolution the RouteEmailDepositDialog
  // uses: (1) gmail_transactions.linked_deposit_request_id fast path,
  // (2) deposit_requests.auto_match_audit->>gmail_message_id fallback.
  // Terminal statuses (rejected/cancelled/failed/reversed) are treated as
  // "not credited" so reversed auto-credits can be re-routed without the
  // double-credit warning.
  useEffect(() => {
    if (!rows.length) { setCreditedDeposits({}); return; }
    const incoming = rows.filter((r) => r.direction === 'in');
    if (!incoming.length) { setCreditedDeposits({}); return; }
    let cancelled = false;
    const rowIds = incoming.map((r) => r.id);
    const msgIds = incoming.map((r) => r.gmail_message_id).filter(Boolean) as string[];
    (async () => {
      try {
        // 1) Fast path via gmail_transactions.linked_deposit_request_id
        const { data: gmailLinks } = await (supabase.from('gmail_transactions') as any)
          .select('id, linked_deposit_request_id')
          .in('id', rowIds);
        const linkByRow = new Map<string, string[]>();
        const depIds = new Set<string>();
        for (const g of (gmailLinks ?? []) as Array<{ id: string; linked_deposit_request_id: string | null }>) {
          if (g.linked_deposit_request_id) {
            const arr = linkByRow.get(g.id) ?? [];
            arr.push(g.linked_deposit_request_id);
            linkByRow.set(g.id, arr);
            depIds.add(g.linked_deposit_request_id);
          }
        }
        // 2) Fallback via deposit_requests.auto_match_audit->>gmail_message_id
        const linkByMsg = new Map<string, string[]>();
        if (msgIds.length) {
          const { data: audits } = await (supabase.from('deposit_requests') as any)
            .select('id, status, auto_match_audit')
            .in('auto_match_audit->>gmail_message_id', msgIds);
          for (const a of (audits ?? []) as Array<{ id: string; status: string; auto_match_audit: any }>) {
            const mid = a?.auto_match_audit?.gmail_message_id as string | undefined;
            if (!mid) continue;
            if (['rejected', 'cancelled', 'failed', 'reversed'].includes(a.status)) continue;
            const arr = linkByMsg.get(mid) ?? [];
            if (!arr.includes(a.id)) {
              arr.push(a.id);
              linkByMsg.set(mid, arr);
              depIds.add(a.id);
            }
          }
        }
        // 3) Reference (TID) fallback. Cash deposits verified via finance are
        //    auto-approved and credited to the wallet, but the matching
        //    deposit_request often never gets stamped with the gmail link or
        //    auto_match_audit. Match the email's normalized transaction
        //    reference against deposit_requests.transaction_id so these
        //    already-landed deposits still surface as "credited — do not
        //    route again".
        const linkByTid = new Map<string, string[]>(); // normalized TID -> deposit ids
        const tidByRow = new Map<string, string>();     // row id -> normalized TID
        const rawTids = new Set<string>();
        for (const r of incoming) {
          const raw = (r.transaction_id ?? '').trim();
          if (!raw) continue;
          const norm = normalizeMomoTid(raw);
          if (norm.length < 6) continue; // avoid spurious short-tail collisions
          tidByRow.set(r.id, norm);
          rawTids.add(raw);
          rawTids.add(norm);
        }
        if (rawTids.size) {
          const { data: tidDeps } = await (supabase.from('deposit_requests') as any)
            .select('id, status, transaction_id')
            .in('transaction_id', Array.from(rawTids));
          for (const d of (tidDeps ?? []) as Array<{ id: string; status: string; transaction_id: string | null }>) {
            if (!d.transaction_id) continue;
            if (['rejected', 'cancelled', 'failed', 'reversed'].includes(d.status)) continue;
            const norm = normalizeMomoTid(d.transaction_id);
            if (norm.length < 6) continue;
            const arr = linkByTid.get(norm) ?? [];
            if (!arr.includes(d.id)) {
              arr.push(d.id);
              linkByTid.set(norm, arr);
              depIds.add(d.id);
            }
          }
        }
        // 3b) Cash-deposit RECEIPT-CODE fallback. "Cash deposit code 8829 —
        //     UGX 9,999 from …" emails credit the wallet the instant the agent
        //     reads the code back, but the email itself never carries a MoMo
        //     TID. The short receipt code IS the deposit_request.transaction_id,
        //     so match it EXACTLY (no normalization / length guard) — these
        //     codes are issued per-deposit and never collide.
        const linkByReceipt = new Map<string, string[]>(); // receipt code -> deposit ids
        const receiptByRow = new Map<string, string>();     // row id -> receipt code
        const receiptCodes = new Set<string>();
        for (const r of incoming) {
          const code = extractCashReceiptCode(r);
          if (!code) continue;
          receiptByRow.set(r.id, code);
          receiptCodes.add(code);
        }
        if (receiptCodes.size) {
          const { data: rcDeps } = await (supabase.from('deposit_requests') as any)
            .select('id, status, transaction_id')
            .in('transaction_id', Array.from(receiptCodes));
          for (const d of (rcDeps ?? []) as Array<{ id: string; status: string; transaction_id: string | null }>) {
            if (!d.transaction_id) continue;
            if (['rejected', 'cancelled', 'failed', 'reversed'].includes(d.status)) continue;
            const code = d.transaction_id.trim();
            const arr = linkByReceipt.get(code) ?? [];
            if (!arr.includes(d.id)) {
              arr.push(d.id);
              linkByReceipt.set(code, arr);
              depIds.add(d.id);
            }
          }
        }
        if (!depIds.size) { if (!cancelled) setCreditedDeposits({}); return; }
        const { data: deps } = await (supabase.from('deposit_requests') as any)
          .select('id, user_id, amount, status, auto_approved, deposit_purpose, created_at, updated_at, auto_match_audit')
          .in('id', Array.from(depIds));
        const depById = new Map<string, any>();
        const userIds = new Set<string>();
        for (const d of (deps ?? []) as Array<any>) {
          depById.set(d.id, d);
          if (d.user_id) userIds.add(d.user_id);
        }
        let profById = new Map<string, any>();
        if (userIds.size) {
          const { data: profs } = await (supabase.from('profiles') as any)
            .select('id, full_name, phone')
            .in('id', Array.from(userIds));
          profById = new Map(((profs ?? []) as Array<any>).map((p) => [p.id, p]));
        }
        const next: Record<string, CreditedDeposit[]> = {};
        for (const r of incoming) {
          const ids = new Set<string>();
          (linkByRow.get(r.id) ?? []).forEach((id) => ids.add(id));
          if (r.gmail_message_id) (linkByMsg.get(r.gmail_message_id) ?? []).forEach((id) => ids.add(id));
          const normTid = tidByRow.get(r.id);
          const tidDepIds = new Set<string>();
          if (normTid) (linkByTid.get(normTid) ?? []).forEach((id) => { ids.add(id); tidDepIds.add(id); });
          // Cash receipt-code matches are treated like TID matches for the
          // "Already Credited — No Routing Needed" status.
          const receiptCode = receiptByRow.get(r.id);
          if (receiptCode) (linkByReceipt.get(receiptCode) ?? []).forEach((id) => { ids.add(id); tidDepIds.add(id); });
          // Deposits matched ONLY by reference (not by explicit gmail link /
          // auto_match_audit) are flagged so the row can show the clear
          // "Already Credited — No Routing Needed" status.
          const explicitDepIds = new Set<string>([
            ...(linkByRow.get(r.id) ?? []),
            ...(r.gmail_message_id ? (linkByMsg.get(r.gmail_message_id) ?? []) : []),
          ]);
          if (!ids.size) continue;
          const list: CreditedDeposit[] = [];
          for (const depId of ids) {
            const d = depById.get(depId);
            if (!d) continue;
            if (['rejected', 'cancelled', 'failed', 'reversed'].includes(d.status)) continue;
            const p = profById.get(d.user_id);
            const audit = (d.auto_match_audit ?? {}) as {
              match_method?: string | null;
              phone_source?: string | null;
              confidence?: string | null;
              confidence_score?: number | null;
            };
            list.push({
              deposit_id: d.id,
              user_id: d.user_id,
              user_name: (p?.full_name as string) ?? 'Unknown user',
              user_phone: (p?.phone as string) ?? '',
              amount: Number(d.amount) || 0,
              status: d.status,
              auto_approved: d.auto_approved ?? null,
              deposit_purpose: d.deposit_purpose ?? null,
              credited_at: (d.updated_at as string) ?? (d.created_at as string) ?? null,
              matched_by_tid: tidDepIds.has(depId) && !explicitDepIds.has(depId),
              matched_tid: tidDepIds.has(depId) ? (normTid ?? receiptCode ?? null) : null,
              auto_match_method: audit.match_method ?? null,
              auto_phone_source: (audit.phone_source as 'counterparty' | 'body' | null) ?? null,
              auto_confidence: (audit.confidence as 'high' | 'medium' | 'low' | null) ?? null,
              auto_confidence_score: typeof audit.confidence_score === 'number' ? audit.confidence_score : null,
            });
          }
          if (list.length) next[r.id] = list;
        }
        if (!cancelled) setCreditedDeposits(next);
        // Audit every TID-only "Already Credited — No Routing Needed" match
        // (idempotent; recordTidAutoCreditAudit skips already-logged pairs).
        const tidPairs = Object.entries(next).flatMap(([rowId, list]) =>
          list
            .filter((c) => c.matched_by_tid)
            .map((c) => ({
              gmail_transaction_id: rowId,
              deposit_request_id: c.deposit_id,
              amount: c.amount,
              tid: c.matched_tid ?? null,
              user_name: c.user_name,
              status: c.status,
            })),
        );
        if (tidPairs.length) void recordTidAutoCreditAudit(tidPairs);
      } catch {
        if (!cancelled) setCreditedDeposits({});
      }
    })();
    return () => { cancelled = true; };
  }, [rows]);

  // Ledger-reference credits: match every visible incoming email's reference
  // (MoMo TID / Airtel TID / cash receipt code) against wallet credits already
  // posted in general_ledger. Batched so the reference array stays small.
  useEffect(() => {
    const incoming = rows.filter((r) => r.direction === 'in');
    if (!incoming.length) { setLedgerCredits({}); return; }
    let cancelled = false;
    const refByRow = new Map<string, string>();
    for (const r of incoming) {
      const raw = (r.transaction_id ?? '').trim() || extractCashReceiptCode(r) || '';
      if (raw.replace(/\D/g, '').length < 6) continue;
      refByRow.set(r.id, raw);
    }
    if (!refByRow.size) { setLedgerCredits({}); return; }
    (async () => {
      const refs = Array.from(new Set(refByRow.values()));
      const byRef = new Map<string, LedgerCredit[]>();
      try {
        // Small batches keep each trigram lookup well inside the statement
        // timeout even on a large ledger.
        for (let i = 0; i < refs.length; i += 40) {
          const batch = refs.slice(i, i + 40);
          const { data, error } = await (supabase.rpc as any)('match_email_ledger_credits', { p_refs: batch });
          if (error) throw error;
          for (const m of (data ?? []) as Array<any>) {
            const arr = byRef.get(m.ref) ?? [];
            arr.push({
              ledger_id: m.ledger_id,
              amount: Number(m.amount) || 0,
              category: m.category ?? null,
              user_id: m.user_id ?? null,
              user_name: m.user_name ?? null,
              user_phone: m.user_phone ?? null,
              created_at: m.created_at ?? null,
            });
            byRef.set(m.ref, arr);
          }
        }
        const next: Record<string, LedgerCredit[]> = {};
        for (const [rowId, ref] of refByRow) {
          const hits = byRef.get(ref);
          if (hits?.length) next[rowId] = hits;
        }
        if (!cancelled) setLedgerCredits(next);
      } catch {
        if (!cancelled) setLedgerCredits({});
      }
    })();
    return () => { cancelled = true; };
  }, [rows]);

  // Load the LATEST manual credit-mark per visible gmail transaction so the
  // list can honor operator overrides immediately. Re-runs whenever the row
  // set changes (e.g. after bulk actions or new polls).
  useEffect(() => {
    if (!rows.length) { setManualMarks({}); return; }
    let cancelled = false;
    const rowIds = rows.map((r) => r.id);
    (async () => {
      try {
        // Pull ALL marks for visible ids (newest first), then keep the first
        // (latest) per gmail_transaction_id. Cheap enough at typical page sizes.
        const { data: marks } = await (supabase.from('email_credit_manual_marks') as any)
          .select('gmail_transaction_id, mark, reason, marked_by, created_at')
          .in('gmail_transaction_id', rowIds)
          .order('created_at', { ascending: false });
        const arr = (marks ?? []) as Array<{ gmail_transaction_id: string; mark: 'credited'|'uncredited'; reason: string | null; marked_by: string; created_at: string }>;
        const operatorIds = Array.from(new Set(arr.map((m) => m.marked_by)));
        let nameById = new Map<string, string>();
        if (operatorIds.length) {
          const { data: profs } = await (supabase.from('profiles') as any)
            .select('id, full_name')
            .in('id', operatorIds);
          nameById = new Map(((profs ?? []) as Array<{ id: string; full_name: string | null }>).map((p) => [p.id, p.full_name ?? '']));
        }
        const next: Record<string, ManualMark> = {};
        for (const m of arr) {
          if (next[m.gmail_transaction_id]) continue; // keep newest only
          next[m.gmail_transaction_id] = {
            mark: m.mark,
            marked_by: m.marked_by,
            marked_by_name: nameById.get(m.marked_by) ?? null,
            reason: m.reason,
            created_at: m.created_at,
          };
        }
        if (!cancelled) setManualMarks(next);
      } catch {
        if (!cancelled) setManualMarks({});
      }
    })();
    return () => { cancelled = true; };
  }, [rows]);

  /**
   * Bulk mark every currently-selected email as credited or uncredited.
   * Inserts one append-only row per selection into
   * `email_credit_manual_marks` (operator = auth.uid, server-stamped
   * timestamp). RLS restricts inserts to Financial Ops roles. After the
   * batch lands we refresh the marks map and clear the selection.
   */
  const applyBulkMark = async (
    mark: 'credited' | 'uncredited',
    idsOverride?: string[],
    presetReason?: string,
  ) => {
    const ids = idsOverride ?? Array.from(selectedIds);
    if (!ids.length) return;
    const reason =
      presetReason !== undefined
        ? presetReason
        : window.prompt(
            `Reason for marking ${ids.length} email(s) as ${mark} (logged in audit trail, optional):`,
            ''
          );
    // null = cancelled, '' = proceed without reason
    if (reason === null) return;
    setBulkBusy(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) throw new Error('Not signed in');
      const byId = new Map(rows.map((r) => [r.id, r]));
      const payload = ids.map((id) => {
        const r = byId.get(id);
        return {
          gmail_transaction_id: id,
          gmail_message_id: r?.gmail_message_id ?? null,
          email_tid: r?.transaction_id ?? null,
          mark,
          reason: reason.trim() || null,
          marked_by: uid,
        };
      });
      const { error } = await (supabase.from('email_credit_manual_marks') as any).insert(payload);
      if (error) throw new Error(error.message);
      toast({
        title: `Marked ${ids.length} email(s) as ${mark}`,
        description: 'Audit trail updated. The list will refresh.',
      });
      // Refresh marks for these rows
      const { data: fresh } = await (supabase.from('email_credit_manual_marks') as any)
        .select('gmail_transaction_id, mark, reason, marked_by, created_at')
        .in('gmail_transaction_id', ids)
        .order('created_at', { ascending: false });
      const arr = (fresh ?? []) as Array<any>;
      setManualMarks((prev) => {
        const next = { ...prev };
        for (const m of arr) {
          if (next[m.gmail_transaction_id] && next[m.gmail_transaction_id].created_at >= m.created_at) continue;
          next[m.gmail_transaction_id] = {
            mark: m.mark,
            marked_by: m.marked_by,
            marked_by_name: prev[m.gmail_transaction_id]?.marked_by_name ?? null,
            reason: m.reason,
            created_at: m.created_at,
          };
        }
        return next;
      });
      setSelectedIds(new Set());
    } catch (e: any) {
      toast({
        title: 'Bulk mark failed',
        description: e?.message || String(e),
        variant: 'destructive',
      });
    } finally {
      setBulkBusy(false);
    }
  };

  /**
   * Single-row equivalent of `applyBulkMark` — used by the mobile right-swipe
   * "Mark resolved" gesture. Appends one immutable row to
   * `email_credit_manual_marks` and updates the local marks map so the row's
   * status pill flips immediately.
   */
  const markRowResolved = async (r: GmailTx, mark: 'credited' | 'uncredited' = 'credited') => {
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) throw new Error('Not signed in');
      const prevMark = manualMarks[r.id] ?? null;
      const { data: inserted, error } = await (supabase.from('email_credit_manual_marks') as any).insert({
        gmail_transaction_id: r.id,
        gmail_message_id: r.gmail_message_id ?? null,
        email_tid: r.transaction_id ?? null,
        mark,
        reason: 'Marked resolved from mobile swipe',
        marked_by: uid,
      }).select('id').maybeSingle();
      if (error) throw new Error(error.message);
      setManualMarks((prev) => ({
        ...prev,
        [r.id]: {
          mark,
          marked_by: uid,
          marked_by_name: prev[r.id]?.marked_by_name ?? null,
          reason: 'Marked resolved from mobile swipe',
          created_at: new Date().toISOString(),
        },
      }));
      // Undo snackbar: swipes are easy to trigger by accident on mobile, so the
      // mark stays reversible for a few seconds (deletes the audit row again).
      sonnerToast(mark === 'credited' ? 'Marked as resolved' : 'Marked as not paid in', {
        description: 'Swiped by mistake? Undo within a few seconds.',
        duration: 8000,
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              if (inserted?.id) {
                const { error: delErr } = await (supabase.from('email_credit_manual_marks') as any)
                  .delete()
                  .eq('id', inserted.id);
                if (delErr) throw new Error(delErr.message);
              }
              setManualMarks((prev) => {
                const next = { ...prev };
                if (prevMark) next[r.id] = prevMark;
                else delete next[r.id];
                return next;
              });
              sonnerToast.success('Mark reverted');
            } catch (e: any) {
              sonnerToast.error('Could not undo', { description: e?.message || String(e) });
            }
          },
        },
      });
    } catch (e: any) {
      toast({ title: 'Mark failed', description: e?.message || String(e), variant: 'destructive' });
    }
  };

  // Background fetch of strict ledger-derived withdrawable balances for
  // every possible-user candidate AND every routed target currently shown.
  // Uses the operator-safe `get_user_wallet_view` RPC so the figure matches
  // what the user themselves would see in their wallet. Re-runs whenever
  // the set of relevant user ids changes (e.g. after a re-route or a new
  // possible-user resolution).
  useEffect(() => {
    const ids = new Set<string>();
    for (const list of Object.values(userMatches)) {
      for (const u of list) ids.add(u.id);
    }
    for (const list of Object.values(routingHistory)) {
      for (const h of list) if (h.target_user_id) ids.add(h.target_user_id);
    }
    // Also fetch wallet positions for any resolved managed proxy agents so the
    // possible-recipient list and breakdown can show the proxy wallet balance.
    for (const p of Object.values(userProxies)) if (p.agentId) ids.add(p.agentId);
    const missing = Array.from(ids).filter((id) => userBalances[id] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        missing.map(async (id) => {
          try {
            const [viewRes, txRes] = await Promise.all([
              supabase.rpc('get_user_wallet_view', { p_user_id: id }),
              supabase
                .from('general_ledger')
                .select('id, amount, direction, category, description, created_at')
                .eq('user_id', id)
                .eq('ledger_scope', 'wallet')
                .neq('classification', 'admin_correction')
                .neq('category', 'system_balance_correction')
                .order('created_at', { ascending: false })
                .limit(3),
            ]);
            if (viewRes.error) return [id, null as number | null, [] as RecentTx[]] as const;
            const r = (viewRes.data ?? {}) as Record<string, unknown>;
            const withdrawable = Number((r.withdrawable as number | string | undefined) ?? 0);
            const floatBal = Number((r.float_balance as number | string | undefined) ?? 0);
            const tx = (txRes.data ?? []) as RecentTx[];
            return [id, (withdrawable + floatBal) as number | null, tx] as const;
          } catch {
            return [id, null as number | null, [] as RecentTx[]] as const;
          }
        }),
      );
      if (cancelled) return;
      setUserBalances((cur) => {
        const next = { ...cur };
        for (const [id, bal] of results) {
          if (bal !== null) next[id] = bal;
        }
        return next;
      });
      setUserRecentTx((cur) => {
        const next = { ...cur };
        for (const [id, , tx] of results) {
          if (tx && tx.length) next[id] = tx;
        }
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [userMatches, routingHistory, userBalances, userProxies]);

  // Resolve the managed proxy agent (if any) for every possible-user candidate.
  // Mirrors the server-side `resolveManagedProxy`: an active, approved,
  // is_managed_account assignment where the candidate is the beneficiary.
  useEffect(() => {
    const ids = new Set<string>();
    for (const list of Object.values(userMatches)) {
      for (const u of list) ids.add(u.id);
    }
    const missing = Array.from(ids).filter((id) => userProxies[id] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data: assigns, error } = await (supabase.from('proxy_agent_assignments') as any)
        .select('beneficiary_id, agent_id')
        .in('beneficiary_id', missing)
        .eq('is_active', true)
        .eq('is_managed_account', true)
        .eq('approval_status', 'approved');
      if (cancelled || error || !assigns?.length) return;
      const agentIds = Array.from(new Set(assigns.map((a: any) => a.agent_id).filter(Boolean)));
      const nameById: Record<string, string | null> = {};
      if (agentIds.length) {
        const { data: profs } = await (supabase.from('profiles') as any)
          .select('id, full_name')
          .in('id', agentIds);
        for (const p of (profs ?? []) as Array<{ id: string; full_name: string | null }>) {
          nameById[p.id] = p.full_name ?? null;
        }
      }
      if (cancelled) return;
      setUserProxies((cur) => {
        const next = { ...cur };
        for (const a of assigns as Array<{ beneficiary_id: string; agent_id: string }>) {
          if (a.beneficiary_id && a.agent_id && next[a.beneficiary_id] === undefined) {
            next[a.beneficiary_id] = { agentId: a.agent_id, agentName: nameById[a.agent_id] ?? null };
          }
        }
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [userMatches, userProxies]);

  // Reverse a single routing-history entry. Posts the opposite leg through
  // `cfo-direct-credit` against the same target user/bucket, then writes a
  // new history row tagged "Reversed" so the UI marks the entry reversed.
  const reverseRoutingEntry = async (rowForEntry: GmailTx, entry: RoutingHistoryEntry) => {
    const isDebitEntry = entry.route.endsWith('_debit');
    const opposite: 'credit' | 'debit' = isDebitEntry ? 'credit' : 'debit';
    const isFloat =
      entry.route === 'operational_float' || entry.route === 'landlord_float_debit';
    const isProxyAgentRoute = entry.route === 'proxy_agent_wallet_debit';
    const opLabel = opposite === 'credit' ? 'Credit back' : 'Debit back';
    if (typeof window !== 'undefined') {
      const ok = window.confirm(
        `${opLabel} UGX ${Math.round(entry.amount).toLocaleString()} ` +
        `${opposite === 'credit' ? 'to' : 'from'} ${entry.target_user_name || 'this user'}?\n\n` +
        `This will post an offsetting ledger leg through CFO Direct ${opposite === 'credit' ? 'Credit' : 'Debit'} ` +
        `and mark the original routing entry as reversed.`,
      );
      if (!ok) return;
    }
    setReverseBusy((cur) => ({ ...cur, [entry.id]: true }));
    try {
      const body = {
        target_user_id: entry.target_user_id,
        amount: Number(entry.amount),
        reason:
          `Reversed routing entry ${entry.id.slice(0, 8)}… ` +
          `(${entry.route}) — Financial Ops correction.`,
        operation: opposite,
        wallet_category: isFloat ? 'agent_float_deposit' : 'wallet_transfer',
        platform_category: isFloat ? 'agent_float_deposit' : 'wallet_transfer',
        financial_impact: 'neutral' as const,
        category_label: `Reverse ${entry.route.replace(/_/g, ' ')}`,
        recipient_type: isFloat ? 'operational_wallet' : 'user',
        sub_category: rowForEntry.transaction_id ?? null,
      };
      const { data, error } = await supabase.functions.invoke('cfo-direct-credit', { body });
      if (error) throw new Error((error as any)?.message || 'Reversal failed');
      if ((data as any)?.error) throw new Error((data as any).error);
      const referenceId = (data as any)?.reference_id ?? null;

      // Best-effort history insert so the UI shows the reversal immediately.
      try {
        const { data: me } = await supabase.auth.getUser();
        if (me?.user?.id) {
          let routedByName: string | null = null;
          try {
            const { data: rp } = await (supabase.from('profiles') as any)
              .select('full_name').eq('id', me.user.id).maybeSingle();
            routedByName = rp?.full_name ?? null;
          } catch { /* ignore */ }
          await (supabase.from('email_routing_history') as any).insert({
            gmail_transaction_id: rowForEntry.id,
            gmail_message_id: rowForEntry.gmail_message_id ?? null,
            transaction_id: rowForEntry.transaction_id,
            from_email: rowForEntry.from_email,
            from_name: rowForEntry.from_name,
            subject: rowForEntry.subject,
            amount: Number(entry.amount),
            route: entry.route,
            target_user_id: entry.target_user_id,
            target_user_name: entry.target_user_name,
            target_user_phone: entry.target_user_phone,
            reason: `Reversed ${isDebitEntry ? 'debit' : 'credit'} (was ${entry.route}): manual reversal by Financial Ops.`,
            ledger_reference_id: referenceId,
            routed_by: me.user.id,
            routed_by_name: routedByName,
            sms_sent: false,
            sms_error: null,
          });
        }
      } catch (e) { console.warn('[EmailTransactionsPanel] reversal history insert failed', e); }

      // Invalidate the cached balance for this user so the next render
      // re-fetches the post-reversal position.
      setUserBalances((cur) => {
        const next = { ...cur };
        delete next[entry.target_user_id];
        return next;
      });
      setUserRecentTx((cur) => {
        const next = { ...cur };
        delete next[entry.target_user_id];
        return next;
      });
      toast({
        title: 'Routing reversed',
        description: `${opLabel} UGX ${Math.round(entry.amount).toLocaleString()} ${opposite === 'credit' ? 'to' : 'from'} ${entry.target_user_name || 'user'}.`,
      });
    } catch (e: any) {
      const raw = e?.message || String(e);
      let title = 'Reverse failed';
      let description = raw;
      if (/NEGATIVE_WALLET_BLOCKED/i.test(raw)) {
        const m = raw.match(/cannot debit\s+(\d+).*strict available balance is\s+(\d+)/i);
        const amt = m?.[1] ? `UGX ${Number(m[1]).toLocaleString()}` : 'the requested amount';
        const bal = m?.[2] ? `UGX ${Number(m[2]).toLocaleString()}` : '0';
        title = 'Cannot reverse — insufficient funds';
        description = `This user’s strict available balance is ${bal}, but the reversal requires ${amt}. The money may have already been swept to another wallet (e.g., via system balance correction). To reverse the original deposit, debit the wallet that currently holds the funds instead.`;
      }
      toast({ title, description, variant: 'destructive' });
    } finally {
      setReverseBusy((cur) => {
        const { [entry.id]: _, ...rest } = cur;
        return rest;
      });
    }
  };

  // ── Auto-payout matcher ─────────────────────────────────────────────
  // For every visible outgoing email (MoMo payout / bank disbursement),
  // look up open `withdrawal_requests` rows that this email plausibly
  // settles. Strongest signal is a normalized-TID hit; phone+amount is
  // a fallback when the cashier didn't include the exact reference yet.
  useEffect(() => {
    const outRows = rows.filter(
      (r) => (r.direction === 'out' || r.direction === 'charge') && r.amount && r.amount > 0,
    );
    if (outRows.length === 0) { setWithdrawalMatches({}); return; }

    let cancelled = false;
    (async () => {
      // Collect normalized TIDs + (phone, amount) pairs from outgoing rows.
      const normTids = new Set<string>();
      const phones = new Set<string>();
      for (const r of outRows) {
        const n = normalizeMomoTid(r.transaction_id);
        if (n.length >= 6) normTids.add(n);
        for (const p of extractPhones(r)) phones.add(p);
      }

      // Pull all open withdrawals once and match in-memory — production
      // queue depth is small enough that this is cheaper than building
      // per-TID OR clauses.
      const openStatuses = ['pending', 'requested', 'manager_approved', 'rejected'];
      const { data, error } = await (supabase.from('withdrawal_requests') as any)
        .select(
          'id,user_id,amount,status,mobile_money_number,mobile_money_provider,bank_name,bank_account_number,payout_method,transaction_id,fin_ops_reference',
        )
        .in('status', openStatuses)
        .order('created_at', { ascending: false })
        .limit(500);
      if (cancelled || error || !data) return;

      type WR = {
        id: string;
        user_id: string;
        amount: number;
        status: string;
        mobile_money_number: string | null;
        mobile_money_provider: string | null;
        bank_name: string | null;
        bank_account_number: string | null;
        payout_method: string;
        transaction_id: string | null;
        fin_ops_reference: string | null;
      };
      const wrs = data as WR[];

      // Index for fast lookup.
      const byTid = new Map<string, WR[]>();
      for (const w of wrs) {
        for (const t of [w.transaction_id, w.fin_ops_reference]) {
          const n = normalizeMomoTid(t);
          if (n.length >= 6) {
            const list = byTid.get(n) ?? [];
            list.push(w);
            byTid.set(n, list);
          }
        }
      }
      const byPhone = new Map<string, WR[]>();
      for (const w of wrs) {
        const n = normalizeUgPhone(w.mobile_money_number ?? '');
        if (!n) continue;
        const list = byPhone.get(n) ?? [];
        list.push(w);
        byPhone.set(n, list);
      }

      // Resolve user names in one round-trip.
      const userIds = Array.from(new Set(wrs.map((w) => w.user_id)));
      let names: Record<string, string> = {};
      if (userIds.length) {
        const { data: profs } = await (supabase.from('profiles') as any)
          .select('id, full_name')
          .in('id', userIds);
        for (const p of (profs ?? []) as Array<{ id: string; full_name: string | null }>) {
          names[p.id] = p.full_name ?? '';
        }
      }

      const matches: Record<string, WithdrawalMatch[]> = {};
      const seen = new Set<string>(); // wr.id already attached to some row
      for (const r of outRows) {
        const list: WithdrawalMatch[] = [];
        // 1. TID match — authoritative.
        const n = normalizeMomoTid(r.transaction_id);
        if (n.length >= 6) {
          for (const w of byTid.get(n) ?? []) {
            if (seen.has(w.id)) continue;
            list.push({
              id: w.id, user_id: w.user_id, amount: Number(w.amount), status: w.status,
              mobile_money_number: w.mobile_money_number, mobile_money_provider: w.mobile_money_provider,
              bank_name: w.bank_name, bank_account_number: w.bank_account_number,
              payout_method: w.payout_method, matched_on: 'reference',
              user_name: names[w.user_id] ?? null,
            });
          }
        }
        // 2. Fallback: phone + exact amount.
        if (list.length === 0 && r.amount) {
          const targetAmt = Math.round(r.amount);
          for (const ph of extractPhones(r)) {
            for (const w of byPhone.get(ph) ?? []) {
              if (seen.has(w.id)) continue;
              if (Math.round(Number(w.amount)) !== targetAmt) continue;
              list.push({
                id: w.id, user_id: w.user_id, amount: Number(w.amount), status: w.status,
                mobile_money_number: w.mobile_money_number, mobile_money_provider: w.mobile_money_provider,
                bank_name: w.bank_name, bank_account_number: w.bank_account_number,
                payout_method: w.payout_method, matched_on: 'phone+amount',
                user_name: names[w.user_id] ?? null,
              });
            }
          }
        }
        if (list.length === 1) seen.add(list[0].id); // only single-match rows are auto-approvable
        matches[r.id] = list;
      }
      if (!cancelled) setWithdrawalMatches(matches);
    })();
    return () => { cancelled = true; };
  }, [rows]);

  // Map an extracted channel to the approve-withdrawal `payment_method`
  // payload value (mobile_money | bank_transfer | cash).
  const channelToPaymentMethod = (channel: string | null, fallback: string): string => {
    if (channel === 'mtn_momo' || channel === 'airtel_money') return 'mobile_money';
    if (channel === 'bank_transfer') return 'bank_transfer';
    if (channel === 'cash_receipt') return 'cash';
    return fallback || 'mobile_money';
  };

  const autoApproveWithdrawal = async (row: GmailTx, match: WithdrawalMatch) => {
    const ref = (row.transaction_id ?? '').trim();
    if (!ref || ref.length < 3) {
      toast({
        title: 'Cannot auto-approve',
        description: 'Email is missing a usable TID / bank reference.',
        variant: 'destructive',
      });
      return;
    }
    setAutoApproving((cur) => ({ ...cur, [row.id]: true }));
    const paymentMethod = channelToPaymentMethod(row.channel, match.payout_method);
    const { data, error } = await invokeEdgeFunction<{ success?: boolean; error?: string }>(
      'approve-withdrawal',
      {
        body: {
          withdrawal_id: match.id,
          reference: ref,
          payment_method: paymentMethod,
        },
        errorTitle: 'Auto-approve failed',
      },
    );
    setAutoApproving((cur) => {
      const { [row.id]: _, ...rest } = cur;
      return rest;
    });
    if (error || !data || data.error) return;
    toast({
      title: 'Withdrawal auto-approved',
      description: `Matched email TID ${ref} → withdrawal ${match.id.slice(0, 8)}… (${match.mobile_money_number ?? match.bank_account_number ?? 'beneficiary'}). Wallet debited.`,
    });
    // Drop this match locally so the button disappears immediately.
    setWithdrawalMatches((cur) => ({ ...cur, [row.id]: [] }));
  };

  // Resolve phone numbers (and transaction ids) found in each email row to
  // app users in `profiles`. Runs whenever the visible row set changes;
  // matches are highlighted inline so the operator can confirm at a glance
  // who likely sent the deposit.
  useEffect(() => {
    let cancelled = false;
    const rowPhones = new Map<string, string[]>();
    const rowFromPhones = new Map<string, string[]>();
    const rowToPhones = new Map<string, string[]>();
    const rowRefs = new Map<string, string[]>();
    const rowToNames = new Map<string, string[]>();
    const rowFromNames = new Map<string, string[]>();
    const allPhones = new Set<string>();
    const allRefs = new Set<string>();
    const allNames = new Set<string>();
    for (const r of rows) {
      const phones = extractPhones(r);
      if (phones.length) {
        rowPhones.set(r.id, phones);
        phones.forEach((p) => allPhones.add(p));
      }
      const fromPhones = extractFromPhones(r);
      if (fromPhones.length) {
        rowFromPhones.set(r.id, fromPhones);
        fromPhones.forEach((p) => allPhones.add(p));
      }
      const toPhones = extractToPhones(r);
      if (toPhones.length) {
        rowToPhones.set(r.id, toPhones);
        toPhones.forEach((p) => allPhones.add(p));
      }
      const refs = extractReferences(r);
      if (refs.length) {
        rowRefs.set(r.id, refs);
        refs.forEach((x) => allRefs.add(x));
      }
      const toNames = extractToNames(r);
      if (toNames.length) {
        rowToNames.set(r.id, toNames);
        toNames.forEach((n) => allNames.add(n));
      }
      const fromNames = extractFromNames(r);
      if (fromNames.length) {
        rowFromNames.set(r.id, fromNames);
        fromNames.forEach((n) => allNames.add(n));
      }
    }
    if (allPhones.size === 0 && allRefs.size === 0 && allNames.size === 0) {
      setUserMatches({});
      return;
    }
    const phoneList = Array.from(allPhones);
    const refList = Array.from(allRefs);
    const nameList = Array.from(allNames);
    (async () => {
      // Build the in-list once and query both phone columns.
      const profileQ = phoneList.length
        ? (supabase.from('profiles') as any)
            .select('id, full_name, phone, mobile_money_number, verified')
            .or(`phone.in.(${phoneList.join(',')}),mobile_money_number.in.(${phoneList.join(',')})`)
            .limit(500)
        : Promise.resolve({ data: [], error: null });
      // Authoritative lookup: a Welile deposit_request that already carries
      // this exact transaction id maps the email straight to its user.
      const depQ = refList.length
        ? (supabase.from('deposit_requests') as any)
            .select('transaction_id, user_id')
            .in('transaction_id', refList)
            .limit(500)
        : Promise.resolve({ data: [], error: null });
      // Name-based lookup: match every extracted "to NAME" / "from NAME"
      // against profiles.full_name with case-insensitive substring. Cap the
      // OR-list to avoid PostgREST URL bloat on huge inboxes.
      const cappedNames = nameList.slice(0, 40);
      const nameQ = cappedNames.length
        ? (supabase.from('profiles') as any)
            .select('id, full_name, phone, mobile_money_number, verified')
            .or(cappedNames.map((n) => `full_name.ilike.%${n.replace(/[,()]/g, ' ')}%`).join(','))
            .limit(500)
        : Promise.resolve({ data: [], error: null });
      const [{ data, error }, { data: deps }, { data: nameData }] = await Promise.all([
        profileQ,
        depQ,
        nameQ,
      ]);
      if (cancelled || error) return;
      type P = { id: string; full_name: string; phone: string | null; mobile_money_number: string | null };
      const byPhone = new Map<string, P[]>();
      for (const p of (data ?? []) as P[]) {
        for (const candidate of [p.phone, p.mobile_money_number]) {
          const n = candidate ? normalizeUgPhone(candidate) : null;
          if (!n) continue;
          const list = byPhone.get(n) ?? [];
          if (!list.find((x) => x.id === p.id)) list.push(p);
          byPhone.set(n, list);
        }
      }
      // Build a name → matching profiles index. A profile matches a name when
      // every non-trivial token in the extracted name appears in full_name
      // (case-insensitive). Guards against "JAMES" matching every James in DB.
      const nameProfiles = (nameData ?? []) as P[];
      const byName = new Map<string, P[]>();
      for (const candidate of nameList) {
        const tokens = candidate.split(/\s+/).filter((t) => t.length > 1);
        if (tokens.length < 2) continue;
        const hits: P[] = [];
        for (const p of nameProfiles) {
          const haystack = (p.full_name ?? '').toUpperCase();
          if (tokens.every((t) => haystack.includes(t))) hits.push(p);
        }
        if (hits.length) byName.set(candidate, hits);
      }
      // Resolve deposit_requests.user_id → profile in a second roundtrip so
      // we don't depend on a specific FK alias being declared on the table.
      const depRows = (deps ?? []) as Array<{ transaction_id: string; user_id: string }>;
      const userIds = Array.from(new Set(depRows.map((d) => d.user_id).filter(Boolean)));
      let refProfiles: Record<string, P> = {};
      if (userIds.length) {
        const { data: pps } = await (supabase.from('profiles') as any)
          .select('id, full_name, phone, mobile_money_number')
          .in('id', userIds);
        for (const p of (pps ?? []) as P[]) refProfiles[p.id] = p;
      }
      const byRef = new Map<string, P>();
      for (const d of depRows) {
        const p = refProfiles[d.user_id];
        if (d.transaction_id && p) byRef.set(d.transaction_id.toUpperCase(), p);
      }
      const next: Record<string, MatchedUser[]> = {};
      for (const [rowId, phones] of rowPhones) {
        const seen = new Set<string>();
        const list: MatchedUser[] = [];
        // 1. Reference / TID hit — authoritative, push first.
        for (const ref of rowRefs.get(rowId) ?? []) {
          const p = byRef.get(ref);
          if (p && !seen.has(p.id)) {
            seen.add(p.id);
            list.push({
              id: p.id, full_name: p.full_name,
              phone: p.phone, mobile_money_number: p.mobile_money_number,
              matched_on: `reference ${ref}`,
            });
          }
        }
        // 2. Phone right after the word "from" — strongest heuristic match.
        const fromSet = new Set(rowFromPhones.get(rowId) ?? []);
        // 2b. Phone right after the word "to" — strongest heuristic match
        //     for outgoing payouts (recipient identification).
        const toSet = new Set(rowToPhones.get(rowId) ?? []);
        for (const ph of phones) {
          for (const p of byPhone.get(ph) ?? []) {
            if (seen.has(p.id)) continue;
            seen.add(p.id);
            list.push({
              id: p.id,
              full_name: p.full_name,
              phone: p.phone,
              mobile_money_number: p.mobile_money_number,
              matched_on: fromSet.has(ph)
                ? `from ${ph}`
                : toSet.has(ph)
                  ? `to ${ph}`
                  : `phone ${ph}`,
            });
          }
        }
        // 3. Name match (recipient/sender by full_name). Lower priority than
        //    phone/reference but surfaces names like "JAMES KATONGOLE" when
        //    the provider email omits a phone number entirely.
        const rowNames = [
          ...(rowToNames.get(rowId) ?? []).map((n) => ({ n, kw: 'to' as const })),
          ...(rowFromNames.get(rowId) ?? []).map((n) => ({ n, kw: 'from' as const })),
        ];
        for (const { n, kw } of rowNames) {
          for (const p of byName.get(n) ?? []) {
            if (seen.has(p.id)) continue;
            seen.add(p.id);
            list.push({
              id: p.id,
              full_name: p.full_name,
              phone: p.phone,
              mobile_money_number: p.mobile_money_number,
              matched_on: `name-${kw} ${n}`,
            });
          }
        }
        if (list.length) next[rowId] = list;
      }
      // Rows that had no extracted phone but did match by reference id.
      for (const [rowId, refs] of rowRefs) {
        if (next[rowId]) continue;
        const list: MatchedUser[] = [];
        const seen = new Set<string>();
        for (const ref of refs) {
          const p = byRef.get(ref);
          if (p && !seen.has(p.id)) {
            seen.add(p.id);
            list.push({
              id: p.id, full_name: p.full_name,
              phone: p.phone, mobile_money_number: p.mobile_money_number,
              matched_on: `reference ${ref}`,
            });
          }
        }
        if (list.length) next[rowId] = list;
      }
      // Rows whose only signal was a name (no phone, no TID). Critical for
      // money-out emails like Equity Bank that print only the recipient name.
      for (const rowId of new Set([
        ...Array.from(rowToNames.keys()),
        ...Array.from(rowFromNames.keys()),
      ])) {
        if (next[rowId]) continue;
        const list: MatchedUser[] = [];
        const seen = new Set<string>();
        const rowNames = [
          ...(rowToNames.get(rowId) ?? []).map((n) => ({ n, kw: 'to' as const })),
          ...(rowFromNames.get(rowId) ?? []).map((n) => ({ n, kw: 'from' as const })),
        ];
        for (const { n, kw } of rowNames) {
          for (const p of byName.get(n) ?? []) {
            if (seen.has(p.id)) continue;
            seen.add(p.id);
            list.push({
              id: p.id,
              full_name: p.full_name,
              phone: p.phone,
              mobile_money_number: p.mobile_money_number,
              matched_on: `name-${kw} ${n}`,
            });
          }
        }
        if (list.length) next[rowId] = list;
      }
      setUserMatches(next);
    })();
    return () => { cancelled = true; };
  }, [rows]);

  const pollNow = async () => {
    setPolling(true);
    const { data, error } = await supabase.functions.invoke('gmail-poll-transactions', { body: {} });
    setPolling(false);
    if (error) {
      const friendly = friendlyPollError(error.message);
      toast({ title: friendly.title, description: friendly.description, variant: 'destructive' });
      await load(); // refresh state so banner shows the new error
    } else {
      const inserted = (data as any)?.inserted ?? 0;
      const scanned = (data as any)?.scanned ?? 0;
      toast({ title: `Scanned ${scanned} emails`, description: `Imported ${inserted} new transaction${inserted === 1 ? '' : 's'}.` });
      await load();
    }
  };

  // Apply date-range filter to everything that drives totals / breakdown / exports.
  // Dates are interpreted in the chosen timezone so the user sees stable bucketing
  // regardless of where the browser is running.
  const fromTs = fromDate ? zonedWallClockToUtcMs(fromDate, '00:00:00', tz) : null;
  const toTs = toDate ? zonedWallClockToUtcMs(toDate, '23:59:59', tz) : null;
  const inRange = (r: GmailTx) => {
    if (!fromTs && !toTs) return true;
    if (!r.internal_date) return false;
    const t = new Date(r.internal_date).getTime();
    if (fromTs && t < fromTs) return false;
    if (toTs && t > toTs) return false;
    return true;
  };
  // When a search query is active we DELIBERATELY bypass the date range so
  // ops can find any email regardless of the date filter currently set.
  const searchActiveForRange = searchQuery.trim().length > 0;
  const dateRows = searchActiveForRange ? rows : rows.filter(inRange);
  // Apply the free-text search on top of the date range. Empty query → pass.
  const searchTokens = searchQuery
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  // Expand each token with phone-number variants so a search like "0772123456"
  // matches emails that printed "+256772123456" / "256772 123 456" / etc.
  const expandedSearchTokens: string[][] = searchTokens.map((t) => {
    const variants = new Set<string>([t]);
    const digits = t.replace(/\D/g, '');
    if (digits.length >= 7) {
      variants.add(digits);
      const norm = normalizeUgPhone(t);
      if (norm) {
        variants.add(norm);                 // 256XXXXXXXXX
        variants.add(`0${norm.slice(3)}`);  // 0XXXXXXXXX
        variants.add(norm.slice(3));        // 7XXXXXXXX
      }
    }
    // Amount typed with or without commas (e.g. "150000" vs "150,000")
    if (/^\d{4,}$/.test(digits)) {
      variants.add(Number(digits).toLocaleString().toLowerCase());
    }
    return Array.from(variants);
  });
  const matchesSearch = (r: GmailTx): boolean => {
    if (searchTokens.length === 0) return true;
    const matched = userMatches[r.id] ?? [];
    const matchedHay = matched
      .flatMap((u) => [u.full_name ?? '', u.phone ?? '', u.id ?? ''])
      .join(' ');
    const hay = [
      r.transaction_id ?? '',
      r.subject ?? '',
      r.snippet ?? '',
      r.counterparty ?? '',
      r.from_email ?? '',
      r.from_name ?? '',
      r.direction ?? '',
      r.channel ?? '',
      r.amount != null ? String(Math.round(r.amount)) : '',
      r.amount != null ? Math.round(r.amount).toLocaleString() : '',
      r.fee != null ? String(Math.round(r.fee)) : '',
      r.balance != null ? String(Math.round(r.balance)) : '',
      r.gmail_message_id ?? '',
      r.internal_date ?? '',
      matchedHay,
    ].join(' ').toLowerCase();
    // Each token must match in ANY of its variant forms.
    return expandedSearchTokens.every((variants) =>
      variants.some((v) => hay.includes(v)),
    );
  };
  // Dedicated depositor-phone match. Compares the trailing 9 digits (the part
  // that's stable across 0…, 256…, +256… and bare 7… formats) so a search like
  // "0783673998" also matches "+256783673998" printed in the email body.
  const phoneDigits = phoneQuery.replace(/\D/g, '');
  const phoneNeedle = phoneDigits.length >= 9 ? phoneDigits.slice(-9) : phoneDigits;
  const phoneActive = phoneNeedle.length >= 6;
  const matchesPhone = (r: GmailTx): boolean => {
    if (!phoneActive) return true;
    const matched = userMatches[r.id] ?? [];
    const hay = [
      r.counterparty ?? '',
      r.from_name ?? '',
      r.from_email ?? '',
      r.subject ?? '',
      r.snippet ?? '',
      ...matched.map((u) => u.phone ?? ''),
    ]
      .join(' ')
      .replace(/\D/g, '');
    return hay.includes(phoneNeedle);
  };
  // `filteredRows` reflects BOTH the date range and the search box, so every
  // downstream consumer (stats, breakdown, chart, exports, list) stays in sync.
  const filteredRows = dateRows.filter((r) => matchesSearch(r) && matchesPhone(r));
  const searchActive = searchTokens.length > 0 || phoneActive;
  // Resolve & memoize the channel for every row once per render. Calling
  // deriveChannel with the cache may write back new entries; we flush to
  // localStorage at the end if anything changed.
  const channelCache = channelCacheRef.current;
  const cacheSnapshot = JSON.stringify(channelCache);
  const rowChannel = new Map<string, ChannelResult>();
  for (const r of rows) rowChannel.set(r.id, deriveChannel(r, channelCache));
  if (JSON.stringify(channelCache) !== cacheSnapshot) flushChannelCache();
  const ch = (r: GmailTx): ChannelResult => rowChannel.get(r.id) ?? deriveChannel(r, channelCache);
  const rangeActive = Boolean(fromTs || toTs);
  const parsedCount = filteredRows.filter((r) => r.parsed).length;
  // Skipped rows the parser could not turn into a usable transaction. Newest
  // first so the most recent failures are at the top of the queue.
  const unparsedRows = filteredRows
    .filter(isUnparsedRow)
    .sort((a, b) => {
      const ta = a.internal_date ? new Date(a.internal_date).getTime() : 0;
      const tb = b.internal_date ? new Date(b.internal_date).getTime() : 0;
      return tb - ta;
    });
  // Compute validity once per row so totals, breakdowns and the list agree.
  const validity = new Map<string, { valid: boolean; reason?: string }>();
  for (const r of rows) validity.set(r.id, validateGmailTx(r));
  const flaggedCount = filteredRows.filter((r) => r.parsed && !validity.get(r.id)!.valid).length;
  // Flagged rows are kept in totals (only highlighted in the UI). A row counts
  // toward totals as long as it's parsed and has a usable amount.
  const isCountable = (r: GmailTx) =>
    r.parsed && r.amount !== null && Number.isFinite(r.amount as number) && (r.amount as number) > 0;
  const totalAmount = filteredRows.filter(isCountable).reduce((s, r) => s + (r.amount ?? 0), 0);
  const totalIn = filteredRows
    .filter((r) => isCountable(r) && r.direction === 'in')
    .reduce((s, r) => s + (r.amount ?? 0), 0);
  const totalOut = filteredRows
    .filter((r) => isCountable(r) && (r.direction === 'out' || r.direction === 'charge'))
    .reduce((s, r) => s + (r.amount ?? 0), 0);
  const netAmount = totalIn - totalOut;

  // Unmatched email counters — deposit emails with no linked request and
  // payout emails neither routed to a wallet nor matched to an open withdrawal.
  const unmatchedInCount = filteredRows.filter(
    (r) => r.parsed && r.direction === 'in' && !r.linked_deposit_request_id && !r.auto_matched_at,
  ).length;
  const unmatchedOutCount = filteredRows.filter(
    (r) =>
      isCountable(r) &&
      (r.direction === 'out' || r.direction === 'charge') &&
      !routingHistory[r.id]?.length &&
      !(withdrawalMatches[r.id]?.length),
  ).length;

  // Per-channel breakdown with counts and totals per direction.
  const channelBreakdown = (() => {
    const map = new Map<
      string,
      { inCount: number; inTotal: number; outCount: number; outTotal: number; feeCount: number; feeTotal: number }
    >();
    for (const r of filteredRows) {
      if (!isCountable(r)) continue;
      const key = ch(r).channel.replace(/_/g, ' ');
      const cur = map.get(key) ?? { inCount: 0, inTotal: 0, outCount: 0, outTotal: 0, feeCount: 0, feeTotal: 0 };
      const amt = r.amount ?? 0;
      if (r.direction === 'in') {
        cur.inCount += 1;
        cur.inTotal += amt;
      } else if (r.direction === 'out' || r.direction === 'charge') {
        cur.outCount += 1;
        cur.outTotal += amt;
      }
      // Provider-deducted fee/charge/tax/excise lives on the row regardless
      // of direction (MTN/Airtel attach it to the same send confirmation;
      // banks send a separate "charge" row). Aggregate whenever present.
      if (r.fee && Number(r.fee) > 0) {
        cur.feeCount += 1;
        cur.feeTotal += Number(r.fee);
      }
      map.set(key, cur);
    }
    return Array.from(map.entries())
      .map(([channel, v]) => ({ channel, ...v, net: v.inTotal - v.outTotal }))
      .sort((a, b) => b.inTotal + b.outTotal - (a.inTotal + a.outTotal));
  })();

  // Total provider fees across every parsed row (any direction).
  const totalFees = filteredRows
    .filter((r) => r.parsed && r.fee && Number(r.fee) > 0)
    .reduce((s, r) => s + Number(r.fee ?? 0), 0);
  const feeCount = filteredRows.filter((r) => r.parsed && r.fee && Number(r.fee) > 0).length;

  // Daily in vs out series for the selected timeframe.
  const dailySeries = (() => {
    const map = new Map<string, { date: string; in: number; out: number; net: number }>();
    for (const r of filteredRows) {
      if (!isCountable(r) || !r.internal_date) continue;
      const key = dateKeyInTz(new Date(r.internal_date), tz);
      const cur = map.get(key) ?? { date: key, in: 0, out: 0, net: 0 };
      const amt = r.amount ?? 0;
      if (r.direction === 'in') cur.in += amt;
      else if (r.direction === 'out' || r.direction === 'charge') cur.out += amt;
      cur.net = cur.in - cur.out;
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  })();

  // Shared "needs routing" predicate: an incoming deposit whose money has not
  // landed in any wallet yet (not credited and not routed). Mirrors the badge
  // logic used in the row render so the filter and the badge always agree.
  const isNeedsRouting = useCallback((r: GmailTx) => {
    if (r.direction !== 'in') return false;
    if (justRoutedIds.has(r.id)) return false;
    const isRouted = (routingHistory[r.id] ?? []).length > 0;
    const credited = creditedDeposits[r.id] ?? [];
    const manualMark = manualMarks[r.id];
    const ledgerHit = (ledgerCredits[r.id] ?? []).length > 0;
    const isCredited = manualMark ? manualMark.mark === 'credited' : (credited.length > 0 || ledgerHit);
    return !isCredited && !isRouted;
  }, [routingHistory, creditedDeposits, manualMarks, justRoutedIds, ledgerCredits]);

  /**
   * Settlement status for a single row, used by the Status filter chips.
   *   'unparsed'     → the parser could not read the email (no amount / not parsed)
   *   'needs_routing'→ incoming money not yet credited or routed to a wallet
   *   'credited'     → incoming money already credited or routed to a wallet
   *   'other'        → outgoing / charge rows (not a settlement candidate)
   */
  const getRowStatus = useCallback((r: GmailTx): 'unparsed' | 'needs_routing' | 'credited' | 'other' => {
    if (isUnparsedRow(r)) return 'unparsed';
    if (r.direction !== 'in') return 'other';
    if (justRoutedIds.has(r.id)) return 'credited';
    const isRouted = (routingHistory[r.id] ?? []).length > 0;
    const credited = creditedDeposits[r.id] ?? [];
    const manualMark = manualMarks[r.id];
    const ledgerHit = (ledgerCredits[r.id] ?? []).length > 0;
    const isCredited = manualMark ? manualMark.mark === 'credited' : (credited.length > 0 || ledgerHit);
    return isCredited || isRouted ? 'credited' : 'needs_routing';
  }, [routingHistory, creditedDeposits, manualMarks, justRoutedIds, ledgerCredits]);

  /**
   * Unread alert tracking. "Alerts" are rows that need a human: incoming
   * emails still awaiting routing, plus unparsed rows the parser skipped.
   * We remember the timestamp of the last time ops acknowledged the queue
   * (localStorage) and treat any alert row newer than that as unread, so the
   * panel can surface "what needs attention first" at a glance.
   */
  const ALERTS_SEEN_KEY = 'gmail_alerts_last_seen';
  /**
   * Alert notification settings. Ops choose which alert types count toward the
   * unread badges and whether new arrivals raise an in-app toast prompt.
   * Persisted per-browser in localStorage.
   */
  const ALERT_PREFS_KEY = 'gmail_alert_prefs_v1';
  type AlertPrefs = { needsRouting: boolean; unparsed: boolean; toastPrompt: boolean };
  const [alertPrefs, setAlertPrefs] = useState<AlertPrefs>(() => {
    const fallback: AlertPrefs = { needsRouting: true, unparsed: true, toastPrompt: true };
    if (typeof window === 'undefined') return fallback;
    try {
      const raw = localStorage.getItem(ALERT_PREFS_KEY);
      return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
    } catch { return fallback; }
  });
  const updateAlertPrefs = useCallback((patch: Partial<AlertPrefs>) => {
    setAlertPrefs((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(ALERT_PREFS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const [alertsSeenTs, setAlertsSeenTs] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    const raw = Number(localStorage.getItem(ALERTS_SEEN_KEY));
    return Number.isFinite(raw) ? raw : 0;
  });
  const rowTimeMs = useCallback((r: GmailTx) => {
    const t = r.internal_date ? new Date(r.internal_date).getTime() : NaN;
    return Number.isFinite(t) ? t : 0;
  }, []);
  const alertRows = useMemo(
    () => filteredRows.filter((r) => {
      const s = getRowStatus(r);
      if (s === 'needs_routing') return alertPrefs.needsRouting;
      if (s === 'unparsed') return alertPrefs.unparsed;
      return false;
    }),
    [filteredRows, getRowStatus, alertPrefs.needsRouting, alertPrefs.unparsed],
  );
  const unreadAlertRows = useMemo(
    () => alertRows.filter((r) => rowTimeMs(r) > alertsSeenTs),
    [alertRows, alertsSeenTs, rowTimeMs],
  );
  const unreadAlertCount = unreadAlertRows.length;
  /** Human-friendly arrival label for an alert row ("12m ago · 14:05"). */
  const formatAlertArrival = useCallback((r: GmailTx) => {
    const ms = rowTimeMs(r);
    if (!ms) return 'unknown time';
    const diff = Date.now() - ms;
    const mins = Math.floor(diff / 60000);
    const rel =
      mins < 1 ? 'just now'
        : mins < 60 ? `${mins}m ago`
          : mins < 1440 ? `${Math.floor(mins / 60)}h ago`
            : `${Math.floor(mins / 1440)}d ago`;
    const clock = new Date(ms).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    return `${rel} · ${clock}`;
  }, [rowTimeMs]);
  /** Newest / oldest unread arrivals, for the banner triage summary. */
  const unreadArrivalSpan = useMemo(() => {
    if (unreadAlertRows.length === 0) return null;
    const sorted = [...unreadAlertRows].sort((a, b) => rowTimeMs(b) - rowTimeMs(a));
    return { newest: sorted[0], oldest: sorted[sorted.length - 1], sorted };
  }, [unreadAlertRows, rowTimeMs]);
  const isUnreadAlertRow = useCallback(
    (r: GmailTx) => {
      const s = getRowStatus(r);
      const enabled = s === 'needs_routing' ? alertPrefs.needsRouting
        : s === 'unparsed' ? alertPrefs.unparsed
          : false;
      return enabled && rowTimeMs(r) > alertsSeenTs;
    },
    [getRowStatus, rowTimeMs, alertsSeenTs, alertPrefs.needsRouting, alertPrefs.unparsed],
  );
  const markAlertsSeen = useCallback(() => {
    const now = Date.now();
    setAlertsSeenTs(now);
    try { localStorage.setItem(ALERTS_SEEN_KEY, String(now)); } catch { /* ignore */ }
  }, []);

  /**
   * In-app prompt: when new unread alerts appear (and prompts are enabled in
   * alert settings) raise a single toast with a jump-to-queue action.
   */
  const promptedUnreadRef = useRef<number>(0);
  useEffect(() => {
    if (!alertPrefs.toastPrompt) { promptedUnreadRef.current = unreadAlertCount; return; }
    if (unreadAlertCount > promptedUnreadRef.current && unreadAlertCount > 0) {
      sonnerToast(`${unreadAlertCount} email alert${unreadAlertCount === 1 ? '' : 's'} need attention`, {
        description: 'Emails awaiting routing or unparsed by the reader.',
        action: {
          label: 'Review',
          onClick: () => document
            .getElementById('email-tx-results')
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        },
      });
    }
    promptedUnreadRef.current = unreadAlertCount;
  }, [unreadAlertCount, alertPrefs.toastPrompt]);

  /**
   * Bulk triage helpers for unmatched alerts. `selectAllAlertRows` tick-selects
   * every attention-needing row in the current window (needs routing /
   * unparsed) so the existing bulk-mark bar can act on them; `resolveAllAlerts`
   * is the one-tap path that marks them resolved (credited) in a single
   * append-only batch and acknowledges the unread counter.
   */
  const selectAllAlertRows = useCallback(() => {
    setSelectedIds(new Set(alertRows.map((r) => r.id)));
  }, [alertRows]);

  /**
   * Desktop keyboard shortcuts (ignored while typing in inputs):
   *   g — jump to the needs-routing queue
   *   s — mark all alerts as seen
   *   d — open details for the newest unread alert
   *   ? — show the shortcut cheatsheet
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      const jump = () => document
        .getElementById('email-tx-results')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      switch (e.key) {
        case 'g':
        case 'G':
          e.preventDefault();
          setStatusFilter('needs_routing');
          jump();
          sonnerToast('Jumped to needs-routing alerts');
          break;
        case 's':
        case 'S':
          e.preventDefault();
          markAlertsSeen();
          sonnerToast('All alerts marked as seen');
          break;
        case 'd':
        case 'D':
          if (!unreadArrivalSpan) return;
          e.preventDefault();
          setAlertDetailsRow(unreadArrivalSpan.newest);
          break;
        case '?':
          e.preventDefault();
          sonnerToast('Keyboard shortcuts', {
            description: 'g — needs-routing queue · s — mark all seen · d — newest alert details',
            duration: 6000,
          });
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [markAlertsSeen, unreadArrivalSpan]);

  const resolveAlertRows = useCallback(async (targets: GmailTx[]) => {
    const ids = targets.map((r) => r.id);
    if (!ids.length) return;
    const ok = window.confirm(
      `Mark ${ids.length} unmatched alert${ids.length === 1 ? '' : 's'} as resolved? This is logged in the audit trail.`,
    );
    if (!ok) return;
    await applyBulkMark('credited', ids, 'Bulk resolved unmatched alerts from Email Transactions triage');
    markAlertsSeen();
  }, [applyBulkMark, markAlertsSeen]);

  /**
   * Compute debit metadata for a single row. Reused in filtering, sorting,
   * and rendering so the breakdown logic is defined in one place.
   */
  const getDebitMeta = useCallback((r: GmailTx) => {
    const history = routingHistory[r.id] ?? [];
    const autoDebitEntry = history.find(
      (h) => h.route === 'withdrawable_debit' && /^DEBIT\b/i.test(h.reason || ''),
    );
    const isReversed = history.some((h) => /revers/i.test(h.reason || ''));
    const isAutoDebited = !!autoDebitEntry && !isReversed;
    const autoImpact = autoDebitResults[r.id];
    const isProxyDebit = /via managed proxy/i.test(autoDebitEntry?.reason || '');
    const debitedName = autoDebitEntry?.target_user_name
      || autoImpact?.userName || 'matched user';
    const rawDebitReason = autoDebitEntry?.reason || '';
    const debitReasonText =
      rawDebitReason.includes('):')
        ? rawDebitReason.slice(rawDebitReason.indexOf('):') + 2).trim()
        : rawDebitReason.trim();
    const debitProxyPartner = (() => {
      const m = rawDebitReason.match(/via managed proxy for ([^,):]+)/i);
      return m ? m[1].trim() : null;
    })();
    const debitIsPartial = /partial/i.test(rawDebitReason);
    const debitAmountValue = autoDebitEntry?.amount ?? autoImpact?.amount ?? Number(r.amount ?? 0);
    return {
      isAutoDebited,
      isProxyDebit,
      debitedName,
      debitReasonText,
      debitProxyPartner,
      debitIsPartial,
      debitAmountValue,
      rawDebitReason,
    };
  }, [routingHistory, autoDebitResults]);

  /**
   * Needs routing 2: an outgoing payout email whose money was never taken off
   * the wallet of the number that was paid out — no auto-debit recorded and no
   * manual routing entry either. Defined after getDebitMeta so it can reuse it.
   */
  const isNeedsDebitRouting = useCallback((r: GmailTx) => {
    if (r.direction !== 'out' && r.direction !== 'charge') return false;
    if (isUnparsedRow(r)) return false;
    if (justRoutedIds.has(r.id)) return false;
    if ((routingHistory[r.id] ?? []).length > 0) return false;
    return !getDebitMeta(r).isAutoDebited;
  }, [routingHistory, justRoutedIds, getDebitMeta]);

  // Navigable rows: the same list the operator sees on the Recent emails page.
  // This drives the Prev / Next button bar inside the Route dialog so Financial
  // Ops can walk through emails in order without closing the dialog each time.
  const visibleRows = useMemo(() => {
    let list = filteredRows.filter((r) => {
      if (directionFilter === 'in' && r.direction !== 'in') return false;
      if (directionFilter === 'out' && r.direction !== 'out' && r.direction !== 'charge') return false;
      if (needsRoutingOnly && !isNeedsRouting(r)) return false;
      if (statusFilter === 'needs_routing_out') {
        if (!isNeedsDebitRouting(r)) return false;
      } else if (statusFilter !== 'all' && getRowStatus(r) !== statusFilter) {
        return false;
      }
      if (matchFilter === 'all') return true;
      const matches = userMatches[r.id] ?? [];
      if (matchFilter === 'reference') return matches.some((u) => u.matched_on.startsWith('reference '));
      if (matchFilter === 'from') return matches.some((u) => u.matched_on.startsWith('from '));
      return matches.some((u) => u.matched_on.startsWith('reference ') || u.matched_on.startsWith('from '));
    });
    // Debit-breakdown filter: only meaningful for outgoing emails.
    if (debitFilter !== 'all') {
      list = list.filter((r) => {
        const meta = getDebitMeta(r);
        if (debitFilter === 'none') return !meta.isAutoDebited;
        if (debitFilter === 'user_debit') return meta.isAutoDebited && !meta.isProxyDebit;
        if (debitFilter === 'proxy_debit') return meta.isAutoDebited && meta.isProxyDebit;
        return true;
      });
    }
    // Debit-breakdown sort: only meaningful when a sort is chosen.
    if (debitSort !== 'none') {
      list = [...list].sort((a, b) => {
        const ma = getDebitMeta(a);
        const mb = getDebitMeta(b);
        // Always push non-debited rows to the bottom when sorting by debit metadata.
        if (!ma.isAutoDebited && !mb.isAutoDebited) return 0;
        if (!ma.isAutoDebited) return 1;
        if (!mb.isAutoDebited) return -1;
        if (debitSort === 'debitType') {
          // Proxy first, then user
          return (mb.isProxyDebit ? 1 : 0) - (ma.isProxyDebit ? 1 : 0);
        }
        if (debitSort === 'debitAmount') {
          return mb.debitAmountValue - ma.debitAmountValue;
        }
        if (debitSort === 'debitName') {
          return ma.debitedName.localeCompare(mb.debitedName);
        }
        return 0;
      });
    } else {
      // Primary sort dropdown. 'newest' is now explicitly sorted by internal_date
      // descending so the latest email always appears on top, regardless of whether
      // rows arrived via realtime subscription or DB pagination order.
      const ts = (r: GmailTx) => {
        const v = r.internal_date ? new Date(r.internal_date).getTime() : 0;
        return Number.isFinite(v) ? v : 0;
      };
      const amt = (r: GmailTx) => (r.amount !== null && Number.isFinite(r.amount) ? (r.amount as number) : -1);
      const statusRank = (r: GmailTx) => {
        const s = getRowStatus(r);
        return s === 'needs_routing' ? 0 : s === 'unparsed' ? 1 : s === 'credited' ? 2 : 3;
      };
      list = [...list].sort((a, b) => {
        if (sortMode === 'newest') return ts(b) - ts(a);
        if (sortMode === 'oldest') return ts(a) - ts(b);
        if (sortMode === 'amount_high') return amt(b) - amt(a) || ts(b) - ts(a);
        if (sortMode === 'amount_low') return amt(a) - amt(b) || ts(b) - ts(a);
        if (sortMode === 'status') return statusRank(a) - statusRank(b) || ts(b) - ts(a);
        return 0;
      });
    }
    return list;
  }, [filteredRows, directionFilter, matchFilter, userMatches, needsRoutingOnly, isNeedsRouting, isNeedsDebitRouting, statusFilter, getRowStatus, debitFilter, debitSort, sortMode, getDebitMeta]);

  const navIndex = routingRow ? visibleRows.findIndex((r) => r.id === routingRow.id) : -1;
  const canPrevNav = navIndex > 0;
  const canNextNav = navIndex >= 0 && navIndex < visibleRows.length - 1;

  // Infinite scroll: when in 'infinite' mode, observe a sentinel at the bottom
  // of the list and grow the rendered window by one page each time it scrolls
  // into view, until every filtered row is shown. Expanded drilldowns persist
  // because `expandedRows` is keyed by row id, not by render position.
  const totalVisible = visibleRows.length;
  useEffect(() => {
    if (paginationMode !== 'infinite') return;
    const node = infiniteSentinelRef.current;
    if (!node) return;
    if (infiniteCount >= totalVisible) return;
    let frame = 0;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          // Grow inside a rAF so the reveal happens on the next paint instead of
          // mid-scroll — keeps momentum scrolling smooth on phones.
          if (frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            setInfiniteCount((c) => Math.min(c + pageSize, totalVisible));
          });
        }
      },
      // Prefetch well ahead of the fold so the next chunk is already rendered
      // before the operator reaches the bottom (no visible "Loading more…" stall).
      { rootMargin: '1200px 0px' },
    );
    observer.observe(node);
    return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [paginationMode, infiniteCount, totalVisible, pageSize]);

  /**
   * Move to a page (paged mode) and bring the top of the results list into view
   * WITHOUT scrolling under the sticky search / filter bars. The results anchor
   * carries `scroll-mt-*`, so `scrollIntoView` stops just below them.
   */
  const goToPage = useCallback((page: number) => {
    setCurrentPage(page);
    try { navigator.vibrate?.(10); } catch { /* haptics optional */ }
    requestAnimationFrame(() => {
      document.getElementById('email-tx-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  /** Compute the best suggested user for a given row and routing mode. */
  const computeSuggestedFor = (r: GmailTx, mode: 'credit' | 'debit') => {
    const matches = userMatches[r.id] ?? [];
    const scoreFrom = mode === 'credit'
      ? (u: MatchedUser) => (
          u.matched_on.startsWith('reference ') ? 100
          : u.matched_on.startsWith('from ') ? 90
          : u.matched_on.startsWith('to ') ? 90
          : u.matched_on.startsWith('name-') ? 75
          : 60
        )
      : (u: MatchedUser) => (
          u.matched_on.startsWith('reference ') ? 100
          : u.matched_on.startsWith('to ') ? 90
          : u.matched_on.startsWith('from ') ? 90
          : u.matched_on.startsWith('name-') ? 75
          : 60
        );
    const top = matches
      .map((u) => ({ u, s: scoreFrom(u) }))
      .sort((a, b) => b.s - a.s)[0]?.u;
    const prefix = mode === 'credit' ? 'from' : 'to';
    const matchedPhone = top?.matched_on.startsWith(`${prefix} `) || top?.matched_on.startsWith('phone ')
      ? top.matched_on.replace(/^(from|to|phone)\s+/, '')
      : null;
    return top ? { id: top.id, full_name: top.full_name, phone: top.phone ?? '', matched_phone: matchedPhone } : null;
  };

  const navigateToRow = (nextRow: GmailTx, mode: 'credit' | 'debit', overrideUser?: PrefilledUser | null) => {
    setRoutingSuggestedUser(overrideUser ?? computeSuggestedFor(nextRow, mode));
    setRoutingMode(mode);
    setRoutingRow(nextRow);
  };

  /**
   * ── Multi-select batch queues ─────────────────────────────────────────────
   * Ops often tick several rows and want to work through them without going
   * back to the list. Two queues drive that:
   *  - `routeQueue`   : ids still to be routed/charged. Closing the routing
   *                     dialog automatically opens the next queued row.
   *  - `historyQueue` : rows to audit; the history drawer gets prev/next.
   */
  const [routeQueue, setRouteQueue] = useState<string[]>([]);
  const [historyQueue, setHistoryQueue] = useState<GmailTx[]>([]);
  /**
   * Inline alert details drawer. Opens the full context for one attention-needing
   * email (raw subject/snippet, every parsed field, and the routing/resolve
   * actions) without leaving the panel; prev/next walks the unread queue.
   */
  const [alertDetailsRow, setAlertDetailsRow] = useState<GmailTx | null>(null);
  /** Controlled open state for the alert notification settings dialog. */
  const [alertSettingsOpen, setAlertSettingsOpen] = useState(false);

  const startRouteQueue = useCallback((batch: GmailTx[]) => {
    if (!batch.length) return;
    const [first, ...rest] = batch;
    setRouteQueue(rest.map((r) => r.id));
    navigateToRow(first, first.direction === 'in' ? 'credit' : 'debit');
    sonnerToast(`Routing 1 of ${batch.length}`, {
      description: 'Finish or close this one and the next selected row opens automatically.',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userMatches]);

  const startHistoryQueue = useCallback((batch: GmailTx[]) => {
    if (!batch.length) return;
    setHistoryQueue(batch);
    setHistoryDrawerRow(batch[0]);
  }, []);

  const historyQueueIndex = historyDrawerRow
    ? historyQueue.findIndex((r) => r.id === historyDrawerRow.id)
    : -1;

  // Swipe-triggered routing/charging. Because a swipe can easily be the wrong
  // gesture, we snapshot the routing dialog state *before* opening it and show
  // an "Undo" toast that instantly reverts to the previous state (usually
  // closing the just-opened dialog), so a mistaken swipe can be undone quickly.
  const swipeNavigate = (nextRow: GmailTx, mode: 'credit' | 'debit') => {
    const prev = {
      row: routingRow,
      mode: routingMode,
      suggestedUser: routingSuggestedUser,
    };
    navigateToRow(nextRow, mode);
    sonnerToast(
      mode === 'credit' ? 'Opened deposit routing' : 'Opened wallet charge',
      {
        description: 'Swiped by mistake? Undo to go back.',
        duration: 6000,
        action: {
          label: 'Undo',
          onClick: () => {
            setRoutingRow(prev.row);
            setRoutingMode(prev.mode);
            setRoutingSuggestedUser(prev.suggestedUser);
          },
        },
      },
    );
  };

  // Targeted refetch of a single row's routing history after a routing/charging
  // action completes, so the status pill updates immediately without waiting
  // for the realtime feed (which may be throttled) or a full reload.
  const refreshRowStatus = async (rowId: string) => {
    const target = rows.find((r) => r.id === rowId);
    const msgId = target?.gmail_message_id ?? null;
    const filter = msgId
      ? `gmail_transaction_id.eq.${rowId},gmail_message_id.eq.${msgId}`
      : `gmail_transaction_id.eq.${rowId}`;
    const { data, error } = await (supabase.from('email_routing_history') as any)
      .select('id,created_at,route,reason,target_user_id,target_user_name,target_user_phone,routed_by_name,amount,sms_sent')
      .or(filter)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return;
    setRoutingHistory((cur) => ({
      ...cur,
      [rowId]: (data ?? []) as RoutingHistoryEntry[],
    }));
  };

  // Gmail-style label counts, computed off the same rows the list renders from.
  const gmailLabelCounts = useMemo(() => {
    let inCount = 0, outCount = 0, routing = 0, routingOut = 0, unparsed = 0, credited = 0;
    for (const r of filteredRows) {
      if (r.direction === 'in') inCount += 1;
      else if (r.direction === 'out' || r.direction === 'charge') outCount += 1;
      if (isNeedsDebitRouting(r)) routingOut += 1;
      const s = getRowStatus(r);
      if (s === 'needs_routing') routing += 1;
      else if (s === 'unparsed') unparsed += 1;
      else if (s === 'credited') credited += 1;
    }
    return { all: filteredRows.length, in: inCount, out: outCount, routing, routingOut, unparsed, credited };
  }, [filteredRows, getRowStatus, isNeedsDebitRouting]);

  // Gmail label definitions — each one maps onto the existing filter state so
  // no filtering logic changes, only the arrangement.
  const gmailLabels: Array<{
    key: string;
    label: string;
    Icon: typeof Inbox;
    count: number;
    active: boolean;
    apply: () => void;
  }> = [
    {
      key: 'all', label: 'Inbox', Icon: Inbox, count: gmailLabelCounts.all,
      active: directionFilter === 'all' && statusFilter === 'all' && !needsRoutingOnly,
      apply: () => { setDirectionFilter('all'); setFocusDirection(null); setStatusFilter('all'); setNeedsRoutingOnly(false); },
    },
    {
      key: 'in', label: 'Money in', Icon: ArrowDownLeft, count: gmailLabelCounts.in,
      active: directionFilter === 'in',
      apply: () => { setDirectionFilter('in'); setFocusDirection(focusView === 'ops' ? 'in' : null); setStatusFilter('all'); setNeedsRoutingOnly(false); },
    },
    {
      key: 'out', label: 'Money out', Icon: ArrowUpRight, count: gmailLabelCounts.out,
      active: directionFilter === 'out',
      apply: () => { setDirectionFilter('out'); setFocusDirection(focusView === 'ops' ? 'out' : null); setStatusFilter('all'); setNeedsRoutingOnly(false); },
    },
    {
      key: 'needs_routing', label: 'Needs routing 1 · money in', Icon: Send, count: gmailLabelCounts.routing,
      active: statusFilter === 'needs_routing',
      // Settlement labels are direction-blind: a status only exists on incoming
      // mail, so leaving a "Money out" direction filter active would render an
      // empty view even though the counter shows matches. Always reset it.
      apply: () => { setStatusFilter('needs_routing'); setNeedsRoutingOnly(false); setFocusDirection(null); setDirectionFilter('all'); },
    },
    {
      key: 'needs_routing_out', label: 'Needs routing 2 · money out', Icon: ArrowUpRight, count: gmailLabelCounts.routingOut,
      active: statusFilter === 'needs_routing_out',
      apply: () => { setStatusFilter('needs_routing_out'); setNeedsRoutingOnly(false); setFocusDirection(null); setDirectionFilter('all'); },
    },
    {
      key: 'unparsed', label: 'Unparsed', Icon: AlertOctagon, count: gmailLabelCounts.unparsed,
      active: statusFilter === 'unparsed',
      apply: () => { setStatusFilter('unparsed'); setNeedsRoutingOnly(false); setFocusDirection(null); setDirectionFilter('all'); },
    },
    {
      key: 'credited', label: 'Credited', Icon: CheckCircle2, count: gmailLabelCounts.credited,
      active: statusFilter === 'credited',
      apply: () => { setStatusFilter('credited'); setNeedsRoutingOnly(false); setFocusDirection(null); setDirectionFilter('all'); },
    },
  ];

  const applyRecentWindow = (days: number) => {
    const todayKey = dateKeyInTz(new Date(), tz);
    const [y, m, d] = todayKey.split('-').map(Number);
    const toUtc = Date.UTC(y, m - 1, d);
    const fromUtc = toUtc - (days - 1) * 86_400_000;
    const fmtKey = (ms: number) => {
      const dt = new Date(ms);
      return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
    };
    setFromDate(fmtKey(fromUtc));
    setToDate(fmtKey(toUtc));
  };

  return (
    <div className="space-y-3">
      {/* ── Gmail-style app bar: hamburger, product name, one big rounded
          search field, then the layout switch on the far right. ───────── */}
      <div className="flex items-center gap-2 sm:gap-3 rounded-full border bg-card px-2 py-1.5 sm:px-3 sm:py-2">
        <Button
          size="icon"
          variant="ghost"
          className="h-9 w-9 shrink-0 rounded-full lg:hidden"
          aria-label={gmailNavOpen ? 'Hide labels' : 'Show labels'}
          aria-expanded={gmailNavOpen}
          onClick={() => setGmailNavOpen((v) => !v)}
        >
          <Menu className="h-4 w-4" />
        </Button>
        <div className="hidden sm:flex items-center gap-2 shrink-0 pl-1 pr-1">
          <Mail className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium tracking-tight">Email transactions</span>
        </div>
        <TelecomBalanceStrip refreshKey={rows[0]?.id ?? null} />
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search mail — amount, name, phone, transaction id…"
            aria-label="Search mail"
            className="h-10 w-full rounded-full border-0 bg-muted/60 pl-10 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:bg-background placeholder:text-muted-foreground/70 transition-colors"
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setSearchOptionsOpen((v) => !v)}
              aria-expanded={searchOptionsOpen}
              aria-label="Show search options"
              title="Show search options"
              className={`rounded-full p-1.5 hover:bg-muted ${searchOptionsOpen ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </button>
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0 h-9 rounded-full px-3 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            const next = focusView === 'gmail' ? 'ops' : 'gmail';
            setFocusView(next);
            if (next === 'gmail') setFocusDirection(null);
          }}
        >
          {focusView === 'gmail' ? 'Ops layout' : 'Inbox layout'}
        </Button>
      </div>

      {/* Gmail's advanced search card — drops beneath the search field with
          From / Date within / Sort, plus Search + Clear actions. */}
      {searchOptionsOpen && (
        <div className="rounded-2xl border bg-card p-4 shadow-sm space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid grid-cols-[88px_1fr] items-center gap-3">
              <span className="text-xs text-muted-foreground text-right">From</span>
              <div className="relative">
                <Phone className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <input
                  type="search"
                  inputMode="tel"
                  value={phoneQuery}
                  onChange={(e) => setPhoneQuery(e.target.value)}
                  placeholder="Phone number"
                  aria-label="Filter by depositor phone number"
                  className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground/70"
                />
              </div>
            </label>
            <label className="grid grid-cols-[88px_1fr] items-center gap-3">
              <span className="text-xs text-muted-foreground text-right">Has the words</span>
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Amount, name, reference…"
                aria-label="Has the words"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground/70"
              />
            </label>
            <div className="grid grid-cols-[88px_1fr] items-center gap-3">
              <span className="text-xs text-muted-foreground text-right">Date within</span>
              <Select
                value="custom"
                onValueChange={(v) => {
                  if (v === 'custom') return;
                  applyRecentWindow(Number(v));
                }}
              >
                <SelectTrigger className="h-9 text-sm" aria-label="Date within">
                  <SelectValue placeholder="Any time" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="custom">{fromDate} → {toDate}</SelectItem>
                  <SelectItem value="1">1 day</SelectItem>
                  <SelectItem value="3">3 days</SelectItem>
                  <SelectItem value="7">1 week</SelectItem>
                  <SelectItem value="14">2 weeks</SelectItem>
                  <SelectItem value="30">1 month</SelectItem>
                  <SelectItem value="90">3 months</SelectItem>
                  <SelectItem value="180">6 months</SelectItem>
                  <SelectItem value="365">1 year</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-[88px_1fr] items-center gap-3">
              <span className="text-xs text-muted-foreground text-right">Sort by</span>
              <Select value={sortMode} onValueChange={(v) => setSortMode(v as SortMode)}>
                <SelectTrigger className="h-9 text-sm" aria-label="Sort mail">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Newest first</SelectItem>
                  <SelectItem value="oldest">Oldest first</SelectItem>
                  <SelectItem value="amount_high">Amount: high to low</SelectItem>
                  <SelectItem value="amount_low">Amount: low to high</SelectItem>
                  <SelectItem value="status">Status (needs routing first)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-[88px_1fr] items-center gap-3">
              <span className="text-xs text-muted-foreground text-right">Date from</span>
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-9 text-sm" aria-label="Date from" />
            </div>
            <div className="grid grid-cols-[88px_1fr] items-center gap-3">
              <span className="text-xs text-muted-foreground text-right">Date to</span>
              <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-9 text-sm" aria-label="Date to" />
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-9 rounded-full px-4 text-xs"
              onClick={() => { setSearchQuery(''); setPhoneQuery(''); applyRecentWindow(7); }}
            >
              Clear
            </Button>
            <Button
              size="sm"
              className="h-9 rounded-full px-5 text-xs"
              onClick={() => {
                setSearchOptionsOpen(false);
                if (typeof document !== 'undefined') {
                  document.getElementById('email-tx-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
              }}
            >
              <Search className="h-3.5 w-3.5 mr-1.5" /> Search
            </Button>
          </div>
        </div>
      )}

      {/* Compact quick date pills (Gmail chip row) — always visible. */}
      <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
        {([
          { label: 'Today', days: 1 },
          { label: 'Last 7 days', days: 7 },
          { label: 'Last 30 days', days: 30 },
        ]).map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => applyRecentWindow(p.days)}
            className="shrink-0 rounded-full border bg-background px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {p.label}
          </button>
        ))}
        {(searchQuery || phoneQuery) && (
          <button
            type="button"
            onClick={() => { setSearchQuery(''); setPhoneQuery(''); }}
            className="shrink-0 inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs text-primary"
          >
            Clear filters <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* ── Gmail body: label rail on the left, mail list + ops panels on
          the right. ──────────────────────────────────────────────────── */}
      <div className="flex gap-4">
        <aside
          className={`${gmailNavOpen ? 'block' : 'hidden'} lg:block w-full max-w-[256px] shrink-0 lg:w-[232px] lg:sticky lg:top-3 lg:self-start`}
          aria-label="Mail labels"
        >
          <nav className="space-y-0.5 pr-1 lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto">
            {gmailLabels.map(({ key, label, Icon, count, active, apply }) => (
              <button
                key={key}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => {
                  apply();
                  // Secondary filters (match confidence / debit breakdown) are
                  // sticky and can silently empty a label's view. Clear them so
                  // the list always matches the counter next to the label.
                  setMatchFilter('all');
                  setDebitFilter('all');
                  setGmailNavOpen(false);
                  // Selecting a label always lands the operator in the Gmail
                  // reading experience for that label, never the ops table.
                  setFocusView('gmail');
                  setSearchOptionsOpen(false);
                  if (typeof document !== 'undefined') {
                    document.getElementById('email-tx-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                }}
                className={`group flex w-full items-center gap-3.5 rounded-r-full py-2 pl-4 pr-3 text-left text-[13px] transition-colors ${
                  active
                    ? 'bg-primary/10 font-bold text-primary'
                    : 'text-foreground/70 hover:bg-muted/70 hover:text-foreground'
                }`}
              >
                <Icon className={`h-[18px] w-[18px] shrink-0 ${active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'}`} />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {/* Always show the counter — a visible 0 explains an empty view
                    instead of leaving the label looking broken. */}
                <span className={`shrink-0 text-[11px] tabular-nums ${active ? 'font-bold text-primary' : count > 0 ? 'font-semibold text-muted-foreground' : 'text-muted-foreground/50'}`}>
                  {count}
                </span>
              </button>
            ))}
          </nav>
        </aside>
        <div className={`min-w-0 flex-1 space-y-4 ${gmailNavOpen ? 'hidden lg:block' : ''}`}>
      <div id="email-tx-results" className="rounded-2xl border bg-card overflow-hidden scroll-mt-20 shadow-sm">
        {/* Prominent, full-width search bar — lets ops find any email by
            amount, name, phone (any format), reference id, or any word in
            the body / subject. Sticky on scroll so it's always reachable. */}
        <div className="p-3.5 border-b bg-card/95 backdrop-blur sm:sticky sm:top-0 sm:z-10 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h3 className="font-medium text-sm flex items-center gap-2">
              <Mail className="h-3.5 w-3.5 text-muted-foreground" />
              <button
                type="button"
                onClick={() => {
                  // Clicking "Recent emails" narrows the list to the last 7 days
                  // (the standard "recent" window) and clears the free-text search
                  // so the date filter is actually applied.
                  const todayKey = dateKeyInTz(new Date(), tz);
                  const [y, m, d] = todayKey.split('-').map(Number);
                  const toUtc = Date.UTC(y, m - 1, d);
                  const fromUtc = toUtc - 6 * 86_400_000; // inclusive 7-day window
                  const fmtKey = (ms: number) => {
                    const dt = new Date(ms);
                    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
                  };
                  setSearchQuery('');
                  setPhoneQuery('');
                  setFromDate(fmtKey(fromUtc));
                  setToDate(fmtKey(toUtc));
                  if (typeof document !== 'undefined') {
                    document.getElementById('email-tx-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                }}
                className="hover:underline underline-offset-4 decoration-muted-foreground/40 cursor-pointer"
                aria-label="Show recent emails (last 7 days)"
                title="Show recent emails (last 7 days)"
              >
                Recent emails
              </button>
              {unreadAlertCount > 0 && (
                <Badge
                  variant="outline"
                  className="border-orange-600/40 text-orange-600 text-[10px] font-mono font-normal"
                  aria-label={`${unreadAlertCount} unread items needing attention`}
                >
                  {unreadAlertCount} new
                </Badge>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => setAlertSettingsOpen(true)}
                aria-label="Alert notification settings"
                title="Alert notification settings"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
              </Button>
            </h3>
            <div className="flex items-center gap-2">
              {searchActive && (
                <span className="text-xs text-muted-foreground">
                  {filteredRows.length} match{filteredRows.length === 1 ? '' : 'es'}
                </span>
              )}
            </div>
          </div>
          {/* Mobile quick date windows. Flow/status narrowing lives in the
              left label rail (Inbox / Money in / Money out / Needs routing /
              Unparsed / Credited). */}
          <div className="sm:hidden -mx-1 overflow-x-auto">
            <div className="flex items-center gap-1.5 px-1 pb-1 w-max">
              {([
                { label: 'Today', days: 1, offset: 0 },
                { label: '7d', days: 7, offset: 0 },
                { label: '30d', days: 30, offset: 0 },
              ] as Array<{ label: string; days: number; offset: number }>).map((p) => {
                const applyPreset = () => {
                  const todayKey = dateKeyInTz(new Date(), tz);
                  const [y, m, d] = todayKey.split('-').map(Number);
                  const toUtc = Date.UTC(y, m - 1, d) - p.offset * 86_400_000;
                  const fromUtc = toUtc - (p.days - 1) * 86_400_000;
                  const fmtKey = (ms: number) => {
                    const dt = new Date(ms);
                    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
                  };
                  setSearchQuery('');
                  setFromDate(fmtKey(fromUtc));
                  setToDate(fmtKey(toUtc));
                };
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={applyPreset}
                    className="shrink-0 text-[11px] px-2.5 py-1 rounded-full border bg-background hover:bg-muted text-muted-foreground border-border"
                  >
                    {p.label}
                  </button>
                );
              })}
              {/* Custom window — same from/to state the desktop date inputs use,
                  so a hand-picked range behaves exactly like a preset. */}
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="shrink-0 inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border bg-background hover:bg-muted text-muted-foreground border-border"
                    aria-label="Pick a custom date range"
                  >
                    <CalendarRange className="h-3 w-3" />
                    Custom
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 p-3 space-y-2 z-[200] pointer-events-auto">
                  <p className="text-[11px] font-medium">Custom date range</p>
                  <div className="space-y-1.5">
                    <label className="block text-[10px] uppercase tracking-wide text-muted-foreground">From</label>
                    <Input
                      type="date"
                      value={fromDate}
                      max={toDate || undefined}
                      onChange={(e) => { setSearchQuery(''); setFromDate(e.target.value); }}
                      className="h-9 text-sm"
                      aria-label="Custom range date from"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-[10px] uppercase tracking-wide text-muted-foreground">To</label>
                    <Input
                      type="date"
                      value={toDate}
                      min={fromDate || undefined}
                      onChange={(e) => { setSearchQuery(''); setToDate(e.target.value); }}
                      className="h-9 text-sm"
                      aria-label="Custom range date to"
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Both ends are inclusive, in {tz.split('/').pop()} time.
                  </p>
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </div>
        
        <div className="p-3 sm:p-4 border-b sticky top-[104px] z-[18] bg-card sm:static sm:z-auto">
          {/* Saved filter presets — one-tap switching between saved views.
              Always visible (mobile-first) so operators never have to expand the
              chip groups to restore a triage view. */}
          <div className="mt-2 sm:mt-0 sm:mb-3">
            <div className="flex items-center gap-1 overflow-x-auto pb-1" role="group" aria-label="Saved filter presets">
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground pr-1">Views</span>
              {filterPresets.length === 0 && (
                <span className="shrink-0 text-[11px] text-muted-foreground">None saved yet</span>
              )}
              {filterPresets.map((p) => {
                const active = activePresetId === p.id;
                return (
                  <span
                    key={p.id}
                    className={`shrink-0 inline-flex items-center gap-1 rounded-full border pl-2.5 pr-1 py-1 text-[11px] transition-colors ${
                      active
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background hover:bg-muted text-muted-foreground border-border'
                    }`}
                  >
                    <button type="button" onClick={() => applyPreset(p)} aria-pressed={active} className="max-w-[120px] truncate">
                      {p.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => deletePreset(p.id)}
                      aria-label={`Delete preset ${p.name}`}
                      className="opacity-70 hover:opacity-100 p-0.5"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                );
              })}
              <button
                type="button"
                onClick={() => setPresetSaveOpen((v) => !v)}
                className="shrink-0 inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-[11px] font-medium hover:bg-muted"
              >
                <Star className="h-3 w-3" /> Save view
              </button>
            </div>
            {presetSaveOpen && (
              <div className="mt-2 flex items-center gap-2">
                <Input
                  value={presetNameDraft}
                  onChange={(e) => setPresetNameDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') savePreset(); }}
                  placeholder="Name this view (e.g. Needs routing)"
                  className="h-8 text-xs"
                  aria-label="Preset name"
                />
                <Button size="sm" className="h-8 text-xs" onClick={savePreset} disabled={!presetNameDraft.trim()}>
                  Save
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* ── Gmail list toolbar: refresh on the left, result count on the
            right — the strip that sits above every Gmail inbox. ────────── */}
        <div className="flex items-center justify-between gap-2 border-b px-2 py-1.5">
          <div className="flex items-center gap-0.5">
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 rounded-full"
              onClick={() => load()}
              disabled={loading}
              aria-label="Refresh"
              title="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 rounded-full"
              onClick={() => setAlertSettingsOpen(true)}
              aria-label="View settings"
              title="View settings"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          </div>
          <span className="pr-1 text-[11px] tabular-nums text-muted-foreground">
            {visibleRows.length} of {rows.length}
          </span>
        </div>

        {!loading && loadError && rows.length > 0 && (
          <div className="mx-3 mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
            <span className="font-semibold">Partial load</span> — some emails could not be read:{' '}
            <span className="font-mono break-all">{loadError.message}</span>
          </div>
        )}
        {loading ? (
          <div className="p-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : rows.length === 0 && loadError?.denied ? (
          <div className="p-10 text-center text-sm space-y-2">
            <ShieldAlert className="h-8 w-8 mx-auto text-destructive opacity-70" />
            <p className="font-semibold text-destructive">Access denied — you can't read the transaction emails</p>
            <p className="text-xs text-muted-foreground max-w-md mx-auto">
              This is a permission problem, not an empty inbox. Your account can open Financial Ops but is not
              allowed to read captured emails. Ask a manager to grant you the Financial Ops dashboard permission.
            </p>
            <p className="text-[10px] text-muted-foreground/80 font-mono break-all">{loadError.message}</p>
          </div>
        ) : rows.length === 0 && loadError ? (
          <div className="p-10 text-center text-sm space-y-2">
            <AlertTriangle className="h-8 w-8 mx-auto text-warning opacity-70" />
            <p className="font-semibold">Could not load transaction emails</p>
            <p className="text-[10px] text-muted-foreground/80 font-mono break-all">{loadError.message}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => load()}>Try again</Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground space-y-2">
            <Mail className="h-8 w-8 mx-auto opacity-30" />
            <p>No transaction emails captured yet.</p>
            <p className="text-xs">Click <strong>Poll now</strong> to check Gmail for new emails, or just wait a minute — it checks on its own.</p>
          </div>
        ) : (
          <div className="divide-y max-h-[calc(100vh-16rem)] min-h-[420px] overflow-y-auto">
            {selectedIds.size > 0 && (
              <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b bg-background/95 backdrop-blur px-3 py-2 shadow-sm">
                <div className="text-xs font-medium">
                  <span className="text-primary">{selectedIds.size}</span> selected
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={bulkBusy || alertRows.length === 0}
                    onClick={selectAllAlertRows}
                  >
                    Select unresolved ({alertRows.length})
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={bulkBusy || visibleRows.length === 0}
                    onClick={() => setSelectedIds(new Set(visibleRows.map((r) => r.id)))}
                  >
                    Select all shown ({visibleRows.length})
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={bulkBusy}
                    onClick={() => startRouteQueue(visibleRows.filter((r) => selectedIds.has(r.id)))}
                  >
                    <Zap className="h-3.5 w-3.5 mr-1" /> Route selected ({selectedIds.size})
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={bulkBusy}
                    onClick={() => startHistoryQueue(visibleRows.filter((r) => selectedIds.has(r.id)))}
                  >
                    <History className="h-3.5 w-3.5 mr-1" /> Open history ({selectedIds.size})
                  </Button>
                  <Button
                    size="sm"
                    disabled={bulkBusy}
                    onClick={() => resolveAlertRows(alertRows.filter((r) => selectedIds.has(r.id)))}
                  >
                    {bulkBusy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
                    Resolve selected alerts
                  </Button>
                  <Button size="sm" variant="outline" disabled={bulkBusy} onClick={() => applyBulkMark('credited')}>
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Mark as paid in
                  </Button>
                  <Button size="sm" variant="outline" disabled={bulkBusy} onClick={() => applyBulkMark('uncredited')}>
                    <Undo2 className="h-3.5 w-3.5 mr-1" /> Mark as not paid in
                  </Button>
                  <Button size="sm" variant="ghost" disabled={bulkBusy} onClick={() => setSelectedIds(new Set())}>
                    Clear
                  </Button>
                </div>
              </div>
            )}
            {focusView === 'gmail' ? (
              // Every label (Inbox / Money in / Money out / Needs routing /
              // Unparsed / Credited) renders as a Gmail inbox that endlessly
              // scrolls through ALL rows behind that label's count.
              <GmailStyleEmailList
                rows={visibleRows}
                onCreditUser={(row, user) => {
                  const transaction = visibleRows.find((candidate) => candidate.id === row.id);
                  if (!transaction) return;
                  navigateToRow(transaction, 'credit', {
                    id: user.id,
                    full_name: user.full_name,
                    phone: user.phone,
                  });
                }}
              />
            ) : (() => {
              const totalPages = Math.max(1, Math.ceil(visibleRows.length / pageSize));
              const safePage = Math.min(currentPage, totalPages);
              const isInfinite = paginationMode === 'infinite';
              const shownCount = isInfinite
                ? Math.min(infiniteCount, visibleRows.length)
                : Math.min(safePage * pageSize, visibleRows.length);
              const startIdx = isInfinite ? 0 : (safePage - 1) * pageSize;
              const pageRows = isInfinite
                ? visibleRows.slice(0, shownCount)
                : visibleRows.slice(startIdx, startIdx + pageSize);
              (window as any).__emailPaginationMeta = {
                totalPages, safePage, total: visibleRows.length, mode: paginationMode, shownCount,
              };
              return pageRows.map((r) => {
                const matches = userMatches[r.id] ?? [];
                const hasRef = matches.some((u) => u.matched_on.startsWith('reference '));
                const hasFrom = matches.some((u) => u.matched_on.startsWith('from '));
                const isConfident = hasRef || hasFrom;
                const isFlagged = r.parsed && !validity.get(r.id)!.valid;
                const history = routingHistory[r.id] ?? [];
                const isRouted = history.length > 0;
                const isReversed = history.some((h) => /revers/i.test(h.reason || ''));
                // Auto-debited rows: a withdrawable debit posted by the
                // auto-debit run. Detected from the routing history reason
                // (prefixed "DEBIT (auto, ...)" or "DEBIT (sweep, ...)") so the
                // badge survives reloads. Matches both the realtime poller and
                // the backlog sweep.
                const autoDebitEntry = history.find(
                  (h) => h.route === 'withdrawable_debit' && /^DEBIT\b/i.test(h.reason || ''),
                );
                const isAutoDebited = !!autoDebitEntry && !isReversed;
                const autoImpact = autoDebitResults[r.id];
                // Whether the debit landed on a managed proxy agent's wallet
                // (user had insufficient balance). Detected from the reason
                // string written by the edge functions.
                const isProxyDebit = /via managed proxy/i.test(autoDebitEntry?.reason || '');
                const debitedName = autoDebitEntry?.target_user_name
                  || autoImpact?.userName || 'matched user';
                // Clean, human-readable reason for the debit. The edge function
                // writes "DEBIT (auto|sweep, <method>[, via managed proxy for
                // <partner>][, partial …]): <reason>". Split off the leading tag
                // so the breakdown can show the routing context and the reason
                // separately.
                const rawDebitReason = autoDebitEntry?.reason || '';
                const debitReasonText =
                  rawDebitReason.includes('):')
                    ? rawDebitReason.slice(rawDebitReason.indexOf('):') + 2).trim()
                    : rawDebitReason.trim();
                const debitProxyPartner = (() => {
                  const m = rawDebitReason.match(/via managed proxy for ([^,):]+)/i);
                  return m ? m[1].trim() : null;
                })();
                const debitIsPartial = /partial/i.test(rawDebitReason);
                const debitAmountValue = autoDebitEntry?.amount ?? autoImpact?.amount ?? Number(r.amount ?? 0);
                // The wallet that actually got charged. For a managed-proxy
                // debit this is the proxy agent's own wallet, so we can surface
                // their current ledger-derived balance straight on the email.
                const debitTargetId = autoDebitEntry?.target_user_id ?? null;
                const debitWalletBalance = debitTargetId ? userBalances[debitTargetId] : undefined;
                // Already-credited incoming deposit (linked to a non-terminal
                // deposit_request by the poller). Distinct emerald treatment
                // tells reviewers this email's money already landed in the
                // shown user's wallet — DO NOT credit again.
                const credited = creditedDeposits[r.id] ?? [];
                const manualMark = manualMarks[r.id];
                const isCredited = manualMark
                  ? manualMark.mark === 'credited'
                  : credited.length > 0;
                const totalCredited = credited.reduce((s, c) => s + c.amount, 0);
                const emailAmount = Number(r.amount ?? 0);
                const creditShortfall = emailAmount > 0 ? Math.max(0, emailAmount - totalCredited) : 0;
                const isFullyCredited = manualMark?.mark === 'credited'
                  ? true
                  : (emailAmount > 0 && totalCredited >= emailAmount);
                // True when at least one credited deposit was matched to this
                // email by its transaction reference (TID). Drives the clear
                // "Already Credited — No Routing Needed" status.
                const matchedByTid = credited.some((c) => c.matched_by_tid);
                const matchedTid = credited.find((c) => c.matched_tid)?.matched_tid ?? null;
                // Auto-credit provenance: which signal resolved the wallet and
                // how confident the matcher was. phone_source='body' at ≈0.6 is
                // the "possible user ≈60%" body-phone signal — surface it plainly
                // so reviewers know to spot-check those credits.
                const autoCredit = credited.find((c) => c.auto_confidence || c.auto_phone_source || c.auto_match_method);
                const autoConfidence = autoCredit?.auto_confidence ?? null;
                const autoScore = autoCredit?.auto_confidence_score ?? null;
                const autoPhoneSource = autoCredit?.auto_phone_source ?? null;
                const autoScorePct = typeof autoScore === 'number' ? Math.round(autoScore * 100) : null;
                const isBodyPhoneCredit = autoPhoneSource === 'body';
                // ── "Not Matched Yet" diagnostics ─────────────────────────
                // For an incoming deposit email that hasn't been credited or
                // routed, surface WHY it can't auto-map to a wallet: which of
                // the two reference signals (MoMo TID vs cash receipt code) the
                // email carries, and whether a depositing user was matched.
                const normTidForRow = normalizeMomoTid(r.transaction_id ?? '');
                const hasMomoTid = normTidForRow.length >= 6;
                const receiptCodeForRow = extractCashReceiptCode(r);
                const hasReceiptCode = !!receiptCodeForRow;
                const hasUserMatch = (userMatches[r.id]?.length ?? 0) > 0;
                // ── Insufficient-funds warning for outgoing payouts ───────
                // When an outgoing email (sent / charge) is matched to a
                // user wallet whose current balance cannot cover the payout
                // amount, this row is about to fail on debit. Make it
                // visually unignorable so reviewers don't blindly auto-debit
                // or approve a doomed withdrawal.
                const isOutgoing = r.direction === 'out' || r.direction === 'charge';
                const outAmount = Number(r.amount ?? 0);
                const rankedMatches = isOutgoing && outAmount > 0
                  ? [...matches]
                      .map((u) => {
                        const mo = u.matched_on;
                        const score = mo.startsWith('reference ')
                          ? 100
                          : mo.startsWith('from ') || mo.startsWith('to ')
                            ? 90
                            : mo.startsWith('name-')
                              ? 75
                              : 60;
                        return { u, score };
                      })
                      .sort((a, b) => b.score - a.score)
                  : [];
                const topMatch = rankedMatches[0]?.u;
                const topBal = topMatch ? userBalances[topMatch.id] : undefined;
                const isInsufficientPayout =
                  isOutgoing &&
                  !isRouted &&
                  outAmount > 0 &&
                  !!topMatch &&
                  typeof topBal === 'number' &&
                  topBal < outAmount;
                const shortfall = isInsufficientPayout
                  ? Math.max(0, outAmount - (topBal as number))
                  : 0;
                // Build a screen-reader description of the row's match status so
                // assistive tech announces *why* this row is highlighted, not
                // just that it's styled differently.
                const matchAriaLabel = isConfident
                  ? (() => {
                      const names = matches
                        .filter((u) => u.matched_on.startsWith('reference ') || u.matched_on.startsWith('from '))
                        .map((u) => u.full_name)
                        .slice(0, 3)
                        .join(', ');
                      const types = [hasRef && 'reference ID', hasFrom && 'sender phone'].filter(Boolean).join(' and ');
                      const extra = matches.length > 3 ? ` and ${matches.length - 3} more` : '';
                      return `Confident match by ${types}: ${names}${extra}`;
                    })()
                  : isFlagged
                    ? 'Flagged: parsed amount needs manual review'
                    : matches.length
                      ? `Possible user match (low confidence): ${matches.map((u) => u.full_name).slice(0, 3).join(', ')}`
                      : 'No depositing user matched';
                // Primary swipe action for this row — mirrors the on-row CTA:
                // incoming uncredited deposits go to a wallet (credit), outgoing
                // unrouted payouts charge a wallet (debit). Anything already
                // settled has no swipe action.
                const swipeAction: SwipeAction | null =
                  r.direction === 'in' && !isCredited && !isRouted
                    ? {
                        label: 'Send to wallet',
                        hint: 'Route deposit',
                        icon: <Zap className="h-5 w-5" />,
                        colorClass: 'bg-emerald-600',
                        onAction: () => setPendingSwipe({ row: r, mode: 'credit' }),
                        ariaLabel: `Send deposit of ${fmtUgx(Number(r.amount ?? 0))}${r.counterparty ? ` from ${r.counterparty}` : ''} to a wallet`,
                      }
                    : isOutgoing && !isRouted && !isAutoDebited && Number(r.amount ?? 0) > 0
                      ? {
                          label: 'Charge wallet',
                          hint: 'Debit user',
                          icon: <Wallet className="h-5 w-5" />,
                          colorClass: 'bg-rose-600',
                          onAction: () => setPendingSwipe({ row: r, mode: 'debit' }),
                          ariaLabel: `Charge wallet ${fmtUgx(Number(r.amount ?? 0))}${r.counterparty ? ` for payout to ${r.counterparty}` : ''}`,
                        }
                      : null;
                // Secondary swipe action (swipe RIGHT): for money-in rows that
                // still need attention, mark the email resolved without opening
                // the row. Already-settled rows instead open the full routing
                // history so operators can audit with one gesture.
                const swipeSecondaryAction: SwipeAction | null =
                  !manualMark && r.direction === 'in' && !isCredited
                    ? {
                        label: 'Mark resolved',
                        hint: 'Resolve',
                        icon: <CheckCircle2 className="h-5 w-5" />,
                        colorClass: 'bg-sky-600',
                        onAction: () => setPendingSwipe({ row: r, mode: 'resolve' }),
                        ariaLabel: `Mark this ${fmtUgx(Number(r.amount ?? 0))} email${r.counterparty ? ` from ${r.counterparty}` : ''} as resolved`,
                      }
                    : {
                        label: 'View history',
                        hint: 'History',
                        icon: <History className="h-5 w-5" />,
                        colorClass: 'bg-slate-600',
                        onAction: () => setHistoryDrawerRow(r),
                        ariaLabel: `View routing history for this ${fmtUgx(Number(r.amount ?? 0))} email`,
                      };
                // ── Consolidated "latest outcome" status ──────────────────
                // A single, plain-language pill shown at the top of the row so
                // reviewers can verify what happened to the money WITHOUT
                // opening the details view. Priority: reversed → credited →
                // charged/auto-debited → routed → still pending.
                const latestRouteEntry = history[0] ?? null;
                // Resolve the timestamp AND the exact underlying field it came
                // from, so the tooltip can label it precisely (e.g. the routing
                // history `created_at` vs a deposit's `credited_at` vs a manual
                // mark's `created_at`).
                const outcomeWhenSource: { when: string; label: string; field: string } | null =
                  latestRouteEntry?.created_at
                    ? {
                        when: latestRouteEntry.created_at,
                        label: isReversed
                          ? 'Reversed at'
                          : (latestRouteEntry.route === 'withdrawable_debit' || /^DEBIT\b/i.test(latestRouteEntry.reason || ''))
                            ? 'Charged at'
                            : 'Routed at',
                        field: 'email_routing_history.created_at',
                      }
                    : isCredited && credited[0]?.credited_at
                      ? {
                          when: credited[0].credited_at,
                          label: 'Credited at',
                          field: 'deposit_requests.credited_at',
                        }
                      : manualMark?.created_at
                        ? {
                            when: manualMark.created_at,
                            label: `Manually marked ${manualMark.mark === 'credited' ? 'paid in' : 'not paid in'} at`,
                            field: 'email_credit_manual_marks.created_at',
                          }
                        : null;
                const outcomeWhen = outcomeWhenSource?.when ?? null;
                const outcomeStatus: {
                  label: string;
                  detail: string;
                  tone: string;
                  tip: string;
                } | null = isReversed
                  ? {
                      label: 'Reversed',
                      detail: `Previous routing was reversed${latestRouteEntry?.routed_by_name ? ` by ${latestRouteEntry.routed_by_name}` : ''}.`,
                      tone: 'bg-amber-500/15 text-amber-700 border-amber-500/30',
                      tip: 'A previous credit or charge was undone. The money is back where it started — re-route it to the correct wallet if needed.',
                    }
                  : isCredited
                    ? {
                        label: isFullyCredited ? 'Credited' : 'Partially credited',
                        detail: isFullyCredited
                          ? `${fmtUgx(totalCredited)} landed in the wallet.`
                          : `${fmtUgx(totalCredited)} of ${fmtUgx(emailAmount)} credited — ${fmtUgx(creditShortfall)} still short.`,
                        tone: isFullyCredited
                          ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30'
                          : 'bg-amber-500/15 text-amber-700 border-amber-500/30',
                        tip: isFullyCredited
                          ? 'The full email amount has already reached a user wallet. Nothing more to do — do not route it again.'
                          : 'Only part of the email amount has reached a wallet. Route the remaining shortfall to complete it.',
                      }
                    : isAutoDebited
                      ? {
                          label: isProxyDebit ? 'Charged (proxy)' : 'Charged',
                          detail: `${fmtUgx(debitAmountValue)} charged to ${debitedName}'s wallet${debitIsPartial ? ' (partial)' : ''}.`,
                          tone: 'bg-rose-500/15 text-rose-700 border-rose-500/30',
                          tip: isProxyDebit
                            ? "The user had insufficient balance, so this payout was charged to their managed proxy agent's wallet."
                            : "This payout was charged from the matched user's wallet. The money has left their balance.",
                        }
                      : isRouted && latestRouteEntry
                        ? {
                            label: 'Routed',
                            detail: `${fmtUgx(latestRouteEntry.amount ?? emailAmount)} routed to ${latestRouteEntry.target_user_name || 'a wallet'}${latestRouteEntry.routed_by_name ? ` by ${latestRouteEntry.routed_by_name}` : ''}.`,
                            tone: 'bg-violet-500/15 text-violet-700 border-violet-500/30',
                            tip: 'A staff member manually sent this money to a wallet. The recipient and who routed it are shown in the detail.',
                          }
                        : r.direction === 'in'
                          ? {
                              label: 'Awaiting routing',
                              detail: 'This deposit has not been sent to a wallet yet.',
                              tone: 'bg-muted text-muted-foreground border-border',
                              tip: 'Incoming money that has not reached any wallet. It still needs action — route it to the correct user.',
                            }
                          : isOutgoing && outAmount > 0
                            ? {
                                label: 'Not charged yet',
                                detail: 'This payout has not been charged to a wallet yet.',
                                tone: 'bg-muted text-muted-foreground border-border',
                                tip: "Outgoing money that has not been charged to any wallet yet. Charge it to the payer's wallet when ready.",
                              }
                            : null;
                return (
              <SwipeableEmailRow key={r.id} action={swipeAction} secondaryAction={swipeSecondaryAction}>
              <div
                role="article"
                aria-label={matchAriaLabel}
                data-match-status={isConfident ? 'confident' : isFlagged ? 'flagged' : 'none'}
                className={`p-4 transition-colors ${
                  isInsufficientPayout
                    // Loudest treatment in the list: thick destructive accent,
                    // tinted surface, persistent ring, and a slow pulse so
                    // the row catches the eye even when scrolling fast.
                    ? 'bg-destructive/15 hover:bg-destructive/20 border-l-8 border-l-destructive ring-2 ring-destructive/40 ring-inset shadow-sm focus-within:ring-2 focus-within:ring-destructive/60'
                    : isCredited
                    // Already-credited incoming deposits get a distinct
                    // treatment so reviewers can scan the list and see at a
                    // glance which emails have already landed in a wallet.
                    // Partial credits use amber (needs attention); fully
                    // credited use emerald (safe to skip).
                    ? isFullyCredited
                      ? 'bg-emerald-500/10 hover:bg-emerald-500/15 border-l-4 border-l-emerald-500 focus-within:ring-2 focus-within:ring-emerald-500/40'
                      : 'bg-amber-500/10 hover:bg-amber-500/15 border-l-4 border-l-amber-500 focus-within:ring-2 focus-within:ring-amber-500/40'
                    : isRouted
                    // Routed rows get a distinct violet treatment so reviewers
                    // can scan the list and immediately see which emails have
                    // already been re-routed (and how many times).
                    ? 'bg-violet-500/10 hover:bg-violet-500/15 border-l-4 border-l-violet-500 focus-within:ring-2 focus-within:ring-violet-500/40'
                    : isConfident
                    // Stronger primary tint (10/20 vs 5/10) + 4px accent border for
                    // clear contrast against the surrounding card surface. Adds a
                    // visible focus-within ring so keyboard users see the row.
                    ? 'bg-primary/10 hover:bg-primary/20 border-l-4 border-l-primary focus-within:ring-2 focus-within:ring-primary/40'
                    : isFlagged
                      ? 'bg-amber-500/10 hover:bg-amber-500/20 border-l-4 border-l-amber-500 focus-within:ring-2 focus-within:ring-amber-500/40'
                      : 'hover:bg-muted/40 border-l-4 border-l-transparent'
                }`}
              >
                {/* Visually hidden status line — keeps the announcement consistent
                    for SR users even if the visual chips reflow on narrow screens. */}
                <span className="sr-only">{matchAriaLabel}.</span>
                {outcomeStatus && (
                  // Consolidated latest routing/charging outcome, shown at the
                  // top of the row so reviewers can verify the result without
                  // opening the details view.
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <BadgeTip
                      plain={outcomeStatus.tip}
                      details={
                        outcomeWhenSource
                          ? `${outcomeWhenSource.label} ${new Date(outcomeWhenSource.when).toLocaleString()} (from ${outcomeWhenSource.field}).`
                          : 'No action has been recorded for this row yet.'
                      }
                    >
                      <Badge
                        variant="outline"
                        className={`text-[11px] font-semibold ${outcomeStatus.tone}`}
                      >
                        {outcomeStatus.label}
                      </Badge>
                    </BadgeTip>
                    <span className="text-[11px] text-muted-foreground min-w-0 truncate">
                      {outcomeStatus.detail}
                    </span>
                    {outcomeWhen && (
                      <span className="text-[10px] text-muted-foreground/80 whitespace-nowrap">
                        {new Date(outcomeWhen).toLocaleString()}
                      </span>
                    )}
                  </div>
                )}
                {isInsufficientPayout && (
                  // Unignorable banner above the row body. Explains the
                  // exact reason in plain language so reviewers can act
                  // (top up, change recipient, or skip) instead of pushing
                  // a debit that will bounce back with NEGATIVE_WALLET_BLOCKED.
                  <div
                    role="alert"
                    className="mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive"
                  >
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <div className="text-xs leading-snug">
                      <p className="font-semibold uppercase tracking-wide text-[11px]">
                        Insufficient funds — debit will be blocked
                      </p>
                      <p className="mt-0.5 text-destructive/90">
                        Payout of <strong>{fmtUgx(outAmount)}</strong> to{' '}
                        <strong>{topMatch?.full_name ?? 'matched user'}</strong>, but their wallet balance is only{' '}
                        <strong>{fmtUgx(topBal as number)}</strong>{' '}
                        (short by <strong>{fmtUgx(shortfall)}</strong>). Top up the wallet, pick a different recipient, or skip — do not auto-debit.
                      </p>
                    </div>
                  </div>
                )}
                {/* On phones the amount/action column drops to its own full-width
                    row underneath the details. Keeping it inline (shrink-0 with
                    non-wrapping button labels) squeezed the details column down
                    to ~120px and broke every sentence one word per line. */}
                <div className="flex flex-wrap items-start gap-x-3 gap-y-2 sm:flex-nowrap sm:justify-between sm:gap-4">
                  <div className="pt-0.5 shrink-0">
                    <Checkbox
                      checked={selectedIds.has(r.id)}
                      onCheckedChange={(v) => {
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (v) next.add(r.id); else next.delete(r.id);
                          return next;
                        });
                      }}
                      aria-label="Select email for bulk action"
                    />
                    {manualMark && (
                      <div
                        className={`mt-1 text-[9px] uppercase tracking-wide font-semibold ${
                          manualMark.mark === 'credited' ? 'text-emerald-600' : 'text-amber-600'
                        }`}
                        title={`${manualMark.mark} by ${manualMark.marked_by_name || manualMark.marked_by} at ${new Date(manualMark.created_at).toLocaleString()}${manualMark.reason ? ' — ' + manualMark.reason : ''}`}
                      >
                        {manualMark.mark === 'credited' ? '✓ marked paid in' : '↺ marked not paid in'}
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1 basis-[calc(100%-2.25rem)] sm:basis-auto">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">{r.from_name || r.from_email || 'Unknown'}</span>
                      {r.parsed ? (
                        <BadgeTip plain="We understood this email and found the money amount inside it.">
                          <Badge variant="secondary" className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-500/20">read OK</Badge>
                        </BadgeTip>
                      ) : (
                        <BadgeTip plain="We could not pull a money amount out of this email, so a person needs to look at it.">
                          <Badge variant="outline" className="text-[10px]">couldn't read</Badge>
                        </BadgeTip>
                      )}
                      {r.parsed && !validity.get(r.id)!.valid && (
                        <BadgeTip
                          plain="Something looks off about this email — please give it a quick look."
                          details={validity.get(r.id)!.reason}
                        >
                          <Badge
                            variant="outline"
                            className="text-[10px] bg-amber-500/10 text-amber-700 border-amber-500/30 gap-1"
                          >
                            <AlertTriangle className="h-3 w-3" /> please check
                          </Badge>
                        </BadgeTip>
                      )}
                      {(() => {
                        const resolved = ch(r);
                        if (resolved.channel === 'other') return null;
                        const inferred = !r.channel || r.channel === 'other';
                        const score = confidenceScore(resolved.confidence);
                        const tone =
                          resolved.confidence === 'authoritative' || resolved.confidence === 'high'
                            ? 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20'
                            : resolved.confidence === 'medium'
                            ? 'bg-sky-500/10 text-sky-700 border-sky-500/20'
                            : 'bg-amber-500/10 text-amber-700 border-amber-500/30';
                        // Multi-line tooltip explaining exactly which rule fired,
                        // which field on the row it inspected, and the matched
                        // fragment so reviewers can audit the inference.
                        const sourceLabel: Record<string, string> = {
                          transaction_id: 'transaction id',
                          subject: 'email subject',
                          snippet: 'email snippet',
                          from: 'sender',
                          body: 'email body',
                          parser: 'parser',
                        };
                        const lines = inferred
                          ? [
                              `Channel: ${resolved.channel.replace(/_/g, ' ')}`,
                              `Rule: ${resolved.signal}${resolved.rule ? ` (${resolved.rule})` : ''}`,
                              resolved.source ? `Matched in: ${sourceLabel[resolved.source] ?? resolved.source}` : null,
                              resolved.match ? `Match: "${resolved.match}"` : null,
                              `Confidence: ${resolved.confidence} (${score}%)`,
                            ]
                          : [
                              `Channel: ${resolved.channel.replace(/_/g, ' ')}`,
                              'Source: parser-assigned by the email importer',
                              `Confidence: ${resolved.confidence} (${score}%)`,
                            ];
                        const tip = lines.filter(Boolean).join('\n');
                        return (
                          <BadgeTip
                            plain="How we think this money was sent (the payment channel), and how sure we are."
                            details={tip}
                          >
                            <Badge
                              variant="outline"
                              className={`text-[10px] capitalize gap-1 ${tone}`}
                            >
                              {resolved.channel.replace(/_/g, ' ')}
                              {inferred && <span className="opacity-70">•</span>}
                              <span className="font-mono tabular-nums opacity-80">{score}%</span>
                            </Badge>
                          </BadgeTip>
                        );
                      })()}
                      <button
                        type="button"
                        onClick={() => setEditingRow(r)}
                        title="Fix channel & save a rule"
                        className="inline-flex items-center justify-center h-5 w-5 rounded border border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/60"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      {r.direction && (
                        <BadgeTip
                          plain={
                            r.direction === 'in'
                              ? 'Money came in — a deposit or payment was received.'
                              : r.direction === 'out'
                              ? 'Money went out — a payment was sent.'
                              : 'A fee or charge, not a deposit.'
                          }
                        >
                          <Badge variant="outline" className={`text-[10px] capitalize ${
                            r.direction === 'in' ? 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20'
                            : r.direction === 'out' ? 'bg-rose-500/10 text-rose-700 border-rose-500/20'
                            : 'bg-amber-500/10 text-amber-700 border-amber-500/20'
                          }`}>{r.direction === 'in' ? 'money in' : r.direction === 'out' ? 'money out' : 'fee'}</Badge>
                        </BadgeTip>
                      )}
                      {r.transaction_id && (
                        <BadgeTip plain="The transaction / receipt code taken from this email. We use it to match the payment.">
                          <Badge variant="outline" className="text-[10px] font-mono">{r.transaction_id}</Badge>
                        </BadgeTip>
                      )}
                      {r.direction === 'in' && inviteSms[r.id] && (
                        <BadgeTip
                          plain={
                            inviteSms[r.id].status === 'sent'
                              ? 'The depositor was texted a link to sign up / log in to Welile.'
                              : 'We tried to text the depositor a sign-up / log-in link but it failed to send.'
                          }
                          details={[
                            `To: ${inviteSms[r.id].phone}`,
                            `Status: ${inviteSms[r.id].status}`,
                            `When: ${new Date(inviteSms[r.id].created_at).toLocaleString()}`,
                            inviteSms[r.id].error ? `Error: ${inviteSms[r.id].error}` : null,
                          ].filter(Boolean).join('\n')}
                        >
                          <Badge
                            variant="outline"
                            className={`text-[10px] gap-1 ${
                              inviteSms[r.id].status === 'sent'
                                ? 'bg-sky-500/10 text-sky-700 border-sky-500/30'
                                : 'bg-rose-500/10 text-rose-700 border-rose-500/30'
                            }`}
                          >
                            <Smartphone className="h-3 w-3" />
                            {inviteSms[r.id].status === 'sent' ? 'invite SMS sent' : 'invite SMS failed'}
                          </Badge>
                        </BadgeTip>
                      )}
                      {isRouted && (
                        <BadgeTip
                          plain={
                            isReversed
                              ? 'This money was sent again: the first credit was undone, then it was put in the right wallet.'
                              : 'A staff member already put this money into a user wallet.'
                          }
                          details={
                            isReversed
                              ? 'Re-routed with a reversal against the original auto-credit.'
                              : 'Manually routed by Financial Ops.'
                          }
                        >
                          <Badge
                            variant="outline"
                            className={`text-[10px] gap-1 ${
                              isReversed
                                ? 'bg-rose-500/10 text-rose-700 border-rose-500/30'
                                : 'bg-violet-500/15 text-violet-700 border-violet-500/30'
                            }`}
                          >
                            <ArrowRight className="h-3 w-3" />
                            {isReversed ? 'sent again (undone first)' : 'sent to wallet'}
                            {history.length > 1 && (
                              <span className="font-mono tabular-nums opacity-80">×{history.length}</span>
                            )}
                          </Badge>
                        </BadgeTip>
                      )}
                      {isAutoDebited && (
                        <BadgeTip
                          plain={isProxyDebit
                            ? "The user had too little balance, so this amount was automatically taken from their managed proxy agent's wallet."
                            : "The system automatically took this amount from the user's wallet."}
                          details={[
                            `Auto-debited from ${debitedName}'s withdrawable wallet${isProxyDebit ? ' (managed proxy agent)' : ''}`,
                            `Amount taken: ${fmtUgx(autoDebitEntry?.amount ?? autoImpact?.amount ?? r.amount)}`,
                            autoImpact && autoImpact.newAvail !== null
                              ? `Wallet left: ${fmtUgx(autoImpact.newAvail)}`
                              : null,
                          ].filter(Boolean).join('\n')}
                        >
                          <Badge
                            variant="outline"
                            className={`text-[10px] gap-1 ${isProxyDebit
                              ? 'bg-amber-600/15 text-amber-700 border-amber-600/40'
                              : 'bg-rose-600/15 text-rose-700 border-rose-600/40'}`}
                          >
                            <Zap className="h-3 w-3" />
                            {isProxyDebit ? 'proxy debited' : 'wallet debited'} −{fmtUgx(autoDebitEntry?.amount ?? autoImpact?.amount ?? r.amount)}
                            <span className="opacity-80">· {debitedName}{isProxyDebit ? ' (proxy)' : ''}</span>
                            {autoImpact && autoImpact.newAvail !== null && (
                              <span className="opacity-80">· left {fmtUgx(autoImpact.newAvail)}</span>
                            )}
                          </Badge>
                        </BadgeTip>
                      )}
                      {isCredited && (
                        <BadgeTip
                          plain={
                            isFullyCredited
                              ? 'The full amount has already landed in a user wallet. Do not send it again.'
                              : 'Only part of this amount has reached a wallet so far.'
                          }
                          details={[
                            `${isFullyCredited ? 'Fully credited' : 'Partially credited'} — DO NOT credit again`,
                            `Email amount: ${fmtUgx(emailAmount)}`,
                            `Total credited: ${fmtUgx(totalCredited)}`,
                            creditShortfall > 0 ? `Shortfall: ${fmtUgx(creditShortfall)}` : null,
                            ...credited.map((c, i) => [
                              `— Deposit ${i + 1}: ${c.deposit_id}`,
                              `  Recipient: ${c.user_name}${c.user_phone ? ' (' + c.user_phone + ')' : ''}`,
                              `  Amount: ${fmtUgx(c.amount)}`,
                              `  Status: ${c.status}${c.auto_approved ? ' · auto-approved' : ''}`,
                              c.deposit_purpose ? `  Purpose: ${c.deposit_purpose}` : null,
                              c.credited_at ? `  When: ${new Date(c.credited_at).toLocaleString()}` : null,
                            ].filter(Boolean).join('\n')),
                          ].filter(Boolean).join('\n')}
                        >
                          <Badge
                            variant="outline"
                            className={`text-[10px] gap-1 ${isFullyCredited ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/40' : 'bg-amber-500/15 text-amber-700 border-amber-500/40'}`}
                          >
                            <CheckCircle2 className="h-3 w-3" />
                            {isFullyCredited ? 'paid into wallet' : 'partly paid in'} · {fmtUgx(totalCredited)}{creditShortfall > 0 ? ` / ${fmtUgx(emailAmount)}` : ''}
                            {credited.length > 1 && <span className="font-mono tabular-nums opacity-80">×{credited.length}</span>}
                          </Badge>
                        </BadgeTip>
                      )}
                      {/* Clear, unambiguous status: when the deposit is fully
                          credited there is nothing left to route. Highlight the
                          transaction reference (TID) when that's what matched it
                          so reviewers trust the auto-detection. */}
                      {isCredited && isFullyCredited && (
                        <BadgeTip
                          plain="This money is settled — it already reached a wallet. Do not send it again."
                          details={[
                            'Already Credited — No Routing Needed',
                            matchedByTid && matchedTid
                              ? `Matched by transaction reference (TID): ${matchedTid}`
                              : 'Matched to a credited deposit for this email.',
                          ].filter(Boolean).join('\n')}
                        >
                          <Badge
                            variant="outline"
                            className="text-[10px] gap-1 bg-emerald-600/15 text-emerald-700 border-emerald-600/50 font-semibold"
                          >
                            <ShieldCheck className="h-3 w-3" />
                            Already in a wallet — nothing to do
                            {matchedByTid && <span className="opacity-75">· via TID</span>}
                          </Badge>
                        </BadgeTip>
                      )}
                      {/* Auto-credit confidence + phone-source provenance. Shown
                          for any row auto-credited by the Gmail matcher so a
                          reviewer can instantly see whether it was a deterministic
                          counterparty-phone match (high) or the "possible user
                          ≈60%" body-phone signal (medium) that warrants a
                          spot-check. */}
                      {isCredited && autoConfidence && (
                        <BadgeTip
                          plain={
                            isBodyPhoneCredit
                              ? 'Auto-credited from the “possible user ≈60%” signal — a phone found in the email body matched exactly one user. Worth a quick spot-check.'
                              : 'Auto-credited from a deterministic match — the sender’s own phone number matched a known user.'
                          }
                          details={[
                            `Auto-credit confidence: ${autoConfidence}${autoScorePct != null ? ` (~${autoScorePct}%)` : ''}`,
                            `Phone source: ${autoPhoneSource === 'body' ? 'body (found inside the email)' : autoPhoneSource === 'counterparty' ? 'counterparty (the sender/recipient field)' : 'n/a'}`,
                            autoCredit?.auto_match_method ? `Match method: ${autoCredit.auto_match_method}` : null,
                          ].filter(Boolean).join('\n')}
                        >
                          <Badge
                            variant="outline"
                            className={`text-[10px] gap-1 font-semibold ${
                              autoConfidence === 'high'
                                ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/40'
                                : autoConfidence === 'medium'
                                  ? 'bg-amber-500/15 text-amber-700 border-amber-500/40'
                                  : 'bg-orange-500/15 text-orange-700 border-orange-500/40'
                            }`}
                          >
                            {isBodyPhoneCredit ? <ShieldQuestion className="h-3 w-3" /> : <ShieldCheck className="h-3 w-3" />}
                            {autoConfidence} confidence{autoScorePct != null ? ` · ~${autoScorePct}%` : ''}
                            <span className="opacity-75">· {autoPhoneSource === 'body' ? 'body phone' : autoPhoneSource === 'counterparty' ? 'sender phone' : autoCredit?.auto_match_method ?? 'auto'}</span>
                          </Badge>
                        </BadgeTip>
                      )}
                      {/* Incoming deposit whose money never landed in any
                          wallet (no credit + not routed). Flag it clearly and
                          explain which reference fields are missing so the
                          operator knows why it couldn't auto-map. */}
                      {r.parsed && r.direction === 'in' && !isCredited && !isRouted && (
                        <BadgeTip
                          plain="This money has not reached any wallet yet — it still needs to be sorted and sent to the right person."
                          details={[
                            'Not Matched Yet — this deposit has not been credited to any wallet.',
                            `MoMo TID: ${hasMomoTid ? normTidForRow : 'missing'}`,
                            `Receipt code: ${hasReceiptCode ? receiptCodeForRow : 'missing'}`,
                            `Depositing user: ${hasUserMatch ? 'matched' : 'not matched'}`,
                            'Use Redirect deposit to send it to the right wallet.',
                          ].join('\n')}
                        >
                          <Badge
                            variant="outline"
                            className="text-[10px] gap-1 bg-orange-500/20 text-orange-700 border-orange-500/50 font-semibold uppercase tracking-wide ring-1 ring-orange-500/30"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            Needs sorting
                          </Badge>
                        </BadgeTip>
                      )}
                      {/* Same clear status for incoming deposits that never even
                          parsed: still uncredited and unrouted, so they need ops
                          attention just as much. */}
                      {!r.parsed && r.direction === 'in' && !isCredited && !isRouted && (
                        <BadgeTip
                          plain="This money has not reached any wallet yet — it still needs to be sorted and sent to the right person."
                          details="Needs Routing — this incoming deposit email has not been credited to any wallet. Open it to route the money to the right user."
                        >
                          <Badge
                            variant="outline"
                            className="text-[10px] gap-1 bg-orange-500/20 text-orange-700 border-orange-500/50 font-semibold uppercase tracking-wide ring-1 ring-orange-500/30"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            Needs sorting
                          </Badge>
                        </BadgeTip>
                      )}
                      {/* Quick "Route Now" action — sits right next to the
                          Needs Routing badge so ops can jump straight into the
                          routing dialog without scanning across the row to the
                          amount-side CTA. Shown for any uncredited, unrouted
                          incoming deposit (parsed or not). Made very visible
                          with a large, pulsing emerald button. */}
                      {r.direction === 'in' && !isCredited && !isRouted && (
                        <Button
                          size="sm"
                          className="h-8 px-3 text-[11px] gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg shadow-emerald-500/30 ring-2 ring-emerald-400/60 ring-offset-1 animate-pulse"
                          title="Route this deposit now — search any user by name or number and credit it to their wallet."
                          onClick={() => navigateToRow(r, 'credit')}
                        >
                          <Wallet className="h-3.5 w-3.5" /> Credit to wallet
                        </Button>
                      )}
                      {/* Click-to-expand drilldown toggle. Opens a panel with the
                          linked proxy agent wallet change, the debit reason, and
                          the transaction references for this email. */}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[10px] gap-1 text-muted-foreground hover:text-foreground"
                        aria-expanded={expandedRows.has(r.id)}
                        title="Show wallet change, debit reason and transaction references for this email"
                        onClick={() => toggleRowExpanded(r.id)}
                      >
                        {expandedRows.has(r.id) ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                        Details
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">{r.subject || '(no subject)'}</p>
                    {/* Debit breakdown: when this email auto-charged a wallet,
                        spell out exactly which wallet was hit (the matched user
                        or a managed proxy agent), the charged person's name, the
                        amount, and the reason — so Financial Ops never has to
                        guess where the money came from. */}
                    {isAutoDebited && (
                      <div
                        className={`mt-1.5 rounded-md border px-2.5 py-1.5 text-[11px] ${
                          isProxyDebit
                            ? 'border-amber-500/40 bg-amber-500/10'
                            : 'border-rose-500/40 bg-rose-500/10'
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="uppercase tracking-wide font-semibold text-[9px] text-muted-foreground">
                            Debit breakdown
                          </span>
                          <Badge
                            variant="outline"
                            className={`text-[9px] px-1.5 py-0 ${
                              isProxyDebit
                                ? 'bg-amber-600/15 text-amber-700 border-amber-600/40'
                                : 'bg-rose-600/15 text-rose-700 border-rose-600/40'
                            }`}
                          >
                            {isProxyDebit ? 'Proxy agent wallet' : 'Matched user wallet'}
                          </Badge>
                          {debitIsPartial && (
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-orange-500/10 text-orange-700 border-orange-500/30">
                              partial
                            </Badge>
                          )}
                        </div>
                        <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5">
                          <p>
                            <span className="text-muted-foreground">Charged: </span>
                            <span className="font-semibold">{debitedName}</span>
                            {isProxyDebit && (
                              <span className="text-muted-foreground">
                                {' '}(proxy{debitProxyPartner ? ` for ${debitProxyPartner}` : ''})
                              </span>
                            )}
                          </p>
                          <p>
                            <span className="text-muted-foreground">Amount: </span>
                            <span className="font-semibold tabular-nums">−{fmtUgx(debitAmountValue)}</span>
                            {autoImpact && autoImpact.newAvail !== null && (
                              <span className="text-muted-foreground"> · left {fmtUgx(autoImpact.newAvail)}</span>
                            )}
                          </p>
                          {/* Linked proxy agent's live wallet balance — so
                              Financial Ops can see the charged proxy wallet
                              position right on the email without drilling in. */}
                          {isProxyDebit && (
                            <p className="sm:col-span-2">
                              <span className="text-muted-foreground">
                                Proxy wallet ({debitedName}):{' '}
                              </span>
                              <span className="font-semibold tabular-nums">
                                {debitWalletBalance === undefined
                                  ? 'loading…'
                                  : fmtUgx(debitWalletBalance)}
                              </span>
                            </p>
                          )}
                          {debitReasonText && (
                            <p className="sm:col-span-2">
                              <span className="text-muted-foreground">Reason: </span>
                              <span>{debitReasonText}</span>
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                    {/* "Not Matched Yet" details: show which reference signals
                        are present vs missing so reviewers know what to fix. */}
                    {r.parsed && r.direction === 'in' && !isCredited && !isRouted && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">
                        <span className="uppercase tracking-wide font-semibold text-orange-600/90">Still missing:</span>
                        <span
                          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono ${hasMomoTid ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700' : 'border-orange-500/40 bg-orange-500/10 text-orange-700'}`}
                          title={hasMomoTid ? `MoMo TID present: ${normTidForRow}` : 'No MoMo transaction ID parsed from this email'}
                        >
                          {hasMomoTid ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                          MoMo TID
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono ${hasReceiptCode ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700' : 'border-orange-500/40 bg-orange-500/10 text-orange-700'}`}
                          title={hasReceiptCode ? `Receipt code present: ${receiptCodeForRow}` : 'No cash receipt code found in this email'}
                        >
                          {hasReceiptCode ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                          Receipt code
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 ${hasUserMatch ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700' : 'border-orange-500/40 bg-orange-500/10 text-orange-700'}`}
                          title={hasUserMatch ? 'A depositing user was matched' : 'No depositing user matched'}
                        >
                          {hasUserMatch ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                          Who paid
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[10px] gap-1 border-orange-500/40 text-orange-700 hover:bg-orange-500/10"
                          title="Manually map this unmatched email to the correct wallet using the details above (MoMo TID, receipt code, depositing user)."
                          onClick={() => {
                            const matches = userMatches[r.id] ?? [];
                            const top = matches
                              .map((u) => ({
                                u,
                                s: u.matched_on.startsWith('reference ') ? 100
                                  : u.matched_on.startsWith('from ') ? 90
                                  : u.matched_on.startsWith('to ') ? 90
                                  : u.matched_on.startsWith('name-') ? 75
                                  : 60,
                              }))
                              .sort((a, b) => b.s - a.s)[0]?.u;
                            const matchedPhone = top?.matched_on.startsWith('from ') || top?.matched_on.startsWith('to ') || top?.matched_on.startsWith('phone ')
                              ? top.matched_on.replace(/^(from|to|phone)\s+/, '')
                              : null;
                            setRoutingSuggestedUser(top ? { id: top.id, full_name: top.full_name, phone: top.phone ?? '', matched_phone: matchedPhone } : null);
                            setRoutingMode('credit');
                            setRoutingRow(r);
                          }}
                        >
                          <Wrench className="h-3 w-3" />
                          Sort it myself
                        </Button>
                      </div>
                    )}
                    {/* "Why auto-credit was skipped" — for every incoming email
                        the poller did NOT auto-credit, show the exact gate
                        checklist it evaluated so ops can see which rule failed
                        (mirrors _tryAutoCreditOperationalFloat in the edge fn). */}
                    {r.direction === 'in' && !isCredited && !isRouted && (() => {
                      const gates = autoCreditGateReport({
                        amount: r.amount,
                        transactionId: r.transaction_id,
                        direction: r.direction,
                        channel: r.channel,
                        internalDate: r.internal_date,
                        hasUserMatch,
                        matchCount: matches.length,
                        isConfidentMatch: isConfident,
                      });
                      const failed = gates.filter((g) => !g.ok);
                      return (
                        <div className="mt-1.5 rounded-md border border-sky-500/30 bg-sky-500/5 px-2.5 py-1.5">
                          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-400">
                            <HelpCircle className="h-3 w-3" />
                            Why auto-credit was skipped
                            {failed.length > 0 && (
                              <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-sky-500/40 text-sky-700 dark:text-sky-400">
                                {failed.length} check{failed.length === 1 ? '' : 's'} failed
                              </Badge>
                            )}
                          </div>
                          {failed.length === 0 ? (
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              All auto-credit checks passed — if this hasn't landed in a wallet it may still be
                              processing or was reversed. Use “Send to wallet” to credit it manually.
                            </p>
                          ) : (
                            <ul className="mt-1 space-y-0.5">
                              {gates.map((g) => (
                                <li key={g.label} className="flex items-start gap-1.5 text-[11px] leading-snug">
                                  {g.ok
                                    ? <Check className="h-3 w-3 mt-0.5 shrink-0 text-emerald-600" />
                                    : <X className="h-3 w-3 mt-0.5 shrink-0 text-rose-600" />}
                                  <span className={g.ok ? 'text-muted-foreground' : 'text-foreground'}>
                                    <span className="font-medium">{g.label}</span>
                                    {!g.ok && <span className="text-rose-700 dark:text-rose-400"> — {g.reason}</span>}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })()}
                    {isCredited && (
                      <div className="mt-1.5 space-y-1">
                        {credited.map((c, i) => (
                          <p key={c.deposit_id} className={`text-[11px] inline-flex items-center gap-1.5 rounded border px-2 py-0.5 ${isFullyCredited ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700' : 'border-amber-500/30 bg-amber-500/10 text-amber-700'}`}>
                            <Wallet className="h-3 w-3" />
                            <span className="font-mono opacity-70">#{i + 1}</span>
                            <strong className="font-semibold">{c.user_name}</strong>
                            {c.user_phone ? <span className="font-mono opacity-80">{c.user_phone}</span> : null}
                            <span className="opacity-70">·</span>
                            <span className="font-mono font-medium">{fmtUgx(c.amount)}</span>
                            <span className="opacity-70">·</span>
                            <span>{c.status}{c.auto_approved ? ' (auto)' : ''}</span>
                          </p>
                        ))}
                      </div>
                    )}
                    {(r.counterparty || r.fee || r.balance !== null) && (
                      <p className="text-[11px] text-muted-foreground/80 mt-0.5 flex flex-wrap gap-x-3">
                        {r.counterparty && <span>↔ <strong className="text-foreground/80">{r.counterparty}</strong></span>}
                        {r.fee ? <span>fee {fmtUgx(r.fee)}</span> : null}
                        {r.balance !== null && r.balance !== undefined ? <span>bal {fmtUgx(r.balance)}</span> : null}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground/80 line-clamp-2 mt-1">{r.snippet}</p>
                    {/* ── Click-to-expand drilldown ──────────────────────────
                        Surfaces the three things Financial Ops most often needs
                        when auditing an auto-debited email: the linked proxy
                        agent's wallet change, the exact debit reason, and every
                        transaction reference tied to the row. */}
                    {expandedRows.has(r.id) && (
                      <div className="mt-2 rounded-lg border border-border bg-muted/30 p-3 space-y-3 text-[11px]">
                        {/* Top-of-email credit CTA — the first thing an operator
                            sees when they open a deposit that has not reached a
                            wallet yet. Full-width and unmissable. */}
                        {r.direction === 'in' && !isCredited && !isRouted && (
                          <div className="rounded-lg border-2 border-emerald-500/60 bg-emerald-500/10 p-3 space-y-3">
                            <div className="flex items-start gap-2">
                              <p className="text-[11px] font-bold uppercase tracking-wide text-emerald-800 dark:text-emerald-300 inline-flex items-center gap-1">
                                <AlertTriangle className="h-3.5 w-3.5" /> Not in any wallet yet
                              </p>
                            </div>
                            <p className="text-[11px] text-muted-foreground break-words">
                              {fmtUgx(r.amount)} received{r.counterparty ? ` from ${r.counterparty}` : ''} — search the user by phone or name and credit it.
                            </p>
                            <div className="flex flex-col sm:flex-row gap-2 items-end">
                              <div className="flex-1 min-w-0 w-full">
                                <UserSearchPicker
                                  label="Search user by phone / name"
                                  placeholder="Type phone number or name…"
                                  selectedUser={inlineRouteUsers[r.id] ?? null}
                                  onSelect={(user) => {
                                    setInlineRouteUsers((cur) => {
                                      const next = { ...cur };
                                      if (user) next[r.id] = user;
                                      else delete next[r.id];
                                      return next;
                                    });
                                  }}
                                />
                              </div>
                              <Button
                                size="lg"
                                disabled={!inlineRouteUsers[r.id]}
                                className="w-full sm:w-auto h-12 px-5 text-sm font-bold gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:animate-none text-white shadow-lg shadow-emerald-500/30 ring-2 ring-emerald-400/60 ring-offset-1 animate-pulse shrink-0"
                                title={inlineRouteUsers[r.id] ? `Credit this deposit to ${inlineRouteUsers[r.id].full_name}'s wallet` : 'Select a user first'}
                                onClick={() => {
                                  const u = inlineRouteUsers[r.id];
                                  if (!u) return;
                                  navigateToRow(r, 'credit', { id: u.id, full_name: u.full_name, phone: u.phone });
                                }}
                              >
                                <Wallet className="h-5 w-5" />
                                {inlineRouteUsers[r.id]
                                  ? `Credit ${inlineRouteUsers[r.id].full_name.split(' ')[0] || inlineRouteUsers[r.id].full_name}`
                                  : 'Credit to wallet'}
                              </Button>
                            </div>
                          </div>
                        )}
                        {/* 0) Full receipt — the complete parsed email so a phone
                            user never has to squint at truncated text. Every
                            field is stacked one-per-line on small screens. */}
                        <div className="space-y-1">
                          <p className="uppercase tracking-wide font-semibold text-[9px] text-muted-foreground inline-flex items-center gap-1">
                            <FileText className="h-3 w-3" />
                            Full receipt
                          </p>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5">
                            <p><span className="text-muted-foreground">Amount: </span><span className="font-semibold tabular-nums">{fmtUgx(r.amount)}</span></p>
                            <p><span className="text-muted-foreground">Direction: </span><span className="font-semibold">{r.direction === 'in' ? 'Money in' : r.direction === 'charge' ? 'Charge' : r.direction === 'out' ? 'Money out' : '—'}</span></p>
                            {r.fee !== null && r.fee !== undefined && (
                              <p><span className="text-muted-foreground">Fee: </span><span className="tabular-nums">{fmtUgx(r.fee)}</span></p>
                            )}
                            {r.balance !== null && r.balance !== undefined && (
                              <p><span className="text-muted-foreground">Balance on receipt: </span><span className="tabular-nums">{fmtUgx(r.balance)}</span></p>
                            )}
                            <p className="break-words"><span className="text-muted-foreground">Counterparty: </span><span className="font-semibold">{r.counterparty || '—'}</span></p>
                            <p><span className="text-muted-foreground">Channel: </span>{r.channel || '—'}</p>
                            <p className="break-words sm:col-span-2"><span className="text-muted-foreground">Sender: </span>{r.from_name || '—'}{r.from_email ? ` · ${r.from_email}` : ''}</p>
                            <p className="sm:col-span-2"><span className="text-muted-foreground">Received: </span>{r.internal_date ? new Date(r.internal_date).toLocaleString('en-GB', { timeZone: tz }) : '—'}</p>
                          </div>
                          <p className="break-words"><span className="text-muted-foreground">Subject: </span>{r.subject || '(no subject)'}</p>
                          <div className="rounded border border-border bg-background p-2 whitespace-pre-wrap break-words leading-relaxed">
                            {r.snippet || 'No email body captured.'}
                          </div>
                        </div>
                        {/* 0b) Matching reasons — exactly why (or why not) this
                            email resolved to a wallet, in plain language. */}
                        <div className="space-y-1 border-t border-border/60 pt-2">
                          <p className="uppercase tracking-wide font-semibold text-[9px] text-muted-foreground inline-flex items-center gap-1">
                            <ShieldQuestion className="h-3 w-3" />
                            Matching reasons
                          </p>
                          {matches.length === 0 ? (
                            <p className="text-muted-foreground">
                              No user matched. {hasMomoTid || hasReceiptCode
                                ? 'A reference code exists, but no profile could be tied to it.'
                                : 'This email carries no MoMo transaction ID or cash receipt code, and no known phone/name was found in the body.'}
                            </p>
                          ) : (
                            <ul className="space-y-1">
                              {matches.map((u) => {
                                const mo = u.matched_on;
                                const why = mo.startsWith('reference ')
                                  ? 'Receipt code / transaction ID on the email matches this user\u2019s deposit reference (authoritative)'
                                  : mo.startsWith('from ')
                                    ? 'Phone number after "from" on the receipt matches this user\u2019s profile phone (strong)'
                                    : mo.startsWith('to ')
                                      ? 'Phone number after "to" on the receipt matches this user\u2019s profile phone (strong)'
                                      : mo.startsWith('name-to ')
                                        ? 'Name after "to" matches this user\u2019s mobile money name (medium)'
                                        : mo.startsWith('name-from ')
                                          ? 'Name after "from" matches this user\u2019s mobile money name (medium)'
                                          : 'A phone number found in the email body matches this user (weak \u2014 spot-check before crediting)';
                                return (
                                  <li key={`${u.id}-${mo}`} className="rounded border border-border bg-background px-2 py-1">
                                    <p className="font-semibold break-words">{u.full_name}{u.phone ? ` · ${u.phone}` : ''}</p>
                                    <p className="text-muted-foreground break-words">{why}</p>
                                    <p className="font-mono text-[10px] text-muted-foreground/70 break-words">signal: {mo}</p>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                          {autoConfidence && (
                            <p className="text-muted-foreground">
                              Auto-credit confidence: <span className="font-semibold">{autoConfidence}</span>
                              {autoScorePct !== null ? ` (${autoScorePct}%)` : ''}
                              {autoPhoneSource ? ` · phone signal from ${autoPhoneSource}` : ''}
                            </p>
                          )}
                        </div>
                        {/* 1) Linked proxy / matched wallet change */}
                        {isAutoDebited ? (
                          <div className="space-y-1">
                            <p className="uppercase tracking-wide font-semibold text-[9px] text-muted-foreground inline-flex items-center gap-1">
                              <Wallet className="h-3 w-3" />
                              {isProxyDebit ? 'Linked proxy agent wallet change' : 'Matched user wallet change'}
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5">
                              <p>
                                <span className="text-muted-foreground">Wallet owner: </span>
                                <span className="font-semibold">{debitedName}</span>
                                {isProxyDebit && (
                                  <span className="text-muted-foreground">
                                    {' '}(proxy{debitProxyPartner ? ` for ${debitProxyPartner}` : ''})
                                  </span>
                                )}
                              </p>
                              <p>
                                <span className="text-muted-foreground">Amount debited: </span>
                                <span className="font-semibold tabular-nums text-rose-700">−{fmtUgx(debitAmountValue)}</span>
                                {debitIsPartial && <span className="text-muted-foreground"> · partial</span>}
                              </p>
                              {autoImpact && autoImpact.newAvail !== null ? (
                                <p>
                                  <span className="text-muted-foreground">Balance before → after: </span>
                                  <span className="font-mono tabular-nums">{fmtUgx(autoImpact.newAvail + debitAmountValue)}</span>
                                  <ArrowRight className="inline h-3 w-3 mx-1 align-middle" />
                                  <span className="font-mono tabular-nums font-semibold">{fmtUgx(autoImpact.newAvail)}</span>
                                </p>
                              ) : null}
                              <p>
                                <span className="text-muted-foreground">Wallet now: </span>
                                <span className="font-semibold tabular-nums">
                                  {debitWalletBalance === undefined ? 'loading…' : fmtUgx(debitWalletBalance)}
                                </span>
                              </p>
                            </div>
                          </div>
                        ) : (
                          <p className="text-muted-foreground">No wallet was auto-debited for this email.</p>
                        )}
                        {/* 2) Debit reason */}
                        {isAutoDebited && (
                          <div className="space-y-0.5 border-t border-border/60 pt-2">
                            <p className="uppercase tracking-wide font-semibold text-[9px] text-muted-foreground inline-flex items-center gap-1">
                              <Info className="h-3 w-3" />
                              Debit reason
                            </p>
                            <p>{debitReasonText || '—'}</p>
                            {rawDebitReason && rawDebitReason !== debitReasonText && (
                              <p className="font-mono text-[10px] text-muted-foreground/80 break-words">{rawDebitReason}</p>
                            )}
                          </div>
                        )}
                        {/* 3) Transaction references */}
                        <div className="space-y-1 border-t border-border/60 pt-2">
                          <p className="uppercase tracking-wide font-semibold text-[9px] text-muted-foreground inline-flex items-center gap-1">
                            <LinkIcon className="h-3 w-3" />
                            Transaction references
                          </p>
                          <div className="flex flex-wrap gap-1.5 font-mono text-[10px]">
                            {r.transaction_id && (
                              <span className="rounded border border-border bg-background px-1.5 py-0.5">TID: {r.transaction_id}</span>
                            )}
                            {hasMomoTid && (
                              <span className="rounded border border-border bg-background px-1.5 py-0.5">MoMo: {normTidForRow}</span>
                            )}
                            {hasReceiptCode && (
                              <span className="rounded border border-border bg-background px-1.5 py-0.5">Receipt: {receiptCodeForRow}</span>
                            )}
                            <span className="rounded border border-border bg-background px-1.5 py-0.5">Msg: {r.gmail_message_id}</span>
                          </div>
                          {history.length > 0 && (
                            <div className="space-y-0.5 pt-1">
                              <p className="text-[9px] uppercase tracking-wide text-muted-foreground/80">Routing ledger entries</p>
                              {history.map((h) => (
                                <p key={h.id} className="font-mono text-[10px] text-muted-foreground/90 break-words">
                                  {format(new Date(h.created_at), 'MMM d HH:mm')} · {h.route} · {fmtUgx(h.amount)} · ref {h.id}
                                </p>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {userMatches[r.id]?.length ? (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold inline-flex items-center gap-1">
                          {userMatches[r.id].length > 1 ? <Users className="h-3 w-3" /> : null}
                          {(() => {
                            const isOut = r.direction === 'out' || r.direction === 'charge';
                            const noun = isOut ? 'recipient' : 'user';
                            return userMatches[r.id].length > 1
                              ? `${userMatches[r.id].length} possible ${noun}s:`
                              : `Possible ${noun}:`;
                          })()}
                        </span>
                        <TooltipProvider delayDuration={150}>
                          {[...userMatches[r.id]]
                            .map((u) => {
                              const isRef = u.matched_on.startsWith('reference ');
                              const isFrom = u.matched_on.startsWith('from ');
                              const isTo = u.matched_on.startsWith('to ');
                              const isName = u.matched_on.startsWith('name-');
                              const score = isRef ? 100 : isFrom || isTo ? 90 : isName ? 75 : 60;
                              return { u, score };
                            })
                            .sort((a, b) => b.score - a.score)
                            .map(({ u, score }, idx, arr) => {
                            const isRef = u.matched_on.startsWith('reference ');
                            const isFrom = u.matched_on.startsWith('from ');
                            const isTo = u.matched_on.startsWith('to ');
                            const isNameTo = u.matched_on.startsWith('name-to ');
                            const isNameFrom = u.matched_on.startsWith('name-from ');
                            const isName = isNameTo || isNameFrom;
                            const strong = isRef || isFrom || isTo || isName;
                            const matchType = isRef
                              ? 'Reference (TID)'
                              : isFrom
                                ? 'Phone after "from"'
                                : isTo
                                  ? 'Phone after "to"'
                                  : isNameTo
                                    ? 'Name after "to"'
                                    : isNameFrom
                                      ? 'Name after "from"'
                                      : 'Phone in email body';
                            const confidenceLabel = isRef
                              ? 'authoritative'
                              : isFrom || isTo
                                ? 'high'
                                : isName
                                  ? 'medium-high'
                                  : 'medium';
                            const matchedValue = u.matched_on.replace(/^(reference|from|to|phone|name-to|name-from)\s+/, '');
                            const shortLabel = isRef
                              ? 'ref'
                              : isFrom
                                ? 'from'
                                : isTo
                                  ? 'to'
                                  : isNameTo
                                    ? 'name→'
                                    : isNameFrom
                                      ? 'name←'
                                      : 'phone';
                            const isPrimary = idx === 0 && arr.length > 1;
                            // Always-visible confidence indicator: tier word + one-line
                            // "why" so ops can pick the right destination without hovering.
                            const tier = score >= 100 ? 'Certain' : score >= 90 ? 'High' : score >= 75 ? 'Likely' : 'Weak';
                            const tierClass = score >= 100
                              ? 'bg-emerald-600 text-white border-emerald-600'
                              : score >= 90
                                ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/40'
                                : score >= 75
                                  ? 'bg-amber-500/15 text-amber-700 border-amber-500/40'
                                  : 'bg-muted text-muted-foreground border-border';
                            const whyText = `${matchType}: ${matchedValue}`;
                            // Visual hierarchy:
                            //  - primary (top-scoring when there are multiple matches): filled + Star
                            //  - other strong matches: filled (no star)
                            //  - weak matches: tinted outline
                            const badgeClass = isPrimary
                              ? 'bg-primary text-primary-foreground border-primary ring-2 ring-primary/50 shadow-sm'
                              : strong
                                ? 'bg-primary text-primary-foreground border-primary ring-1 ring-primary/30'
                                : 'bg-primary/10 text-primary border-primary/30';
                            return (
                              <Fragment key={u.id}>
                              <span className="inline-flex flex-col gap-0.5">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Badge
                                    variant="outline"
                                    className={`text-[10px] gap-1 cursor-help ${badgeClass}`}
                                  >
                                    {isPrimary
                                      ? <Star className="h-3 w-3 fill-current" />
                                      : strong
                                        ? <CheckCircle2 className="h-3 w-3" />
                                        : null}
                                    <span className="font-medium">{u.full_name}</span>
                                    <span className="opacity-70">· {shortLabel}</span>
                                    <span className="font-mono tabular-nums opacity-80">{score}%</span>
                                    <span className="font-mono tabular-nums opacity-90 border-l border-current/30 pl-1 ml-0.5 inline-flex items-center gap-0.5">
                                      <Wallet className="h-2.5 w-2.5" />
                                      {userBalances[u.id] === undefined
                                        ? '…'
                                        : Math.round(userBalances[u.id]).toLocaleString()}
                                    </span>
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-xs text-xs">
                                  <div className="space-y-0.5">
                                    <p className="font-semibold flex items-center gap-1">
                                      {isPrimary && <Star className="h-3 w-3 fill-current text-primary" />}
                                      {u.full_name}
                                      {isPrimary && <span className="text-[10px] uppercase tracking-wide text-primary font-bold">· Primary</span>}
                                    </p>
                                    <p>
                                      <span className="text-muted-foreground">Match type: </span>
                                      {matchType}
                                    </p>
                                    <p className="font-mono">
                                      <span className="text-muted-foreground font-sans">Matched value: </span>
                                      {matchedValue}
                                    </p>
                                    <p>
                                      <span className="text-muted-foreground">Confidence: </span>
                                      {confidenceLabel} ({score}%)
                                    </p>
                                    {arr.length > 1 && (
                                      <p className="text-muted-foreground pt-0.5 border-t mt-1">
                                        {isPrimary
                                          ? `Top match of ${arr.length} candidates — primary attribution.`
                                          : `Secondary match (rank ${idx + 1} of ${arr.length}). Review before attributing.`}
                                      </p>
                                    )}
                                    {u.phone && (
                                      <p className="font-mono">
                                        <span className="text-muted-foreground font-sans">Phone: </span>
                                        {u.phone}
                                      </p>
                                    )}
                                    {u.mobile_money_number && u.mobile_money_number !== u.phone && (
                                      <p className="font-mono">
                                        <span className="text-muted-foreground font-sans">MoMo: </span>
                                        {u.mobile_money_number}
                                      </p>
                                    )}
                                    <p className="font-mono pt-0.5 border-t mt-1">
                                      <span className="text-muted-foreground font-sans inline-flex items-center gap-1">
                                        <Wallet className="h-3 w-3" /> Wallet:{' '}
                                      </span>
                                      {userBalances[u.id] === undefined
                                        ? '…'
                                        : `UGX ${Math.round(userBalances[u.id]).toLocaleString()}`}
                                    </p>
                                    {(userRecentTx[u.id]?.length ?? 0) > 0 && (
                                      <div className="pt-1 mt-1 border-t">
                                        <p className="text-muted-foreground font-sans text-[10px] uppercase tracking-wider mb-0.5">
                                          Last {Math.min(3, userRecentTx[u.id].length)} wallet tx
                                        </p>
                                        <ul className="space-y-0.5">
                                          {userRecentTx[u.id].slice(0, 3).map((t) => {
                                            const isIn = t.direction === 'cash_in' || t.direction === 'credit';
                                            return (
                                              <li key={t.id} className="flex items-center justify-between gap-2 font-sans">
                                                <span className="truncate">
                                                  <span className={isIn ? 'text-emerald-600' : 'text-rose-600'}>
                                                    {isIn ? '+' : '−'}{Math.round(t.amount).toLocaleString()}
                                                  </span>{' '}
                                                  <span className="text-muted-foreground">· {t.category}</span>
                                                </span>
                                                <span className="text-muted-foreground/70 text-[10px] shrink-0">
                                                  {format(new Date(t.created_at), 'MMM d HH:mm')}
                                                </span>
                                              </li>
                                            );
                                          })}
                                        </ul>
                                      </div>
                                    )}
                                  </div>
                                </TooltipContent>
                              </Tooltip>
                              <span className="inline-flex items-center gap-1 pl-0.5">
                                <Badge variant="outline" className={`text-[9px] px-1 py-0 leading-4 ${tierClass}`}>
                                  {tier} · {score}%
                                </Badge>
                                <span className="text-[9px] text-muted-foreground truncate max-w-[180px]" title={whyText}>
                                  {whyText}
                                </span>
                              </span>
                              </span>
                              {(r.direction === 'out' || r.direction === 'charge') && userProxies[u.id] && (
                                <ProxyDebitBreakdownDialog
                                  partner={{ id: u.id, name: u.full_name }}
                                  proxy={userProxies[u.id]}
                                  onChanged={() => setUserBalances({})}
                                >
                                  <Badge
                                    variant="outline"
                                    role="button"
                                    title={`See proxy-wallet debits charged for ${u.full_name}`}
                                    className="text-[10px] gap-1 cursor-pointer border-amber-500/50 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20"
                                  >
                                    <Users className="h-2.5 w-2.5" />
                                    <span className="font-medium">proxy: {userProxies[u.id].agentName || 'agent'}</span>
                                    <span className="font-mono tabular-nums opacity-90 border-l border-current/30 pl-1 ml-0.5 inline-flex items-center gap-0.5">
                                      <Wallet className="h-2.5 w-2.5" />
                                      {userBalances[userProxies[u.id].agentId] === undefined
                                        ? '…'
                                        : Math.round(userBalances[userProxies[u.id].agentId]).toLocaleString()}
                                    </span>
                                  </Badge>
                                </ProxyDebitBreakdownDialog>
                              )}
                              </Fragment>
                            );
                          })}
                        </TooltipProvider>
                      </div>
                    ) : null}
                    {isRouted && (
                      <div className="mt-2 rounded-md border border-violet-500/20 bg-violet-500/5 p-2">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <p className="text-[10px] uppercase tracking-wider text-violet-700 font-semibold flex items-center gap-1">
                            <History className="h-3 w-3" /> Routing history ({history.length})
                          </p>
                          <button
                            type="button"
                            onClick={() => setHistoryDrawerRow(r)}
                            className="text-[10px] font-medium text-violet-700 underline underline-offset-2 hover:text-violet-800 min-h-11 sm:min-h-0 px-1"
                          >
                            View full history
                          </button>
                        </div>
                        <ul className="space-y-1">
                          {history.slice(0, 4).map((h) => {
                            const reversal = /revers/i.test(h.reason || '');
                            const busy = !!reverseBusy[h.id];
                            const bal = userBalances[h.target_user_id];
                            return (
                              <li
                                key={h.id}
                                className="text-[11px] flex items-start gap-1.5 leading-snug"
                              >
                                <span
                                  className={`mt-[3px] h-1.5 w-1.5 rounded-full shrink-0 ${
                                    reversal ? 'bg-rose-500' : 'bg-violet-500'
                                  }`}
                                />
                                <span className="flex-1 min-w-0">
                                  <span className="font-medium text-foreground">
                                    {reversal ? 'Reversed from' : '→'} {h.target_user_name || 'Unknown user'}
                                  </span>
                                  <span className="text-muted-foreground">
                                    {' '}· {h.route === 'operational_float' ? 'Operational Float' : 'Personal Deposit'}
                                    {' '}· UGX {Number(h.amount).toLocaleString()}
                                  </span>
                                  <span className="block text-muted-foreground/80 text-[10px]">
                                    {h.routed_by_name ? `by ${h.routed_by_name} · ` : ''}
                                    {format(new Date(h.created_at), 'MMM d, HH:mm')}
                                    {h.sms_sent ? ' · SMS sent' : ''}
                                  </span>
                                  <span className="mt-1 flex items-center gap-2 flex-wrap">
                                    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                                      <Wallet className="h-3 w-3" />
                                      Wallet now:{' '}
                                      <strong className="font-mono tabular-nums text-foreground/80">
                                        {bal === undefined ? '…' : `UGX ${Math.round(bal).toLocaleString()}`}
                                      </strong>
                                    </span>
                                    {!reversal && (
                                      <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => reverseRoutingEntry(r, h)}
                                        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-rose-300 text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30 disabled:opacity-60"
                                        title="Post the opposite ledger leg against the same user/bucket"
                                      >
                                        {busy
                                          ? <Loader2 className="h-3 w-3 animate-spin" />
                                          : <Undo2 className="h-3 w-3" />}
                                        Reverse
                                      </button>
                                    )}
                                  </span>
                                </span>
                              </li>
                            );
                          })}
                          {history.length > 4 && (
                            <li className="pl-3">
                              <button
                                type="button"
                                onClick={() => setHistoryDrawerRow(r)}
                                className="text-[10px] font-medium text-violet-700 underline underline-offset-2 hover:text-violet-800"
                              >
                                + {history.length - 4} more — view full history
                              </button>
                            </li>
                          )}
                        </ul>
                      </div>
                    )}
                  </div>
                  <div className="w-full sm:w-auto shrink-0 text-left sm:text-right flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/60 pt-2 sm:mt-0 sm:block sm:border-0 sm:pt-0">
                    <p className={`font-mono font-semibold text-sm ${r.amount ? 'text-emerald-600' : 'text-muted-foreground'}`}>{fmtUgx(r.amount)}</p>
                    <p className="text-[10px] text-muted-foreground sm:mt-0.5">
                      {r.internal_date ? format(new Date(r.internal_date), 'MMM d, HH:mm') : '—'}
                    </p>
                    {r.amount && r.amount > 0 && r.direction !== 'out' && (
                      (() => {
                        // Money that has NOT landed in any wallet (not auto-credited
                        // and not already routed) gets a loud, filled CTA so ops can
                        // immediately search out ANY user and drop it into their
                        // wallet. Already-handled rows keep the quiet outline button.
                        const needsWallet = !isCredited && !isRouted;
                        return (
                      <Button
                        size="default"
                        variant={needsWallet ? 'default' : 'outline'}
                        className={`mt-1.5 h-10 sm:h-9 text-xs sm:text-[11px] gap-1.5 font-semibold ${
                          needsWallet
                            ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg shadow-emerald-500/30 ring-2 ring-emerald-400/60 ring-offset-1 animate-pulse'
                            : ''
                        }`}
                        title={
                          needsWallet
                            ? 'This money is not in any wallet yet. Search any user by name or number and credit it to their wallet.'
                            : isRouted && !isReversed
                              ? 'Already routed to a user. You can still route it to a different user — routing it to the same user again will be blocked.'
                              : 'Route this deposit to a user wallet'
                        }
                        onClick={() => {
                          const matches = userMatches[r.id] ?? [];
                          const top = matches
                            .map((u) => ({
                              u,
                              s: u.matched_on.startsWith('reference ') ? 100
                                : u.matched_on.startsWith('from ') ? 90
                                : u.matched_on.startsWith('to ') ? 90
                                : u.matched_on.startsWith('name-') ? 75
                                : 60,
                            }))
                            .sort((a, b) => b.s - a.s)[0]?.u;
                          const matchedPhone = top?.matched_on.startsWith('from ') || top?.matched_on.startsWith('to ') || top?.matched_on.startsWith('phone ')
                            ? top.matched_on.replace(/^(from|to|phone)\s+/, '')
                            : null;
                          setRoutingSuggestedUser(top ? { id: top.id, full_name: top.full_name, phone: top.phone ?? '', matched_phone: matchedPhone } : null);
                          setRoutingMode('credit');
                          setRoutingRow(r);
                        }}
                      >
                        {needsWallet
                          ? <><Wallet className="h-4 w-4" /> Credit to wallet</>
                          : isRouted && !isReversed
                            ? <>Route to another user <ArrowRight className="h-3.5 w-3.5" /></>
                            : <>Route to user <ArrowRight className="h-3.5 w-3.5" /></>}
                      </Button>
                        );
                      })()
                    )}
                    {r.amount && r.amount > 0 && (r.direction === 'out' || r.direction === 'charge') && (
                      (() => {
                        const wMatches = withdrawalMatches[r.id] ?? [];
                        if (wMatches.length !== 1) return null;
                        const m = wMatches[0];
                        const busy = !!autoApproving[r.id];
                        return (
                          <Button
                            size="sm"
                            variant="default"
                            className="mt-1.5 h-8 sm:h-7 text-[11px] gap-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                            disabled={busy}
                            title={`Match: withdrawal ${m.id.slice(0,8)}… for ${m.user_name || 'user'} (${m.mobile_money_number || m.bank_account_number || '—'}) · ${m.matched_on}`}
                            onClick={() => autoApproveWithdrawal(r, m)}
                          >
                            {busy ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <CheckCircle2 className="h-3 w-3" />
                            )}
                            Auto-approve payout
                          </Button>
                        );
                      })()
                    )}
                    {r.amount && r.amount > 0 && (r.direction === 'out' || r.direction === 'charge') && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-1.5 h-8 sm:h-7 text-[11px] gap-1 border-rose-300 text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                        title={
                          isRouted && !isReversed
                            ? 'Already debited from a user. You can still debit a different user — debiting the same user again will be blocked.'
                            : 'Debit this outflow from a user wallet'
                        }
                        onClick={() => {
                          const matches = userMatches[r.id] ?? [];
                          const top = matches
                            .map((u) => ({
                              u,
                              s: u.matched_on.startsWith('reference ') ? 100
                                : u.matched_on.startsWith('to ') ? 90
                                : u.matched_on.startsWith('from ') ? 90
                                : u.matched_on.startsWith('name-') ? 75
                                : 60,
                            }))
                            .sort((a, b) => b.s - a.s)[0]?.u;
                          const matchedPhone = top?.matched_on.startsWith('to ') || top?.matched_on.startsWith('from ') || top?.matched_on.startsWith('phone ')
                            ? top.matched_on.replace(/^(to|from|phone)\s+/, '')
                            : null;
                          setRoutingSuggestedUser(top ? { id: top.id, full_name: top.full_name, phone: top.phone ?? '', matched_phone: matchedPhone } : null);
                          setRoutingMode('debit');
                          setRoutingRow(r);
                        }}
                      >
                        {isRouted && !isReversed ? <>Debit a different user <ArrowRight className="h-3 w-3" /></> : <>Debit user wallet <ArrowRight className="h-3 w-3" /></>}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
              </SwipeableEmailRow>
                );
              });
            })()}
            {/* Infinite-scroll sentinel: when this scrolls into view the list
                grows by one more page. Only rendered in infinite mode while
                there are still more rows to reveal. */}
            {paginationMode === 'infinite'
              && infiniteCount < visibleRows.length
              && (
              <div
                ref={infiniteSentinelRef}
                className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground"
              >
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading {Math.min(pageSize, visibleRows.length - infiniteCount).toLocaleString()} more
                {' '}({(visibleRows.length - infiniteCount).toLocaleString()} left)
              </div>
            )}
          </div>
        )}
        {/* Pagination controls — only shown when there's more than one page. */}
        {!loading && rows.length > 0 && (() => {
          const meta = (typeof window !== 'undefined' ? (window as any).__emailPaginationMeta : null) as
            | { totalPages: number; safePage: number; total: number; mode?: PaginationMode; shownCount?: number }
            | null;
          if (!meta) return null;
          const { totalPages, safePage, total } = meta;
          const isInfinite = paginationMode === 'infinite';
          const shownCount = isInfinite ? Math.min(infiniteCount, total) : 0;
          const from = total === 0 ? 0 : isInfinite ? 1 : (safePage - 1) * pageSize + 1;
          const to = isInfinite ? shownCount : Math.min(safePage * pageSize, total);
          return (
            <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 text-xs">
              <div className="text-muted-foreground tabular-nums">
                Showing <span className="font-medium text-foreground">{from.toLocaleString()}–{to.toLocaleString()}</span> of{' '}
                <span className="font-medium text-foreground">{total.toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 gap-1"
                  title={isInfinite ? 'Switch to paged navigation' : 'Switch to infinite scroll'}
                  onClick={() => setPaginationMode((m) => (m === 'infinite' ? 'paged' : 'infinite'))}
                >
                  {isInfinite ? 'Use pages' : 'Infinite scroll'}
                </Button>
                <label className="text-muted-foreground">Rows:</label>
                <select
                  value={pageSize}
                  onChange={(e) => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}
                  className="h-7 rounded border border-input bg-background px-2 text-xs"
                >
                  {[25, 50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                {isInfinite ? (
                  to < total ? (
                    <Button size="sm" variant="outline" className="h-8 px-3"
                      onClick={() => setInfiniteCount((c) => Math.min(c + pageSize, total))}>
                      Load {Math.min(pageSize, total - to)} more
                    </Button>
                  ) : (
                    <span className="text-muted-foreground px-1">All loaded</span>
                  )
                ) : (
                  <>
                    <Button size="sm" variant="outline" className="h-8 px-2 hidden sm:inline-flex"
                      onClick={() => goToPage(1)} disabled={safePage <= 1}>« First</Button>
                    <Button size="sm" variant="outline" className="h-8 px-3"
                      onClick={() => goToPage(Math.max(1, safePage - 1))} disabled={safePage <= 1}>‹ Prev</Button>
                    <span className="tabular-nums text-muted-foreground px-1">Page {safePage} / {totalPages}</span>
                    <Button size="sm" variant="outline" className="h-8 px-3"
                      onClick={() => goToPage(Math.min(totalPages, safePage + 1))} disabled={safePage >= totalPages}>Next ›</Button>
                    <Button size="sm" variant="outline" className="h-8 px-2 hidden sm:inline-flex"
                      onClick={() => goToPage(totalPages)} disabled={safePage >= totalPages}>Last »</Button>
                  </>
                )}
              </div>
            </div>
          );
        })()}
      </div>

      <DebitBucketAuditSearch />

      <div className="rounded-xl border bg-card p-3 flex flex-col gap-3">

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={pollNow} disabled={polling} className="gap-2 flex-1 sm:flex-none min-w-[130px]">
            {polling ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Poll now
          </Button>
          <Button
            variant="outline"
            onClick={() => exportTotalsCsv({ rows: filteredRows, totalIn, totalOut, netAmount, channelBreakdown })}
            disabled={filteredRows.length === 0}
            className="gap-2 flex-1 sm:flex-none min-w-[120px]"
          >
            <FileDown className="h-4 w-4" /> Export CSV
          </Button>
          <Button
            variant="outline"
            onClick={() => exportTotalsPdf({ rows: filteredRows, totalIn, totalOut, netAmount, channelBreakdown })}
            disabled={filteredRows.length === 0}
            className="gap-2 flex-1 sm:flex-none min-w-[120px]"
          >
            <FileText className="h-4 w-4" /> Export PDF
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium w-full sm:w-auto sm:mr-1">More tools</span>
          <ArchivedPdfsDrawer />
          <ReconnectGmailDialog />
          <DebugPollDialog />
          <SmsSetupGuide />
          <BucketTransferLauncher />
          <BacklogSweepLauncher />
        </div>
      </div>

      {/* Mobile fast-search — sits at the very top of the page (sticky) so ops
          can find a transaction by reference / TID / amount / sender name or
          phone without scrolling past the summary cards. Bound to the same
          `searchQuery` state as the full search bar in the list card, so the
          two always stay in sync. */}
      <div className="sm:hidden sticky top-0 z-20 -mx-1 px-1 py-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b space-y-2">
        <div className="relative w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground pointer-events-none" />
          <input
            type="search"
            inputMode="search"
            enterKeyHint="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
                document
                  .getElementById('email-tx-results')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }
            }}
            placeholder="Search reference, TID, amount or sender…"
            aria-label="Quick search email transactions"
            className="h-11 w-full rounded-full border-2 border-input bg-background pl-10 pr-10 text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent placeholder:text-muted-foreground/70"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground rounded-full p-1 hover:bg-muted"
              aria-label="Clear quick search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {searchActive && (
          <button
            type="button"
            onClick={() =>
              document
                .getElementById('email-tx-results')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
            className="w-full rounded-lg bg-primary/10 text-primary text-xs font-semibold py-2"
          >
            {filteredRows.length} match{filteredRows.length === 1 ? '' : 'es'} — tap to view results
          </button>
        )}
      </div>

      {/* Date-range selector — recomputes totals/breakdown/exports for the chosen
          period. Pinned under the quick-search bar on mobile so filters are
          always one tap away, no scrolling back up. */}
      <div className="sm:hidden sticky top-[60px] z-[19] flex items-center justify-between gap-2 -mx-1 px-1 py-1.5 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b">
        <Button
          variant="outline"
          size="sm"
          className="flex-1 gap-2"
          onClick={() => setMobileFiltersOpen((v) => !v)}
        >
          {mobileFiltersOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          {mobileFiltersOpen ? 'Hide filters' : 'Filters & date range'}
          {(rangeActive || searchActive) && (
            <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">active</Badge>
          )}
        </Button>
        {/* One-tap audit export of exactly what is on screen (all filters,
            search and sort applied) — one CSV line per email. */}
        <Button
          variant="secondary"
          size="sm"
          className="gap-1.5 shrink-0"
          disabled={visibleRows.length === 0}
          onClick={() => {
            try { navigator.vibrate?.(15); } catch { /* haptics optional */ }
            const count = exportFilteredRowsCsv(visibleRows, getRowStatus);
            toast({
              title: 'CSV exported',
              description: `${count} filtered transaction${count === 1 ? '' : 's'} downloaded.`,
            });
          }}
        >
          <FileDown className="h-4 w-4" />
          CSV ({visibleRows.length})
        </Button>
      </div>
      <div className={`rounded-xl border bg-card p-3 sm:p-4 flex-col sm:flex-row sm:flex-wrap sm:items-end gap-3 sm:gap-4 ${mobileFiltersOpen ? 'flex' : 'hidden sm:flex'}`}>
        <div className="flex-1 min-w-full sm:min-w-[200px]">
          <h3 className="font-semibold text-sm">Date range</h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {searchActive
              ? `Showing ${filteredRows.length} of ${rows.length} emails — search "${searchQuery}" (date range ignored while searching) · timezone ${tz}`
              : rangeActive
              ? `Showing ${filteredRows.length} of ${rows.length} emails — totals recomputed for ${fromDate || '…'} → ${toDate || '…'} (${tz})`
              : `No range selected — showing all ${rows.length} emails · timezone ${tz}`}
          </p>
        </div>
        <div className="flex flex-col flex-1 sm:flex-none min-w-[140px]">
          <label
            className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1"
            title="Date boundaries and daily buckets are interpreted in this timezone."
          >
            Timezone
          </label>
          <select
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            {TIMEZONE_OPTIONS.includes(tz) ? null : <option value={tz}>{tz}</option>}
            {TIMEZONE_OPTIONS.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
            {browserTz && !TIMEZONE_OPTIONS.includes(browserTz) && (
              <option value={browserTz}>{browserTz} (browser)</option>
            )}
          </select>
        </div>
        <div className="flex flex-col flex-1 sm:flex-none min-w-[130px]">
          <label className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">From</label>
          <input
            type="date"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => setFromDate(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        <div className="flex flex-col flex-1 sm:flex-none min-w-[130px]">
          <label className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">To</label>
          <input
            type="date"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => setToDate(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        <div className="flex flex-col flex-1 sm:flex-none min-w-[160px]">
          <label
            className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1"
            title="Warn when the absolute Net (in − out) exceeds this amount — flags potentially unusual parsing."
          >
            Net warning ≥
          </label>
          <div className="relative">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground pointer-events-none">UGX</span>
            <input
              type="number"
              min={0}
              step={10000}
              value={netThreshold}
              onChange={(e) => {
                const v = Number(e.target.value);
                setNetThreshold(Number.isFinite(v) && v >= 0 ? v : 0);
              }}
              className="h-9 w-full sm:w-36 rounded-md border border-input bg-background pl-10 pr-2 text-sm tabular-nums"
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2 w-full sm:w-auto">
          {[
            { label: 'Today', days: 1 },
            { label: 'Yesterday', days: 1, offset: 1 },
            { label: '7d', days: 7 },
            { label: '30d', days: 30 },
            { label: '90d', days: 90 },
          ].map((p) => (
            <Button
              key={p.label}
              variant="outline"
              size="sm"
              className="flex-1 sm:flex-none"
              onClick={() => {
                // Anchor presets to "today" as seen in the selected timezone.
                const todayKey = dateKeyInTz(new Date(), tz);
                const [y, m, d] = todayKey.split('-').map(Number);
                const offsetDays = (p as { offset?: number }).offset ?? 0;
                const toUtc = Date.UTC(y, m - 1, d) - offsetDays * 86_400_000;
                const fromUtc = toUtc - (p.days - 1) * 86_400_000;
                const fmtKey = (ms: number) => {
                  const dt = new Date(ms);
                  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
                };
                setFromDate(fmtKey(fromUtc));
                setToDate(fmtKey(toUtc));
              }}
            >
              {p.label}
            </Button>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 sm:flex-none"
            onClick={() => { setFromDate(''); setToDate(''); }}
            disabled={!rangeActive}
          >
            Clear
          </Button>
        </div>
      </div>

      <GmailConnectionStatus
        state={state}
        lastSuccessAt={lastSuccessAt}
        onRetry={pollNow}
        retrying={polling}
      />

      <GmailReconnectAuditPanel />

      <EmailPeriodComparison />

      <div className="sm:hidden">
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-2"
          onClick={() => setMobileStatsOpen((v) => !v)}
        >
          {mobileStatsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          {mobileStatsOpen ? 'Hide summary' : `Summary · ${rows.length} emails · net ${netAmount < 0 ? '-' : ''}${fmtUgx(Math.abs(netAmount))}`}
        </Button>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Label htmlFor="tooltip-placement" className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Tooltip position
        </Label>
        <Select value={tooltipPlacement} onValueChange={(v) => setTooltipPlacement(v as typeof tooltipPlacement)}>
          <SelectTrigger id="tooltip-placement" className="h-8 w-[120px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Auto</SelectItem>
            <SelectItem value="top">Top</SelectItem>
            <SelectItem value="bottom">Bottom</SelectItem>
            <SelectItem value="left">Left</SelectItem>
            <SelectItem value="right">Right</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className={`grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 ${mobileStatsOpen ? 'grid' : 'hidden sm:grid'}`}>
        <StatCard
          tooltipSide={statTooltipSide}
          label="Emails captured"
          value={rows.length.toString()}
          info={<p className="text-xs leading-relaxed">How many confirmation emails we have pulled in from Gmail.</p>}
        />
        <StatCard
          tooltipSide={statTooltipSide}
          label="Parsed transactions"
          value={parsedCount.toString()}
          info={<p className="text-xs leading-relaxed">Emails we successfully read and turned into a money amount.</p>}
        />
        <StatCard
          tooltipSide={statTooltipSide}
          label="Total amount (parsed)"
          value={fmtUgx(totalAmount)}
          info={<p className="text-xs leading-relaxed">All the money values added up across every readable email.</p>}
        />
        <StatCard
          tooltipSide={statTooltipSide}
          label="Total in (received)"
          value={fmtUgx(totalIn)}
          info={<p className="text-xs leading-relaxed">Money that came IN — deposits and payments received.</p>}
          sub={<span className="text-[10px] text-emerald-600">↓ money received</span>}
        />
        <StatCard
          tooltipSide={statTooltipSide}
          label="Total out (sent + charges)"
          value={fmtUgx(totalOut)}
          info={<p className="text-xs leading-relaxed">Money that went OUT — payments sent plus provider fees.</p>}
          sub={<span className="text-[10px] text-rose-600">↑ money sent</span>}
        />
        <StatCard
          tooltipSide={statTooltipSide}
          label="Total provider fees"
          value={fmtUgx(totalFees)}
          info={<p className="text-xs leading-relaxed">Charges taken by MTN, Airtel or the banks for these transactions.</p>}
          sub={<span className="text-[10px] text-amber-600">{feeCount} row{feeCount === 1 ? '' : 's'} · MTN / Airtel / banks</span>}
        />
        <StatCard
          tooltipSide={statTooltipSide}
          label="Net (in − out)"
          value={`${netAmount < 0 ? '-' : ''}${fmtUgx(Math.abs(netAmount))}`}
          info={
            <div className="space-y-1.5 text-xs leading-relaxed">
              <p className="font-semibold">How Net is calculated</p>
              <p>
                <span className="font-mono">Net = Total in − Total out</span>
              </p>
              <ul className="list-disc pl-4 space-y-0.5">
                <li><span className="text-emerald-300">Total in</span> = sum of <code>amount</code> for rows where <code>direction = 'in'</code> (money received).</li>
                <li><span className="text-rose-300">Total out</span> = sum of <code>amount</code> for rows where <code>direction = 'out'</code> or <code>'charge'</code> (sent + fees).</li>
              </ul>
              <p className="pt-1 border-t border-border/40">
                Counts every <strong>parsed</strong> row with a usable amount that falls inside the selected date range. Flagged rows are still included — they are highlighted in amber for manual review but no longer excluded from totals.
              </p>
              <p className="text-muted-foreground">
                Currently: {fmtUgx(totalIn)} − {fmtUgx(totalOut)} = {netAmount < 0 ? '-' : ''}{fmtUgx(Math.abs(netAmount))}
              </p>
            </div>
          }
          sub={
            <div className="flex flex-col gap-1">
              <span className={`text-[10px] ${netAmount >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                {netAmount >= 0 ? 'net inflow' : 'net outflow'}
              </span>
              {netThreshold > 0 && Math.abs(netAmount) >= netThreshold && (
                <Badge
                  variant="outline"
                  className="text-[10px] bg-amber-500/10 text-amber-700 border-amber-500/30 gap-1 w-fit"
                  title={`|Net| ${fmtUgx(Math.abs(netAmount))} ≥ threshold ${fmtUgx(netThreshold)}. Review parsed emails for duplicates, misclassified direction, or unusually large amounts.`}
                >
                  <AlertTriangle className="h-3 w-3" /> unusual · review
                </Badge>
              )}
            </div>
          }
        />
        <StatCard
          tooltipSide={statTooltipSide}
          label="Last poll"
          value={state?.last_polled_at ? format(new Date(state.last_polled_at), 'HH:mm:ss') : '—'}
          info={<p className="text-xs leading-relaxed">The time we last checked Gmail for new emails (happens automatically every minute).</p>}
          sub={state?.last_status === 'error' ? (
            <span className="inline-flex items-center gap-1 text-destructive text-xs"><AlertCircle className="h-3 w-3" /> {state.last_error?.slice(0, 60)}</span>
          ) : state?.last_status === 'ok' ? (
            <span className="inline-flex items-center gap-1 text-emerald-600 text-xs"><CheckCircle2 className="h-3 w-3" /> ok</span>
          ) : null}
        />
        <StatCard
          tooltipSide={statTooltipSide}
          label="Flagged (review)"
          value={flaggedCount.toString()}
          info={<p className="text-xs leading-relaxed">Rows that look unusual and are worth a quick human check. They still count toward totals.</p>}
          sub={
            flaggedCount > 0 ? (
              <span className="inline-flex items-center gap-1 text-amber-600 text-[10px]">
                <AlertTriangle className="h-3 w-3" /> counted, but verify
              </span>
            ) : (
              <span className="text-[10px] text-emerald-600">all parsed rows valid</span>
            )
          }
        />
        <StatCard
          tooltipSide={statTooltipSide}
          label="Unmatched deposits"
          value={unmatchedInCount.toString()}
          info={<p className="text-xs leading-relaxed">Incoming money not yet linked to a deposit request — may still need routing.</p>}
          sub={
            unmatchedInCount > 0 ? (
              <span className="inline-flex items-center gap-1 text-amber-600 text-[10px]">
                <AlertTriangle className="h-3 w-3" /> not linked to any deposit request
              </span>
            ) : (
              <span className="text-[10px] text-emerald-600">all deposits matched</span>
            )
          }
        />
        <StatCard
          tooltipSide={statTooltipSide}
          label="Unmatched payouts"
          value={unmatchedOutCount.toString()}
          info={<p className="text-xs leading-relaxed">Outgoing money not yet linked to a withdrawal — may still need routing.</p>}
          sub={
            unmatchedOutCount > 0 ? (
              <span className="inline-flex items-center gap-1 text-rose-600 text-[10px]">
                <AlertTriangle className="h-3 w-3" /> not routed or matched to withdrawal
              </span>
            ) : (
              <span className="text-[10px] text-emerald-600">all payouts settled</span>
            )
          }
        />
      </div>

      {channelBreakdown.length > 0 && (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="p-4 border-b flex items-center justify-between">
            <h3 className="font-semibold text-sm">Breakdown by channel</h3>
            <span className="text-[11px] text-muted-foreground">parsed transactions only</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-2 font-semibold">Channel</th>
                  <th className="text-right px-4 py-2 font-semibold">In (count)</th>
                  <th className="text-right px-4 py-2 font-semibold text-emerald-700">Total in</th>
                  <th className="text-right px-4 py-2 font-semibold">Out (count)</th>
                  <th className="text-right px-4 py-2 font-semibold text-rose-700">Total out</th>
                  <th className="text-right px-4 py-2 font-semibold">Fees (count)</th>
                  <th className="text-right px-4 py-2 font-semibold text-amber-700">Total fees</th>
                  <th className="text-right px-4 py-2 font-semibold">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {channelBreakdown.map((b) => (
                  <tr key={b.channel} className="hover:bg-muted/30">
                    <td className="px-4 py-2 capitalize font-medium">{b.channel}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{b.inCount}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-mono text-emerald-700">{fmtUgx(b.inTotal)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{b.outCount}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-mono text-rose-700">{fmtUgx(b.outTotal)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{b.feeCount}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-mono text-amber-700">{fmtUgx(b.feeTotal)}</td>
                    <td className={`px-4 py-2 text-right tabular-nums font-mono font-semibold ${b.net >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {b.net < 0 ? '-' : ''}{fmtUgx(Math.abs(b.net))}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-muted/30 font-semibold">
                <tr>
                  <td className="px-4 py-2">Total</td>
                  <td className="px-4 py-2 text-right tabular-nums">{channelBreakdown.reduce((s, b) => s + b.inCount, 0)}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-mono text-emerald-700">{fmtUgx(totalIn)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{channelBreakdown.reduce((s, b) => s + b.outCount, 0)}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-mono text-rose-700">{fmtUgx(totalOut)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{channelBreakdown.reduce((s, b) => s + b.feeCount, 0)}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-mono text-amber-700">{fmtUgx(totalFees)}</td>
                  <td className={`px-4 py-2 text-right tabular-nums font-mono ${netAmount >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {netAmount < 0 ? '-' : ''}{fmtUgx(Math.abs(netAmount))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {dailySeries.length > 0 && (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="p-4 border-b flex items-center justify-between">
            <h3 className="font-semibold text-sm">In vs Out — daily</h3>
            <span className="text-[11px] text-muted-foreground">
              {dailySeries.length} day{dailySeries.length === 1 ? '' : 's'}
              {rangeActive ? ' in selected range' : ''}
              {dailySeries.length > 1 ? ' · drag the slider below to zoom' : ''}
            </span>
          </div>
          {(() => {
            // Summary for the currently-zoomed window. Defaults to the full series
            // when no brush selection is active.
            const start = chartBrush ? Math.max(0, Math.min(chartBrush.start, dailySeries.length - 1)) : 0;
            const end = chartBrush ? Math.max(start, Math.min(chartBrush.end, dailySeries.length - 1)) : dailySeries.length - 1;
            const windowDays = dailySeries.slice(start, end + 1);
            if (windowDays.length === 0) return null;
            const winIn = windowDays.reduce((s, d) => s + d.in, 0);
            const winOut = windowDays.reduce((s, d) => s + d.out, 0);
            const winNet = winIn - winOut;
            const isZoomed = !!chartBrush && (start > 0 || end < dailySeries.length - 1);
            return (
              <div className="px-4 pt-3 pb-1 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
                <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                  <span className="text-muted-foreground">{isZoomed ? 'Zoomed' : 'Full range'}:</span>
                  {format(new Date(windowDays[0].date), 'MMM d')}
                  {windowDays.length > 1 ? ` – ${format(new Date(windowDays[windowDays.length - 1].date), 'MMM d, yyyy')}` : `, ${format(new Date(windowDays[0].date), 'yyyy')}`}
                  <span className="text-muted-foreground">({windowDays.length} day{windowDays.length === 1 ? '' : 's'})</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: 'hsl(142 71% 45%)' }} />
                  <span className="text-muted-foreground">In</span>
                  <span className="font-mono font-semibold text-emerald-600">{fmtUgx(winIn)}</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: 'hsl(0 72% 51%)' }} />
                  <span className="text-muted-foreground">Out</span>
                  <span className="font-mono font-semibold text-rose-600">{fmtUgx(winOut)}</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-muted-foreground">Net</span>
                  <span className={`font-mono font-semibold ${winNet >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {winNet < 0 ? '-' : ''}{fmtUgx(Math.abs(winNet))}
                  </span>
                </span>
                {isZoomed && (
                  <button
                    type="button"
                    onClick={() => setChartBrush(null)}
                    className="ml-auto text-[11px] font-medium text-primary hover:underline"
                  >
                    Reset zoom
                  </button>
                )}
                <div className={`flex items-center gap-1.5 ${isZoomed ? '' : 'ml-auto'}`}>
                  <button
                    type="button"
                    onClick={() => exportZoomWindowCsv({ days: windowDays, totalIn: winIn, totalOut: winOut, net: winNet, zoomed: isZoomed })}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground hover:bg-muted transition-colors"
                    title="Export this date-range summary to CSV"
                  >
                    <FileDown className="h-3 w-3" /> CSV
                  </button>
                  <button
                    type="button"
                    onClick={() => exportZoomWindowPdf({ days: windowDays, totalIn: winIn, totalOut: winOut, net: winNet, zoomed: isZoomed })}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground hover:bg-muted transition-colors"
                    title="Export this date-range summary to PDF"
                  >
                    <FileText className="h-3 w-3" /> PDF
                  </button>
                </div>
              </div>
            );
          })()}
          <div className="p-4 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dailySeries} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                  tickFormatter={(v) => format(new Date(v), 'MMM d')}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                  tickFormatter={(v) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `${Math.round(v / 1_000)}k` : `${v}`)}
                  width={50}
                />
                <RTooltip
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelFormatter={(v) => format(new Date(v as string), 'PPP')}
                  formatter={(v: number, name) => [fmtUgx(v), name]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="in" name="In" stroke="hsl(142 71% 45%)" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="out" name="Out" stroke="hsl(0 72% 51%)" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="net" name="Net" stroke="hsl(var(--primary))" strokeWidth={1.5} strokeDasharray="4 4" dot={false} />
                {dailySeries.length > 1 && (
                  <Brush
                    dataKey="date"
                    height={22}
                    travellerWidth={10}
                    stroke="hsl(var(--primary))"
                    fill="hsl(var(--muted))"
                    tickFormatter={(v) => format(new Date(v as string), 'MMM d')}
                    startIndex={chartBrush ? Math.min(chartBrush.start, dailySeries.length - 1) : 0}
                    endIndex={chartBrush ? Math.min(chartBrush.end, dailySeries.length - 1) : dailySeries.length - 1}
                    onChange={(range: { startIndex?: number; endIndex?: number }) => {
                      if (typeof range.startIndex === 'number' && typeof range.endIndex === 'number') {
                        setChartBrush({ start: range.startIndex, end: range.endIndex });
                      }
                    }}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {(() => {
        // Unrouted money-out banner. Counts every payable outgoing row in the
        // active date/search window that has NOT yet been routed to a wallet.
        // The "Auto-debit" button acts on EVERY row that has a possible
        // recipient match — as soon as the system detects a possible recipient
        // (TID = 100, "to/from <phone>" = 90, name match = 75, weak match = 60),
        // the wallet is eligible for an automatic reduction.
        const AUTO_DEBIT_MIN_SCORE = 0;
        const outRows = filteredRows.filter(
          (r) => isCountable(r) && (r.direction === 'out' || r.direction === 'charge'),
        );
        const unrouted = outRows.filter((r) => !(routingHistory[r.id]?.length));
        type HighConfRow = { row: GmailTx; top: MatchedUser; score: number };
        const highConf: HighConfRow[] = [];
        for (const r of unrouted) {
          const matches = userMatches[r.id] ?? [];
          const ranked = matches
            .map((u) => ({
              u,
              s: u.matched_on.startsWith('reference ') ? 100
                : u.matched_on.startsWith('to ') ? 90
                : u.matched_on.startsWith('from ') ? 90
                : u.matched_on.startsWith('name-') ? 75
                : 60,
            }))
            .sort((a, b) => b.s - a.s);
          const top = ranked[0];
          if (top && top.s >= AUTO_DEBIT_MIN_SCORE) highConf.push({ row: r, top: top.u, score: top.s });
        }
        if (outRows.length === 0) return null;
        const unroutedAmt = unrouted.reduce((s, r) => s + (r.amount ?? 0), 0);
        const highConfAmt = highConf.reduce((s, x) => s + (x.row.amount ?? 0), 0);

        const runAutoDebit = async () => {
          if (!highConf.length) return;
          setAutoDebitBusy(true);
          setAutoDebitProgress({ done: 0, total: highConf.length, ok: 0, failed: 0 });
          let okCount = 0;
          let failCount = 0;
          let me: { id: string } | null = null;
          let routedByName: string | null = null;
          try {
            const { data: meRes } = await supabase.auth.getUser();
            if (meRes?.user?.id) {
              me = { id: meRes.user.id };
              const { data: rp } = await (supabase.from('profiles') as any)
                .select('full_name').eq('id', meRes.user.id).maybeSingle();
              routedByName = rp?.full_name ?? null;
            }
          } catch { /* ignore */ }
          for (let i = 0; i < highConf.length; i++) {
            const { row, top, score } = highConf[i];
            const amt = row.amount ?? 0;
            const matchedLabel = top.matched_on;
            const reason = `Auto-debit (score ${score}%, ${matchedLabel}) — outgoing payment email from ${row.from_name || row.from_email || 'provider'}${row.transaction_id ? ` TID ${row.transaction_id}` : ''} charged against ${top.full_name}'s wallet.`;
            try {
              // Guard: the ledger rejects amount 0. Emails with no parsed
              // amount must never be sent to cfo-direct-credit — skip cleanly.
              if (!Number.isFinite(amt) || amt <= 0) {
                failCount++;
                console.warn(`[auto-debit] skip ${row.id}: no usable amount on email (got ${amt})`);
                setAutoDebitProgress({ done: i + 1, total: highConf.length, ok: okCount, failed: failCount });
                continue;
              }
              // Pre-check strict available balance. The ledger blocks
              // negative wallets, so calling cfo-direct-credit when the
              // user has < amt withdrawable just produces a NEGATIVE_WALLET
              // 400. Skip cleanly with a clear console reason instead.
              const { data: availRaw } = await (supabase.rpc as any)(
                'get_user_available_balance',
                { p_user_id: top.id },
              );
              const avail = Number(availRaw ?? 0);
              // Nothing to take — skip cleanly.
              if (!Number.isFinite(avail) || avail <= 0) {
                failCount++;
                console.warn(
                  `[auto-debit] skip ${row.id}: ${top.full_name} has UGX ${Math.max(0, avail).toLocaleString()} available, needs UGX ${amt.toLocaleString()}`,
                );
                setAutoDebitProgress({ done: i + 1, total: highConf.length, ok: okCount, failed: failCount });
                continue;
              }
              // The ledger blocks negative wallets, so never try to debit more
              // than the strict available balance — clamp to drain to zero.
              const debitAmt = Math.min(Math.floor(amt), Math.floor(avail));
              if (!Number.isFinite(debitAmt) || debitAmt <= 0) {
                failCount++;
                console.warn(
                  `[auto-debit] skip ${row.id}: computed debit amount was UGX ${debitAmt.toLocaleString()} after clamping available balance UGX ${avail.toLocaleString()}`,
                );
                setAutoDebitProgress({ done: i + 1, total: highConf.length, ok: okCount, failed: failCount });
                continue;
              }
              const isPartial = debitAmt < amt;
              const { data: debitData, error: debitErr } = await supabase.functions.invoke('cfo-direct-credit', {
                body: {
                  target_user_id: top.id,
                  amount: debitAmt,
                  reason,
                  operation: 'debit' as const,
                  wallet_category: 'wallet_transfer',
                  platform_category: 'wallet_transfer',
                  financial_impact: 'neutral' as const,
                  category_label: 'Email charge → Withdrawable (auto)',
                  recipient_type: 'user',
                  sub_category: row.transaction_id ?? null,
                },
              });
              if (debitErr) throw new Error((debitErr as any)?.message || 'Debit failed');
              if ((debitData as any)?.error) throw new Error((debitData as any).error);
              const referenceId = (debitData as any)?.reference_id ?? null;
              if (isPartial) {
                console.warn(
                  `[auto-debit] partial ${row.id}: debited UGX ${debitAmt.toLocaleString()} of UGX ${amt.toLocaleString()} (wallet drained to zero)`,
                );
              }
              // Capture the wallet impact: re-read the strict available balance
              // after the debit so the row can show how much is left.
              let newAvail: number | null = null;
              try {
                const { data: afterRaw } = await (supabase.rpc as any)(
                  'get_user_available_balance',
                  { p_user_id: top.id },
                );
                const n = Number(afterRaw);
                newAvail = Number.isFinite(n) ? n : null;
              } catch { /* ignore — impact display is best-effort */ }
              setAutoDebitResults((prev) => ({
                ...prev,
                [row.id]: { amount: debitAmt, newAvail, userName: top.full_name },
              }));
              // Refresh the displayed wallet figure for this user immediately so
              // the panel reflects the reduced balance instead of the stale
              // pre-debit value cached in `userBalances`.
              if (newAvail !== null) {
                setUserBalances((cur) => ({ ...cur, [top.id]: newAvail as number }));
              } else {
                setUserBalances((cur) => {
                  const next = { ...cur };
                  delete next[top.id];
                  return next;
                });
              }
              // Best-effort history insert so the row immediately shows as routed.
              if (me?.id) {
                try {
                  await (supabase.from('email_routing_history') as any).insert({
                    gmail_transaction_id: row.id,
                    gmail_message_id: row.gmail_message_id ?? null,
                    transaction_id: row.transaction_id,
                    from_email: row.from_email,
                    from_name: row.from_name,
                    subject: row.subject,
                    amount: debitAmt,
                    route: 'withdrawable_debit',
                    target_user_id: top.id,
                    target_user_name: top.full_name,
                    target_user_phone: top.phone,
                    reason: `DEBIT (auto, ${matchedLabel}${isPartial ? `, partial ${debitAmt.toLocaleString()}/${amt.toLocaleString()}` : ''}): ${reason}`,
                    ledger_reference_id: referenceId,
                    routed_by: me.id,
                    routed_by_name: routedByName,
                    sms_sent: false,
                    sms_error: null,
                  });
                } catch (e) {
                  console.warn('[auto-debit] history insert failed', e);
                }
              }
              okCount++;
            } catch (e: any) {
              failCount++;
              console.error('[auto-debit] row failed', row.id, e?.message);
            }
            setAutoDebitProgress({ done: i + 1, total: highConf.length, ok: okCount, failed: failCount });
          }
          setAutoDebitBusy(false);
          // Force an authoritative re-fetch of every displayed strict balance so
          // each charged wallet visibly drops by the debited amount. Without this
          // the cache only fetches missing ids and keeps showing pre-debit values.
          setUserBalances({});
          // Stamp the refresh so the UI can show a visible "Balance refreshed"
          // confirmation that the figures on screen are now post-debit.
          setBalanceRefreshedAt(Date.now());
          toast({
            title: `Auto-debit complete`,
            description: `${okCount} succeeded, ${failCount} skipped/failed of ${highConf.length}. Skips usually mean the matched user has 0 withdrawable balance — see console for details.`,
            variant: failCount > 0 ? 'destructive' : 'default',
          });
        };

        return (
          <div className={`rounded-xl border p-3 flex flex-col gap-3 sm:flex-row sm:items-start ${unrouted.length > 0 ? 'border-rose-300 bg-rose-50/60 dark:border-rose-900/60 dark:bg-rose-950/30' : 'border-emerald-300 bg-emerald-50/60 dark:border-emerald-900/60 dark:bg-emerald-950/30'}`}>
            <div className="flex items-start gap-3 flex-1 min-w-0">
            <div className={`mt-0.5 h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${unrouted.length > 0 ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-200' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-200'}`}>
              {unrouted.length > 0 ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold">
                {unrouted.length > 0
                  ? `${unrouted.length} money-out email${unrouted.length === 1 ? '' : 's'} not yet charged to any wallet`
                  : `All ${outRows.length} money-out email${outRows.length === 1 ? '' : 's'} routed to wallets`}
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {unrouted.length > 0 ? (
                  <>
                    Unrouted total <strong className="font-mono text-foreground/80">{fmtUgx(unroutedAmt)}</strong>
                    {' '}· {highConf.length} of them have a possible recipient
                    {highConf.length > 0 && <> ({fmtUgx(highConfAmt)})</>}.
                    {' '}Until they're routed, no user wallet is reduced for these payouts.
                  </>
                ) : (
                  <>Every outgoing email in this window has a matching wallet debit on the ledger.</>
                )}
              </p>
              {autoDebitProgress && (
                <p className="text-[11px] mt-1 font-mono">
                  Progress: {autoDebitProgress.done}/{autoDebitProgress.total}
                  {' '}· <span className="text-emerald-700">{autoDebitProgress.ok} ok</span>
                  {autoDebitProgress.failed > 0 && <> · <span className="text-rose-700">{autoDebitProgress.failed} failed</span></>}
                </p>
              )}
              {balanceRefreshedAt && !autoDebitBusy && (
                <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-200">
                  <RefreshCw className="h-3 w-3" />
                  Balances refreshed · {new Date(balanceRefreshedAt).toLocaleTimeString()}
                </span>
              )}
            </div>
            </div>
            {highConf.length > 0 && (
              <Button
                size="sm"
                variant="default"
                className="w-full sm:w-auto shrink-0 bg-rose-600 hover:bg-rose-700 text-white gap-1.5"
                disabled={autoDebitBusy}
                onClick={runAutoDebit}
                title={`Posts a withdrawable debit via CFO Direct Debit for each of the ${highConf.length} payout(s) with a possible recipient.`}
              >
                {autoDebitBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                Auto-debit {highConf.length} possible recipient{highConf.length === 1 ? '' : 's'}
              </Button>
            )}
          </div>
        );
      })()}

      {/* ── Unparsed-email queue ─────────────────────────────────────────
          Every Gmail row the parser skipped (no usable amount), each with
          the exact reason(s) it failed. Collapsed by default. */}
      {unparsedRows.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 overflow-hidden">
          <button
            type="button"
            onClick={() => setUnparsedOpen((o) => !o)}
            className="w-full flex items-center justify-between gap-2 p-4 text-left hover:bg-amber-500/10 transition-colors"
          >
            <span className="flex items-center gap-2 font-semibold text-sm text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Unparsed email queue
              <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-400">
                {unparsedRows.length} skipped
              </Badge>
            </span>
            {unparsedOpen ? <ChevronUp className="h-4 w-4 text-amber-700 dark:text-amber-400" /> : <ChevronDown className="h-4 w-4 text-amber-700 dark:text-amber-400" />}
          </button>
          {unparsedOpen && (
            <div className="border-t border-amber-500/20 divide-y divide-amber-500/10">
              <p className="px-4 py-2 text-xs text-muted-foreground">
                These rows were skipped by the parser and never counted toward any total. Each shows the exact reason it could not be parsed.
              </p>
              {unparsedRows.map((r) => {
                const reasons = parseFailureReasons(r);
                const when = r.internal_date
                  ? new Date(r.internal_date).toLocaleString('en-GB', { timeZone: tz })
                  : '—';
                return (
                  <div key={r.id} className="px-4 py-3 space-y-1.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{r.subject || '(no subject)'}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {r.from_name || r.from_email || 'unknown sender'} · {when}
                        </p>
                      </div>
                      <Badge variant="outline" className="text-[10px] shrink-0">unparsed</Badge>
                    </div>
                    {r.snippet && (
                      <p className="text-xs text-muted-foreground line-clamp-2">{r.snippet}</p>
                    )}
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      {reasons.map((reason) => (
                        <Badge
                          key={reason}
                          variant="outline"
                          className="text-[10px] gap-1 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                        >
                          <AlertCircle className="h-3 w-3" />
                          {reason}
                        </Badge>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Unread alert banner — first thing ops sees: how many attention-needing
          emails (needs routing / unparsed) arrived since they last acknowledged
          the queue, with one tap to jump straight to them. */}
      {unreadAlertCount > 0 && (
        <div className="rounded-xl border border-orange-500/40 bg-orange-500/10 p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="flex items-start gap-2 min-w-0">
            <span className="relative mt-0.5 shrink-0">
              <AlertCircle className="h-4 w-4 text-orange-700 dark:text-orange-400" />
              <span className="absolute -top-1.5 -right-1.5 h-2 w-2 rounded-full bg-orange-600 animate-pulse" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-orange-800 dark:text-orange-300">
                {unreadAlertCount} new item{unreadAlertCount === 1 ? '' : 's'} need attention
                <Badge className="ml-2 bg-orange-600 text-white hover:bg-orange-600 text-[10px] font-mono">
                  {unreadAlertCount} unread
                </Badge>
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {alertRows.length} total unresolved in this window (awaiting routing or unparsed).
              </p>
              {unreadArrivalSpan && (
                <>
                  <p className="text-[11px] text-orange-800/90 dark:text-orange-300/90 mt-1">
                    Newest arrived {formatAlertArrival(unreadArrivalSpan.newest)}
                    {unreadAlertCount > 1 && <> · oldest unread {formatAlertArrival(unreadArrivalSpan.oldest)}</>}
                  </p>
                  <ul className="mt-1.5 space-y-0.5">
                    {unreadArrivalSpan.sorted.slice(0, 3).map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => setAlertDetailsRow(r)}
                          className="w-full text-left text-[11px] text-muted-foreground flex items-center gap-1.5 min-w-0 rounded px-1 py-0.5 hover:bg-orange-500/10 hover:text-foreground transition-colors"
                          aria-label="Open alert details"
                        >
                          <Clock className="h-3 w-3 shrink-0" aria-hidden />
                          <span className="font-mono shrink-0">{formatAlertArrival(r)}</span>
                          <span className="truncate">
                            — {r.counterparty || r.from_name || r.from_email || 'Unknown sender'}
                            {r.amount ? ` · UGX ${Number(r.amount).toLocaleString()}` : ''}
                          </span>
                          <ArrowRight className="h-3 w-3 shrink-0 ml-auto" aria-hidden />
                        </button>
                      </li>
                    ))}
                    {unreadAlertCount > 3 && (
                      <li className="text-[11px] text-muted-foreground/80">
                        +{unreadAlertCount - 3} more unread…
                      </li>
                    )}
                  </ul>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => {
                setStatusFilter('needs_routing');
                document.getElementById('email-tx-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              Review now
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={bulkBusy || alertRows.length === 0}
              onClick={() => { selectAllAlertRows(); document.getElementById('email-tx-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
            >
              Select all {alertRows.length}
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={bulkBusy || alertRows.length === 0}
              onClick={() => resolveAlertRows(alertRows)}
            >
              {bulkBusy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
              Resolve all
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={!unreadArrivalSpan}
              onClick={() => unreadArrivalSpan && setAlertDetailsRow(unreadArrivalSpan.newest)}
            >
              Open details
            </Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={markAlertsSeen}>
              Mark all seen
            </Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setAlertSettingsOpen(true)}>
              <SlidersHorizontal className="h-3.5 w-3.5 mr-1" /> Alert settings
            </Button>
          </div>
        </div>
      )}

      {/* Alert notification settings — which alert types count toward badges and
          whether new arrivals raise an in-app prompt. Stored per browser. */}
      <Dialog open={alertSettingsOpen} onOpenChange={setAlertSettingsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4" /> Alert notification settings
            </DialogTitle>
            <DialogDescription>
              Choose which email alert types show unread badges and trigger in-app prompts.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="flex items-start gap-3 rounded-md border p-3 cursor-pointer">
              <Checkbox
                checked={alertPrefs.needsRouting}
                onCheckedChange={(v) => updateAlertPrefs({ needsRouting: !!v })}
              />
              <span className="text-sm">
                Awaiting routing
                <span className="block text-[11px] text-muted-foreground">
                  Parsed emails not yet routed to a wallet or deposit.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-md border p-3 cursor-pointer">
              <Checkbox
                checked={alertPrefs.unparsed}
                onCheckedChange={(v) => updateAlertPrefs({ unparsed: !!v })}
              />
              <span className="text-sm">
                Unparsed emails
                <span className="block text-[11px] text-muted-foreground">
                  Messages the reader could not extract amount / TID from.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-md border p-3 cursor-pointer">
              <Checkbox
                checked={alertPrefs.toastPrompt}
                onCheckedChange={(v) => updateAlertPrefs({ toastPrompt: !!v })}
              />
              <span className="text-sm">
                In-app prompts
                <span className="block text-[11px] text-muted-foreground">
                  Pop a toast with a "Review" shortcut when new alerts arrive.
                </span>
              </span>
            </label>
            {!alertPrefs.needsRouting && !alertPrefs.unparsed && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                All alert types are off — no badges or prompts will show.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>


      <DedupAuditPanel />

      <AlertDialog open={!!pendingSwipe} onOpenChange={(o) => { if (!o) { setPendingSwipe(null); setSwipeAck(false); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingSwipe?.mode === 'credit'
                ? 'Send to wallet?'
                : pendingSwipe?.mode === 'debit'
                  ? 'Charge wallet?'
                  : 'Mark as resolved?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingSwipe?.mode === 'credit'
                ? `Route this deposit of ${fmtUgx(Number(pendingSwipe?.row.amount ?? 0))} to a user's wallet.`
                : pendingSwipe?.mode === 'debit'
                  ? `Charge ${fmtUgx(Number(pendingSwipe?.row.amount ?? 0))} to a user's wallet for this payout. This reduces their balance.`
                  : 'This writes an audit mark saying the money is accounted for. It does not move any funds.'}
              {pendingSwipe && pendingSwipe.mode !== 'resolve'
                ? " You'll confirm the recipient and details on the next screen."
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingSwipe && (
            <div className="rounded-md border bg-muted/40 p-2 text-xs space-y-1">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Amount</span>
                <span className="font-semibold tabular-nums">{fmtUgx(Number(pendingSwipe.row.amount ?? 0))}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Counterparty</span>
                <span className="font-medium text-right">{pendingSwipe.row.counterparty || '—'}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Transaction ID</span>
                <span className="font-mono text-right">{pendingSwipe.row.transaction_id || '—'}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Direction</span>
                <span className="font-medium">{pendingSwipe.row.direction === 'in' ? 'Money in' : 'Money out'}</span>
              </div>
            </div>
          )}
          {pendingSwipe?.mode === 'debit' && (
            <label className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs cursor-pointer">
              <Checkbox checked={swipeAck} onCheckedChange={(v) => setSwipeAck(!!v)} className="mt-0.5" />
              <span>
                I confirm this payout of {fmtUgx(Number(pendingSwipe.row.amount ?? 0))} should be charged to a user's wallet.
              </span>
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pendingSwipe?.mode === 'debit' && !swipeAck}
              onClick={() => {
                if (pendingSwipe) {
                  if (pendingSwipe.mode === 'resolve') void markRowResolved(pendingSwipe.row, 'credited');
                  else swipeNavigate(pendingSwipe.row, pendingSwipe.mode);
                }
                setPendingSwipe(null);
                setSwipeAck(false);
              }}
            >
              {pendingSwipe?.mode === 'credit'
                ? 'Send to wallet'
                : pendingSwipe?.mode === 'debit'
                  ? 'Charge wallet'
                  : 'Mark resolved'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Inline alert details drawer — raw email, parsed fields and actions for a
          single attention-needing row, with prev/next through the unread queue. */}
      <Sheet open={!!alertDetailsRow} onOpenChange={(o) => { if (!o) setAlertDetailsRow(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
          {alertDetailsRow && (() => {
            const r = alertDetailsRow;
            const queue = unreadArrivalSpan?.sorted ?? [];
            const idx = queue.findIndex((q) => q.id === r.id);
            const status = getRowStatus(r);
            const fields: Array<[string, ReactNode]> = [
              ['Arrived', formatAlertArrival(r)],
              ['Status', status.replace('_', ' ')],
              ['Direction', r.direction || '—'],
              ['Amount', r.amount ? `UGX ${Number(r.amount).toLocaleString()}` : '—'],
              ['Fee', r.fee != null ? `UGX ${Number(r.fee).toLocaleString()}` : '—'],
              ['Balance after', r.balance != null ? `UGX ${Number(r.balance).toLocaleString()}` : '—'],
              ['Counterparty', r.counterparty || '—'],
              ['Channel', r.channel || '—'],
              ['Transaction ID', r.transaction_id || '—'],
              ['Parsed', r.parsed ? 'yes' : 'no'],
              ['Linked deposit', r.linked_deposit_request_id || '—'],
              ['Auto matched', r.auto_matched_at ? format(new Date(r.auto_matched_at), 'dd MMM HH:mm') : '—'],
            ];
            return (
              <>
                <SheetHeader>
                  <SheetTitle className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 text-orange-600" /> Alert details
                  </SheetTitle>
                  <SheetDescription>
                    {r.from_name || r.from_email || 'Unknown sender'} · {formatAlertArrival(r)}
                  </SheetDescription>
                </SheetHeader>

                {queue.length > 1 && idx >= 0 && (
                  <div className="mt-3 flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
                    <span className="text-xs font-medium">Unread {idx + 1} of {queue.length}</span>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="outline" className="h-7 text-xs" disabled={idx <= 0}
                        onClick={() => setAlertDetailsRow(queue[idx - 1])}>Prev</Button>
                      <Button size="sm" variant="outline" className="h-7 text-xs" disabled={idx >= queue.length - 1}
                        onClick={() => setAlertDetailsRow(queue[idx + 1])}>Next</Button>
                    </div>
                  </div>
                )}

                <div className="mt-4 space-y-4">
                  <div>
                    <p className="text-xs font-semibold mb-1">Parsed fields</p>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border p-2 text-[11px]">
                      {fields.map(([k, v]) => (
                        <Fragment key={k}>
                          <dt className="text-muted-foreground">{k}</dt>
                          <dd className="font-mono break-all">{v}</dd>
                        </Fragment>
                      ))}
                    </dl>
                  </div>

                  <div>
                    <p className="text-xs font-semibold mb-1">Raw message</p>
                    <div className="rounded-md border bg-muted/30 p-2 space-y-1">
                      <p className="text-[11px] text-muted-foreground">From: {r.from_email || '—'}</p>
                      <p className="text-xs font-medium break-words">{r.subject || '(no subject)'}</p>
                      <p className="text-[11px] whitespace-pre-wrap break-words text-muted-foreground">
                        {r.snippet || '(no body captured)'}
                      </p>
                      <p className="text-[10px] font-mono text-muted-foreground/70 pt-1">
                        msg {r.gmail_message_id}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" className="h-8 text-xs"
                      onClick={() => { setAlertDetailsRow(null); navigateToRow(r, r.direction === 'in' ? 'credit' : 'debit'); }}>
                      <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      {r.direction === 'in' ? 'Route to wallet' : 'Charge wallet'}
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 text-xs"
                      onClick={() => { void markRowResolved(r); }}>
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Mark resolved
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 text-xs"
                      onClick={() => { setAlertDetailsRow(null); setHistoryDrawerRow(r); }}>
                      <History className="h-3.5 w-3.5 mr-1" /> History
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8 text-xs"
                      onClick={() => { navigator.clipboard?.writeText(r.transaction_id || r.gmail_message_id); toast({ title: 'Copied reference' }); }}>
                      <Copy className="h-3.5 w-3.5 mr-1" /> Copy ref
                    </Button>
                  </div>
                </div>
              </>
            );
          })()}
        </SheetContent>
      </Sheet>

      <Sheet open={!!historyDrawerRow} onOpenChange={(o) => { if (!o) { setHistoryDrawerRow(null); setHistoryQueue([]); } }}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <History className="h-4 w-4" /> Status history
            </SheetTitle>
            <SheetDescription>
              {historyDrawerRow
                ? `Every routing / charging transition for the email from ${historyDrawerRow.from_name || historyDrawerRow.from_email || 'Unknown'}.`
                : ''}
            </SheetDescription>
          </SheetHeader>
          {historyQueue.length > 1 && historyQueueIndex >= 0 && (
            <div className="mt-3 flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
              <span className="text-xs font-medium">
                Selected {historyQueueIndex + 1} of {historyQueue.length}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={historyQueueIndex <= 0}
                  onClick={() => setHistoryDrawerRow(historyQueue[historyQueueIndex - 1])}
                >
                  Prev
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={historyQueueIndex >= historyQueue.length - 1}
                  onClick={() => setHistoryDrawerRow(historyQueue[historyQueueIndex + 1])}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
          {(() => {
            const drawerHistory = historyDrawerRow ? (routingHistory[historyDrawerRow.id] ?? []) : [];
            if (!drawerHistory.length) {
              return <p className="mt-6 text-sm text-muted-foreground">No routing or charging transitions recorded yet.</p>;
            }
            // Classify + label each entry once, so both the filter and the
            // rendered timeline share the same route-type logic.
            const classify = (h: RoutingHistoryEntry) => {
              const reversal = /revers/i.test(h.reason || '');
              const isDebit = h.route === 'withdrawable_debit' || /^DEBIT\b/i.test(h.reason || '');
              const type: 'routed' | 'charged' | 'reversed' = reversal ? 'reversed' : isDebit ? 'charged' : 'routed';
              const routeLabel = reversal
                ? 'Reversal'
                : isDebit
                  ? 'Wallet charged'
                  : h.route === 'operational_float'
                    ? 'Routed → Operational Float'
                    : 'Routed → Personal Deposit';
              return { reversal, isDebit, type, routeLabel };
            };
            const q = historyDrawerQuery.trim().toLowerCase();
            const filtered = drawerHistory.filter((h) => {
              const { type, routeLabel } = classify(h);
              if (historyDrawerType !== 'all' && type !== historyDrawerType) return false;
              if (!q) return true;
              const haystack = [
                h.routed_by_name,
                h.target_user_name,
                h.target_user_phone,
                h.reason,
                routeLabel,
                String(h.amount ?? ''),
                format(new Date(h.created_at), 'MMM d, yyyy HH:mm'),
              ].filter(Boolean).join(' ').toLowerCase();
              return haystack.includes(q);
            });
            return (
              <>
                <div className="mt-4 space-y-2">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                    <Input
                      value={historyDrawerQuery}
                      onChange={(e) => setHistoryDrawerQuery(e.target.value)}
                      placeholder="Search actor, user, reason, time…"
                      className="pl-8 h-9 text-sm"
                    />
                    {historyDrawerQuery && (
                      <button
                        type="button"
                        onClick={() => setHistoryDrawerQuery('')}
                        aria-label="Clear search"
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(['all', 'routed', 'charged', 'reversed'] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setHistoryDrawerType(t)}
                        className={`text-xs px-2.5 py-1 rounded-full border capitalize min-h-8 ${
                          historyDrawerType === t
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-background text-muted-foreground border-border hover:bg-muted'
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Showing {filtered.length} of {drawerHistory.length} transition{drawerHistory.length === 1 ? '' : 's'}
                  </p>
                </div>
                {filtered.length === 0 ? (
                  <p className="mt-6 text-sm text-muted-foreground">No transitions match your search or filter.</p>
                ) : (
                <ol className="mt-4 relative border-l border-border pl-5 space-y-5">
                {filtered.map((h) => {
                  const { reversal, isDebit, routeLabel } = classify(h);
                  const busy = !!reverseBusy[h.id];
                  const dotClass = reversal ? 'bg-rose-500' : isDebit ? 'bg-rose-500' : 'bg-violet-500';
                  return (
                    <li key={h.id} className="relative">
                      <span className={`absolute -left-[27px] top-1 h-3 w-3 rounded-full ring-4 ring-background ${dotClass}`} />
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-foreground">{routeLabel}</p>
                        <span className="font-mono tabular-nums text-sm text-foreground">
                          UGX {Number(h.amount ?? 0).toLocaleString()}
                        </span>
                      </div>
                      <p className="mt-0.5 text-sm text-foreground">
                        {reversal ? 'Reversed from ' : 'To '}
                        <span className="font-medium">{h.target_user_name || 'Unknown user'}</span>
                        {h.target_user_phone ? <span className="text-muted-foreground"> · {h.target_user_phone}</span> : null}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {h.routed_by_name ? <>By <span className="font-medium text-foreground/80">{h.routed_by_name}</span> · </> : 'By system · '}
                        {format(new Date(h.created_at), 'MMM d, yyyy · HH:mm')}
                        {h.sms_sent ? ' · SMS sent' : ''}
                      </p>
                      {h.reason && (
                        <p className="mt-1 text-xs text-muted-foreground/90 whitespace-pre-line break-words">{h.reason}</p>
                      )}
                      {!reversal && historyDrawerRow && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => reverseRoutingEntry(historyDrawerRow, h)}
                          className="mt-2 inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-rose-300 text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30 disabled:opacity-60"
                        >
                          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
                          Reverse this transition
                        </button>
                      )}
                    </li>
                  );
                })}
                </ol>
                )}
              </>
            );
          })()}
        </SheetContent>
      </Sheet>

      <RouteEmailDepositDialog
        open={!!routingRow}
        onOpenChange={(o) => {
          if (o) return;
          setRoutingRow(null);
          setRoutingSuggestedUser(null);
          // Batch mode: advance to the next selected row automatically.
          if (routeQueue.length) {
            const [nextId, ...rest] = routeQueue;
            const nextRow = rows.find((r) => r.id === nextId);
            setRouteQueue(rest);
            if (nextRow) {
              setTimeout(() => navigateToRow(nextRow, nextRow.direction === 'in' ? 'credit' : 'debit'), 200);
              sonnerToast(`Next selected row (${rest.length} left after this)`);
            }
          }
        }}
        row={routingRow as EmailRowForRouting | null}
        suggestedUser={routingSuggestedUser}
        mode={routingMode}
        onPrev={canPrevNav ? () => navigateToRow(visibleRows[navIndex - 1], routingMode) : undefined}
        onNext={canNextNav ? () => navigateToRow(visibleRows[navIndex + 1], routingMode) : undefined}
        canPrev={canPrevNav}
        canNext={canNextNav}
        currentIndex={navIndex >= 0 ? navIndex + 1 : 0}
        totalCount={visibleRows.length}
        onRouted={(rowId) => {
          setJustRoutedIds((cur) => new Set(cur).add(rowId));
          void refreshRowStatus(rowId);
        }}
      />

      <FixChannelDialog
        row={editingRow}
        onClose={() => setEditingRow(null)}
        userRules={storedUserRules}
        onSave={(channel, ruleSpec) => {
          // 1. Override the cache for this row so it sticks immediately.
          if (editingRow) {
            const key = channelCacheKey(editingRow);
            if (key) {
              channelCacheRef.current[key] = {
                channel,
                confidence: 'authoritative',
                signal: 'Manual correction',
                rule: 'user_override',
                source: 'parser',
              };
              flushChannelCache();
            }
          }
          // 2. Persist a new permanent rule (if the user opted to).
          if (ruleSpec) {
            const next: StoredUserRule[] = [
              ...storedUserRules,
              { ...ruleSpec, channel, createdAt: new Date().toISOString() },
            ];
            persistUserRules(next);
          } else {
            setRulesVersion((v) => v + 1);
          }
          toast({
            title: 'Channel updated',
            description: ruleSpec
              ? `Saved as "${channel}" and added a rule for future emails.`
              : `Saved as "${channel}" for this transaction.`,
          });
          setEditingRow(null);
        }}
        onDeleteRule={deleteUserRule}
      />
      </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  info,
  tooltipSide = 'bottom',
  tooltipAlign = 'center',
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  info?: ReactNode;
  /** Preferred tooltip side. Radix flips it automatically if it would clip on small screens. */
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
  /** Preferred alignment along the chosen side. */
  tooltipAlign?: 'start' | 'center' | 'end';
}) {
  // Controlled open state so the info tooltip is fully keyboard-operable:
  // Enter/Space toggles it, Escape closes it, focus opens it, blur/pointer-leave closes it.
  const [tipOpen, setTipOpen] = useState(false);
  return (
    <div className="rounded-xl border bg-card p-4 transition-colors hover:bg-muted/30">
      <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
        <span className="truncate">{label}</span>
        {info && (
          <TooltipProvider delayDuration={150}>
            <Tooltip open={tipOpen} onOpenChange={setTipOpen}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`How "${label}" is calculated. Press Enter or Space to ${tipOpen ? 'hide' : 'show'} details, Escape to close.`}
                  aria-expanded={tipOpen}
                  className="inline-flex items-center justify-center text-muted-foreground/70 hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setTipOpen((o) => !o)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                      e.preventDefault();
                      setTipOpen((o) => !o);
                    } else if (e.key === 'Escape') {
                      setTipOpen(false);
                    }
                  }}
                >
                  <Info className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side={tooltipSide}
                align={tooltipAlign}
                sideOffset={6}
                avoidCollisions
                collisionPadding={12}
                className="max-w-[min(18rem,calc(100vw-1.5rem))]"
                onEscapeKeyDown={() => setTipOpen(false)}
              >
                {info}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </p>
      <p className="font-bold text-xl tracking-tight mt-1.5 tabular-nums">{value}</p>
      {sub && <div className="mt-1.5">{sub}</div>}
    </div>
  );
}


/**
 * Maps a raw poll error message into a friendly headline + description.
 * Covers the common Gmail / gateway failure modes operators encounter.
 */
function friendlyPollError(raw: string | null | undefined): { title: string; description: string; kind: 'expired' | 'scope' | 'rate' | 'network' | 'config' | 'gmail' | 'unknown' } {
  return friendlyPollErrorImpl(raw);
}



/**
 * Small wrapper that shows a plain-language explanation for a Recent emails
 * badge on hover OR keyboard focus. The trigger is a focusable span so the
 * tooltip is reachable without a mouse; the badge inside keeps its own styles.
 */
function BadgeTip({
  plain,
  details,
  children,
}: {
  plain: string;
  details?: string;
  children: ReactNode;
}) {
  // Stable id for an always-rendered, visually-hidden description. Radix only
  // mounts TooltipContent while open, so its auto aria-describedby vanishes on
  // blur. Pairing the trigger with a persistent sr-only element guarantees a
  // screen reader announces the explanation whenever the badge is focused.
  const descId = useId();
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            role="note"
            aria-describedby={descId}
            className="inline-flex cursor-help rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {children}
            <span id={descId} className="sr-only">
              {plain}{details ? ` ${details}` : ''}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
          <p className="font-medium">{plain}</p>
          {details && (
            <p className="mt-1 whitespace-pre-line text-muted-foreground">{details}</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}


function friendlyPollErrorImpl(raw: string | null | undefined): { title: string; description: string; kind: 'expired' | 'scope' | 'rate' | 'network' | 'config' | 'gmail' | 'unknown' } {
  const m = (raw || '').toLowerCase();
  if (m.includes('google_mail_api_key') || m.includes('not connected') || m.includes('not configured')) {
    return { title: 'Gmail isn\'t connected', description: 'Connect a Gmail account in Lovable Cloud → Connectors before polling.', kind: 'config' };
  }
  if (m.includes('invalid credentials') || m.includes('unauthenticated') || m.includes('[401]') || m.includes(' 401')) {
    return { title: 'Gmail session expired', description: 'The OAuth token is no longer valid. Click Reconnect Gmail to re-authenticate.', kind: 'expired' };
  }
  if (m.includes('insufficient') || m.includes('scope') || m.includes('[403]') || m.includes(' 403')) {
    return { title: 'Missing Gmail permission', description: 'The connection lacks a required scope. Reconnect Gmail and approve all requested permissions.', kind: 'scope' };
  }
  if (m.includes('429') || m.includes('rate') || m.includes('quota')) {
    return { title: 'Gmail rate limit hit', description: 'Google is throttling requests. Wait a minute, then click Retry.', kind: 'rate' };
  }
  if (m.includes('502') || m.includes('503') || m.includes('504') || m.includes('timeout') || m.includes('fetch')) {
    return { title: 'Network or gateway hiccup', description: 'A transient error reached the Gmail gateway. Click Retry to try again.', kind: 'network' };
  }
  if (m.startsWith('gmail ') || m.includes('gmail /')) {
    return { title: 'Gmail rejected the request', description: raw?.slice(0, 200) || 'Unknown Gmail API error.', kind: 'gmail' };
  }
  return { title: 'Polling failed', description: raw?.slice(0, 200) || 'Unknown error. Click Retry to try again.', kind: 'unknown' };
}

function GmailConnectionStatus({
  state,
  lastSuccessAt,
  onRetry,
  retrying,
}: {
  state: PollState | null;
  lastSuccessAt: string | null;
  onRetry?: () => void | Promise<void>;
  retrying?: boolean;
}) {
  const { toast } = useToast();
  const [verifying, setVerifying] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [copiedDetails, setCopiedDetails] = useState(false);

  const verifyNow = async (action: 'verify' | 'reconnect_initiated') => {
    setVerifying(true);
    const { data, error } = await supabase.functions.invoke('gmail-verify-connection', { body: { action } });
    setVerifying(false);
    if (error) {
      toast({ title: 'Verify failed', description: error.message, variant: 'destructive' });
      return;
    }
    const oc = (data as any)?.outcome;
    const ms = (data as any)?.latency_ms;
    if (oc === 'verified' || oc === 'skipped') {
      toast({ title: `Gmail ${oc}`, description: ms ? `${ms}ms — logged to audit.` : 'Logged to audit.' });
    } else {
      toast({
        title: `Gmail ${oc ?? 'error'}`,
        description: ((data as any)?.error || 'See audit log for details.').slice(0, 200),
        variant: 'destructive',
      });
    }
    window.dispatchEvent(new CustomEvent('gmail-reconnect-audit-refresh'));
  };

  const isError = state?.last_status === 'error';
  const isOk = state?.last_status === 'ok';
  const friendly = isError ? friendlyPollError(state?.last_error) : null;
  const isExpired = friendly?.kind === 'expired' || friendly?.kind === 'scope';

  // Try to extract an HTTP status code from the raw error (e.g. "[401]", "status 403", "HTTP 429").
  const statusCode = (() => {
    if (!state?.last_error) return null;
    const m = state.last_error.match(/\b(?:HTTP\s*|status\s*|code\s*|\[)(\d{3})\b/i);
    return m ? m[1] : null;
  })();

  const tone = isExpired
    ? 'border-destructive/40 bg-destructive/5 text-destructive'
    : isError
      ? 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400'
      : isOk
        ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400'
        : 'border-border bg-muted/30 text-muted-foreground';

  const Icon = isExpired || isError ? WifiOff : isOk ? Wifi : Wifi;
  const label = isError
    ? friendly!.title
    : isOk
      ? 'Gmail connected'
      : 'Gmail status unknown';

  const copyDetails = async () => {
    if (!state?.last_error) return;
    try {
      await navigator.clipboard.writeText(state.last_error);
      setCopiedDetails(true);
      setTimeout(() => setCopiedDetails(false), 1500);
    } catch {
      /* noop */
    }
  };

  return (
    <div className={`rounded-xl border p-3 flex flex-col gap-2 ${tone}`}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
      <div className="flex items-center gap-2.5 min-w-0">
        <Icon className="h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate flex items-center gap-2">
            {label}
            {isError && statusCode && (
              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-current/30 bg-background/40">
                HTTP {statusCode}
              </span>
            )}
          </p>
          {isError && friendly && (
            <p className="text-[11px] opacity-80 line-clamp-2">{friendly.description}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 text-[11px] sm:text-xs shrink-0">
        <span className="opacity-80">
          Last successful poll:{' '}
          <strong className="font-mono">
            {lastSuccessAt ? format(new Date(lastSuccessAt), 'MMM d, HH:mm:ss') : 'never'}
          </strong>
        </span>
        {isError && state?.last_error && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 gap-1.5 text-[11px]"
            onClick={() => setShowDetails((v) => !v)}
            aria-expanded={showDetails}
          >
            {showDetails ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {showDetails ? 'Hide details' : 'Show details'}
          </Button>
        )}
        {isError && onRetry && (
          <Button
            size="sm"
            variant="default"
            className="h-7 px-2 gap-1.5 text-[11px]"
            onClick={() => onRetry()}
            disabled={retrying}
          >
            {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Retry
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 gap-1.5 text-[11px]"
          onClick={() => verifyNow('verify')}
          disabled={verifying}
        >
          {verifying ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
          Verify
        </Button>
        {(isExpired || isError) && (
          <Button
            size="sm"
            variant="destructive"
            className="h-7 px-2 gap-1.5 text-[11px]"
            onClick={() => verifyNow('reconnect_initiated')}
            disabled={verifying}
          >
            <RefreshCw className="h-3 w-3" />
            Log reconnect
          </Button>
        )}
      </div>
      </div>
      {isError && showDetails && state?.last_error && (
        <div className="rounded-lg border border-current/20 bg-background/60 text-foreground p-2.5 mt-1">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">
              Last poll error
              {state?.last_polled_at && (
                <span className="ml-2 font-mono normal-case tracking-normal">
                  · {format(new Date(state.last_polled_at), 'MMM d, HH:mm:ss')}
                </span>
              )}
              {statusCode && <span className="ml-2 font-mono">· HTTP {statusCode}</span>}
            </p>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 gap-1 text-[10px]"
              onClick={copyDetails}
            >
              {copiedDetails ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copiedDetails ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <pre className="text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-all max-h-48 overflow-auto">
            {state.last_error}
          </pre>
        </div>
      )}
    </div>
  );
}

interface ReconnectAuditRow {
  id: string;
  action: string;
  outcome: string;
  latency_ms: number | null;
  error_message: string | null;
  initiated_by_email: string | null;
  created_at: string;
}

function GmailReconnectAuditPanel() {
  const [rows, setRows] = useState<ReconnectAuditRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const { data } = await (supabase.from('gmail_reconnect_audit') as any)
      .select('id,action,outcome,latency_ms,error_message,initiated_by_email,created_at')
      .order('created_at', { ascending: false })
      .limit(25);
    setRows((data as ReconnectAuditRow[]) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const onRefresh = () => load();
    window.addEventListener('gmail-reconnect-audit-refresh', onRefresh);
    const ch = supabase
      .channel('gmail_reconnect_audit_feed')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'gmail_reconnect_audit' },
        (payload) => setRows((cur) => [payload.new as ReconnectAuditRow, ...cur].slice(0, 25)),
      )
      .subscribe();
    return () => {
      window.removeEventListener('gmail-reconnect-audit-refresh', onRefresh);
      supabase.removeChannel(ch);
    };
  }, []);

  const outcomeBadge = (oc: string) => {
    const map: Record<string, string> = {
      verified: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20',
      skipped: 'bg-sky-500/10 text-sky-700 border-sky-500/20',
      initiated: 'bg-amber-500/10 text-amber-700 border-amber-500/20',
      failed: 'bg-rose-500/10 text-rose-700 border-rose-500/20',
      error: 'bg-destructive/10 text-destructive border-destructive/20',
    };
    return map[oc] ?? 'bg-muted text-muted-foreground';
  };

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="p-4 border-b flex items-center gap-2">
        <History className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-semibold text-sm">Gmail reconnect / verify audit log</h3>
        <span className="text-[11px] text-muted-foreground ml-auto">last 25</span>
      </div>
      {loading ? (
        <div className="p-6 flex justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-6 text-center text-sm text-muted-foreground">
          No verify or reconnect attempts recorded yet.
        </div>
      ) : (
        <div className="divide-y max-h-[320px] overflow-y-auto">
          {rows.map((r) => (
            <div key={r.id} className="p-3 text-sm flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={`text-[10px] capitalize ${outcomeBadge(r.outcome)}`}>
                    {r.outcome}
                  </Badge>
                  <Badge variant="outline" className="text-[10px] capitalize">
                    {r.action.replace('_', ' ')}
                  </Badge>
                  {r.latency_ms !== null && (
                    <span className="text-[10px] font-mono text-muted-foreground">{r.latency_ms}ms</span>
                  )}
                  {r.initiated_by_email && (
                    <span className="text-[11px] text-muted-foreground truncate">by {r.initiated_by_email}</span>
                  )}
                </div>
                {r.error_message && (
                  <p className="text-[11px] text-destructive/90 mt-1 line-clamp-2">{r.error_message}</p>
                )}
              </div>
              <span className="text-[11px] text-muted-foreground shrink-0 font-mono">
                {format(new Date(r.created_at), 'MMM d, HH:mm:ss')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SmsSetupGuide() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Smartphone className="h-4 w-4" /> SMS → Gmail setup
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Auto-forward SMS to Gmail</DialogTitle>
          <DialogDescription>
            One-time phone setup. After this, every incoming SMS is forwarded to the connected Gmail and appears here within 1 minute.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div>
            <p className="font-semibold mb-1">Android (recommended)</p>
            <ol className="list-decimal pl-5 space-y-1.5 text-muted-foreground">
              <li>Install <strong>SMS Forwarder</strong> by Hannes Petri (free, open-source) from the Play Store.</li>
              <li>Open the app → tap <strong>Add rule</strong>.</li>
              <li>Sender filter: leave blank, or restrict to shortcodes like <code className="text-xs">MTNMoMo</code>, <code className="text-xs">Airtel</code>, <code className="text-xs">Stanbic</code>.</li>
              <li>Action: <strong>Email</strong>. Set the recipient to the Gmail address connected to Welile.</li>
              <li>Subject: <code className="text-xs">SMS from {'{sender}'}</code> &nbsp;|&nbsp; Body: <code className="text-xs">{'{content}'}</code></li>
              <li>Grant SMS permission and disable battery optimisation for the app.</li>
              <li>Send a test SMS to confirm it lands in Gmail and appears in this feed.</li>
            </ol>
          </div>
          <div className="rounded-lg border bg-muted/40 p-3 text-xs">
            <p className="font-semibold mb-1">iPhone</p>
            <p className="text-muted-foreground">iOS does not allow apps to read SMS, so true auto-forwarding isn't possible. Use a dedicated Android device for the SIM, or route the SIM through a GSM gateway.</p>
          </div>
          <p className="text-xs text-muted-foreground">
            The poller already matches subjects starting with <code>SMS from…</code> and emails from any sender containing <code>smsforwarder</code>.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface DebugItem {
  id: string;
  decision: string;
  reason?: string;
  from?: string | null;
  from_name?: string | null;
  subject?: string | null;
  snippet?: string | null;
  internal_date?: string | null;
  last_cutoff?: string | null;
  extracted?: Record<string, any>;
  parser_notes?: string[];
}

function DebugPollDialog() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<DebugItem[] | null>(null);
  const [meta, setMeta] = useState<{ scanned: number; query: string; last_cutoff: string | null } | null>(null);
  const [filter, setFilter] = useState<'all' | 'parsed' | 'unparsed' | 'skipped'>('all');

  const runDebug = async () => {
    setRunning(true); setReport(null);
    const { data, error } = await supabase.functions.invoke('gmail-poll-transactions', { body: { debug: true } });
    setRunning(false);
    if (error) {
      toast({ title: 'Debug poll failed', description: error.message, variant: 'destructive' });
      return;
    }
    const d = data as any;
    setReport((d?.debug ?? []) as DebugItem[]);
    setMeta({ scanned: d?.scanned ?? 0, query: d?.query ?? '', last_cutoff: d?.last_cutoff ?? null });
  };

  const filtered = (report ?? []).filter((r) => {
    if (filter === 'all') return true;
    if (filter === 'skipped') return r.decision === 'skipped';
    if (filter === 'parsed') return r.decision === 'would_insert_parsed';
    if (filter === 'unparsed') return r.decision === 'would_insert_unparsed';
    return true;
  });

  const counts = {
    parsed: (report ?? []).filter((r) => r.decision === 'would_insert_parsed').length,
    unparsed: (report ?? []).filter((r) => r.decision === 'would_insert_unparsed').length,
    skipped: (report ?? []).filter((r) => r.decision === 'skipped').length,
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Bug className="h-4 w-4" /> Debug poll
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Gmail poll debug report</DialogTitle>
          <DialogDescription>
            Runs the poller in dry-run mode and shows why each scanned email was matched, rejected, or only partially parsed. Nothing is written to the database.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" onClick={runDebug} disabled={running} className="gap-2">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bug className="h-4 w-4" />}
            Run dry-run
          </Button>
          {report && (
            <>
              <Badge variant="outline">scanned {meta?.scanned ?? 0}</Badge>
              <Badge className="bg-emerald-500/10 text-emerald-700 border-emerald-500/20">parsed {counts.parsed}</Badge>
              <Badge className="bg-amber-500/10 text-amber-700 border-amber-500/20">unparsed {counts.unparsed}</Badge>
              <Badge variant="secondary">skipped {counts.skipped}</Badge>
              <div className="ml-auto flex gap-1">
                {(['all','parsed','unparsed','skipped'] as const).map((f) => (
                  <Button key={f} size="sm" variant={filter === f ? 'default' : 'ghost'} onClick={() => setFilter(f)} className="h-7 text-xs capitalize">{f}</Button>
                ))}
              </div>
            </>
          )}
        </div>
        {meta?.last_cutoff && (
          <p className="text-[11px] text-muted-foreground">
            Last poll cutoff: <code>{meta.last_cutoff}</code> — emails older than this are skipped.
          </p>
        )}
        <div className="max-h-[55vh] overflow-y-auto space-y-2 -mx-1 px-1">
          {!report && !running && (
            <p className="text-sm text-muted-foreground py-8 text-center">Click <strong>Run dry-run</strong> to inspect the next 50 emails Gmail returns for the query.</p>
          )}
          {running && (
            <div className="py-10 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          )}
          {report && filtered.length === 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center">No emails match this filter.</p>
          )}
          {filtered.map((item) => {
            const tone = item.decision === 'would_insert_parsed' ? 'border-emerald-500/30 bg-emerald-500/5'
              : item.decision === 'would_insert_unparsed' ? 'border-amber-500/30 bg-amber-500/5'
              : 'border-muted bg-muted/30';
            const label = item.decision === 'would_insert_parsed' ? 'parsed'
              : item.decision === 'would_insert_unparsed' ? 'unparsed'
              : `skipped • ${item.reason ?? ''}`;
            return (
              <div key={item.id} className={`rounded-lg border p-3 text-xs ${tone}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm truncate">{item.from_name || item.from || 'Unknown sender'}</p>
                    <p className="text-muted-foreground truncate">{item.subject || '(no subject)'}</p>
                    {item.snippet && <p className="text-muted-foreground/80 line-clamp-2 mt-1">{item.snippet}</p>}
                  </div>
                  <Badge variant="outline" className="shrink-0 text-[10px]">{label}</Badge>
                </div>
                {item.extracted && (
                  <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-0.5 font-mono text-[10px]">
                    {Object.entries(item.extracted).map(([k, v]) => (
                      <div key={k} className="truncate">
                        <span className="text-muted-foreground">{k}:</span> <span className={v == null ? 'text-rose-600' : 'text-foreground'}>{v == null ? '—' : String(v)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {item.parser_notes && item.parser_notes.length > 0 && (
                  <p className="mt-2 text-[10px] text-amber-700">Notes: {item.parser_notes.join(', ')}</p>
                )}
                {item.reason === 'older_than_last_poll' && item.internal_date && (
                  <p className="mt-1 text-[10px] text-muted-foreground">internal_date {item.internal_date} ≤ cutoff {item.last_cutoff}</p>
                )}
              </div>
            );
          })}
        </div>
        {meta?.query && (
          <details className="text-[10px] text-muted-foreground">
            <summary className="cursor-pointer">Gmail search query</summary>
            <pre className="mt-1 whitespace-pre-wrap break-all bg-muted p-2 rounded">{meta.query}</pre>
          </details>
        )}
      </DialogContent>
    </Dialog>
  );
}
interface DedupAuditRow {
  id: string;
  gmail_message_id: string;
  dedup_hash: string | null;
  matched_transaction_id: string | null;
  matched_row_id: string | null;
  reason: string;
  from_email: string | null;
  subject: string | null;
  snippet: string | null;
  internal_date: string | null;
  created_at: string;
}

function DedupAuditPanel() {
  const [rows, setRows] = useState<DedupAuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<'all' | 'transaction_id_match' | 'dedup_hash_match'>('all');
  const [search, setSearch] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = async () => {
    const { data } = await (supabase.from('gmail_dedup_audit') as any)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    setRows((data as DedupAuditRow[]) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const ch = supabase
      .channel('gmail_dedup_audit_feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'gmail_dedup_audit' }, (payload) => {
        setRows((cur) => [payload.new as DedupAuditRow, ...cur].slice(0, 100));
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  const counts = {
    all: rows.length,
    transaction_id_match: rows.filter((r) => r.reason === 'transaction_id_match').length,
    dedup_hash_match: rows.filter((r) => r.reason === 'dedup_hash_match').length,
  };

  const filtered = rows.filter((r) => {
    if (filter !== 'all' && r.reason !== filter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const hay = [r.from_email, r.subject, r.snippet, r.matched_transaction_id, r.dedup_hash, r.gmail_message_id]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const copySnippet = async (r: DedupAuditRow) => {
    const text = [
      `From: ${r.from_email || 'Unknown'}`,
      `Subject: ${r.subject || '(no subject)'}`,
      `Reason: ${r.reason}`,
      `Matched TID: ${r.matched_transaction_id || '—'}`,
      `Hash: ${r.dedup_hash || '—'}`,
      `Gmail ID: ${r.gmail_message_id}`,
      `Date: ${r.internal_date ? format(new Date(r.internal_date), 'yyyy-MM-dd HH:mm:ss') : '—'}`,
      `---`,
      r.snippet || '',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(r.id);
      setTimeout(() => setCopiedId((cur) => (cur === r.id ? null : cur)), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full p-4 border-b flex items-center justify-between hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-600" />
          <h3 className="font-semibold text-sm">Dedup audit log</h3>
          <Badge variant="secondary" className="text-[10px]">{rows.length}</Badge>
        </div>
        <span className="text-xs text-muted-foreground">{expanded ? 'Hide' : 'Show'}</span>
      </button>
      {expanded && (
        <>
          <div className="p-3 border-b flex flex-wrap items-center gap-2 bg-muted/20">
            {([
              { id: 'all', label: 'All' },
              { id: 'transaction_id_match', label: 'TID match' },
              { id: 'dedup_hash_match', label: 'Hash match' },
            ] as const).map((f) => (
              <Button
                key={f.id}
                size="sm"
                variant={filter === f.id ? 'default' : 'outline'}
                onClick={() => setFilter(f.id)}
                className="h-7 text-xs gap-1.5"
              >
                {f.label}
                <Badge variant="secondary" className="text-[10px] h-4 px-1">{counts[f.id]}</Badge>
              </Button>
            ))}
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sender, subject, TID, hash…"
              className="ml-auto h-7 text-xs px-2 rounded border bg-background w-full sm:w-64"
            />
          </div>
          {loading ? (
            <div className="p-6 flex justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              {rows.length === 0
                ? 'No deduplicated emails yet. Skipped duplicates will appear here in real time.'
                : 'No entries match the current filters.'}
            </div>
          ) : (
            <div className="divide-y max-h-[400px] overflow-y-auto">
              {filtered.map((r) => (
                <div key={r.id} className="p-3 text-xs hover:bg-muted/30">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{r.from_email || 'Unknown sender'}</p>
                      <p className="text-muted-foreground truncate">{r.subject || '(no subject)'}</p>
                    </div>
                    <Badge
                      variant="outline"
                      className={`shrink-0 text-[10px] ${
                        r.reason === 'transaction_id_match'
                          ? 'bg-rose-500/10 text-rose-700 border-rose-500/20'
                          : 'bg-amber-500/10 text-amber-700 border-amber-500/20'
                      }`}
                    >
                      {r.reason.replace('_', ' ')}
                    </Badge>
                  </div>
                  {r.snippet && (
                    <div className="mt-2 relative">
                      <pre className="p-2 rounded bg-muted/60 border border-border/50 text-[11px] text-muted-foreground whitespace-pre-wrap break-words font-mono leading-snug pr-8">
                        {r.snippet.slice(0, 200)}{r.snippet.length > 200 ? '…' : ''}
                      </pre>
                      <button
                        type="button"
                        onClick={() => copySnippet(r)}
                        className="absolute top-1.5 right-1.5 p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        title="Copy to clipboard"
                      >
                        {copiedId === r.id ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                      </button>
                    </div>
                  )}
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
                    {r.matched_transaction_id && (
                      <span>matched TID: <span className="text-foreground">{r.matched_transaction_id}</span></span>
                    )}
                    {r.dedup_hash && (
                      <span title={r.dedup_hash}>hash: <span className="text-foreground">{r.dedup_hash.slice(0, 12)}…</span></span>
                    )}
                    <span>msg: {r.gmail_message_id.slice(0, 14)}…</span>
                    <span>{format(new Date(r.created_at), 'MMM d HH:mm:ss')}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

type ChannelBreakdownRow = {
  channel: string;
  inCount: number;
  inTotal: number;
  outCount: number;
  outTotal: number;
  feeCount: number;
  feeTotal: number;
  net: number;
};

type ExportPayload = {
  rows: GmailTx[];
  totalIn: number;
  totalOut: number;
  netAmount: number;
  channelBreakdown: ChannelBreakdownRow[];
};

type ZoomWindowDay = { date: string; in: number; out: number; net: number };

/**
 * One-tap audit export: dumps the CURRENTLY FILTERED rows (one line per email)
 * rather than the aggregated totals. Built for mobile ops/audit hand-offs.
 */
function exportFilteredRowsCsv(
  rows: GmailTx[],
  statusOf: (r: GmailTx) => string,
): number {
  const stamp = format(new Date(), 'yyyy-MM-dd_HHmm');
  const headers = [
    'Date (ISO)', 'Status', 'Direction', 'Channel', 'Amount (UGX)', 'Fee (UGX)',
    'Balance (UGX)', 'Transaction ID', 'Counterparty', 'Sender name', 'Sender email',
    'Subject', 'Parsed', 'Linked deposit request', 'Auto matched at', 'Gmail message ID',
  ];
  const body = rows.map((r) => [
    csvTimestamp(r.internal_date),
    statusOf(r),
    r.direction ?? '',
    r.channel ?? '',
    r.amount === null || r.amount === undefined ? '' : Math.round(Number(r.amount)),
    r.fee === null || r.fee === undefined ? '' : Math.round(Number(r.fee)),
    r.balance === null || r.balance === undefined ? '' : Math.round(Number(r.balance)),
    r.transaction_id ?? '',
    r.counterparty ?? '',
    r.from_name ?? '',
    r.from_email ?? '',
    (r.subject ?? '').replace(/\s+/g, ' ').trim(),
    r.parsed ? 'yes' : 'no',
    r.linked_deposit_request_id ?? '',
    csvTimestamp(r.auto_matched_at),
    r.gmail_message_id ?? '',
  ]);
  downloadCsv(`email-transactions-filtered_${stamp}.csv`, headers, body);
  return body.length;
}

type ZoomWindowPayload = {
  days: ZoomWindowDay[];
  totalIn: number;
  totalOut: number;
  net: number;
  zoomed: boolean;
};

/** Export the currently-selected In/Out zoom window summary to CSV. */
function exportZoomWindowCsv({ days, totalIn, totalOut, net, zoomed }: ZoomWindowPayload) {
  if (days.length === 0) return;
  const fromDay = days[0].date;
  const toDay = days[days.length - 1].date;
  const stamp = format(new Date(), 'yyyy-MM-dd_HHmm');
  const headers = ['Section', 'Key', 'Total in (UGX)', 'Total out (UGX)', 'Net (UGX)'];
  const body: (string | number)[][] = [];
  body.push(['Summary', `${zoomed ? 'Zoomed' : 'Full range'} ${fromDay} → ${toDay} (${days.length} day${days.length === 1 ? '' : 's'})`, Math.round(totalIn), Math.round(totalOut), Math.round(net)]);
  body.push(['', '', '', '', '']);
  for (const d of days) {
    body.push(['Day', d.date, Math.round(d.in), Math.round(d.out), Math.round(d.net)]);
  }
  downloadCsv(`in-vs-out-zoom_${fromDay}_to_${toDay}_${stamp}.csv`, headers, body);
}

/** Export the currently-selected In/Out zoom window summary to PDF. */
async function exportZoomWindowPdf({ days, totalIn, totalOut, net, zoomed }: ZoomWindowPayload) {
  if (days.length === 0) return;
  const [{ default: jsPDF }, autoTableModule] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const autoTable = (autoTableModule as any).default ?? (autoTableModule as any);
  const fromDay = days[0].date;
  const toDay = days[days.length - 1].date;
  const stamp = format(new Date(), 'yyyy-MM-dd HH:mm');
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text('In vs Out — Zoom Window Summary', 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(`Generated ${stamp}`, 14, 25);
  doc.text(`${zoomed ? 'Zoomed' : 'Full'} range: ${fromDay} → ${toDay} (${days.length} day${days.length === 1 ? '' : 's'})`, 14, 31);
  doc.setTextColor(0);

  autoTable(doc, {
    startY: 38,
    head: [['Metric', 'Value']],
    body: [
      ['Total in (received)', `UGX ${Math.round(totalIn).toLocaleString()}`],
      ['Total out (sent + charges)', `UGX ${Math.round(totalOut).toLocaleString()}`],
      ['Net (in − out)', `UGX ${Math.round(net).toLocaleString()}`],
      ['Days in window', String(days.length)],
    ],
    styles: { fontSize: 10 },
    headStyles: { fillColor: [30, 41, 59] },
  });

  autoTable(doc, {
    head: [['Day', 'Total in', 'Total out', 'Net']],
    body: days.map(d => [
      d.date,
      `UGX ${Math.round(d.in).toLocaleString()}`,
      `UGX ${Math.round(d.out).toLocaleString()}`,
      `UGX ${Math.round(d.net).toLocaleString()}`,
    ]),
    styles: { fontSize: 9 },
    headStyles: { fillColor: [30, 41, 59] },
  });

  downloadPdfMobileSafe(doc, `in-vs-out-zoom_${fromDay}_to_${toDay}_${format(new Date(), 'yyyy-MM-dd_HHmm')}.pdf`);
}

function buildPerDayBreakdown(rows: GmailTx[]) {
  const map = new Map<string, { inCount: number; inTotal: number; outCount: number; outTotal: number }>();
  for (const r of rows) {
    if (!r.parsed) continue;
    const day = r.internal_date ? format(new Date(r.internal_date), 'yyyy-MM-dd') : 'unknown';
    const cur = map.get(day) ?? { inCount: 0, inTotal: 0, outCount: 0, outTotal: 0 };
    const amt = r.amount ?? 0;
    if (r.direction === 'in') { cur.inCount += 1; cur.inTotal += amt; }
    else if (r.direction === 'out' || r.direction === 'charge') { cur.outCount += 1; cur.outTotal += amt; }
    map.set(day, cur);
  }
  return Array.from(map.entries())
    .map(([day, v]) => ({ day, ...v, net: v.inTotal - v.outTotal }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));
}

function exportTotalsCsv({ rows, totalIn, totalOut, netAmount, channelBreakdown }: ExportPayload) {
  const perDay = buildPerDayBreakdown(rows);
  const stamp = format(new Date(), 'yyyy-MM-dd_HHmm');

  const allRows: (string | number)[][] = [];
  const totalFeesAll = rows
    .filter((r) => r.parsed && r.fee && Number(r.fee) > 0)
    .reduce((s, r) => s + Number(r.fee ?? 0), 0);
  const feeCountAll = rows.filter((r) => r.parsed && r.fee && Number(r.fee) > 0).length;
  allRows.push(['Section', 'Key', 'In count', 'Total in (UGX)', 'Out count', 'Total out (UGX)', 'Fee count', 'Total fees (UGX)', 'Net (UGX)']);
  allRows.push(['Summary', 'All parsed', rows.filter(r => r.parsed && r.direction === 'in').length, Math.round(totalIn),
    rows.filter(r => r.parsed && (r.direction === 'out' || r.direction === 'charge')).length, Math.round(totalOut),
    feeCountAll, Math.round(totalFeesAll), Math.round(netAmount)]);
  allRows.push(['', '', '', '', '', '', '', '', '']);
  for (const c of channelBreakdown) {
    allRows.push(['Channel', c.channel, c.inCount, Math.round(c.inTotal), c.outCount, Math.round(c.outTotal), c.feeCount, Math.round(c.feeTotal), Math.round(c.net)]);
  }
  allRows.push(['', '', '', '', '', '', '', '', '']);
  for (const d of perDay) {
    allRows.push(['Day', d.day, d.inCount, Math.round(d.inTotal), d.outCount, Math.round(d.outTotal), '', '', Math.round(d.net)]);
  }
  downloadCsv(`email-transactions-totals_${stamp}.csv`, allRows[0] as string[], allRows.slice(1));
}

async function exportTotalsPdf({ rows, totalIn, totalOut, netAmount, channelBreakdown }: ExportPayload) {
  const [{ default: jsPDF }, autoTableModule] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const autoTable = (autoTableModule as any).default ?? (autoTableModule as any);

  const perDay = buildPerDayBreakdown(rows);
  const stamp = format(new Date(), 'yyyy-MM-dd HH:mm');
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text('Email Transactions — Totals Report', 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(`Generated ${stamp}`, 14, 25);
  doc.setTextColor(0);

  autoTable(doc, {
    startY: 32,
    head: [['Metric', 'Value']],
    body: [
      ['Total in (received)', `UGX ${Math.round(totalIn).toLocaleString()}`],
      ['Total out (sent + charges)', `UGX ${Math.round(totalOut).toLocaleString()}`],
      ['Net (in − out)', `UGX ${Math.round(netAmount).toLocaleString()}`],
      ['Parsed transactions', String(rows.filter(r => r.parsed).length)],
      ['Emails captured', String(rows.length)],
    ],
    styles: { fontSize: 10 },
    headStyles: { fillColor: [30, 41, 59] },
  });

  if (channelBreakdown.length > 0) {
    autoTable(doc, {
      head: [['Channel', 'In #', 'Total in', 'Out #', 'Total out', 'Fee #', 'Total fees', 'Net']],
      body: channelBreakdown.map(c => [
        c.channel,
        c.inCount,
        `UGX ${Math.round(c.inTotal).toLocaleString()}`,
        c.outCount,
        `UGX ${Math.round(c.outTotal).toLocaleString()}`,
        c.feeCount,
        `UGX ${Math.round(c.feeTotal).toLocaleString()}`,
        `UGX ${Math.round(c.net).toLocaleString()}`,
      ]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 41, 59] },
    });
  }

  if (perDay.length > 0) {
    autoTable(doc, {
      head: [['Day', 'In #', 'Total in', 'Out #', 'Total out', 'Net']],
      body: perDay.map(d => [
        d.day,
        d.inCount,
        `UGX ${Math.round(d.inTotal).toLocaleString()}`,
        d.outCount,
        `UGX ${Math.round(d.outTotal).toLocaleString()}`,
        `UGX ${Math.round(d.net).toLocaleString()}`,
      ]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 41, 59] },
    });
  }

  const filename = `email-transactions-totals_${format(new Date(), 'yyyy-MM-dd_HHmm')}.pdf`;
  downloadPdfMobileSafe(doc, filename);
}

/**
 * Trigger a PDF download in a way that works on mobile Safari / Chrome.
 * `doc.save()` alone often opens a blank tab on iOS — we hand the user a
 * proper blob URL via an anchor click, and fall back to opening in a new
 * tab on iOS so they can use the share sheet.
 */
function downloadPdfMobileSafe(doc: any, filename: string) {
  try {
    const blob: Blob = doc.output('blob');
    // Archive a copy in the offline PDF vault so the record survives
    // network loss, browser cache wipes, or a cleared Downloads folder.
    archivePdfBlob(blob, {
      label: filename.replace(/\.pdf$/i, '').replace(/_/g, ' '),
      filename,
      category: 'finops-emails',
    }).catch(() => {});
    const url = URL.createObjectURL(blob);
    const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isIOS) {
      // iOS Safari ignores the `download` attribute — opening the blob in a
      // new tab lets the user save / share via the native share sheet.
      window.open(url, '_blank');
    } else {
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.rel = 'noopener';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch {
    // Last-resort fallback to jsPDF's built-in saver.
    try { doc.save(filename); } catch {}
  }
}

function ReconnectGmailDialog() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [logging, setLogging] = useState(false);

  const logReconnectAttempt = async () => {
    setLogging(true);
    const { error } = await supabase.functions.invoke('gmail-verify-connection', {
      body: { action: 'reconnect_initiated' },
    });
    setLogging(false);
    if (error) {
      toast({ title: 'Audit log failed', description: error.message, variant: 'destructive' });
      return;
    }
    toast({
      title: 'Reconnect attempt logged',
      description: 'Now ask the AI in chat to reconnect Gmail to complete OAuth.',
    });
    window.dispatchEvent(new CustomEvent('gmail-reconnect-audit-refresh'));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <LinkIcon className="h-4 w-4" /> Reconnect Gmail
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LinkIcon className="h-5 w-5 text-primary" /> Reconnect Gmail
          </DialogTitle>
          <DialogDescription>
            Use this when polling has stopped because the Gmail connection's OAuth token has
            expired or scopes have changed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <ol className="list-decimal pl-5 space-y-2 text-muted-foreground">
            <li>
              Click <strong className="text-foreground">Log &amp; open chat</strong> below — this
              records the attempt in the audit log.
            </li>
            <li>
              In the Lovable chat, type{' '}
              <code className="px-1.5 py-0.5 rounded bg-muted text-foreground font-mono text-[11px]">
                Reconnect Gmail
              </code>{' '}
              and approve the OAuth prompt that appears.
            </li>
            <li>
              Return here and click <strong className="text-foreground">Verify</strong> on the
              status banner to confirm the new token works.
            </li>
          </ol>

          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[12px] text-amber-700 dark:text-amber-400">
            OAuth must complete in the Lovable chat surface — browsers can't initiate the
            reconnect directly from this page.
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={logReconnectAttempt} disabled={logging} className="gap-2">
            {logging ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Log &amp; open chat
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Dialog for manually correcting an inferred channel and (optionally)
 * persisting a permanent rule so future emails matching the same pattern
 * automatically classify the same way.
 *
 * The form is intentionally simple: pick the right channel, optionally
 * enter a short matching phrase (e.g. "RCT-", "FT2025"), choose which
 * field to match against, and save. The phrase is escaped and stored as
 * a case-insensitive regex.
 */
function FixChannelDialog({
  row,
  onClose,
  userRules,
  onSave,
  onDeleteRule,
}: {
  row: GmailTx | null;
  onClose: () => void;
  userRules: StoredUserRule[];
  onSave: (channel: string, ruleSpec: Omit<StoredUserRule, 'createdAt'> | null) => void;
  onDeleteRule: (id: string) => void;
}) {
  const open = !!row;
  const current = row ? deriveChannel(row) : null;
  const [channel, setChannel] = useState<string>('cash_receipt');
  const [matchText, setMatchText] = useState<string>('');
  const [source, setSource] = useState<RuleSource>('transaction_id');
  const [saveRule, setSaveRule] = useState<boolean>(true);
  const [note, setNote] = useState<string>('');

  // Re-seed the form whenever a new row opens the dialog.
  useEffect(() => {
    if (!row) return;
    setChannel(current?.channel && current.channel !== 'other' ? current.channel : 'cash_receipt');
    // Pre-fill the match text with the most distinctive thing we can find.
    const id = (row.transaction_id ?? '').trim();
    const preset = current?.match ?? (id ? id.slice(0, Math.min(id.length, 6)) : '');
    setMatchText(preset);
    setSource(id ? 'transaction_id' : 'subject');
    setSaveRule(true);
    setNote('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.id]);

  const handleSave = () => {
    if (!row) return;
    const phrase = matchText.trim();
    let ruleSpec: Omit<StoredUserRule, 'createdAt'> | null = null;
    if (saveRule && phrase.length >= 2) {
      ruleSpec = {
        id: `user_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        channel,
        confidence: 'high',
        signal: `User rule: matches "${phrase}"${note ? ` — ${note}` : ''}`,
        source,
        patternSource: escapeRegex(phrase),
        patternFlags: 'i',
        note: note || undefined,
      };
    }
    onSave(channel, ruleSpec);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Fix inferred channel</DialogTitle>
          <DialogDescription>
            Reclassify this transaction and optionally save a rule so future emails
            matching the same phrase always use this channel.
          </DialogDescription>
        </DialogHeader>

        {row && (
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-[10px] capitalize">
                  current: {current?.channel.replace(/_/g, ' ') ?? 'other'}
                </Badge>
                {current?.rule && (
                  <span className="text-muted-foreground">rule: {current.rule}</span>
                )}
              </div>
              <div className="truncate"><strong>Subject:</strong> {row.subject || '(none)'}</div>
              {row.transaction_id && (
                <div className="font-mono"><strong className="font-sans">Txn id:</strong> {row.transaction_id}</div>
              )}
              {row.snippet && (
                <div className="line-clamp-2 text-muted-foreground">{row.snippet}</div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Correct channel</Label>
                <Select value={channel} onValueChange={setChannel}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CHANNEL_OPTIONS.map((c) => (
                      <SelectItem key={c} value={c} className="capitalize">{c.replace(/_/g, ' ')}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Match in field</Label>
                <Select value={source} onValueChange={(v) => setSource(v as RuleSource)}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="transaction_id">Transaction id / receipt</SelectItem>
                    <SelectItem value="subject">Email subject</SelectItem>
                    <SelectItem value="snippet">Email snippet</SelectItem>
                    <SelectItem value="from">Sender</SelectItem>
                    <SelectItem value="body">Anywhere (subject + body)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Match phrase (case-insensitive)</Label>
              <Input
                value={matchText}
                onChange={(e) => setMatchText(e.target.value)}
                placeholder='e.g. "RCT-" or "FT2025"'
                className="h-9 font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                Any future email whose chosen field contains this phrase will be
                classified as <strong className="capitalize">{channel.replace(/_/g, ' ')}</strong>.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Optional note</Label>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why this rule exists"
                className="h-9 text-xs"
              />
            </div>

            <label className="flex items-center gap-2 text-xs select-none">
              <input
                type="checkbox"
                checked={saveRule}
                onChange={(e) => setSaveRule(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Save as a permanent rule for future emails
            </label>

            {userRules.length > 0 && (
              <div className="space-y-2 pt-2 border-t">
                <Label className="text-xs">Existing user rules ({userRules.length})</Label>
                <div className="max-h-40 overflow-y-auto space-y-1 pr-1">
                  {userRules.map((u) => (
                    <div key={u.id} className="flex items-center gap-2 text-[11px] rounded border bg-muted/20 px-2 py-1">
                      <Badge variant="outline" className="text-[10px] capitalize shrink-0">{u.channel.replace(/_/g, ' ')}</Badge>
                      <span className="font-mono truncate flex-1" title={`/${u.patternSource}/${u.patternFlags} in ${u.source}`}>
                        /{u.patternSource}/ <span className="text-muted-foreground">in {u.source}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => onDeleteRule(u.id)}
                        className="text-muted-foreground hover:text-destructive"
                        title="Delete rule"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={handleSave}>Save</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
