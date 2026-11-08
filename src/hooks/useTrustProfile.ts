import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { readTrustProfileCache, writeTrustProfileCache } from '@/lib/trustProfileCache';

// Returns figures reveal a person's own rate. From migration 4b (owner decision D9) they are null for
// anyone but the person, partner staff and their approved proxy agent, and so is every figure the server
// builds from them (the vouch limit and its boosters, the supporter score, the principal). Every field
// typed `number | null` below means "unknown to this viewer": show "—" or no line, never 0.
export interface TrustProfile {
  ai_id: string;
  user_id: string | null;
  identity: {
    full_name: string;
    phone: string | null;
    email: string | null;
    national_id: string | null;
    national_id_present: boolean;
    avatar_url: string | null;
    verified: boolean;
    member_since: string;
    roles: string[];
    primary_role: string;
    is_supporter?: boolean;
  };
  trust: {
    /** null from 4b for a viewer who may not see the person's Returns: the score is the sum of the breakdown
     *  parts, so with it the masked supporter part is the score minus the visible parts. Show "—", never 0. */
    score: number | null;
    tier: string;
    data_points: number;
    /** null from 4b for a viewer who may not see the person's Returns: it is portfolio + boosters, and the
     *  payment-history booster carries a quarter of the monthly Returns. */
    borrowing_limit_ugx: number | null;
    vouch_breakdown?: {
      /** = borrowing_limit_ugx; null with it. */
      total_ugx: number | null;
      /** The portfolio principal; null from 4b with the other Returns figures. */
      portfolio_component_ugx: number | null;
      angel_shares_ugx: number;
      shares_component_ugx: number;
      /** Includes payment_history below; null with it. */
      boosters_ugx: number | null;
      booster_breakdown: {
        wallet_activity: number;
        network_contribution: number;
        agent_performance: number;
        verification: number;
        movement_behavior: number;
        /** Rent repaid x 0.3 + (wallet + Returns monthly) x 0.25: null from 4b when Returns are hidden. */
        payment_history: number | null;
      };
    };
    breakdown: {
      /** Built from the principal and the Returns paid in 180 days: null from 4b when Returns are hidden. */
      supporter?: number | null;
      payment: number;
      wallet: number;
      network: number;
      referrals?: number;
      verification: number;
      behavior: number;
      landlord: number;
      agent_performance?: number;
    };
    weights: {
      supporter?: number;
      payment: number;
      wallet: number;
      network: number;
      verification: number;
      behavior: number;
      landlord: number;
      agent_performance?: number;
    };
  };
  agent_performance?: {
    qualifying_tenants: number;
    healthy_tenants: number;
    healthy_ratio: number;
    collection_rate: number;
    monthly_book: number;
    agent_term?: number;
    top_performing: boolean;
  };
  supporter_activity?: {
    is_supporter: boolean;
    portfolio_value: number | null;
    active_portfolios: number;
    total_roi_earned: number | null;
    roi_paid_30d: number | null;
    roi_paid_180d: number | null;
    roi_monthly_avg: number | null;
    angel_shares_ugx?: number;
    /** Public trust profile (4b, get_public_trust_profile): whether the person earns Returns,
     *  instead of an amount. Sits inside supporter_activity, as the SQL builds it. */
    earning_returns?: boolean;
  };
  payment_history: {
    total_rent_plans: number;
    total_repaid: number;
    total_owing: number;
    on_time_count: number;
    late_count: number;
    on_time_rate: number;
  };
  wallet_activity: {
    balance: number | null;
    total_received_180d: number;
    total_sent_180d: number;
    transaction_count_180d: number;
  };
  cash_flow_capacity: {
    /** null from 4b when the viewer may not see Returns figures (D9): monthly_avg / 30, so it
     *  would give the masked figure back. */
    daily_avg: number | null;
    /** null from 4b, same rule as daily_avg. */
    weekly_avg: number | null;
    /** null from 4b when the viewer may not see Returns figures (D9). */
    monthly_avg: number | null;
    wallet_monthly?: number;
    /** null from 4b when the viewer may not see Returns figures (D9). */
    roi_monthly?: number | null;
    inflow_30d?: number;
    outflow_30d?: number;
    window_days: number;
  };
  network: {
    referrals: number;
    referrals_score?: number;
    referrals_max?: number;
    top_referrer?: boolean;
    sub_agents: number;
    sub_agents_verified?: number;
    tenants_onboarded: number;
    partners_managed?: number;
    landlords_registered?: number;
    promissory_notes?: number;
    total_relationships?: number;
    /** The person's portfolio principal; null from 4b when Returns are hidden. */
    portfolio_value: number | null;
  };
  behavior: {
    visits_total_60d: number;
    worship_visits?: number;
    mall_visits?: number;
    restaurant_visits?: number;
    hotel_visits?: number;
    shop_visits?: number;
    wallet_shopping_count?: number;
    always_share_location: boolean;
    location_captures_30d?: number;
  };
  landlord_activity: {
    total_listings: number;
    verified_listings: number;
    guaranteed_rent: boolean;
  };
  permissions: {
    is_self: boolean;
    is_staff_view: boolean;
    can_see_pii: boolean;
  };
  generated_at: string;
}

/**
 * Who is asking: the signed-in user id, null when signed out, undefined when it cannot be read (then
 * nothing is read from or written to the cache). The session supabase-js holds is the one the RPC sends,
 * so the cached answer is filed under the viewer it was computed for.
 */
async function currentViewerId(): Promise<string | null | undefined> {
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session?.user?.id ?? null;
  } catch {
    return undefined;
  }
}

/** Fetch holistic trust profile by AI ID (authenticated view) */
export function useTrustProfile(aiId: string | undefined, opts?: { publicMode?: boolean }) {
  const [profile, setProfile] = useState<TrustProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const publicMode = opts?.publicMode === true;
  // Bumped by every load and by a change of viewer; an answer that arrives after either is dropped.
  const seqRef = useRef(0);
  // Whose view the state holds: a user id, null (signed out) or undefined (not known yet).
  const viewerRef = useRef<string | null | undefined>(undefined);

  const load = useCallback(async (hydrate: boolean) => {
    if (!aiId) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);

    const viewer = await currentViewerId();
    if (seq !== seqRef.current) return;
    viewerRef.current = viewer;
    if (hydrate && viewer !== undefined) {
      // Show this viewer's own recent copy while the fresh one loads (another viewer's copy is dropped).
      const cached = readTrustProfileCache<TrustProfile>(viewer, aiId, publicMode);
      if (cached) setProfile(cached);
    }

    const rpcName = publicMode ? 'get_public_trust_profile' : 'get_user_trust_profile';
    let data: unknown = null;
    let rpcErr: { message: string } | null = null;
    try {
      const res = await supabase.rpc(rpcName, { p_ai_id: aiId.trim().toUpperCase() });
      data = res.data;
      rpcErr = res.error;
    } catch (e) {
      rpcErr = { message: e instanceof Error ? e.message : 'Could not load the trust profile' };
    }
    if (seq !== seqRef.current) return; // a newer load, or another viewer, owns the state now

    if (rpcErr) {
      setError(rpcErr.message);
      setLoading(false);
      return;
    }

    const parsed = data as unknown as TrustProfile & { error?: string };
    if (parsed?.error) {
      setError(parsed.error === 'AI ID not found' ? 'No Welile member found with this AI ID' : parsed.error);
    } else {
      setProfile(parsed);
      if (viewer !== undefined) writeTrustProfileCache(viewer, aiId, publicMode, parsed);
    }
    setLoading(false);
  }, [aiId, publicMode]);

  const refresh = useCallback(() => load(false), [load]);

  useEffect(() => {
    if (!aiId) return;
    void load(true);
  }, [aiId, load]);

  // Another person (or nobody) signed in on this device while the screen is open: what is shown, and any
  // answer still on its way, were for the previous viewer. Clear it and load the new viewer's view.
  useEffect(() => {
    if (!aiId) return;
    let unsubscribe: (() => void) | undefined;
    try {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        const now = session?.user?.id ?? null;
        if (viewerRef.current === undefined || now === viewerRef.current) return;
        seqRef.current++;
        viewerRef.current = undefined;
        setProfile(null);
        // Deferred: no auth calls inside an onAuthStateChange callback.
        setTimeout(() => { void load(true); }, 0);
      });
      unsubscribe = () => data?.subscription?.unsubscribe();
    } catch {
      /* no auth client (tests): nothing to follow */
    }
    return () => unsubscribe?.();
  }, [aiId, load]);

  // Live-refresh on cross-component vouch updates (e.g., a collection just
  // landed). Filters by AI ID when the emitter knows it; otherwise refreshes.
  useEffect(() => {
    if (!aiId) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ aiId?: string }>).detail || {};
      if (!detail.aiId || detail.aiId.toUpperCase() === aiId.toUpperCase()) {
        refresh();
      }
    };
    window.addEventListener('welile:vouch:updated', handler);
    return () => window.removeEventListener('welile:vouch:updated', handler);
  }, [aiId, refresh]);

  return { profile, loading, error, refresh };
}
