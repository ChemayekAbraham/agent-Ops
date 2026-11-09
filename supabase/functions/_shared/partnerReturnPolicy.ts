// Partner Returns rates: READ answers, never decide a rate (Phase 1 partner_rates_for is the only decider).
// Every function returns null when it cannot answer; callers then show no number (never a 15 fallback).
// Imported by edge functions AND by the browser (src/lib/partnerReturnPolicy.ts re-exports it): no Deno APIs,
// no imports.
//
// Rules (Phase 4 design v2, section 0):
//   R1 the rate shown is the rate STORED on the row (or an SQL answer), never worked out from amounts;
//   R2 missing/invalid rate -> no number;
//   R3 inserts omit roi_percentage unless staff typed one (the database gate decides);
//   R4 a person's rate goes only to that person, partner staff, their approved proxy agent or the backend.
//      Whether a row's rate is public is read from the row (rate_basis). Only an unstamped row (NULL basis)
//      asks the policy: public while no cut-off exists (switch never on), personal afterwards.

// deno-lint-ignore no-explicit-any
type Client = any;

export interface PublicReturnPolicy {
  enabled: boolean;
  /** The public new-partner rate right now (15 while the switch is off, 10 when on). */
  newContractRate: number;
  cutoffAt: string | null;
  enabledAt: string | null;
  updatedAt: string | null;
}

/** Partner staff who may see a named person's rate. Mirrors partner_rate_visible_to_caller and
 *  partner_quote_rate('partner') (static test T1.12 compares the lists). */
export const PARTNER_STAFF_ROLES = ['partner_ops', 'coo', 'cfo', 'ceo', 'super_admin', 'manager', 'financial_ops'] as const;

/** Rate bases that apply to everyone (no personal information in the stored rate). */
export const PUBLIC_RATE_BASES = ['switch_off', 'typed_switch_off', 'new_no_investor'] as const;

/** Rate bases written while the switch was off (today's behaviour). */
export const SWITCH_OFF_RATE_BASES = ['switch_off', 'typed_switch_off'] as const;

/** Whether a row's rate applies to everyone (so an email may carry it to the profile email, as today).
 *  A stamped basis speaks for itself. An unstamped row (rate_basis NULL: written before Phase 1, or no
 *  portfolio row at all, e.g. a rent reward rate) is public only while no cut-off exists
 *  (noCutoffYet, from ratesPublicBeforeCutoff); after the first switch-on it is personal.
 *  Before the first switch-on only NULL, switch_off and typed_switch_off can be written, so a stale
 *  "no cut-off" answer can never make a row stamped after the switch-on public. */
export function rateIsPublicForRow(row: { rate_basis?: unknown } | null | undefined, noCutoffYet = false): boolean {
  const basis = row?.rate_basis;
  if (typeof basis === 'string') return (PUBLIC_RATE_BASES as readonly string[]).includes(basis);
  return noCutoffYet === true;
}

export function rowIsSwitchOff(row: { rate_basis?: unknown } | null | undefined): boolean {
  return typeof row?.rate_basis === 'string' && (SWITCH_OFF_RATE_BASES as readonly string[]).includes(row.rate_basis);
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A monthly rate in (0, 100], else null. Never a default. Accepts numbers and numeric strings
 *  (PostgREST may return numeric columns as strings). */
export function rateOrNull(v: unknown): number | null {
  const n = toNumber(v);
  return n !== null && n > 0 && n <= 100 ? n : null;
}

/** The rate stored on a portfolio row, or null. */
export function storedRate(row: { roi_percentage?: unknown } | null | undefined): number | null {
  return rateOrNull(row?.roi_percentage);
}

/** A rate staff typed: absent / null / '' -> null (not typed); a valid rate -> that number;
 *  anything else -> 'invalid' (the caller answers 400). */
export function typedRate(v: unknown): number | null | 'invalid' {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  if (typeof v !== 'number' && typeof v !== 'string') return 'invalid';
  const r = rateOrNull(v);
  return r === null ? 'invalid' : r;
}

const cents = (r: number) => Math.round(r * 100);

/** True when staff typed a rate and the gate stored a different one (the typed rate waits for the CFO). */
export function rateAwaitsCfo(typed: number | null, stored: number | null): boolean {
  return typed !== null && stored !== null && cents(typed) !== cents(stored);
}

/** 10 -> "10%", 12.5 -> "12.5%"; null -> null. */
export function formatRatePct(rate: number | null): string | null {
  const r = rateOrNull(rate);
  return r === null ? null : `${Math.round(r * 100) / 100}%`;
}

/** Math.round(a * r / 100); equals the old fixed-rate rounding for every integer amount at the legacy rate (T1.4).
 *  null when the rate is missing or the amount is not a non-negative number. */
export function monthlyReturnFor(amount: unknown, rate: number | null): number | null {
  const r = rateOrNull(rate);
  const a = toNumber(amount);
  if (r === null || a === null || a < 0) return null;
  return Math.round(a * r / 100);
}

/** The one rate shared by every value, else null (empty input, a missing value or two different rates). */
export function singleRate(values: Iterable<number | null>): number | null {
  let found: number | null = null;
  let any = false;
  for (const v of values) {
    const r = rateOrNull(v);
    if (r === null) return null;
    if (found !== null && cents(found) !== cents(r)) return null;
    found = r;
    any = true;
  }
  return any ? found : null;
}

const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** Parse the get_partner_return_policy() JSON. null on anything malformed. Shared with the browser. */
export function parsePublicPolicy(raw: unknown): PublicReturnPolicy | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.enabled !== 'boolean') return null;
  const rate = rateOrNull(o.new_contract_rate);
  if (rate === null) return null;
  return {
    enabled: o.enabled,
    newContractRate: rate,
    cutoffAt: isoOrNull(o.cutoff_at),
    enabledAt: isoOrNull(o.enabled_at),
    updatedAt: isoOrNull(o.updated_at),
  };
}

export interface PublicPolicyResult {
  policy: PublicReturnPolicy | null;
  /** The error code when the read failed (e.g. 'PGRST202' = function missing), else null. */
  errorCode: string | null;
}

/** One RPC with the error code kept (og-plan needs to tell "function missing" from other failures). */
export async function readPublicPolicyResult(client: Client): Promise<PublicPolicyResult> {
  try {
    const { data, error } = await client.rpc('get_partner_return_policy');
    if (error) {
      return { policy: null, errorCode: typeof error.code === 'string' && error.code ? error.code : 'error' };
    }
    const policy = parsePublicPolicy(data);
    return { policy, errorCode: policy === null ? 'malformed' : null };
  } catch (_e) {
    return { policy: null, errorCode: 'exception' };
  }
}

/** One RPC; null on any error. Uncached: use it where a stale answer would matter (the 409 check). */
export async function readPublicPolicy(client: Client): Promise<PublicReturnPolicy | null> {
  return (await readPublicPolicyResult(client)).policy;
}

const FAILURE_TTL_MS = 10_000;
let policyCache: { at: number; ttl: number; result: PublicPolicyResult } | null = null;
let policyInFlight: Promise<PublicPolicyResult> | null = null;

/** Isolate cache for DISPLAY only (60 s); a failure is cached 10 s with its error code. Never used to
 *  decide privacy (R4). Concurrent callers share one in-flight read. */
export function cachedPublicPolicyResult(client: Client, ttlMs = 60_000): Promise<PublicPolicyResult> {
  const now = Date.now();
  if (policyCache && now - policyCache.at < policyCache.ttl) return Promise.resolve(policyCache.result);
  if (!policyInFlight) {
    policyInFlight = readPublicPolicyResult(client)
      .then((result) => {
        policyCache = { at: Date.now(), ttl: result.policy ? ttlMs : Math.min(ttlMs, FAILURE_TTL_MS), result };
        return result;
      })
      .finally(() => {
        policyInFlight = null;
      });
  }
  return policyInFlight;
}

export async function cachedPublicPolicy(client: Client, ttlMs = 60_000): Promise<PublicReturnPolicy | null> {
  return (await cachedPublicPolicyResult(client, ttlMs)).policy;
}

/** True only when the policy was read and has no cut-off (the switch has never been on): every stored
 *  rate is then today's public rate and every rate-bearing email goes where it goes today. Uses the
 *  display cache (the cut-off is written once and never moves; see rateIsPublicForRow for why a stale
 *  answer is safe for stamped rows). Fails closed: an unreadable policy counts as "cut-off exists". */
export async function ratesPublicBeforeCutoff(client: Client): Promise<boolean> {
  const policy = await cachedPublicPolicy(client);
  return policy !== null && policy.cutoffAt === null;
}

/** rateIsPublicForRow with the policy read only when the row's basis cannot answer by itself
 *  (no RPC for a stamped row; at most one cached RPC otherwise). */
export async function rowRateIsPublic(client: Client, row: { rate_basis?: unknown } | null | undefined): Promise<boolean> {
  if (typeof row?.rate_basis === 'string') return rateIsPublicForRow(row);
  return rateIsPublicForRow(row, await ratesPublicBeforeCutoff(client));
}

export function _resetPolicyCacheForTests(): void {
  policyCache = null;
  policyInFlight = null;
}

/** partner_quote_rate(): one RPC. 'me' needs the caller's JWT; 'partner' needs service role or a
 *  partner-staff JWT. null on any error. Number only: the basis never reaches edge code. */
export async function readQuoteRate(client: Client, quoteFor: 'me' | 'partner', partnerId?: string): Promise<number | null> {
  if (quoteFor !== 'me' && quoteFor !== 'partner') return null;
  if (quoteFor === 'partner' && !partnerId) return null;
  try {
    const { data, error } = await client.rpc('partner_quote_rate', {
      p_quote_for: quoteFor,
      p_partner_id: quoteFor === 'partner' ? partnerId : null,
    });
    if (error) return null;
    return rateOrNull(data);
  } catch (_e) {
    return null;
  }
}

function uniqueIds(ids: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const id of ids) if (typeof id === 'string' && id) out.add(id);
  return [...out];
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** rent_facilitation_reward_rates for a list of rent requests: ONE select per 100 ids.
 *  A chunk that fails is left out (its requests then have no rate: callers show no number). */
export async function readRentRewardRates(admin: Client, rentRequestIds: string[], supporterId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = uniqueIds(rentRequestIds);
  if (!supporterId || ids.length === 0) return out;
  for (const part of chunks(ids, 100)) {
    try {
      const { data, error } = await admin
        .from('rent_facilitation_reward_rates')
        .select('rent_request_id, rate')
        .in('rent_request_id', part)
        .eq('supporter_id', supporterId);
      if (error || !Array.isArray(data)) continue;
      for (const row of data) {
        const r = rateOrNull(row?.rate);
        if (r !== null && typeof row?.rent_request_id === 'string') out.set(row.rent_request_id, r);
      }
    } catch (_e) {
      // fail closed: no rate for this chunk
    }
  }
  return out;
}

/** Confirmed, real login emails for people: ONE RPC (partner_confirmed_login_emails) per 1000 ids.
 *  Map<userId, email>; a failed chunk adds nothing (empty map when every chunk fails). */
export async function readConfirmedLoginEmails(admin: Client, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = uniqueIds(ids);
  for (const part of chunks(unique, 1000)) {
    try {
      const { data, error } = await admin.rpc('partner_confirmed_login_emails', { p_ids: part });
      if (error || !Array.isArray(data)) continue;
      for (const row of data) {
        const email = typeof row?.email === 'string' ? row.email.trim() : '';
        if (email && typeof row?.user_id === 'string') out.set(row.user_id, email);
      }
    } catch (_e) {
      // fail closed: these people get the figure-free email
    }
  }
  return out;
}

const cleanEmail = (v: string | null | undefined): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

/** Where an email that carries a rate goes, and whether it may show figures.
 *  rateIsPublic (row basis says the rate applies to everyone): the profile email, as today.
 *  Otherwise the confirmed login email (only the person can change it); when there is none, the profile
 *  email WITHOUT rate or Returns figures (the template hides those lines). */
export function rateEmailTarget(loginEmail: string | null, profileEmail: string | null, rateIsPublic: boolean):
  { to: string | null; withFigures: boolean } {
  const profile = cleanEmail(profileEmail);
  if (rateIsPublic) return { to: profile, withFigures: true };
  const login = cleanEmail(loginEmail);
  if (login) return { to: login, withFigures: true };
  return { to: profile, withFigures: false };
}

/** True when the user holds an enabled partner-staff role (one select). false on any error. */
export async function callerIsPartnerStaff(admin: Client, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  try {
    const { data, error } = await admin
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .eq('enabled', true)
      .in('role', [...PARTNER_STAFF_ROLES])
      .limit(1);
    return !error && Array.isArray(data) && data.length > 0;
  } catch (_e) {
    return false;
  }
}

/** Stale-screen guard (design v2 section 3.1.0). A staff screen that typed a rate and did not see the
 *  switch ON (or an old bundle that never says) is refused with 409 when the live policy is on or
 *  unreadable. One uncached policy RPC, only when a rate was typed. */
export const POLICY_CHANGED_RESPONSE = {
  error: 'The Returns policy changed. Reload the page and check the rate.',
  code: 'POLICY_CHANGED',
} as const;

export async function typedRateNeedsReload(client: Client, typedAny: boolean, policyEnabledSeen: unknown): Promise<boolean> {
  if (!typedAny || policyEnabledSeen === true) return false;
  const live = await readPublicPolicy(client);
  return live === null || live.enabled;
}

/** The note staff without partner-staff roles get instead of stored rates (owner decision D11). */
export const RATE_NOTE_FOR_OTHER_STAFF = "Rates that differ from the person's rate go to the CFO.";
