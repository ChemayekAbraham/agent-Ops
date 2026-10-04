import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface RoleVerification {
  role: 'agent' | 'tenant' | 'landlord' | 'supporter';
  label: string;
  verified: boolean;
  reason: string;
  action?: string;
  actionRoute?: string;
}

export function useVerificationStatus(userId: string | undefined) {
  const [verifications, setVerifications] = useState<RoleVerification[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) { setLoading(false); return; }

    const fetch = async () => {
      try {
        const [
          rentReqAgent,
          activeRentSubs,
          landlordTenants,
          deployedCapital,
          houseListingsAgent,
          floatAllocAgent,
          agentVisitsAgent,
          referredProfiles,
        ] = await Promise.all([
          // Agent: has posted ≥1 rent request
          supabase.from('rent_requests').select('id', { count: 'exact', head: true }).eq('agent_id', userId),
          // Tenant: has active rent subscription (running balance)
          supabase.from('rent_requests').select('id', { count: 'exact', head: true }).eq('tenant_id', userId).in('status', ['funded', 'active', 'partially_repaid']),
          // Landlord: has ≥1 tenant attached with active rent
          supabase.from('landlords').select('id', { count: 'exact', head: true }).eq('tenant_id', userId).eq('verified', true),
          // Supporter: ≥50K deployed
          supabase.from('investor_portfolios').select('investment_amount').eq('investor_id', userId).in('status', ['active', 'pending', 'pending_approval']),
          // Agent (extended): listed houses
          supabase.from('house_listings').select('id', { count: 'exact', head: true }).eq('agent_id', userId),
          // Agent (extended): landlord float allocations
          supabase.from('agent_landlord_float_allocations').select('id', { count: 'exact', head: true }).eq('agent_id', userId),
          // Agent (extended): logged agent visits
          supabase.from('agent_visits').select('id', { count: 'exact', head: true }).eq('agent_id', userId),
          // Agent (extended): referrer of an active profile
          supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('referrer_id', userId),
        ]);

        // Also check if this user is a landlord with tenants
        const landlordCheck = await supabase
          .from('house_listings')
          .select('id', { count: 'exact', head: true })
          .eq('landlord_id', userId)
          .not('tenant_id', 'is', null);

        const deployedTotal = (deployedCapital.data || []).reduce((s, p) => s + (p.investment_amount || 0), 0);

        const agentSignals = {
          rent_requests: rentReqAgent.count ?? 0,
          house_listings: houseListingsAgent.count ?? 0,
          float_allocations: floatAllocAgent.count ?? 0,
          agent_visits: agentVisitsAgent.count ?? 0,
          referrals: referredProfiles.count ?? 0,
        };
        const agentTotal = Object.values(agentSignals).reduce((s, n) => s + n, 0);
        const isAgent = agentTotal >= 1;
        const agentReasonParts = Object.entries(agentSignals)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`);

        const results: RoleVerification[] = [
          {
            role: 'agent',
            label: 'Verified Agent',
            verified: isAgent,
            reason: isAgent
              ? `Active responsibility: ${agentReasonParts.join(', ')}`
              : 'Post a rent request, list a house, allocate landlord float, log a visit, or refer a user',
            action: 'Post Rent Request',
          },
          {
            role: 'tenant',
            label: 'Verified Tenant',
            verified: (activeRentSubs.count ?? 0) >= 1,
            reason: (activeRentSubs.count ?? 0) >= 1 ? 'Active rent balance running' : 'Get your rent funded by Welile',
            action: 'Request Rent',
          },
          {
            role: 'landlord',
            label: 'Verified Landlord',
            verified: (landlordCheck.count ?? 0) >= 1,
            reason: (landlordCheck.count ?? 0) >= 1 ? 'Tenants attached & rent flowing' : 'Have at least 1 tenant with active rent',
            action: 'Add Tenant',
          },
          {
            role: 'supporter',
            label: 'Verified Funder',
            verified: deployedTotal >= 50000,
            reason: deployedTotal >= 50000 ? `UGX ${deployedTotal.toLocaleString()} deployed` : `Deploy at least UGX 50,000 (${Math.round((deployedTotal / 50000) * 100)}% done)`,
            action: 'Add Funding',
          },
        ];

        setVerifications(results);
      } catch (e) {
        console.warn('[useVerificationStatus] Error:', e);
      } finally {
        setLoading(false);
      }
    };

    fetch();
  }, [userId]);

  const verifiedCount = verifications.filter(v => v.verified).length;

  return { verifications, loading, verifiedCount, totalRoles: verifications.length };
}
