import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type AdvanceReconIssueKind =
  | 'balance_jump'
  | 'deduction_without_wallet_debit'
  | 'balance_change_without_amount'
  | 'row_arithmetic'
  | 'wallet_debit_without_statement_row'
  | 'statement_vs_outstanding';

export interface AdvanceReconIssue {
  kind: AdvanceReconIssueKind;
  at: string;
  amount: number;
  detail: string;
  row_id?: string;
  wallet_entry_id?: string;
}

export interface AdvanceReconDay {
  day: string;
  deductions: number;
  wallet_deducted: number;
  statement_deducted: number;
  penalty: number;
  closing_balance: number;
}

export interface AdvanceReconRow {
  id: string;
  at: string;
  day: string;
  opening_balance: number;
  penalty: number;
  deducted: number;
  closing_balance: number;
  status: string;
  source: string | null;
  wallet_entry_id: string | null;
  issue: AdvanceReconIssueKind | null;
}

export interface AdvanceWalletReconciliation {
  advance: {
    id: string;
    agent_id: string;
    agent_name: string | null;
    agent_phone: string | null;
    status: string;
    issued_at: string;
    expires_at: string;
    principal: number;
    access_fee: number | null;
    total_repayable: number;
    daily_installment: number;
    outstanding_balance: number;
    arrears_balance: number;
  };
  totals: {
    statement_deducted: number;
    wallet_deducted: number;
    wallet_deduction_count: number;
    penalty: number;
    statement_closing: number | null;
    issue_count: number;
    reconciled: boolean;
  };
  days: AdvanceReconDay[];
  issues: AdvanceReconIssue[];
  rows: AdvanceReconRow[];
}

export interface AdvanceReconSummary {
  advance_id: string;
  issue_count: number;
  wallet_deducted: number;
  statement_deducted: number;
  reconciled: boolean;
}

/** Plain-language labels for the issue kinds returned by the RPC. */
export const ADVANCE_RECON_ISSUE_LABEL: Record<AdvanceReconIssueKind, string> = {
  balance_jump: 'Balance moved with no statement row',
  deduction_without_wallet_debit: 'Deduction not taken from wallet',
  balance_change_without_amount: '+0 / −0 row changed the balance',
  row_arithmetic: 'Row does not add up',
  wallet_debit_without_statement_row: 'Wallet debit missing from statement',
  statement_vs_outstanding: 'Statement ≠ advance balance',
};

/**
 * Row-for-row reconciliation of one advance's statement against the agent's
 * wallet debits. All matching happens in `get_advance_wallet_reconciliation`
 * (CFO/CEO/COO/Manager only); this hook only fetches it.
 */
export function useAdvanceWalletReconciliation(advanceId?: string | null) {
  return useQuery({
    queryKey: ['advance-wallet-reconciliation', advanceId],
    enabled: !!advanceId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_advance_wallet_reconciliation' as any, {
        p_advance_id: advanceId,
      });
      if (error) throw error;
      return data as unknown as AdvanceWalletReconciliation;
    },
  });
}

/** Reconciled / issue-count badges for the advances currently on screen (max 100). */
export function useAdvanceReconciliationSummary(advanceIds: string[]) {
  const ids = advanceIds.slice(0, 100);
  return useQuery({
    queryKey: ['advance-reconciliation-summary', ids],
    enabled: ids.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_advance_reconciliation_summary' as any, {
        p_advance_ids: ids,
      });
      if (error) throw error;
      const map = new Map<string, AdvanceReconSummary>();
      for (const r of ((data as unknown as AdvanceReconSummary[]) || [])) map.set(r.advance_id, r);
      return map;
    },
  });
}
