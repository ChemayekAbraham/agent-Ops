import { supabase } from '@/integrations/supabase/client';

/**
 * Fetch ALL agent IDs, paginating past the 1000-row default limit.
 */
export async function fetchAllAgentIds(): Promise<string[]> {
  return fetchAllUserIdsByRole('agent');
}

/**
 * Fetch ALL user IDs with a given role, paginating past the 1000-row default limit.
 */
export async function fetchAllUserIdsByRole(role: 'agent' | 'ceo' | 'cfo' | 'cmo' | 'coo' | 'crm' | 'cto' | 'employee' | 'landlord' | 'manager' | 'operations' | 'super_admin' | 'supporter' | 'tenant'): Promise<string[]> {
  const allIds: string[] = [];
  const PAGE_SIZE = 1000;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data } = await supabase
      .from('user_roles')
      .select('user_id')
      .eq('role', role)
      .eq('enabled', true)
      .range(offset, offset + PAGE_SIZE - 1);

    if (data && data.length > 0) {
      allIds.push(...data.map(r => r.user_id));
      offset += PAGE_SIZE;
      hasMore = data.length === PAGE_SIZE;
    } else {
      hasMore = false;
    }
  }

  return allIds;
}

/**
 * Fetch user IDs that hold ONLY the `supporter` role (no other enabled roles).
 * Used by Partner Ops + COO partner dashboards so the supporter list excludes
 * staff/agents/managers who happen to have a supporter role attached.
 */
let _supporterOnlyIdsCache: { ids: string[]; ts: number } | null = null;
const SUPPORTER_ONLY_TTL = 5 * 60 * 1000;
export async function fetchSupporterOnlyUserIds(): Promise<string[]> {
  if (_supporterOnlyIdsCache && Date.now() - _supporterOnlyIdsCache.ts < SUPPORTER_ONLY_TTL) {
    return _supporterOnlyIdsCache.ids;
  }
  // Pull all enabled role rows (paginated) and compute users whose ONLY role is supporter.
  const PAGE_SIZE = 1000;
  let offset = 0;
  let hasMore = true;
  const roleMap = new Map<string, Set<string>>();
  while (hasMore) {
    const { data } = await supabase
      .from('user_roles')
      .select('user_id, role')
      .eq('enabled', true)
      .range(offset, offset + PAGE_SIZE - 1);
    if (data && data.length > 0) {
      data.forEach((r: any) => {
        if (!roleMap.has(r.user_id)) roleMap.set(r.user_id, new Set());
        roleMap.get(r.user_id)!.add(r.role);
      });
      offset += PAGE_SIZE;
      hasMore = data.length === PAGE_SIZE;
    } else {
      hasMore = false;
    }
  }
  const ids: string[] = [];
  roleMap.forEach((roles, userId) => {
    if (roles.size === 1 && roles.has('supporter')) ids.push(userId);
  });
  _supporterOnlyIdsCache = { ids, ts: Date.now() };
  return ids;
}

/**
 * Batch IN queries to avoid URL length overflow (PostgREST 400).
 * Calls `fn` with chunks of IDs and merges results.
 */
export async function batchedQuery<T>(
  ids: string[],
  fn: (batch: string[]) => PromiseLike<{ data: T[] | null }>,
  batchSize = 50
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const { data } = await fn(ids.slice(i, i + batchSize));
    if (data) results.push(...data);
  }
  return results;
}

/**
 * Fetch ALL partner/funder IDs — supporters that own at least one portfolio
 * (as `investor_id` OR `agent_id` in `investor_portfolios`, any status).
 * Cached per session to avoid repeated full scans.
 */
let _partnerIdsCache: { ids: string[]; ts: number } | null = null;
const PARTNER_IDS_TTL = 5 * 60 * 1000; // 5 min
export async function fetchAllPartnerIds(): Promise<string[]> {
  if (_partnerIdsCache && Date.now() - _partnerIdsCache.ts < PARTNER_IDS_TTL) {
    return _partnerIdsCache.ids;
  }
  // Partner = ANY user with ≥1 row in investor_portfolios, regardless of role.
  // Page through every portfolio (no role intersection, no status filter).
  const PAGE = 1000;
  let offset = 0;
  let hasMore = true;
  const ownerIds = new Set<string>();
  while (hasMore) {
    const { data } = await supabase
      .from('investor_portfolios')
      .select('investor_id')
      .range(offset, offset + PAGE - 1);
    if (data && data.length > 0) {
      data.forEach((p: any) => { if (p.investor_id) ownerIds.add(p.investor_id); });
      offset += PAGE;
      hasMore = data.length === PAGE;
    } else {
      hasMore = false;
    }
  }
  const ids = Array.from(ownerIds);
  _partnerIdsCache = { ids, ts: Date.now() };
  return ids;
}

/**
 * Fetch a paginated page of supporter IDs + total count.
 * Optionally filter by name/phone/email search term (joins profiles).
 *
 * NOTE: "Supporter" here means partner/funder — a supporter that owns at
 * least one portfolio. Plain supporters with zero portfolios are excluded
 * so the Partner Management table (and all its filters) only operate on
 * the partner set.
 */
export async function fetchPaginatedSupporterIds(
  page: number,
  pageSize: number,
  search?: string
): Promise<{ ids: string[]; totalCount: number }> {
  const partnerIds = await fetchAllPartnerIds();
  if (partnerIds.length === 0) return { ids: [], totalCount: 0 };
  const partnerSet = new Set(partnerIds);

  // If searching, do a single broad profile search then intersect with supporter set in memory.
  // This avoids N batched .in() round-trips against profiles (the previous slow path).
  if (search && search.trim().length > 0) {
    const raw = search.trim();
    const q = raw.replace(/[%,]/g, ''); // sanitize PostgREST wildcards/separators
    if (!q) return { ids: [], totalCount: 0 };

    // Use the indexed `search_users_fast` RPC (name-prefix + trigram, phone
    // last-9, email prefix, national-id, UUID). Falls back to a broad ilike
    // scan if the RPC returns nothing (e.g. very short/edge queries) so we
    // never miss a matching partner.
    let allMatched: string[] = [];
    if (q.length >= 3) {
      const { data: rpcMatches } = await supabase.rpc('search_users_fast', {
        p_query: q,
        p_limit: 50,
      });
      allMatched = (rpcMatches || []).map((p: any) => p.id as string);
    }
    if (allMatched.length === 0) {
      const { data: matches } = await supabase
        .from('profiles')
        .select('id')
        .or(`full_name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%`)
        .limit(2000);
      allMatched = (matches || []).map((p: any) => p.id as string);
    }

    // Surface BOTH existing partners and any other user who matches (e.g. a
    // verified depositor with wallet money but no portfolio yet). This lets
    // Partnership Ops find and invest/top-up from any user's wallet, not just
    // people who already own a portfolio. Existing partners are ordered first.
    const partnerMatches = allMatched.filter(id => partnerSet.has(id));
    const prospectMatches = allMatched.filter(id => !partnerSet.has(id));
    const matchedIds = [...partnerMatches, ...prospectMatches];
    const start = page * pageSize;
    return {
      ids: matchedIds.slice(start, start + pageSize),
      totalCount: matchedIds.length,
    };
  }

  // No search: paginate over the in-memory partner ID list (already filtered to ≥1 portfolio)
  const start = page * pageSize;
  return {
    ids: partnerIds.slice(start, start + pageSize),
    totalCount: partnerIds.length,
  };
}

/**
 * Fetch a paginated page of VERIFIED, WALLET-FUNDED PROSPECT IDs + total count.
 *
 * A "prospect" = a user who is verified and has a positive wallet balance but
 * does NOT yet own any portfolio. These are people Partnership Ops can invest /
 * top-up from their wallet, even though they have never funded a deal before.
 * Optionally narrowed by a name/phone/email search term.
 */
export async function fetchVerifiedFundedProspectIds(
  page: number,
  pageSize: number,
  search?: string
): Promise<{ ids: string[]; totalCount: number }> {
  const partnerIds = await fetchAllPartnerIds();
  const partnerSet = new Set(partnerIds);

  // 1) All wallets currently holding money (funded). Paginate defensively.
  const PAGE = 1000;
  let offset = 0;
  let hasMore = true;
  const fundedIds = new Set<string>();
  while (hasMore) {
    const { data } = await supabase
      .from('wallets')
      .select('user_id, balance')
      .gt('balance', 0)
      .range(offset, offset + PAGE - 1);
    if (data && data.length > 0) {
      data.forEach((w: any) => { if (w.user_id) fundedIds.add(w.user_id); });
      offset += PAGE;
      hasMore = data.length === PAGE;
    } else {
      hasMore = false;
    }
  }

  // Funded AND not already a partner — the prospect candidate pool.
  const candidateIds = Array.from(fundedIds).filter(id => !partnerSet.has(id));
  if (candidateIds.length === 0) return { ids: [], totalCount: 0 };

  // 2) Keep only VERIFIED candidates (optionally matching the search term).
  const raw = (search || '').trim();
  const q = raw.replace(/[%,]/g, ''); // sanitize PostgREST wildcards/separators
  const verifiedIds: string[] = [];
  for (let i = 0; i < candidateIds.length; i += 100) {
    const batch = candidateIds.slice(i, i + 100);
    let query = supabase
      .from('profiles')
      .select('id')
      .in('id', batch)
      .eq('verified', true);
    if (q) query = query.or(`full_name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%`);
    const { data } = await query;
    (data || []).forEach((p: any) => { if (p.id) verifiedIds.push(p.id as string); });
  }

  const start = page * pageSize;
  return {
    ids: verifiedIds.slice(start, start + pageSize),
    totalCount: verifiedIds.length,
  };
}

/**
 * Fetch ALL active portfolios with their owner profiles for nearing payout computation.
 * This runs independently of the paginated table view.
 */
export async function fetchAllNearingPayoutPortfolios(): Promise<{
  portfolios: Array<{
    id: string;
    investor_id: string | null;
    agent_id: string;
    investment_amount: number;
    roi_percentage: number;
    payout_day: number;
    roi_mode: string;
    status: string;
    created_at: string;
    next_roi_date: string | null;
    account_name: string | null;
    portfolio_code: string;
    duration_months: number;
    payment_method?: 'mobile_money' | 'bank_transfer' | 'cash' | null;
    mobile_network?: string | null;
    mobile_money_number?: string | null;
    bank_name?: string | null;
    bank_account_name?: string | null;
    account_number?: string | null;
  }>;
  profileMap: Map<string, { full_name: string; phone: string; email: string }>;
  supporterIds: Set<string>;
}> {
  // Fetch ALL active portfolios across the platform (paginated). The Nearing Payout
  // count must reflect operational reality — every portfolio whose Next Payout Date
  // is today must show up, regardless of whether the owner is a "supporter-only"
  // user, an agent acting as a proxy supporter, or a partner. Filtering by role
  // here historically hid 8/11 portfolios due today on 2026-05-12.
  const PAGE = 1000;
  let offset = 0;
  let hasMore = true;
  const portfolios: any[] = [];
  while (hasMore) {
    const { data, error } = await supabase
      .from('investor_portfolios')
      .select('id, investor_id, agent_id, investment_amount, roi_percentage, payout_day, roi_mode, status, created_at, next_roi_date, account_name, portfolio_code, duration_months, payment_method, mobile_network, mobile_money_number, bank_name, bank_account_name, account_number')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (error) break;
    if (data && data.length > 0) {
      portfolios.push(...data);
      offset += PAGE;
      hasMore = data.length === PAGE;
    } else {
      hasMore = false;
    }
  }

  // Owner = investor_id when present, otherwise agent_id.
  const ownerIds = new Set<string>();
  portfolios.forEach(p => {
    const ownerId = p.investor_id || p.agent_id;
    if (ownerId) ownerIds.add(ownerId);
  });

  const profiles = await batchedQuery<{ id: string; full_name: string; phone: string; email: string; frozen_at: string | null; is_frozen: boolean }>(
    Array.from(ownerIds),
    (batch) => supabase.from('profiles').select('id, full_name, phone, email, frozen_at, is_frozen').in('id', batch)
  );

  const profileMap = new Map(profiles.map(p => [p.id, p]));

  // Suspended (frozen) owners must NOT surface in nearing payouts. Drop every
  // portfolio whose owner has a non-null `frozen_at` or `is_frozen=true`, and
  // remove those owners from the owner set so downstream name resolution skips them too.
  const frozenOwnerIds = new Set(
    profiles.filter((p: any) => p.frozen_at != null || p.is_frozen === true).map((p) => p.id)
  );

  // Portfolios that are locked for redemption/maturity payout must not appear in
  // nearing payouts. A pending/processing REDEMPTION_REQUEST means the partner
  // has asked for their capital back and the portfolio is locked from new ROI.
  const lockedPortfolioIds = new Set<string>();
  try {
    const { data } = await supabase
      .from('portfolio_action_requests')
      .select('portfolio_id')
      .eq('request_type', 'REDEMPTION_REQUEST')
      .in('status', ['pending', 'processing']);
    for (const r of (data as any[]) || []) if (r.portfolio_id) lockedPortfolioIds.add(r.portfolio_id);
  } catch (e) {
    console.error('[fetchAllNearingPayoutPortfolios] locked lookup failed', e);
  }

  const filteredPortfolios = portfolios.filter((p) => {
    const ownerId = p.investor_id || p.agent_id;
    if (ownerId && frozenOwnerIds.has(ownerId)) return false;
    if (lockedPortfolioIds.has(p.id)) return false;
    return true;
  });
  frozenOwnerIds.forEach((id) => ownerIds.delete(id));

  // `supporterIds` is now "the set of all owner IDs we have profiles for" — the
  // downstream consumer uses it only to resolve the display name, so any owner
  // counts. Naming kept for backward compatibility with the call site.
  return { portfolios: filteredPortfolios, profileMap, supporterIds: ownerIds };
}

/**
 * Fetch lightweight summary stats for ALL supporters (count, total funded, etc.)
 * without loading full profile/wallet data.
 */
export async function fetchSupporterSummary(): Promise<{
  totalPartners: number;
  totalFunded: number;
  totalWalletBalance: number;
  totalDeals: number;
  activePartners: number;
  suspendedPartners: number;
}> {
  // A partner/funder = ANY user with one or more rows in investor_portfolios.
  // Page through ALL portfolios (no role/status filter) so the count matches DB truth.
  const PAGE = 1000;
  let offset = 0;
  let hasMore = true;
  const portfolioRows: { investment_amount: number | null; investor_id: string | null }[] = [];

  while (hasMore) {
    const { data } = await supabase
      .from('investor_portfolios')
      .select('investment_amount, investor_id')
      .range(offset, offset + PAGE - 1);
    if (data && data.length > 0) {
      portfolioRows.push(...(data as any));
      offset += PAGE;
      hasMore = data.length === PAGE;
    } else {
      hasMore = false;
    }
  }

  const ownerIds = new Set<string>();
  portfolioRows.forEach(p => { if (p.investor_id) ownerIds.add(p.investor_id); });
  const ids = Array.from(ownerIds);

  if (ids.length === 0) {
    return { totalPartners: 0, totalFunded: 0, totalWalletBalance: 0, totalDeals: 0, activePartners: 0, suspendedPartners: 0 };
  }

  const [wallets, frozenProfiles] = await Promise.all([
    batchedQuery<{ user_id: string; balance: number }>(ids, (batch) =>
      supabase.from('wallets').select('user_id, balance').in('user_id', batch)
    ),
    batchedQuery<{ id: string; frozen_at: string | null }>(ids, (batch) =>
      supabase.from('profiles').select('id, frozen_at').in('id', batch).not('frozen_at', 'is', null)
    ),
  ]);

  const frozenIds = new Set(frozenProfiles.map(p => p.id));
  const suspendedPartners = ids.filter(id => frozenIds.has(id)).length;
  const totalWalletBalance = wallets.reduce((s, w) => s + (w.balance || 0), 0);
  const totalFunded = portfolioRows.reduce((s, p) => s + (p.investment_amount || 0), 0);

  return {
    totalPartners: ownerIds.size,
    totalFunded,
    totalWalletBalance,
    totalDeals: portfolioRows.length,
    activePartners: ownerIds.size - suspendedPartners,
    suspendedPartners,
  };
}
