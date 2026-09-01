/**
 * Balance sheet presentation taxonomy.
 *
 * Classification only. Every figure still comes from
 * get_statement_of_financial_position(); this decides which heading a line is
 * printed under, never what it is worth.
 *
 * Two rules keep the statement honest:
 *
 * 1. Every line lands in exactly one group. Anything that cannot be classified
 *    with confidence goes to "Unclassified — flagged for review", which is
 *    included in the section total. Nothing is dropped, and no plug value is
 *    invented to make a section foot.
 *
 * 2. Requested categories with no ledger account behind them still render, at
 *    zero, so the intended structure is visible and the gap is obvious rather
 *    than looking like an omission.
 */

export interface PositionLine {
  label: string;
  value: number;
  source?: string;
}

export interface BsGroup {
  label: string;
  value: number;
  lines: PositionLine[];
  /** True when no ledger account maps here yet. */
  unsourced?: boolean;
}

export const FLAGGED_LABEL = 'Unclassified — flagged for review';

/** `source` reads "general_ledger trial balance — account A1". */
export function accountCodeOf(line: PositionLine): string | null {
  const m = /account\s+([A-Z]\d+)\s*$/.exec(line.source ?? '');
  return m ? m[1] : null;
}

/* ── Assets ────────────────────────────────────────────────────────────── */

export const ASSET_CATEGORIES = [
  'Cash and Bank Balances',
  'Receivables from Tenant Products and Services',
  'Receivables from Agent Products and Services',
  'Receivables from Landlord Products and Services',
  'Receivables from Partner Products and Services',
  'Receivables from R&D',
  'Loans and Advances to Employees',
  'Other Assets',
  'Property, Equipment and Right-of-Use Assets',
  'Intangible Assets',
  'Goodwill',
] as const;

/**
 * Only mappings that are unambiguous.
 *
 * A1 Cash and Bank, A2 Cash at Hand — Float with Agents and A5 Cash in Transit
 * are all cash; the cash flow statement already defines cash as A1 + A2.
 * A3 is tenant rent access receivables.
 *
 * A4 "Advances and Other Receivables" now carries only agent advance
 * disbursements and their repayments (a genuine debit balance), so it is
 * reported under agent receivables. It used to be left flagged because wallet
 * deductions were credited to it, pushing an asset account to a ~UGX 1.21bn
 * credit balance; those deductions are corrections with no receivable behind
 * them and are now presented as equity balance corrections (E3) by
 * sofp_ledger_legs, which is where the misclassification actually lived.
 *
 * A9 Suspense is unresolved postings by definition and is never classified.
 */
const ASSET_ACCOUNT_MAP: Record<string, string> = {
  A1: 'Cash and Bank Balances',
  A2: 'Cash and Bank Balances',
  A5: 'Cash and Bank Balances',
  A3: 'Receivables from Tenant Products and Services',
  A4: 'Receivables from Agent Products and Services',
};


/* ── Liabilities ───────────────────────────────────────────────────────── */

export const MARKETPLACE_LIABILITY_CATEGORIES = [
  'Landlord Float',
  'Withdrawal Balances',
  'Operational Float',
  'Merchant Agent Float (Net)',
  'Borrowed Funds',
] as const;

export const STANDALONE_LIABILITY_CATEGORIES = [
  'Taxes Payable',
  'Provisional Liabilities',
] as const;

/**
 * Obligations owed to partners and agents. These are real payables that do not
 * belong in Marketplace float, so they get their own block instead of being
 * left unclassified.
 *
 * L2 is partner capital held under rent-plan portfolios (partner_funding,
 * roi_reinvestment, supporter_facilitation_capital) — capital the company holds
 * and must eventually return, i.e. a non-current partner obligation.
 * L6 is money received from partners that has not yet been applied to a
 * portfolio (pending_portfolio_topup) — a short-term custody obligation.
 * L3 partner returns payable and L5 agent commission payable are accrued
 * payouts.
 */
export const PARTNER_LIABILITY_CATEGORIES = [
  'Partner Portfolio Capital Held',
  'Partner Top-Ups Awaiting Application',
  'Partner Returns Payable',
  'Agent Commission Payable',
] as const;

/**
 * L4 is the landlord payable and L1 is withdrawable user wallet custody.
 *
 * L9 (suspense) stays unmapped by design — unresolved postings must remain
 * visible as unresolved.
 */
const LIABILITY_ACCOUNT_MAP: Record<string, string> = {
  L4: 'Landlord Float',
  L1: 'Withdrawal Balances',
  L2: 'Partner Portfolio Capital Held',
  L6: 'Partner Top-Ups Awaiting Application',
  L3: 'Partner Returns Payable',
  L5: 'Agent Commission Payable',
};

/* ── Equity ────────────────────────────────────────────────────────────── */

export const EQUITY_CATEGORIES = [
  'Angel Pool Shares',
  'Retained Earnings',
  'Proposed Dividends',
  'Legacy Opening Balance Adjustments',
  'Legacy One-Sided Posting Counterparts',
] as const;

/**
 * Retained earnings is a derived line with no account code, matched by label.
 *
 * E1 Shareholders' Capital Contributions is reported under Angel Pool Shares:
 * the underlying legs are 'pool_capital_received' (UGX 94.155m of the UGX
 * 96.274m balance) plus a small 'share_capital' remainder (UGX 2.119m). The
 * statement exposes one line per account, so the remainder rides along with the
 * pool contributions rather than being split — the account is materially the
 * angel pool.
 *
 * E3 carries opening-balance and system balance corrections; E4 is the equity
 * counterpart raised for historic one-sided postings. Both are legitimate
 * equity movements with their own meaning, so each gets its own line instead of
 * being flagged as unexplained.
 */
const EQUITY_LABEL_MAP: Record<string, string> = {
  'Retained Earnings / (Accumulated Deficit)': 'Retained Earnings',
  'Accumulated Profit / (Loss)': 'Retained Earnings',
};

const EQUITY_ACCOUNT_MAP: Record<string, string> = {
  E1: 'Angel Pool Shares',
  E3: 'Legacy Opening Balance Adjustments',
  E4: 'Legacy One-Sided Posting Counterparts',
};


/* ── Grouping ──────────────────────────────────────────────────────────── */

function build(
  lines: PositionLine[],
  categories: readonly string[],
  classify: (line: PositionLine) => string | null,
) {
  const byLabel = new Map<string, BsGroup>(
    categories.map(label => [label, { label, value: 0, lines: [], unsourced: true }]),
  );
  const flagged: BsGroup = { label: FLAGGED_LABEL, value: 0, lines: [] };

  for (const line of lines) {
    const label = classify(line);
    const group = (label && byLabel.get(label)) || flagged;
    group.value += line.value;
    group.lines.push(line);
    group.unsourced = false;
  }

  const groups = categories.map(c => byLabel.get(c)!);
  const total = [...groups, flagged].reduce((t, g) => t + g.value, 0);
  return { groups, flagged, total };
}

export function classifyAssets(lines: PositionLine[]) {
  return build(lines, ASSET_CATEGORIES, l => {
    const code = accountCodeOf(l);
    return code ? ASSET_ACCOUNT_MAP[code] ?? null : null;
  });
}

export function classifyEquity(lines: PositionLine[]) {
  return build(lines, EQUITY_CATEGORIES, l => {
    const code = accountCodeOf(l);
    return (code ? EQUITY_ACCOUNT_MAP[code] : null) ?? EQUITY_LABEL_MAP[l.label] ?? null;
  });
}

export function classifyLiabilities(lines: PositionLine[]) {
  const all = [
    ...MARKETPLACE_LIABILITY_CATEGORIES,
    ...STANDALONE_LIABILITY_CATEGORIES,
    ...PARTNER_LIABILITY_CATEGORIES,
  ];
  const { groups, flagged, total } = build(lines, all, l => {
    const code = accountCodeOf(l);
    return code ? LIABILITY_ACCOUNT_MAP[code] ?? null : null;
  });
  const inList = (list: readonly string[], g: BsGroup) => list.includes(g.label);
  const marketplace = groups.filter(g => inList(MARKETPLACE_LIABILITY_CATEGORIES, g));
  const standalone = groups.filter(g => inList(STANDALONE_LIABILITY_CATEGORIES, g));
  const partner = groups.filter(g => inList(PARTNER_LIABILITY_CATEGORIES, g));
  return {
    marketplace,
    marketplaceTotal: marketplace.reduce((t, g) => t + g.value, 0),
    standalone,
    partner,
    partnerTotal: partner.reduce((t, g) => t + g.value, 0),
    flagged,
    total,
  };
}

/**
 * Lines worth showing inside the flagged block. Accounts sitting at exactly
 * zero (typically the suspense accounts A9 / L9) contribute nothing to the
 * section total, so listing them only adds noise to the review warning. They
 * remain part of the flagged group's value, which is zero for them.
 */
export const visibleFlaggedLines = (g: BsGroup) =>
  g.lines.filter(l => Math.round(l.value) !== 0);

/** Only show the flagged group when it actually holds something. */
export const hasFlagged = (g: BsGroup) =>
  visibleFlaggedLines(g).length > 0 && Math.round(g.value) !== 0;

