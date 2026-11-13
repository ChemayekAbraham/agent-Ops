import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { PARTNER_RETURN_POLICY_QUERY_KEY } from '@/hooks/usePartnerReturnPolicy';

/**
 * CFO side of the partner Returns policy (migration 20261108160000):
 *   get_partner_return_policy / set_partner_return_policy   the switch (cfo, ceo, super_admin flip it)
 *   list_portfolio_rate_requests                            the CFO queue, one call per status
 *   cfo_decide_portfolio_rate_requests                      one batch call per decision (CFO only)
 * Every rule is enforced in the database; these hooks only read and call.
 */

// Not in the generated types yet: one narrow cast instead of `as any` at each call.
type RpcResult = { data: unknown; error: { message: string; code?: string } | null };
const rpc = (fn: string, args?: Record<string, unknown>) =>
  (supabase.rpc as unknown as (f: string, a?: Record<string, unknown>) => Promise<RpcResult>)(fn, args);

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw error;
  return data as T;
}

/** Roles the database lets flip the switch (set_partner_return_policy). */
// Only the CEO may turn Partner Returns on or off (owner rule; set_partner_return_policy enforces ARRAY['ceo']).
export const PARTNER_RETURN_POLICY_SWITCH_ROLES = ['ceo'] as const;
/** The only role the database lets decide rate requests (cfo_decide_portfolio_rate_requests). */
export const PARTNER_RATE_DECIDER_ROLE = 'cfo' as const;

export interface PartnerReturnPolicyDetail {
  enabled: boolean;
  new_contract_rate: number;
  policy_rate: number;
  legacy_rate: number;
  enabled_at: string | null;
  updated_at: string | null;
}

export type PartnerRateRequestStatus = 'pending' | 'approved' | 'rejected' | 'superseded';
export type PartnerRateRequestStage = 'pending' | 'approved_next_cycle' | 'applied' | 'rejected' | 'superseded';

export interface PartnerRateRequestRow {
  request_id: string;
  portfolio_id: string | null;
  portfolio_code: string | null;
  partner_id: string | null;
  partner_name: string | null;
  investment_amount: number | null;
  portfolio_status: string | null;
  source: 'new_portfolio' | 'rate_change' | 'agreement_rate';
  requested_rate: number;
  rate_in_force: number;
  standard_rate: number;
  status: PartnerRateRequestStatus;
  requested_by: string | null;
  requested_by_name: string | null;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  applied_at: string | null;
  current_rate: number | null;
  stage: PartnerRateRequestStage;
}

export interface PartnerRateDecisionResult {
  decision?: 'approved' | 'rejected';
  decided: number;
  skipped: number;
  applies?: 'next_cycle' | null;
}

/** Plain-language text for errors from these RPCs (MFA, role, validation). */
export function partnerRateErrorText(err: unknown): string {
  const msg = String((err as { message?: string } | null)?.message ?? err ?? '');
  if (/mfa_required/i.test(msg)) {
    return 'Two-step verification needed: confirm with your authenticator app (Settings → Authenticator app), then try again.';
  }
  if (/Only the CFO/i.test(msg)) return 'Only the CFO can approve or reject partner Rent profit share rates.';
  if (/Not authorised|permission denied|42501/i.test(msg)) return 'Your role cannot do this.';
  if (/reason is required/i.test(msg)) return 'A reason is required to reject.';
  return msg || 'Something went wrong. Try again.';
}

const DETAIL_KEY = [...PARTNER_RETURN_POLICY_QUERY_KEY, 'detail'] as const;
const REQUESTS_KEY = ['partner-rate-requests'] as const;

/** Full policy row for the CFO card (enabled_at, legacy rate). Shares the policy key prefix. */
export function usePartnerReturnPolicyDetail() {
  return useQuery({
    queryKey: DETAIL_KEY,
    queryFn: () => call<PartnerReturnPolicyDetail>('get_partner_return_policy'),
    staleTime: 60_000,
  });
}

export function useSetPartnerReturnPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { enabled: boolean; note?: string }) =>
      call<PartnerReturnPolicyDetail>('set_partner_return_policy', {
        p_enabled: v.enabled,
        p_note: v.note?.trim() || null,
      }),
    onSuccess: async (detail) => {
      qc.setQueryData(DETAIL_KEY, detail);
      // Prefix match: refreshes every screen reading the policy (forms, calculators, this card).
      await qc.invalidateQueries({ queryKey: PARTNER_RETURN_POLICY_QUERY_KEY });
    },
  });
}

/** One list_portfolio_rate_requests call per status (null = all). Rows carry partner and requester names. */
export function usePartnerRateRequests(status: PartnerRateRequestStatus | null, limit = 200) {
  return useQuery({
    queryKey: [...REQUESTS_KEY, status ?? 'all', limit],
    queryFn: async () => {
      const [portfolios, agreements] = await Promise.all([
        call<PartnerRateRequestRow[] | null>('list_portfolio_rate_requests', { p_status: status, p_limit: limit }),
        call<PartnerRateRequestRow[] | null>('list_agreement_rate_requests', { p_status: status, p_limit: limit }),
      ]);
      return [...(portfolios ?? []), ...(agreements ?? [])].sort((a, b) => b.requested_at.localeCompare(a.requested_at));
    },
    staleTime: 30_000,
  });
}

/** One cfo_decide_portfolio_rate_requests call for the whole batch. */
export function useDecidePartnerRateRequests() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { requestIds: string[]; agreementRequestIds?: string[]; decision: 'approve' | 'reject'; note?: string }) => {
      const args = { p_decision: v.decision, p_note: v.note?.trim() || null };
      const results: PartnerRateDecisionResult[] = [];
      if (v.requestIds.length) results.push(await call<PartnerRateDecisionResult>('cfo_decide_portfolio_rate_requests', { ...args, p_request_ids: v.requestIds }));
      if (v.agreementRequestIds?.length) results.push(await call<PartnerRateDecisionResult>('cfo_decide_agreement_rate_requests', { ...args, p_request_ids: v.agreementRequestIds }));
      return { decision: v.decision === 'approve' ? 'approved' as const : 'rejected' as const, decided: results.reduce((sum, r) => sum + r.decided, 0), skipped: results.reduce((sum, r) => sum + r.skipped, 0) };
    },
    onSettled: () => qc.invalidateQueries({ queryKey: REQUESTS_KEY }),
  });
}
