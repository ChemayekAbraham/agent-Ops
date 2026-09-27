/**
 * Calls the tops-tenant-brief edge function — a short AI-generated summary,
 * validated server-side (every UGX figure in the narrative must match the
 * supplied facts verbatim) before it ever reaches here. `facts` is always
 * present and is the same data the narrative was checked against; render it
 * beside the narrative, never instead of it being fetched separately.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface TenantBriefFacts {
  as_at: string;
  basis: string;
  tenant_name: string | null;
  cadence: string;
  days_past_due: number | null;
  term_expired: boolean;
  outstanding_ugx: number;
  expected_to_date_ugx: number;
  paid_to_date_ugx: number;
  catch_up_daily_ugx: number | null;
  missed_instalments_count: number;
  total_instalments_count: number;
  last_promise: {
    promised_amount_ugx: number;
    promised_date: string;
    channel: string;
    status: string;
  } | null;
  last_contact_at: string | null;
  last_contact_outcome: string | null;
  total_contact_attempts: number;
}

export interface TenantBrief {
  rent_request_id: string;
  generated_at: string;
  narrative: string | null;
  degraded: boolean;
  facts: TenantBriefFacts;
}

async function fetchTenantBrief(rentRequestId: string): Promise<TenantBrief> {
  const { data, error } = await supabase.functions.invoke('tops-tenant-brief', {
    body: { rent_request_id: rentRequestId },
  });
  if (error) throw error;
  return data as TenantBrief;
}

export function useTenantBrief(rentRequestId: string | undefined) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'tenantBrief', rentRequestId],
    queryFn: () => fetchTenantBrief(rentRequestId as string),
    enabled: !!rentRequestId,
    staleTime: 10 * 60_000,
    retry: false,
  });
}
