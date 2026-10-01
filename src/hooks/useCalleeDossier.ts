/**
 * One-round-trip caller dossier for the CRM call drawer.
 * Backed by `crm_callee_dossier` (SECURITY DEFINER). The server decides what
 * is returned: partner details only reach partner_ops / super_admin / hr.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface DossierWalletTxn {
  id: string; created_at: string; amount: number; direction: string; category: string;
  description: string | null; wallet_bucket: string | null; paid_by: 'self' | 'agent' | null;
}
export interface DossierCollection {
  id: string; created_at: string; amount: number; payment_method: string | null;
  tenant_id: string | null; tenant_name: string | null; kampala_day: string;
}
export interface DossierAgentTenant {
  rent_request_id: string; tenant_id: string; tenant_name: string | null; tenant_phone: string | null;
  status: string; daily: number; weekly: number; total: number; repaid: number; outstanding: number; collected_today: number;
}
export type PeriodTotal = { count: number; amount: number };
export interface DossierPlan {
  id: string; status: string; rent_amount: number | null; total_repayment: number | null; amount_repaid: number | null;
  daily_repayment: number | null; duration_days: number | null; outstanding: number; created_at: string;
  funded_at: string | null; tenancy_status: string | null; agent_name: string | null;
}
export interface DossierRepayment {
  id: string; rent_request_id: string | null; amount: number; created_at: string; payment_method: string | null;
  paid_by: 'self' | 'agent'; agent_name: string | null;
}
export interface DossierNote {
  id: string; partner_name: string | null; phone_number: string | null; email: string | null; amount: number;
  contribution_type: string | null; deduction_day: number | null; status: string; total_collected: number | null;
  next_deduction_date: string | null; recorded_on: string | null; fulfilment_due_on: string | null;
  follow_up_status: string | null; follow_up_note: string | null; notes: string | null; created_at: string; came_in: boolean;
}
export interface DossierProxyPartner {
  beneficiary_id: string; full_name: string | null; phone: string | null; approval_status: string | null;
  is_active: boolean; is_managed_account: boolean; created_at: string; came_in: boolean; active_support: number | null;
}
export interface DossierPortfolio {
  id: string; portfolio_code: string | null; investment_amount: number; duration_months: number | null;
  roi_percentage: number | null; roi_mode: string | null; status: string; created_at: string;
  maturity_date: string | null; next_roi_date: string | null; total_roi_earned: number | null;
  payout_day: number | null; auto_reinvest: boolean | null; payment_method: string | null;
}
export interface CalleeDossier {
  profile: {
    id: string; full_name: string | null; email: string | null; phone: string | null; avatar_url: string | null;
    joined_at: string; last_active_at: string | null; location: string | null; landmark: string | null;
    is_frozen: boolean | null; roles: string[];
  } | null;
  kinds: { agent: boolean; sub_agent: boolean; proxy_agent: boolean; tenant: boolean; partner: boolean };
  partner_access: boolean;
  wallet: { withdrawable: number; operational_float: number; advance: number; landlord_float: number };
  wallet_txns: DossierWalletTxn[];
  complaints: { id: string; body_text: string; created_at: string; recorded_by_name: string | null }[];
  agent?: {
    totals: { today: PeriodTotal; yesterday: PeriodTotal; month: PeriodTotal; all: PeriodTotal };
    collections: DossierCollection[];
    tenants: DossierAgentTenant[];
  };
  proxy?: { notes: DossierNote[]; partners: DossierProxyPartner[] };
  tenant?: {
    plans: DossierPlan[]; repayments: DossierRepayment[];
    last_collection: { amount: number; created_at: string; agent_name: string | null } | null;
  };
  partner?: {
    restricted: boolean;
    portfolios?: DossierPortfolio[];
    topups?: { id: string; amount: number; status: string; effective_at: string | null; prorata_amount: number | null; created_at: string }[];
    changes?: { id: string; action: string; portfolio_code: string | null; changed_fields: string[] | null; changed_at: string }[];
    returns?: { id: string; created_at: string; amount: number; direction: string; category: string; description: string | null }[];
  };
}

export const calleeDossierKey = (id: string) => ['crm-callee-dossier', id] as const;

export function useCalleeDossier(userId: string | null | undefined) {
  return useQuery({
    queryKey: calleeDossierKey(userId ?? ''),
    enabled: !!userId,
    staleTime: 30_000,
    queryFn: async () => {
      if (!userId) throw new Error('A person is required to load the call file.');
      const { data, error } = await supabase.rpc('crm_callee_dossier', { p_user_id: userId });
      if (error) throw error;
      return data as unknown as CalleeDossier;
    },
  });
}

export function useRecordCallComplaint(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { html: string; text: string; callId: string | null }) => {
      const { error } = await supabase.rpc('crm_record_call_complaint', {
        p_target_user_id: userId,
        p_call_session_id: v.callId as string,
        p_body_html: v.html,
        p_body_text: v.text,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: calleeDossierKey(userId) }),
  });
}
