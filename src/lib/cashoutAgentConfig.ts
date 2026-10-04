/**
 * Cash-Out (merchant) Agent permission matrix.
 *
 * The CFO configures, per Cash-Out Agent, not just HOW they pay (channels) but
 * WHAT categories of payouts they may process, WHICH approval workflow applies,
 * HOW MUCH they can move, and WHAT security controls are enforced.
 *
 * The whole matrix is persisted in `cashout_agents.config` (jsonb). The legacy
 * boolean columns (`handles_cash/bank/mtn/airtel`) are kept in sync from
 * `channels`/`networks` so existing routing & filters keep working.
 */

export type ApprovalRule =
  | 'none'
  | 'finance'
  | 'finance_cfo'
  | 'cfo_only'
  | 'operations_cfo'
  | 'credit_committee';

export const APPROVAL_RULES: { value: ApprovalRule; label: string }[] = [
  { value: 'none', label: 'No approval' },
  { value: 'finance', label: 'Finance Approval' },
  { value: 'finance_cfo', label: 'Finance + CFO' },
  { value: 'cfo_only', label: 'CFO Only' },
  { value: 'operations_cfo', label: 'Operations + CFO' },
  { value: 'credit_committee', label: 'Credit Committee' },
];

export type AgentStatus = 'active' | 'suspended' | 'blocked' | 'under_review' | 'on_leave';

export const AGENT_STATUSES: { value: AgentStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'under_review', label: 'Under Review' },
  { value: 'on_leave', label: 'On Leave' },
];

/** Authorized payout categories, grouped for the UI. */
export interface PayoutCategory {
  id: string;
  label: string;
  hint?: string;
  /** default approval rule when the category is first enabled */
  defaultApproval: ApprovalRule;
}

export interface PayoutCategoryGroup {
  group: string;
  items: PayoutCategory[];
}

export const PAYOUT_CATEGORY_GROUPS: PayoutCategoryGroup[] = [
  {
    group: 'Customer Withdrawals',
    items: [
      { id: 'wallet_withdrawals', label: 'Wallet Withdrawals', hint: 'Users withdrawing money from their wallets.', defaultApproval: 'finance' },
    ],
  },
  {
    group: 'Merchant Settlements',
    items: [
      { id: 'merchant_settlement', label: 'Merchant Settlement', hint: 'Reimburse cash-out merchants after they pay customers.', defaultApproval: 'finance_cfo' },
    ],
  },
  {
    group: 'Proxy Partner Withdrawals',
    items: [
      { id: 'proxy_partner_withdrawal', label: 'Partner Withdrawal (Proxy Initiated)', hint: 'All partner payouts — ROI, capital, profit share — initiated by a Proxy Agent. This is the single unified partner payout channel.', defaultApproval: 'finance_cfo' },
    ],
  },
  {
    group: 'Rent Disbursements',
    items: [
      { id: 'landlord_payouts', label: 'Landlord Payouts', hint: 'Monthly landlord rent disbursements.', defaultApproval: 'operations_cfo' },
    ],
  },
  {
    group: 'Welile Homes Payouts',
    items: [
      { id: 'welile_homes_settlement', label: 'Welile Homes Settlement', hint: 'Property-related landlord payouts.', defaultApproval: 'operations_cfo' },
    ],
  },
  {
    group: 'Agent Commissions',
    items: [
      { id: 'cashout_commission', label: 'Cash-Out Commission', defaultApproval: 'none' },
      { id: 'rent_collection_commission', label: 'Rent Collection Commission', defaultApproval: 'none' },
      { id: 'partner_commission', label: 'Partner Commission', defaultApproval: 'none' },
    ],
  },
  {
    group: 'Rewards & Bonuses',
    items: [
      { id: 'referral_bonuses', label: 'Referral Bonuses', defaultApproval: 'none' },
      { id: 'recruiter_bonuses', label: 'Recruiter Bonuses', defaultApproval: 'none' },
      { id: 'tenant_placement_bonuses', label: 'Tenant Placement Bonuses', defaultApproval: 'none' },
      { id: 'listing_bonuses', label: 'Listing Bonuses', defaultApproval: 'none' },
      { id: 'verification_bonuses', label: 'Verification Bonuses', defaultApproval: 'none' },
    ],
  },
  {
    group: 'Credit & Advances',
    items: [
      { id: 'business_advances', label: 'Business Advances', defaultApproval: 'credit_committee' },
      { id: 'credit_access', label: 'Credit Access', defaultApproval: 'credit_committee' },
      { id: 'agent_advance', label: 'Agent Advance', defaultApproval: 'cfo_only' },
    ],
  },
  {
    group: 'Payroll',
    items: [
      { id: 'payroll_payments', label: 'Payroll Payments', hint: 'Employee salary processing.', defaultApproval: 'cfo_only' },
    ],
  },
  {
    group: 'Internal Finance',
    items: [
      { id: 'cfo_direct_credit', label: 'CFO Direct Credit', defaultApproval: 'cfo_only' },
      { id: 'internal_wallet_transfers', label: 'Internal Wallet Transfers', defaultApproval: 'cfo_only' },
      { id: 'float_transfers', label: 'Float Transfers', defaultApproval: 'cfo_only' },
    ],
  },
  {
    group: 'Scheduled Payments',
    items: [
      { id: 'scheduled_payouts', label: 'Scheduled Payouts', defaultApproval: 'finance' },
      { id: 'auto_recoveries', label: 'Auto Recoveries', defaultApproval: 'none' },
      { id: 'bulk_bank_settlements', label: 'Bulk Bank Settlements', defaultApproval: 'finance_cfo' },
    ],
  },
];

export const ALL_PAYOUT_CATEGORIES: PayoutCategory[] = PAYOUT_CATEGORY_GROUPS.flatMap((g) => g.items);

/**
 * Canonical Uganda commercial banks used for merchant payout assignment.
 * `patterns` are lowercase substrings matched against a normalized bank name
 * (non-letters collapsed to single spaces), most specific first.
 */
export const SUPPORTED_BANKS: { id: string; label: string; patterns: string[] }[] = [
  { id: 'absa', label: 'Absa Bank Uganda', patterns: ['absa'] },
  { id: 'bank_of_africa', label: 'Bank of Africa Uganda', patterns: ['bank of africa', 'boa uganda'] },
  { id: 'baroda', label: 'Bank of Baroda Uganda', patterns: ['baroda'] },
  { id: 'bank_of_india', label: 'Bank of India (Uganda)', patterns: ['bank of india'] },
  { id: 'cairo', label: 'Cairo Bank Uganda', patterns: ['cairo'] },
  { id: 'centenary', label: 'Centenary Bank', patterns: ['centenary', 'centinary'] },
  { id: 'citibank', label: 'Citibank Uganda', patterns: ['citibank', 'citi bank'] },
  { id: 'dfcu', label: 'DFCU Bank', patterns: ['dfcu'] },
  { id: 'dtb', label: 'Diamond Trust Bank (DTB)', patterns: ['diamond trust', 'dtb'] },
  { id: 'ecobank', label: 'Ecobank Uganda', patterns: ['ecobank', 'eco bank'] },
  { id: 'equity', label: 'Equity Bank Uganda', patterns: ['equity'] },
  { id: 'exim', label: 'Exim Bank Uganda', patterns: ['exim'] },
  { id: 'housing_finance', label: 'Housing Finance Bank', patterns: ['housing finance', 'housingfinance'] },
  { id: 'im_bank', label: 'I&M Bank (Uganda)', patterns: ['i m bank', 'i and m bank', 'im bank'] },
  { id: 'kcb', label: 'KCB Bank Uganda', patterns: ['kcb', 'kenya commercial bank'] },
  { id: 'ncba', label: 'NCBA Bank Uganda', patterns: ['ncba', 'nc bank'] },
  { id: 'pearl', label: 'Pearl Bank Uganda', patterns: ['pearl'] },
  { id: 'salaam', label: 'Salaam Bank Uganda', patterns: ['salaam'] },
  { id: 'stanbic', label: 'Stanbic Bank Uganda', patterns: ['stanbic'] },
  { id: 'stanchart', label: 'Standard Chartered Bank Uganda', patterns: ['standard chartered', 'stanchart', 'scb'] },
  { id: 'tropical', label: 'Tropical Bank', patterns: ['tropical'] },
  { id: 'uba', label: 'United Bank for Africa (UBA)', patterns: ['united bank for africa', 'uba'] },
  // Legacy id kept so existing merchant assignments keep resolving.
  { id: 'postbank', label: 'PostBank Uganda', patterns: ['postbank', 'post bank'] },
];

// ===========================================================================
// Provider-level payout routing
// ---------------------------------------------------------------------------
// A merchant is only eligible for a withdrawal when BOTH the parent channel
// (momo / bank / cash) AND the specific provider (MTN / Airtel, or the exact
// bank) are enabled on their permission matrix. `bank_name` is free text in
// the wild ("EQUITY BANK", "equity bank", "Equity Bank Uganda"), so it is
// normalized to a SUPPORTED_BANKS id before the check.
// ===========================================================================

/** Normalize a free-text bank name to a SUPPORTED_BANKS id, or null if unknown. */
export function normalizeBankId(raw: unknown): string | null {
  const s = String(raw ?? '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  if (!s) return null;
  for (const b of SUPPORTED_BANKS) {
    if (b.patterns.some((p) => s.includes(p))) return b.id;
  }
  return null;
}

export type PayoutChannel = 'momo' | 'bank' | 'cash';

export interface PayoutRoute {
  channel: PayoutChannel;
  /** 'mtn' | 'airtel' for momo, a SUPPORTED_BANKS id for bank, null when unknown */
  provider: string | null;
}

/** Resolve the channel + specific provider of a withdrawal_requests row. */
export function getWithdrawalPayoutRoute(w: any): PayoutRoute {
  const method = String(w?.payout_method ?? '').toLowerCase();
  if (method === 'bank_transfer' || method === 'bank') {
    return { channel: 'bank', provider: normalizeBankId(w?.bank_name) };
  }
  if (method === 'cash') return { channel: 'cash', provider: null };
  const prov = String(w?.mobile_money_provider ?? '').toLowerCase();
  return {
    channel: 'momo',
    provider: prov.includes('mtn') ? 'mtn' : prov.includes('airtel') ? 'airtel' : null,
  };
}

/**
 * Channel + provider gate. Returns false when the merchant is not assigned the
 * exact provider/bank of the withdrawal, even if the parent channel is on.
 * Unknown providers (bank names outside SUPPORTED_BANKS, missing momo network)
 * fall back to the parent channel flag so those payouts are never stranded.
 */
export function isWithdrawalChannelAuthorized(config: CashoutAgentConfig | null, withdrawal: any): boolean {
  if (!config) return true; // matrix not loaded yet — don't block
  const { channel, provider } = getWithdrawalPayoutRoute(withdrawal);
  if (!config.channels[channel]) return false;
  if (!provider) return true; // channel enabled, provider unknown
  if (channel === 'momo') return !!config.networks[provider as 'mtn' | 'airtel'];
  if (channel === 'bank') return !!config.banks[provider];
  return true;
}

/** Full eligibility: category matrix AND channel/provider assignment. */
export function isWithdrawalRoutableToMerchant(config: CashoutAgentConfig | null, withdrawal: any): boolean {
  return isWithdrawalCategoryAuthorized(config, withdrawal) && isWithdrawalChannelAuthorized(config, withdrawal);
}

const BANK_MATCH_PATTERNS: Record<string, string[]> = Object.fromEntries(
  SUPPORTED_BANKS.map((b) => [b.id, b.patterns]),
);

const ALL_BANK_PATTERNS = Object.values(BANK_MATCH_PATTERNS).flat();

/**
 * Build a PostgREST `.or()` clause restricting withdrawal_requests to the exact
 * channels AND providers/banks assigned to this merchant. Returns null when no
 * restriction is needed (everything enabled, or matrix not loaded).
 */
export function buildChannelProviderOrClause(config: CashoutAgentConfig | null): string | null {
  if (!config) return null;
  const { channels, networks, banks } = config;
  const allBanksOn = SUPPORTED_BANKS.every((b) => !!banks[b.id]);
  if (channels.momo && channels.bank && channels.cash && networks.mtn && networks.airtel && allBanksOn) {
    return null;
  }

  const parts: string[] = [];

  if (channels.momo) {
    const momoBase = 'or(payout_method.eq.mobile_money,payout_method.is.null,payout_method.ilike.*momo*,payout_method.ilike.*mobile*)';
    if (networks.mtn && networks.airtel) {
      parts.push(`and(${momoBase})`);
    } else {
      if (networks.mtn) parts.push(`and(${momoBase},mobile_money_provider.ilike.*mtn*)`);
      if (networks.airtel) parts.push(`and(${momoBase},mobile_money_provider.ilike.*airtel*)`);
      // Momo rows with no provider recorded still route on the channel flag.
      parts.push(`and(${momoBase},mobile_money_provider.is.null)`);
    }
  }

  if (channels.bank) {
    const bankBase = 'payout_method.ilike.*bank*';
    for (const b of SUPPORTED_BANKS) {
      if (!banks[b.id]) continue;
      const pats = BANK_MATCH_PATTERNS[b.id] || [b.id];
      parts.push(`and(${bankBase},or(${pats.map((p) => `bank_name.ilike.*${p}*`).join(',')}))`);
    }
    // Banks outside the supported list are not provider-gated — keep them
    // routable to any bank-enabled merchant so they are never stranded.
    const negations = ALL_BANK_PATTERNS.map((p) => `bank_name.not.ilike.*${p}*`).join(',');
    parts.push(`and(${bankBase},or(bank_name.is.null,and(${negations})))`);
  }

  if (channels.cash) {
    parts.push('and(or(payout_method.ilike.*cash*,payout_method.ilike.*pickup*))');
  }

  if (parts.length === 0) return 'id.eq.00000000-0000-0000-0000-000000000000';
  return parts.join(',');
}

export interface CashoutAgentConfig {
  channels: { momo: boolean; bank: boolean; cash: boolean };
  networks: { mtn: boolean; airtel: boolean };
  banks: Record<string, boolean>;
  categories: Record<string, boolean>;
  approvals: Record<string, ApprovalRule>;
  float: {
    request: boolean;
    receive: boolean;
    distribute: boolean;
    emergency: boolean;
    max: number | null;
  };
  limits: {
    daily: number | null;
    single: number | null;
    monthly: number | null;
    maxCashout: number | null;
    minCashout: number | null;
  };
  security: {
    otp: boolean;
    twoFactor: boolean;
    deviceRestriction: boolean;
    highValueVerification: boolean;
  };
  status: AgentStatus;
  ops: {
    region: string;
    district: string;
    branch: string;
    cluster: string;
    supervisor: string;
    team: string;
  };
}

export function defaultCashoutAgentConfig(): CashoutAgentConfig {
  const categories: Record<string, boolean> = {};
  const approvals: Record<string, ApprovalRule> = {};
  for (const c of ALL_PAYOUT_CATEGORIES) {
    // No implicit access. Every payout category must be explicitly allocated to
    // the merchant by the CFO — a merchant only sees the withdrawal
    // transactions for the categories mapped to them.
    categories[c.id] = false;
    approvals[c.id] = c.defaultApproval;
  }
  const banks: Record<string, boolean> = {};
  for (const b of SUPPORTED_BANKS) banks[b.id] = false;
  return {
    channels: { momo: true, bank: true, cash: true },
    networks: { mtn: true, airtel: true },
    banks,
    categories,
    approvals,
    float: { request: false, receive: false, distribute: false, emergency: false, max: null },
    limits: { daily: null, single: null, monthly: null, maxCashout: null, minCashout: null },
    security: { otp: true, twoFactor: false, deviceRestriction: false, highValueVerification: false },
    status: 'active',
    ops: { region: '', district: '', branch: '', cluster: '', supervisor: '', team: '' },
  };
}

/** Merge a persisted config (possibly partial / legacy) with the full default shape. */
export function normalizeCashoutAgentConfig(
  raw: unknown,
  legacy?: { handles_cash?: boolean; handles_bank?: boolean; handles_mtn?: boolean; handles_airtel?: boolean; label?: string | null },
): CashoutAgentConfig {
  const def = defaultCashoutAgentConfig();
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<CashoutAgentConfig>;

  const merged: CashoutAgentConfig = {
    channels: { ...def.channels, ...(r.channels || {}) },
    networks: { ...def.networks, ...(r.networks || {}) },
    banks: { ...def.banks, ...(r.banks || {}) },
    categories: { ...def.categories, ...(r.categories || {}) },
    approvals: { ...def.approvals, ...(r.approvals || {}) },
    float: { ...def.float, ...(r.float || {}) },
    limits: { ...def.limits, ...(r.limits || {}) },
    security: { ...def.security, ...(r.security || {}) },
    status: (r.status as AgentStatus) || def.status,
    ops: { ...def.ops, ...(r.ops || {}) },
  };

  // If no config was ever saved, seed channels/networks from legacy boolean columns.
  if (!raw || Object.keys(raw as object).length === 0) {
    if (legacy) {
      merged.channels = {
        momo: !!(legacy.handles_mtn || legacy.handles_airtel),
        bank: !!legacy.handles_bank,
        cash: !!legacy.handles_cash,
      };
      merged.networks = { mtn: !!legacy.handles_mtn, airtel: !!legacy.handles_airtel };
    }
    // Legacy fallback: pre-matrix merchants must not be silently denied every
    // queue category (that hides ALL withdrawals from them). Seed full category
    // access — the CFO can tighten this in the permission matrix.
    for (const c of ALL_PAYOUT_CATEGORIES) merged.categories[c.id] = true;
  }
  return merged;
}

// ===========================================================================
// Mapping payout categories → the merchant withdrawal claim queue
// ---------------------------------------------------------------------------
// The CFO authorizes each Cash-Out Agent for specific payout categories. The
// merchant claim queue reads from `withdrawal_requests`, so we translate a
// withdrawal row into one of the config categories (using its `reason`) and
// only surface / allow claiming of the categories the agent is authorized for.
//
// A single queue "category" can map to several config category ids (e.g. the
// Agent Commissions group). `configIds` lists every config id that authorizes
// the queue category; `orPredicates` are the PostgREST predicates that select
// rows of that category server-side.
// ===========================================================================

export interface QueueCategoryDef {
  /** stable queue-category id (not necessarily a config id) */
  id: string;
  label: string;
  /** config category ids that authorize this queue category */
  configIds: string[];
  /** true if a withdrawal_requests row belongs to this category (client-side) */
  match: (w: any) => boolean;
  /** PostgREST predicate fragments that positively select this category */
  orPredicates: string[];
  /** PostgREST predicate fragments that EXCLUDE this category (for the catch-all) */
  notPredicates: string[];
}

const reasonOf = (w: any) => String(w?.reason || '').toLowerCase();

// Ordered, most-specific first. `wallet_withdrawals` is the catch-all.
export const QUEUE_CATEGORY_DEFS: QueueCategoryDef[] = [
  {
    id: 'proxy_partner_withdrawal',
    label: 'Partner Withdrawal (Proxy Initiated)',
    configIds: ['proxy_partner_withdrawal'],
    // Any partner payout — proxy-initiated wallet withdrawal OR legacy ROI/returns
    // rows that predate the unified flow — belongs to this single queue.
    match: (w) => {
      const r = reasonOf(w);
      return r.includes('proxy') || r.includes('roi') || r.includes('return');
    },
    orPredicates: ['reason.ilike.*proxy*', 'reason.ilike.*roi*', 'reason.ilike.*return*'],
    notPredicates: ['reason.not.ilike.*proxy*', 'reason.not.ilike.*roi*', 'reason.not.ilike.*return*'],
  },
  {
    id: 'landlord_payouts',
    label: 'Landlord Payouts',
    configIds: ['landlord_payouts'],
    match: (w) => reasonOf(w).startsWith('landlord float payout'),
    orPredicates: ['reason.ilike.Landlord float payout*'],
    notPredicates: ['reason.not.ilike.Landlord float payout*'],
  },
  {
    id: 'payroll_payments',
    label: 'Payroll Payments',
    configIds: ['payroll_payments'],
    match: (w) => /salary|payroll/.test(reasonOf(w)),
    orPredicates: ['reason.ilike.*salary*', 'reason.ilike.*payroll*'],
    notPredicates: ['reason.not.ilike.*salary*', 'reason.not.ilike.*payroll*'],
  },
  {
    id: 'agent_commissions',
    label: 'Agent Commissions',
    configIds: ['cashout_commission', 'rent_collection_commission', 'partner_commission'],
    match: (w) => reasonOf(w).includes('commission'),
    orPredicates: ['reason.ilike.*commission*'],
    notPredicates: ['reason.not.ilike.*commission*'],
  },
  {
    id: 'wallet_withdrawals',
    label: 'Wallet Withdrawals',
    configIds: ['wallet_withdrawals'],
    match: () => true, // catch-all — any withdrawal that isn't one of the above
    orPredicates: [], // handled specially (negation of every special category)
    notPredicates: [],
  },
];

const SPECIAL_QUEUE_DEFS = QUEUE_CATEGORY_DEFS.filter((d) => d.id !== 'wallet_withdrawals');
const WALLET_QUEUE_DEF = QUEUE_CATEGORY_DEFS.find((d) => d.id === 'wallet_withdrawals')!;

/** Resolve which queue category a withdrawal_requests row belongs to. */
export function getWithdrawalQueueCategory(withdrawal: any): QueueCategoryDef {
  return QUEUE_CATEGORY_DEFS.find((d) => d.match(withdrawal)) || WALLET_QUEUE_DEF;
}

/** Is any config id backing this queue category enabled? */
function isQueueCategoryAuthorized(config: CashoutAgentConfig, def: QueueCategoryDef): boolean {
  return def.configIds.some((id) => !!config.categories[id]);
}

/** Client-side gate: may this agent claim/see this specific withdrawal? */
export function isWithdrawalCategoryAuthorized(config: CashoutAgentConfig | null, withdrawal: any): boolean {
  if (!config) return true; // no matrix loaded yet — don't block
  const def = getWithdrawalQueueCategory(withdrawal);
  return isQueueCategoryAuthorized(config, def);
}

/** Human-readable labels of the queue categories this agent may process. */
export function authorizedQueueCategoryLabels(config: CashoutAgentConfig | null): string[] {
  if (!config) return [];
  return QUEUE_CATEGORY_DEFS.filter((d) => isQueueCategoryAuthorized(config, d)).map((d) => d.label);
}

/**
 * Build a single PostgREST `.or()` clause that restricts a withdrawal_requests
 * query to ONLY the categories this agent is authorized to process.
 * Returns `null` when the agent is authorized for every queue category (no
 * filtering needed) so we avoid an unnecessary predicate.
 */
export function buildQueueCategoryOrClause(config: CashoutAgentConfig | null): string | null {
  if (!config) return null;
  const authorized = QUEUE_CATEGORY_DEFS.filter((d) => isQueueCategoryAuthorized(config, d));
  if (authorized.length === QUEUE_CATEGORY_DEFS.length) return null; // all allowed

  const parts: string[] = [];
  for (const def of authorized) {
    if (def.id === 'wallet_withdrawals') continue; // handled below
    parts.push(...def.orPredicates);
  }

  if (isQueueCategoryAuthorized(config, WALLET_QUEUE_DEF)) {
    // Catch-all: rows with no reason, or a reason that matches none of the
    // special categories.
    const negations = SPECIAL_QUEUE_DEFS.flatMap((d) => d.notPredicates);
    parts.push('reason.is.null');
    parts.push(`and(${negations.join(',')})`);
  }

  if (parts.length === 0) {
    // Authorized for nothing that maps to the queue — match no rows.
    return 'id.eq.00000000-0000-0000-0000-000000000000';
  }
  return parts.join(',');
}

// ===========================================================================
// Withdrawal reason presets (user-facing)
// ---------------------------------------------------------------------------
// When a user initiates a withdrawal they pick a reason. The stored reason
// string is what maps the resulting withdrawal_requests row to a payout
// category (see getWithdrawalQueueCategory) so it reaches a Cash-Out Agent
// authorized for that category. Keep the `value` strings' keywords aligned
// with QUEUE_CATEGORY_DEFS.match().
// ===========================================================================

export interface WithdrawalReasonOption {
  /** stored into withdrawal_requests.reason */
  value: string;
  label: string;
  /** the queue category this reason maps to (for reference) */
  queueCategory: string;
}

export const OTHER_WITHDRAWAL_REASON = '__other__';

export const WITHDRAWAL_REASON_OPTIONS: WithdrawalReasonOption[] = [
  { value: 'Wallet withdrawal', label: 'Personal / wallet withdrawal', queueCategory: 'wallet_withdrawals' },
  { value: 'Commission payout', label: 'Commission earnings', queueCategory: 'agent_commissions' },
  { value: 'Salary / payroll payout', label: 'Salary / payroll', queueCategory: 'payroll_payments' },
];
