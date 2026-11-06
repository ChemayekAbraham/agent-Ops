// Builds the "Portfolio Compounded" email payload from RECORDED facts
// (see public.portfolio_compound_email_facts). Pure: no Deno or network calls,
// so it is unit-tested and also run against a real portfolio before sending.
//
// What the partner is told, and why it adds up:
//   capital added + returns compounded to date = portfolio value
//   opening balance + this return              = portfolio value
// The schedule starts on the portfolio's next return date, uses the real
// compounding day (not the 1st of the month), and stops before maturity.

export interface CompoundFacts {
  error?: string;
  portfolio: {
    id: string;
    code: string;
    account_name?: string | null;
    roi_percentage: number;
    maturity_date?: string | null;
    next_roi_date?: string | null;
    created_at?: string | null;
  };
  partner: { id?: string; name?: string | null; email?: string | null };
  compound: {
    at: string;
    reference?: string | null;
    next_roi_date?: string | null;
    return_amount: number;
    new_principal: number;
    opening_balance: number;
  };
  compound_number: number;
  returns_to_date: number;
  capital_added: number;
}

export interface ScheduleRow {
  /** "28 October 2026" */
  date: string;
  /** "October 2026" */
  month_name: string;
  balance_before: number;
  return_amount: number;
  balance_after: number;
}

export interface CompoundEmailData {
  partner_name: string;
  /** Always the portfolio code, never the account name. */
  portfolio_id: string;
  compound_date: string;
  compound_number: number;
  opening_balance: number;
  return_amount: number;
  new_total_partnership_value: number;
  capital_added: number;
  returns_to_date: number;
  roi_percentage: number;
  roi_return: string;
  maturity_date_label: string;
  schedule: ScheduleRow[];
  /** Kept so an older template build still renders the headline numbers. */
  initial_partnership_amount: number;
  currency: string;
  company_name: string;
  logo_url: string;
  unsubscribe_url: string;
  dashboard_url: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** Parse "YYYY-MM-DD" (or an ISO timestamp) as a calendar date, ignoring the time zone. */
function parseDay(v: string | null | undefined): { y: number; m: number; d: number } | null {
  const mt = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));
  if (!mt) return null;
  return { y: Number(mt[1]), m: Number(mt[2]) - 1, d: Number(mt[3]) };
}

const key = (x: { y: number; m: number; d: number }) => x.y * 10000 + x.m * 100 + x.d;

/** The same day of month `n` months later, clamped to the month's last day. */
function addMonths(x: { y: number; m: number; d: number }, n: number, day: number) {
  const total = x.y * 12 + x.m + n;
  const y = Math.floor(total / 12);
  const m = total % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return { y, m, d: Math.min(day, last) };
}

const label = (x: { y: number; m: number; d: number }) => `${x.d} ${MONTHS[x.m]} ${x.y}`;

/** Compound date in Kampala time, e.g. "28 September 2026". */
function kampalaDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Kampala', day: 'numeric', month: 'long', year: 'numeric',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')} ${get('month')} ${get('year')}`;
}

export function buildSchedule(opts: {
  startingBalance: number;
  ratePct: number;
  nextReturnDate: string | null | undefined;
  maturityDate: string | null | undefined;
  maxRows?: number;
}): ScheduleRow[] {
  const first = parseDay(opts.nextReturnDate);
  const maturity = parseDay(opts.maturityDate);
  if (!first || !maturity || !(opts.startingBalance > 0) || !(opts.ratePct > 0)) return [];
  const rows: ScheduleRow[] = [];
  let bal = opts.startingBalance;
  const max = opts.maxRows ?? 36;
  for (let i = 0; i < max; i++) {
    const d = addMonths(first, i, first.d);
    // A return that falls on or after the maturity date is not a compounding cycle.
    if (key(d) >= key(maturity)) break;
    const earned = Math.round((bal * opts.ratePct) / 100);
    rows.push({
      date: label(d),
      month_name: `${MONTHS[d.m]} ${d.y}`,
      balance_before: bal,
      return_amount: earned,
      balance_after: bal + earned,
    });
    bal += earned;
  }
  return rows;
}

export function buildCompoundEmailData(f: CompoundFacts): CompoundEmailData {
  const pct = Number(f.portfolio.roi_percentage) || 0;
  const mat = parseDay(f.portfolio.maturity_date);
  return {
    partner_name: (f.partner.name ?? '').trim() || 'Partner',
    portfolio_id: f.portfolio.code,
    compound_date: kampalaDay(f.compound.at),
    compound_number: f.compound_number,
    opening_balance: f.compound.opening_balance,
    return_amount: f.compound.return_amount,
    new_total_partnership_value: f.compound.new_principal,
    capital_added: f.capital_added,
    returns_to_date: f.returns_to_date,
    roi_percentage: pct,
    roi_return: `${Math.round(pct * 100) / 100}%`,
    maturity_date_label: mat ? label(mat) : '',
    schedule: buildSchedule({
      startingBalance: f.compound.new_principal,
      ratePct: pct,
      nextReturnDate: f.compound.next_roi_date ?? f.portfolio.next_roi_date,
      maturityDate: f.portfolio.maturity_date,
    }),
    initial_partnership_amount: f.compound.opening_balance,
    currency: 'UGX',
    company_name: 'Welile',
    logo_url: 'https://welileapp.com/welile-logo.png',
    unsubscribe_url: 'https://welile.com/unsubscribe',
    dashboard_url: 'https://welileapp.com/auth',
  };
}

/** One email per compounding event, however many times it is triggered. */
export function compoundEmailIdempotencyKey(partnerId: string, portfolioId: string, reference: string): string {
  return `partner-portfolio-compounded-${partnerId}-${portfolioId}-${reference}`;
}
