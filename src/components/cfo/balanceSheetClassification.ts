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
 * A4 "Advances and Other Receivables" is deliberately NOT mapped. It is a
 * single account carrying agent advances, employee advances and wallet
 * deductions together, so it cannot be split into the separate agent and
 * employee lines this structure asks for without inventing the split.
 *
 * A9 Suspense is unresolved postings by definition and is never classified.
 */
const ASSET_ACCOUNT_MAP: Record<string, string> = {
  A1: 'Cash and Bank Balances',
  A2: 'Cash and Bank Balances',
  A5: 'Cash and Bank Balances',
  A3: 'Receivables from Tenant Products and Services',
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
 * L4 is the landlord payable and L1 is withdrawable user wallet custody.
 *
 * L2, L3, L5, L6 (partner capital, partner returns, agent commissions, partner
 * top-ups) and L9 (suspense) have no home in this structure, so they are
 * flagged rather than forced into Marketplace.
 */
const LIABILITY_ACCOUNT_MAP: Record<string, string> = {
  L4: 'Landlord Float',
  L1: 'Withdrawal Balances',
};

/* ── Equity ────────────────────────────────────────────────────────────── */

export const EQUITY_CATEGORIES = [
  'Angel Pool Shares',
  'Retained Earnings',
  'Proposed Dividends',
] as const;

/**
 * Retained earnings is a derived line with no account code, matched by label.
 *
 * E1 Shareholders' Capital Contributions is NOT mapped to Angel Pool Shares:
 * the Angel Pool is one funding route among several and E1 is the general
 * contributions account, so equating them would misstate both. E3 and E4
 * (legacy opening balances and one-sided posting counterparts) are flagged.
 */
const EQUITY_LABEL_MAP: Record<string, string> = {
  'Retained Earnings / (Accumulated Deficit)': 'Retained Earnings',
  'Accumulated Profit / (Loss)': 'Retained Earnings',
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
  return build(lines, EQUITY_CATEGORIES, l => EQUITY_LABEL_MAP[l.label] ?? null);
}

export function classifyLiabilities(lines: PositionLine[]) {
  const all = [...MARKETPLACE_LIABILITY_CATEGORIES, ...STANDALONE_LIABILITY_CATEGORIES];
  const { groups, flagged, total } = build(lines, all, l => {
    const code = accountCodeOf(l);
    return code ? LIABILITY_ACCOUNT_MAP[code] ?? null : null;
  });
  const marketplace = groups.filter(g =>
    (MARKETPLACE_LIABILITY_CATEGORIES as readonly string[]).includes(g.label));
  const standalone = groups.filter(g =>
    (STANDALONE_LIABILITY_CATEGORIES as readonly string[]).includes(g.label));
  return {
    marketplace,
    marketplaceTotal: marketplace.reduce((t, g) => t + g.value, 0),
    standalone,
    flagged,
    total,
  };
}

/** Only show the flagged group when it actually holds something. */
export const hasFlagged = (g: BsGroup) => g.lines.length > 0 && Math.round(g.value) !== 0;
