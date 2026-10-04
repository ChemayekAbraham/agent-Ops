import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { TOTAL_SHARES, POOL_PERCENT, UGX_PER_USD, VALUATIONS } from '@/components/angel-pool/constants';

export interface AngelShareRecord {
  id: string;
  amount: number;
  shares: number;
  pool_ownership_percent: number;
  company_ownership_percent: number;
  status: string;
  reference_id: string | null;
  created_at: string;
}

export interface AngelSharesSummary {
  totalShares: number;
  totalInvested: number;
  poolOwnershipPct: number;
  companyOwnershipPct: number;
  records: AngelShareRecord[];
  valuations: { label: string; value: number; myValue: number; myValueUGX: number }[];
  hasShares: boolean;
  isLoading: boolean;
}

export function useMyAngelShares(): AngelSharesSummary {
  const { user } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ['my-angel-shares', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data: investments, error } = await supabase
        .from('angel_pool_investments')
        .select('id, amount, shares, pool_ownership_percent, company_ownership_percent, status, reference_id, created_at')
        .eq('investor_id', user!.id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return (investments || []) as AngelShareRecord[];
    },
    staleTime: 30_000,
  });

  const records = data || [];
  const confirmed = records.filter(r => r.status === 'confirmed');

  const totalShares = confirmed.reduce((s, r) => s + r.shares, 0);
  const totalInvested = confirmed.reduce((s, r) => s + Number(r.amount), 0);
  const poolOwnershipPct = TOTAL_SHARES > 0 ? (totalShares / TOTAL_SHARES) * 100 : 0;
  const companyOwnershipPct = TOTAL_SHARES > 0 ? (totalShares / TOTAL_SHARES) * POOL_PERCENT : 0;

  const valuations = VALUATIONS.map(v => {
    const myValue = (companyOwnershipPct / 100) * v.value;
    return {
      label: v.label,
      value: v.value,
      myValue,
      myValueUGX: myValue * UGX_PER_USD,
    };
  });

  return {
    totalShares,
    totalInvested,
    poolOwnershipPct,
    companyOwnershipPct,
    records,
    valuations,
    hasShares: totalShares > 0 || records.length > 0,
    isLoading,
  };
}
