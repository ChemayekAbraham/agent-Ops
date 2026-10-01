import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export interface AgentRejectedRequest {
  id: string;
  rent_amount: number;
  duration_days: number;
  number_of_payments: number | null;
  daily_repayment: number;
  total_repayment: number;
  access_fee: number;
  request_fee: number;
  status: string;
  created_at: string;
  rejected_at: string | null;
  rejected_at_stage: string | null;
  rejected_reason: string | null;
  reopen_count: number;
  tenant_id: string;
  landlord_id: string;
  tenant_water_meter: string | null;
  tenant_electricity_meter: string | null;
  request_latitude: number | null;
  request_longitude: number | null;
  // Expanded editable fields
  lc1_id: string | null;
  house_category: string | null;
  preferred_language: string | null;
  tenant_no_smartphone: boolean | null;
  registration_type: string | null;
  initial_outstanding_balance: number | null;
  outstanding_grace_days: number | null;
  // Evidence the agent may need to replace on resubmit
  house_image_urls: string[] | null;
  lc_letter_path: string | null;
  lc_letter_bucket: string | null;
  // Reviewer columns we resolve to a name
  tenant_ops_reviewed_by: string | null;
  tenant_ops_reviewed_at: string | null;
  agent_verified_by: string | null;
  agent_verified_at: string | null;
  landlord_ops_reviewed_by: string | null;
  landlord_ops_reviewed_at: string | null;
  coo_reviewed_by: string | null;
  coo_reviewed_at: string | null;
  cfo_reviewed_by: string | null;
  cfo_reviewed_at: string | null;
  // Enriched
  tenant_name?: string;
  tenant_phone?: string;
  landlord_name?: string;
  landlord_address?: string;
  reviewer_name?: string;
  reviewer_at?: string | null;
  stage_label?: string;
  /**
   * True when the 24-hour landlord float recall cancelled this plan rather
   * than a reviewer rejecting it. The landlord was never paid and the float
   * went back to the pool, so the agent can simply submit it again.
   */
  returned_by_recall?: boolean;
}

export const STAGE_LABEL: Record<string, string> = {
  // Label = the desk that REJECTED at this stage (i.e. the next reviewer
  // after the stored "approved" status). Keep aligned with RentPipelineTracker.
  pending: 'Agent Ops',
  agent_ops_approved: 'Tenant Ops',
  tenant_ops_approved: 'Landlord Ops',
  agent_verified: 'Landlord Ops', // legacy alias
  landlord_ops_approved: 'COO',
  coo_approved: 'CFO',
};

function humanizeStage(stage: string | null | undefined): string {
  if (!stage) return 'Reviewer';
  if (STAGE_LABEL[stage]) return STAGE_LABEL[stage];
  return stage
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function reviewerForStage(r: any): { id: string | null; at: string | null; label: string } {
  const stage = r.rejected_at_stage ?? 'pending';
  const label = humanizeStage(stage);
  switch (stage) {
    case 'pending':
      // Agent Ops triage — no dedicated reviewer column; fall back to tenant_ops.
      return { id: r.tenant_ops_reviewed_by, at: r.tenant_ops_reviewed_at, label };
    case 'agent_ops_approved':
      return { id: r.tenant_ops_reviewed_by, at: r.tenant_ops_reviewed_at, label };
    case 'tenant_ops_approved':
    case 'agent_verified':
      return { id: r.landlord_ops_reviewed_by ?? r.agent_verified_by, at: r.landlord_ops_reviewed_at ?? r.agent_verified_at, label };
    case 'landlord_ops_approved':
      return { id: r.coo_reviewed_by, at: r.coo_reviewed_at, label };
    case 'coo_approved':
      return { id: r.cfo_reviewed_by, at: r.cfo_reviewed_at, label };
    default:
      return { id: null, at: null, label };
  }
}

export function useAgentRejectedRequests() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['agent-rejected-rent-requests', user?.id],
    enabled: !!user,
    queryFn: async (): Promise<AgentRejectedRequest[]> => {
      const { data, error } = await supabase
        .from('rent_requests')
        .select(
          'id, rent_amount, duration_days, number_of_payments, daily_repayment, total_repayment, access_fee, request_fee, status, created_at, rejected_at, rejected_at_stage, rejected_reason, reopen_count, tenant_id, landlord_id, lc1_id, house_category, preferred_language, tenant_no_smartphone, registration_type, initial_outstanding_balance, outstanding_grace_days, tenant_water_meter, tenant_electricity_meter, request_latitude, request_longitude, house_image_urls, lc_letter_path, lc_letter_bucket, agent_payment_status_reason, tenant_ops_reviewed_by, tenant_ops_reviewed_at, agent_verified_by, agent_verified_at, landlord_ops_reviewed_by, landlord_ops_reviewed_at, coo_reviewed_by, coo_reviewed_at, cfo_reviewed_by, cfo_reviewed_at',
        )
        .eq('agent_id', user!.id)
        // A plan the 24-hour landlord float recall cancelled never becomes
        // 'rejected', so it used to appear on no queue at all and the tenant
        // was stranded. Pull cancelled rows too, then keep only the ones the
        // recall produced — an ops cancellation is not the agent's to retry.
        .in('status', ['rejected', 'cancelled'])
        .order('rejected_at', { ascending: false, nullsFirst: false })
        .limit(100);

      if (error) throw error;
      let rows = (data ?? []) as any[];
      if (rows.length === 0) return [];

      const cancelledIds = rows.filter((r) => r.status === 'cancelled').map((r) => r.id);
      let recalledIds = new Set<string>();
      if (cancelledIds.length > 0) {
        const { data: alerts } = await supabase
          .from('landlord_float_idle_alerts')
          .select('rent_request_id')
          .eq('outcome', 'auto_recalled')
          .in('rent_request_id', cancelledIds);
        recalledIds = new Set((alerts ?? []).map((a: any) => a.rent_request_id));
      }
      rows = rows.filter((r) => r.status !== 'cancelled' || recalledIds.has(r.id));
      if (rows.length === 0) return [];

      const tenantIds = [...new Set(rows.map((r) => r.tenant_id).filter(Boolean))];
      const landlordIds = [...new Set(rows.map((r) => r.landlord_id).filter(Boolean))];
      const reviewerIds = [
        ...new Set(rows.map((r) => reviewerForStage(r).id).filter(Boolean) as string[]),
      ];
      const profileIds = [...new Set([...tenantIds, ...reviewerIds])];

      const [{ data: profiles }, { data: landlords }] = await Promise.all([
        profileIds.length
          ? supabase.from('profiles').select('id, full_name, phone').in('id', profileIds)
          : Promise.resolve({ data: [] as any[] }),
        landlordIds.length
          ? supabase
              .from('landlords')
              .select('id, name, property_address')
              .in('id', landlordIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);

      const pmap = new Map((profiles ?? []).map((p: any) => [p.id, p]));
      const lmap = new Map((landlords ?? []).map((l: any) => [l.id, l]));

      return rows.map((r) => {
        const returnedByRecall = r.status === 'cancelled';
        const reviewer = returnedByRecall
          ? { id: null, at: null, label: 'Landlord float returned' }
          : reviewerForStage(r);
        const reviewerProfile = reviewer.id ? pmap.get(reviewer.id) : null;
        const tenantProfile = pmap.get(r.tenant_id);
        const landlord = lmap.get(r.landlord_id);
        return {
          ...r,
          tenant_name: tenantProfile?.full_name ?? 'Unknown tenant',
          tenant_phone: tenantProfile?.phone ?? '',
          landlord_name: landlord?.name ?? 'Unknown landlord',
          landlord_address: landlord?.property_address ?? '',
          reviewer_name: returnedByRecall
            ? 'Automatic recall'
            : (reviewerProfile?.full_name ?? 'Reviewer'),
          reviewer_at: reviewer.at,
          stage_label: reviewer.label,
          returned_by_recall: returnedByRecall,
          // The recall writes its explanation here, not to rejected_reason.
          rejected_reason: returnedByRecall
            ? (r.agent_payment_status_reason ??
               'The landlord was not paid within 24 hours, so the float was returned and this Rent Plan was cancelled. You can submit it again.')
            : r.rejected_reason,
        } as AgentRejectedRequest;
      });
    },
  });
}
