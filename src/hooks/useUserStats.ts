import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface UserStats {
  tenantsRegistered: number;
  landlordsRegistered: number;
  subAgentsRecruited: number;
  supportersRegistered: number;
  tenantsEarningFrom: number;
  roles: string[];
  rentRequestsPosted: number;
  totalEarnings: number;
  collectionsCount: number;
  collectionsTotal: number;
  housesListed: number;
  deliveryConfirmations: number;
  visitsCount: number;
  totalCommissions: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const statsCache = new Map<string, { data: UserStats; fetchedAt: number }>();

function getCached(userId: string): UserStats | null {
  const entry = statsCache.get(userId);
  if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) return entry.data;
  return null;
}

const emptyStats: UserStats = {
  tenantsRegistered: 0, landlordsRegistered: 0, subAgentsRecruited: 0,
  supportersRegistered: 0, tenantsEarningFrom: 0, roles: [],
  rentRequestsPosted: 0, totalEarnings: 0, collectionsCount: 0,
  collectionsTotal: 0, housesListed: 0, deliveryConfirmations: 0,
  visitsCount: 0, totalCommissions: 0,
};

export function useUserStats(userId: string | undefined) {
  const [stats, setStats] = useState<UserStats>(() => {
    if (userId) {
      const cached = getCached(userId);
      if (cached) return cached;
    }
    return emptyStats;
  });
  const [loading, setLoading] = useState(() => !(userId && getCached(userId)));

  const fetchStats = useCallback(async () => {
    if (!userId) return;
    const cached = getCached(userId);
    if (cached) { setStats(cached); setLoading(false); return; }

    setLoading(true);
    try {
      const [
        tenantsResult, landlordsResult, subAgentsResult,
        supportersResult, earningTenantsResult, rolesResult,
        rentRequestsResult, earningsResult, collectionsResult,
        housesResult, deliveryResult, visitsResult, commissionsResult,
      ] = await Promise.all([
        supabase.from('supporter_invites').select('id', { count: 'exact', head: true }).eq('created_by', userId).eq('role', 'tenant').eq('status', 'activated'),
        supabase.from('supporter_invites').select('id', { count: 'exact', head: true }).eq('created_by', userId).eq('role', 'landlord').eq('status', 'activated'),
        supabase.from('agent_subagents').select('id', { count: 'exact', head: true }).eq('parent_agent_id', userId),
        supabase.from('supporter_invites').select('id', { count: 'exact', head: true }).eq('created_by', userId).eq('role', 'supporter').eq('status', 'activated'),
        supabase.from('agent_earnings').select('source_user_id').eq('agent_id', userId).eq('earning_type', 'commission').not('source_user_id', 'is', null),
        supabase.from('user_roles').select('role').eq('user_id', userId).eq('enabled', true),
        supabase.from('rent_requests').select('id', { count: 'exact', head: true }).eq('agent_id', userId),
        supabase.from('agent_earnings').select('amount').eq('agent_id', userId),
        supabase.from('agent_collections').select('amount').is('reversed_at', null).eq('agent_id', userId),
        supabase.from('house_listings').select('id', { count: 'exact', head: true }).eq('agent_id', userId),
        supabase.from('agent_delivery_confirmations').select('id', { count: 'exact', head: true }).eq('agent_id', userId),
        supabase.from('agent_visits').select('id', { count: 'exact', head: true }).eq('agent_id', userId),
        supabase.from('agent_commission_payouts').select('amount').eq('agent_id', userId),
      ]);

      const uniqueEarningTenants = new Set((earningTenantsResult.data || []).map(e => e.source_user_id));
      const totalEarnings = (earningsResult.data || []).reduce((s, e) => s + (e.amount || 0), 0);
      const collectionsData = collectionsResult.data || [];
      const collectionsTotal = collectionsData.reduce((s, c) => s + (c.amount || 0), 0);
      const totalCommissions = (commissionsResult.data || []).reduce((s, c) => s + (c.amount || 0), 0);

      const result: UserStats = {
        tenantsRegistered: tenantsResult.count || 0,
        landlordsRegistered: landlordsResult.count || 0,
        subAgentsRecruited: subAgentsResult.count || 0,
        supportersRegistered: supportersResult.count || 0,
        tenantsEarningFrom: uniqueEarningTenants.size,
        roles: (rolesResult.data || []).map(r => r.role),
        rentRequestsPosted: rentRequestsResult.count || 0,
        totalEarnings,
        collectionsCount: collectionsData.length,
        collectionsTotal,
        housesListed: housesResult.count || 0,
        deliveryConfirmations: deliveryResult.count || 0,
        visitsCount: visitsResult.count || 0,
        totalCommissions,
      };

      statsCache.set(userId, { data: result, fetchedAt: Date.now() });
      setStats(result);
    } catch (error) {
      console.error('[useUserStats] Error:', error);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  return { stats, loading, refetch: fetchStats };
}
