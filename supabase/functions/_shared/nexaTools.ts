/**
 * Nexa tool calling: the returns calculator and the caller's own portfolio reads.
 * Pure helpers are exported for tests. Portfolio tools never take a user id or a
 * portfolio code from the model; identity comes only from the server.
 */
export const NEW_PARTNER_MONTHLY_RATE = 10; // Benjamin's decision, 4 Nov 2026
export const LEGACY_RATES = [15, 20];
export const MIN_AMOUNT = 20_000;
export const MAX_AMOUNT = 500_000_000;
export const MAX_MONTHS = 36;
export const RETURNS_DISCLAIMER = 'Illustrative only, not guaranteed. Returns depend on approved plan terms and capital is at risk.';

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

export function estimateSupporterReturns(input: { amount?: unknown; months?: unknown; rate?: unknown; mode?: unknown }): ReturnsEstimate | { error: string } {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) return { error: `Amount must be between UGX ${MIN_AMOUNT.toLocaleString('en-US')} and UGX ${MAX_AMOUNT.toLocaleString('en-US')}.` };
  const months = clampInt(input.months, 1, MAX_MONTHS, 12);
  const rateRaw = input.rate === undefined || input.rate === null || input.rate === '' ? NEW_PARTNER_MONTHLY_RATE : Number(input.rate);
  if (!Number.isFinite(rateRaw) || rateRaw <= 0 || rateRaw > 20) return { error: 'Monthly rate must be above 0% and at most 20%.' };
  const mode: ReturnsMode = input.mode === 'compound' ? 'compound' : 'simple';
  const r = rateRaw / 100;
  let balance = Math.round(amount);
  let total = 0;
  const monthlyBreakdown: ReturnsEstimate['monthlyBreakdown'] = [];
  for (let m = 1; m <= months; m++) {
    const base = mode === 'compound' ? balance : amount;
    const ret = Math.round(base * r);
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

export const NEXA_TOOL_DEFS = [
  { type: 'function', function: { name: 'estimate_supporter_returns', description: 'Calculate illustrative Supporter Returns. Use this for every Returns figure; never do the maths yourself. New partners default to 10% per month. For an existing portfolio, pass that portfolio\'s own rate.', parameters: { type: 'object', properties: { amount: { type: 'number', description: 'UGX amount, 20,000 to 500,000,000' }, months: { type: 'integer', description: '1 to 36, default 12' }, rate: { type: 'number', description: 'Monthly percent. Omit for new partners (10).' }, mode: { type: 'string', enum: ['simple', 'compound'], description: 'simple = paid out monthly; compound = Returns added to the balance each month' } }, required: ['amount'] } } },
  { type: 'function', function: { name: 'get_my_portfolios', description: 'Read the verified caller\'s own Supporter portfolios. Takes no arguments; identity is checked by the server. Returns an error if the caller is not verified.', parameters: { type: 'object', properties: {} } } },
] as const;

export type PortfolioReader = () => Promise<{ portfolios: PortfolioSummary[] } | { error: string }>;

export type DenialHook = (tool: string, reason: string) => Promise<void>;
export async function runNexaTool(name: string, rawArgs: string, readPortfolios: PortfolioReader | null, onDenied?: DenialHook): Promise<unknown> {
  let args: Record<string, unknown> = {};
  try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return { error: 'Invalid tool arguments.' }; }
  if (name === 'estimate_supporter_returns') return estimateSupporterReturns(args);
  if (name === 'get_my_portfolios') {
    if (!readPortfolios) { await onDenied?.('get_my_portfolios', 'Portfolio tool called without a signed-in or OTP-verified caller'); return { error: 'Not verified. Ask the partner to sign in at welileapp.com, or to verify with their portfolio code and the SMS code sent to their registered phone.' }; }
    return await readPortfolios();
  }
  await onDenied?.(name.slice(0, 80), 'Model requested a tool that does not exist or is not allowed');
  return { error: 'Unknown tool.' };
}

/** Questions that must reach the returns tool instead of a canned 15% guide. */
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
