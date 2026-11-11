/**
 * Nexa tool calling: the returns calculator and the caller's own portfolio reads.
 * Pure helpers are exported for tests. Portfolio tools never take a user id or a
 * portfolio code from the model; identity comes only from the server.
 *
 * No rate lives here. The new-partner rate is the live public rate the caller passes in
 * (get_partner_return_policy); a signed-in person's own rate for a NEW portfolio comes from
 * partner_quote_rate('me') through get_my_returns_rate, and is also the estimate's default for them.
 * Without a rate the estimate refuses.
 */
import { formatRatePct, monthlyReturnFor, rateOrNull } from './partnerReturnPolicy.ts';

export const MIN_AMOUNT = 20_000;
export const MAX_AMOUNT = 500_000_000;
export const MAX_MONTHS = 36;
export const RETURNS_DISCLAIMER = 'New partners earn a 15% Rent profit share per month for 12 months. Your principal and Rent profit share are guaranteed as set out in your partnership agreement.';

export type ReturnsMode = 'simple' | 'compound';
export interface ReturnsEstimate {
  amount: number; months: number; monthlyRatePercent: number; mode: ReturnsMode;
  monthlyBreakdown: Array<{ month: number; returns: number; balance: number }>;
  totalReturns: number; endingBalance: number; disclaimer: string;
}

const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

export const RATE_UNAVAILABLE_ERROR = 'The current Returns rate is not available right now. Please check the Welile app.';

/**
 * `defaultRate` is used when the model omits `rate` (a new partner): the live public rate, or null
 * when it is unknown, in which case the tool returns an error and the model gives no figure.
 * An explicit `rate` (an existing portfolio's own rate) is always honoured.
 */
export function estimateSupporterReturns(input: { amount?: unknown; months?: unknown; rate?: unknown; mode?: unknown }, defaultRate: number | null): ReturnsEstimate | { error: string } {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) return { error: `Amount must be between UGX ${MIN_AMOUNT.toLocaleString('en-US')} and UGX ${MAX_AMOUNT.toLocaleString('en-US')}.` };
  const months = clampInt(input.months, 1, MAX_MONTHS, 12);
  const rateRaw = input.rate === undefined || input.rate === null || input.rate === '' ? rateOrNull(defaultRate) : Number(input.rate);
  if (rateRaw === null) return { error: RATE_UNAVAILABLE_ERROR };
  if (!Number.isFinite(rateRaw) || rateRaw <= 0 || rateRaw > 20) return { error: 'Monthly rate must be above 0% and at most 20%.' };
  const mode: ReturnsMode = input.mode === 'compound' ? 'compound' : 'simple';
  let balance = Math.round(amount);
  let total = 0;
  const monthlyBreakdown: ReturnsEstimate['monthlyBreakdown'] = [];
  for (let m = 1; m <= months; m++) {
    const base = mode === 'compound' ? balance : amount;
    // Same maths as every notice and screen (monthlyReturnFor = round(base * rate / 100)).
    const ret = monthlyReturnFor(base, rateRaw) ?? 0;
    total += ret;
    if (mode === 'compound') balance += ret;
    monthlyBreakdown.push({ month: m, returns: ret, balance: mode === 'compound' ? balance : Math.round(amount) });
  }
  return { amount: Math.round(amount), months, monthlyRatePercent: rateRaw, mode, monthlyBreakdown: months > 12 ? monthlyBreakdown.filter(x => x.month % 3 === 0 || x.month === months) : monthlyBreakdown, totalReturns: total, endingBalance: mode === 'compound' ? balance : Math.round(amount) + total, disclaimer: RETURNS_DISCLAIMER };
}

export interface PortfolioSummary {
  portfolio_code: string; investment_amount: number; roi_mode: string; roi_percentage: number;
  next_roi_date: string | null; maturity_date: string | null; total_roi_earned: number; current_value: number; status: string;
}

/**
 * Tool definitions for one request. `publicRate` is the live public new-partner rate (null when
 * unknown); `ownRate` adds get_my_returns_rate, offered ONLY to a caller signed in with a user JWT
 * (a phone number or an OTP portfolio session is not an identity for this question).
 */
export function buildNexaToolDefs({ publicRate, ownRate }: { publicRate: number | null; ownRate: boolean }) {
  const pct = formatRatePct(rateOrNull(publicRate));
  const noRate = 'the tool returns an error when no rate is available; then give no figure';
  // Signed in, an omitted rate is the caller's OWN new-portfolio rate (runNexaTool reads it), so a
  // question about new partners in general must pass the public rate explicitly.
  const rateUse = ownRate
    ? `Omit rate to use the signed-in caller's own rate for a new portfolio (${noRate}). For new partners in general (someone else, or what new partners get), pass ${pct ? `rate ${pct.slice(0, -1)} (the new-partner rate, ${pct} a month now)` : 'the new-partner rate; none is available right now, so give no figure'}.`
    : `Omit rate for a new partner (${pct ? `${pct} a month now` : noRate}).`;
  const rateArg = ownRate ? 'Monthly percent. Omit for the signed-in caller\'s own new-portfolio rate.' : 'Monthly percent. Omit for a new partner.';
  const defs: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> = [
    { type: 'function', function: { name: 'estimate_supporter_returns', description: `Calculate illustrative Supporter Returns. Use this for every Returns figure; never do the maths yourself. ${rateUse} For an existing portfolio, pass that portfolio's own rate.`, parameters: { type: 'object', properties: { amount: { type: 'number', description: 'UGX amount, 20,000 to 500,000,000' }, months: { type: 'integer', description: '1 to 36, default 12' }, rate: { type: 'number', description: rateArg }, mode: { type: 'string', enum: ['simple', 'compound'], description: 'simple = paid out monthly; compound = Returns added to the balance each month' } }, required: ['amount'] } } },
    { type: 'function', function: { name: 'get_my_portfolios', description: 'Read the verified caller\'s own Supporter portfolios. Takes no arguments; identity is checked by the server. Returns an error if the caller is not verified.', parameters: { type: 'object', properties: {} } } },
  ];
  if (ownRate) {
    defs.push({ type: 'function', function: { name: 'get_my_returns_rate', description: 'The signed-in caller\'s own monthly Returns rate for a NEW portfolio. Takes no arguments. Use it when they ask what a new portfolio would earn for them.', parameters: { type: 'object', properties: {} } } });
  }
  return defs;
}

export type PortfolioReader = () => Promise<{ portfolios: PortfolioSummary[] } | { error: string }>;
/** Reads the signed-in caller's own rate for a new portfolio (partner_quote_rate('me')). */
export type MyRateReader = () => Promise<{ rate: number } | { error: string }>;
export interface NexaToolContext { defaultRate: number | null; readMyRate?: MyRateReader }

export type DenialHook = (tool: string, reason: string) => Promise<void>;
export async function runNexaTool(name: string, rawArgs: string, readPortfolios: PortfolioReader | null, onDenied?: DenialHook, ctx: NexaToolContext = { defaultRate: null }): Promise<unknown> {
  let args: Record<string, unknown> = {};
  try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return { error: 'Invalid tool arguments.' }; }
  if (name === 'estimate_supporter_returns') {
    // Signed in (readMyRate present): an omitted rate is the caller's own rate for a new portfolio,
    // never the public new-partner rate. Unreadable -> null -> the estimate refuses (no figure).
    const omitted = args.rate === undefined || args.rate === null || args.rate === '';
    if (omitted && ctx.readMyRate) {
      const mine = await ctx.readMyRate();
      return estimateSupporterReturns(args, 'rate' in mine ? mine.rate : null);
    }
    return estimateSupporterReturns(args, ctx.defaultRate);
  }
  if (name === 'get_my_portfolios') {
    if (!readPortfolios) { await onDenied?.('get_my_portfolios', 'Portfolio tool called without a signed-in or OTP-verified caller'); return { error: 'Not verified. Ask the partner to sign in at welileapp.com, or to verify with their portfolio code and the SMS code sent to their registered phone.' }; }
    return await readPortfolios();
  }
  if (name === 'get_my_returns_rate') {
    if (!ctx.readMyRate) { await onDenied?.('get_my_returns_rate', 'Own-rate tool called without a signed-in caller'); return { error: 'Sign in at welileapp.com to see your own rate.' }; }
    return await ctx.readMyRate();
  }
  await onDenied?.(name.slice(0, 80), 'Model requested a tool that does not exist or is not allowed');
  return { error: 'Unknown tool.' };
}

/** Questions that must reach the server tools instead of a canned guide. */
export function isPortfolioOrReturnsQuestion(text: string): boolean {
  return /\bsupport(?:ing)? a tenant\b/i.test(text)
    || /\b(supporter|partner)\s+returns?\b/i.test(text)
    || /\bmy\s+portfolios?\b/i.test(text)
    || (/\bportfolios?\b/i.test(text) && /\b(balance|returns?|value|earned|rate|status)\b/i.test(text))
    || (/\b(estimate|calculate|how much)\b/i.test(text) && /\b(returns?|earn)\b/i.test(text));
}

export function normalizePortfolioRow(r: Record<string, unknown>): PortfolioSummary {
  return {
    portfolio_code: String(r.portfolio_code ?? ''), investment_amount: Number(r.investment_amount ?? 0), roi_mode: String(r.roi_mode ?? ''),
    roi_percentage: Number(r.roi_percentage ?? 0), next_roi_date: (r.next_roi_date as string) ?? null, maturity_date: (r.maturity_date as string) ?? null,
    total_roi_earned: Number(r.total_roi_earned ?? 0), current_value: Number(r.current_value ?? 0), status: String(r.status ?? ''),
  };
}
