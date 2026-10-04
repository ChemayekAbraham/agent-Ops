import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

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
    score: number;
    tier: string;
    data_points: number;
    borrowing_limit_ugx: number;
    vouch_breakdown?: {
      total_ugx: number;
      portfolio_component_ugx: number;
      angel_shares_ugx: number;
      shares_component_ugx: number;
      boosters_ugx: number;
      booster_breakdown: {
        wallet_activity: number;
        network_contribution: number;
        agent_performance: number;
        verification: number;
        movement_behavior: number;
        payment_history: number;
      };
    };
    breakdown: {
      supporter?: number;
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
    portfolio_value: number;
    active_portfolios: number;
    total_roi_earned: number;
    roi_paid_30d: number;
    roi_paid_180d: number;
    roi_monthly_avg: number;
    angel_shares_ugx?: number;
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
    daily_avg: number;
    weekly_avg: number;
    monthly_avg: number;
    wallet_monthly?: number;
    roi_monthly?: number;
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

const CACHE_PREFIX = 'welile_trust_profile_';
const CACHE_TTL = 10 * 60 * 1000; // 10 min

interface CacheEntry {
  data: TrustProfile;
  cachedAt: number;
}

/** Fetch holistic trust profile by AI ID (authenticated view) */
export function useTrustProfile(aiId: string | undefined, opts?: { publicMode?: boolean }) {
  const [profile, setProfile] = useState<TrustProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const publicMode = opts?.publicMode === true;

  const refresh = useCallback(async () => {
    if (!aiId) return;
    setLoading(true);
    setError(null);

    const rpcName = publicMode ? 'get_public_trust_profile' : 'get_user_trust_profile';
    const { data, error: rpcErr } = await supabase.rpc(rpcName, { p_ai_id: aiId.trim().toUpperCase() });

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
      try {
        const key = CACHE_PREFIX + (publicMode ? 'pub_' : '') + aiId.toUpperCase();
        localStorage.setItem(key, JSON.stringify({ data: parsed, cachedAt: Date.now() } as CacheEntry));
      } catch {}
    }
    setLoading(false);
  }, [aiId, publicMode]);

  useEffect(() => {
    if (!aiId) return;
    // Hydrate from cache first
    try {
      const key = CACHE_PREFIX + (publicMode ? 'pub_' : '') + aiId.toUpperCase();
      const raw = localStorage.getItem(key);
      if (raw) {
        const cached: CacheEntry = JSON.parse(raw);
        if (Date.now() - cached.cachedAt < CACHE_TTL) {
          setProfile(cached.data);
        }
      }
    } catch {}
    refresh();
  }, [aiId, publicMode, refresh]);

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
