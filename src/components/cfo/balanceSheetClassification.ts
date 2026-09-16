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
  /** Presentation-only fields used by the balance sheet renderer. */
  heading?: boolean;
  subtotal?: boolean;
  depth?: number;
  components?: PositionLine[];
}


export const FLAGGED_LABEL = 'Unclassified — flagged for review';

/** `source` reads "general_ledger trial balance — account A1". */
export function accountCodeOf(line: PositionLine): string | null {
  const m = /account\s+([A-Z]\d+)\s*$/.exec(line.source ?? '');
  return m ? m[1] : null;
}

/* ── Assets ────────────────────────────────────────────────────────────── */

export const ASSET_CATEGORIES = [
  'Cash at Bank',
  'Agent Float — Amounts with Agents',
  'Cash in Custody — Not Yet Confirmed Banked',
  'Agent and Merchant Float Cycle Control',
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

/** The bank line is A1 alone — float and custody are never bank cash. */
export const CASH_AT_BANK_LABEL = 'Cash at Bank';

/**
 * Only mappings that are unambiguous.
 *
 * Cash presentation (approved correction, 2026-09-15): A1 is the ONLY bank
 * line. A2 is money in agents' hands, A5 is physical cash received and not yet
 * confirmed banked, and A8 is the agent/merchant float cycle control account —
 * none of the three is company bank cash, so each reports on its own line and
 * none is added into "Cash at Bank". They were previously grouped together,
 * which presented float and custody as bank money.
 *
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
  A1: 'Cash at Bank',
  A2: 'Agent Float — Amounts with Agents',
  A5: 'Cash in Custody — Not Yet Confirmed Banked',
  A8: 'Agent and Merchant Float Cycle Control',
  A3: 'Receivables from Tenant Products and Services',
  A4: 'Receivables from Agent Products and Services',
  // A6 and A7 recognise the Welile Homes and promissory note receivables that
  // previously existed only in the operational sub-ledgers and were disclosed as
  // memo comparisons. Once the ledger carries them they report here, and the
  // two categories stop being unsourced placeholders.
  A6: 'Receivables from Landlord Products and Services',
  A7: 'Receivables from Partner Products and Services',
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
  'Deferred Rent Plan Fee Income',
  'Provisional Liabilities',
] as const;

/**
 * L4 is the landlord payable and L1 is withdrawable user wallet custody.
 *
 * L7 "Platform Treasury Control — Landlord Flow" is the funding-side credit
 * raised by recognise_funding_treasury() for the access and registration fees
 * a tenant will pay over the life of a Rent Plan (DR A3 / CR L7), drawn down
 * by the repayment waterfall as instalments come in. It is unearned fee income
 * — a current liability in ledger_account_catalog — so it reports on its own
 * line as deferred Rent Plan fee income rather than sitting unclassified. No
 * cash account is involved and the balance is unchanged; only the heading it
 * prints under is decided here.
 *
 * L9 (suspense) stays unmapped by design — unresolved postings must remain
 * visible as unresolved.
 */
const LIABILITY_ACCOUNT_MAP: Record<string, string> = {
  L4: 'Landlord Float',
  L1: 'Withdrawal Balances',
  L7: 'Deferred Rent Plan Fee Income',
  // Reported as component lines inside Landlord Float rather than as their own
  // section. Their ledger accounts, balances and classifications are unchanged;
  // only the heading they print under moves, and each still appears exactly
  // once because a line can only land in one group.
  L2: 'Landlord Float',
  L6: 'Landlord Float',
  L3: 'Landlord Float',
  L5: 'Landlord Float',
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
 * counterpart raised for historic one-sided postings. Both are equity accounts
 * in ledger_account_catalog (section 'equity', nature 'equity') and are
 * reported in equity, each on its own line.
 *
 * They were briefly presented as component lines of Intangible Assets on the
 * asset side. That inverted their sign and produced a negative intangible
 * asset, which is not a real construct — an intangible asset cannot be
 * negative, and neither account represents an intangible. Per BIS approval they
 * are back in equity, matching their ledger classification.
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
  ];
  const { groups, flagged, total } = build(lines, all, l => {
    const code = accountCodeOf(l);
    return code ? LIABILITY_ACCOUNT_MAP[code] ?? null : null;
  });
  const inList = (list: readonly string[], g: BsGroup) => list.includes(g.label);
  const marketplace = groups.filter(g => inList(MARKETPLACE_LIABILITY_CATEGORIES, g));
  const standalone = groups.filter(g => inList(STANDALONE_LIABILITY_CATEGORIES, g));
  return {
    marketplace,
    marketplaceTotal: marketplace.reduce((t, g) => t + g.value, 0),
    standalone,
    flagged,
    total,
  };
}

/* ── Landlord Float presentation split ─────────────────────────────────── */

export const LANDLORD_FLOAT_LABEL = 'Landlord Float';
export const LANDLORD_FLOAT_COMPANY_LABEL = 'Landlord Float — Company Managed';
export const LANDLORD_FLOAT_SELF_LABEL = 'Landlord Float — Self Managed';
export const LANDLORD_FLOAT_TOTAL_LABEL = 'Total Landlord Float';
export const LANDLORD_FLOAT_COMPANY_TOTAL_LABEL = 'Total Landlord Float — Company Managed';
export const LANDLORD_FLOAT_SELF_TOTAL_LABEL = 'Total Landlord Float — Self Managed';

/**
 * The landlord rent payable (L4) is the only account in the group that carries
 * a company/self split, so it appears as a line in both blocks. Naming it
 * explicitly is what lets each block's items foot to its own total — listing
 * only the partner/agent components would leave the company block short by this
 * amount.
 */
export const LANDLORD_RENT_PAYABLE_LABEL = 'Landlord Rent Payable';

export interface LandlordFloatSplit {
  total: number;
  self_managed: number;
  company_managed: number;
}

/**
 * The four partner/agent obligation accounts, presented as component lines
 * inside Landlord Float — Company Managed instead of under a section of their
 * own. Presentation only: the ledger accounts, balances, classifications and
 * posting logic are untouched, and each balance is still reported exactly once
 * because a line can only land in one group.
 *
 * Labels are the reporting names for these accounts; the catalog names them
 * "Partner Portfolios — Capital Held" (L2) and "Partner Returns / Rewards
 * Payable" (L3).
 */
export const LANDLORD_FLOAT_COMPONENT_ACCOUNTS: { code: string; label: string }[] = [
  { code: 'L2', label: 'Partner Portfolio Capital Held' },
  { code: 'L6', label: 'Partner Top-Ups Awaiting Application' },
  { code: 'L3', label: 'Partner Returns Payable' },
  { code: 'L5', label: 'Agent Commission Payable' },
];

/** A marketplace row for rendering: a normal group, or a subtotal line. */
export type MarketplaceRow = BsGroup & {
  subtotal?: boolean;
  /**
   * A parent/sub-heading that names the block below it. Its own amount is not
   * printed — the block's own total line carries the figure, so no balance is
   * shown twice.
   */
  heading?: boolean;
  /** Nesting depth for indentation: 0 = top level, 1 = nested block. */
  depth?: number;
  /** Indented component lines printed under this row. */
  components?: PositionLine[];
};

/**
 * Presentation only: shows the existing Landlord Float as Company Managed vs
 * Self Managed (per the landlord record's own management flag) followed by a
 * Total Landlord Float subtotal.
 *
 * The reported Landlord Float value is never changed — the self-managed share
 * measured on the ledger is applied proportionally to it and the company figure
 * is the residual, so the two lines always foot to the existing total exactly.
 * With no split available the original single line is returned untouched.
 *
 * The partner/agent obligation accounts (see LANDLORD_FLOAT_COMPONENT_ACCOUNTS)
 * are company-managed by definition, so they attach whole to the company line
 * and are excluded from the self-managed proportion — applying a landlord
 * management ratio to partner capital would allocate it to landlords who do not
 * hold it. Company + Self still foot to the group total exactly.
 */
export function expandLandlordFloat(
  marketplace: BsGroup[],
  split: LandlordFloatSplit | null | undefined,
): MarketplaceRow[] {
  const componentCodes = new Set(LANDLORD_FLOAT_COMPONENT_ACCOUNTS.map(c => c.code));

  return marketplace.flatMap((g): MarketplaceRow[] => {
    if (g.label !== LANDLORD_FLOAT_LABEL) return [g];

    const isComponent = (l: PositionLine) => {
      const code = accountCodeOf(l);
      return code !== null && componentCodes.has(code);
    };
    const componentLines = g.lines.filter(isComponent);
    const floatLines = g.lines.filter(l => !isComponent(l));

    // Only the landlord payable itself carries a company/self split; the
    // component accounts sit wholly on the company side.
    const componentTotal = componentLines.reduce((t, l) => t + l.value, 0);
    const floatValue = g.value - componentTotal;
    const share = split && split.total !== 0 ? split.self_managed / split.total : 0;
    const self = Math.round(floatValue * share);
    const company = g.value - self;

    // Presentation: each managed block shows its own amount only — no component
    // breakdown and no per-block subtotal — followed by the overall total.
    return [
      { label: LANDLORD_FLOAT_LABEL, value: g.value, lines: [], heading: true, depth: 0 },
      {
        ...g,
        label: LANDLORD_FLOAT_COMPANY_LABEL,
        value: company,
        lines: [...floatLines, ...componentLines],
        depth: 1,
      },
      {
        ...g,
        label: LANDLORD_FLOAT_SELF_LABEL,
        value: self,
        lines: [],
        depth: 1,
      },
      { label: LANDLORD_FLOAT_TOTAL_LABEL, value: g.value, lines: [], subtotal: true, depth: 0 },
    ];
  });
}

        value: self,
        lines: [],
        subtotal: true,
        depth: 1,
      },
      { label: LANDLORD_FLOAT_TOTAL_LABEL, value: g.value, lines: [], subtotal: true, depth: 0 },
    ];
  });
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



