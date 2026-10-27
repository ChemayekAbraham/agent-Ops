import { useQuery } from '@tanstack/react-query';
import { cfoReportRetry } from './cfoReportRetry';
import { supabase } from '@/integrations/supabase/client';

/**
 * Partner Products and Services — Paid & Outstanding (CFO Payables page).
 *
 * Server functions (migration 20261024110000_partner_paid_outstanding) do all the classification:
 *  - Paid = ledger wallet credits (cash Returns, commissions) or ledger reinvestment entries (compounding Returns),
 *    in the selected Kampala dates. Reinvested Returns are never added to cash.
 *  - Outstanding = the Partner payables lines as at now (the same lines as the rest of this page).
 *  - Pending items are not owed and are in no total.
 * This hook only fetches; it never computes money.
 */

const STALE_TIME = 5 * 60 * 1000;

type RpcFn = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
// Keep the method bound to the client (see usePayables).
const rpc: RpcFn = (fn, args) =>
  (supabase.rpc as unknown as (f: string, a?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>)
    .call(supabase, fn, args);

export interface CountAmount { count: number; amount: number }

export interface PartnerCommissionLine {
  key: 'registration_bonus' | 'fulfilment_commission' | 'topup_commission' | 'recalculation_topup' | 'lead_override';
  label: string;
  rule: string;
  historical_paid_only: boolean;
  paid: { count: number; payees: number; amount: number };
  unpaid: { count: number; amount: number };
}

export interface PartnerPaidOutstanding {
  as_at: string;
  period: { from: string | null; to: string | null; outstanding_due_to: string };
  paid: {
    returns_cash: CountAmount & {
      payees: number;
      reversed: CountAmount;
      to_partner_wallet: CountAmount;
      to_other_wallet: CountAmount;
      not_linked_to_portfolio: CountAmount;
    };
    returns_reinvested: CountAmount & { portfolios: number };
    commissions: PartnerCommissionLine[];
    commission_totals: {
      commissions_paid: number;
      commissions_unpaid_confirmed: number;
      lead_override_paid: number;
      lead_override_unpaid_confirmed: number;
      recalculation_topups_paid_historical: number;
      unpaid_in_payables: number;
    };
  };
  outstanding: {
    returns: CountAmount & {
      by_status: { overdue: CountAmount; due_in_period: CountAmount; later: CountAmount };
      by_mode: { cash_payout: CountAmount; compounding: CountAmount };
    };
    commissions_unpaid: CountAmount;
    pending_not_owed: Array<Record<string, unknown> & { key: string; label: string; status?: string }>;
  };
  reconciliation: {
    partner_payables_total: number;
    returns_plus_unpaid_commissions: number;
    other_partner_lines: number;
    ties_out: boolean;
    commission_unpaid_matches_report: boolean;
    possible_double_return_credits: { pairs: number; second_credit_amount: number };
  };
  basis: { paid: string; outstanding: string };
}

export type PartnerItemsComponent =
  | 'returns_cash' | 'returns_reinvested' | 'returns_outstanding' | 'registration_bonus' | 'lead_override'
  | 'fulfilment_commission' | 'topup_commission' | 'recalculation_topup' | 'commissions_unpaid';

export interface PartnerItemsPage {
  component: PartnerItemsComponent;
  status: string;
  total_count: number;
  limit: number;
  offset: number;
  items: Array<Record<string, unknown>>;
}

export function usePartnerPaidOutstanding(from: string | null, to: string | null, enabled = true) {
  return useQuery({
    queryKey: ['partner-paid-outstanding', from, to],
    enabled,
    queryFn: async (): Promise<PartnerPaidOutstanding> => {
      const { data, error } = await rpc('get_partner_paid_outstanding', { p_from: from, p_to: to });
      if (error) throw error;
      return data as PartnerPaidOutstanding;
    },
    staleTime: STALE_TIME,
    retry: cfoReportRetry,
  });
}

export function usePartnerPaidOutstandingItems(
  component: PartnerItemsComponent | null,
  status: string,
  from: string | null,
  to: string | null,
  offset = 0,
  limit = 50,
) {
  return useQuery({
    queryKey: ['partner-paid-outstanding-items', component, status, from, to, offset, limit],
    enabled: component !== null,
    queryFn: async (): Promise<PartnerItemsPage> => {
      const { data, error } = await rpc('get_partner_paid_outstanding_items', {
        p_component: component, p_status: status, p_from: from, p_to: to, p_limit: limit, p_offset: offset,
      });
      if (error) throw error;
      return data as PartnerItemsPage;
    },
    staleTime: STALE_TIME,
    retry: cfoReportRetry,
  });
}
