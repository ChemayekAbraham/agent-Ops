import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Landlord payables under the CFO's weekly-float rule — data layer for the CFO weekly view and the
 * FinOps provider-statement upload (migration 20261021100000_landlord_payables_weekly_float).
 *
 * Rule (server-side, get_landlord_payables_by_week): a landlord payout is payable once it has been paid
 * out, and stays payable until a provider statement line confirms it (same transaction ID and amount).
 * Approval, the "completed" status, receipt codes and FinOps screenshots are not evidence. Payouts are
 * grouped by the CFO weekly landlord float; payouts without one are grouped by the week they were paid.
 *
 * Statement upload writes evidence only — no ledger entry, wallet or payout status changes.
 */

export interface LandlordPayablesWeek {
  week_start: string;
  has_weekly_float: boolean;
  float_set: number | null;
  approved: number | null;
  approved_not_paid: number | null;
  approved_not_paid_count: number | null;
  paid_out: number;
  paid_out_count: number;
  confirmed: number;
  confirmed_count: number;
  payable: number;
  payable_count: number;
  probable_count: number;
  screenshot_matched_count: number;
}

export type LandlordPayoutState = 'confirmed' | 'paid_unconfirmed' | 'not_paid' | 'failed';
/**
 * Most serious first. All but probable_match are review exceptions; none of them changes an amount or a state.
 * - paid_amount_differs: the completed withdrawal paid another amount than the payout records
 * - reference_unusable: paid out, unconfirmed, reference is not an 11-digit MTN or 12-digit Airtel transaction ID
 * - shared_reference: paid out, unconfirmed, another payout carries the same reference
 */
export type LandlordPayoutException =
  | 'failed_but_paid'
  | 'completed_without_payout'
  | 'paid_amount_differs'
  | 'reference_unusable'
  | 'shared_evidence'
  | 'shared_reference'
  | 'probable_match';

export interface LandlordPayoutSettlement {
  payout_id: string;
  rent_request_id: string | null;
  landlord_id: string | null;
  landlord_name: string | null;
  landlord_phone: string | null;
  amount: number;
  /** What the completed withdrawal actually paid (null when paid by FinOps directly). */
  paid_amount: number | null;
  payout_status: string;
  paid_out: boolean;
  paid_at: string | null;
  payout_reference: string | null;
  has_weekly_float: boolean;
  float_week_start: string | null;
  report_week_start: string;
  provider_confirmed: boolean;
  confirmed_at: string | null;
  evidence_source: 'statement' | 'provider_email' | null;
  screenshot_result: string | null;
  state: LandlordPayoutState;
  /** The most serious exception (first of `exceptions`). */
  exception: LandlordPayoutException | null;
  exceptions: LandlordPayoutException[];
}

export interface LandlordPayablesReport {
  as_at: string;
  rule: string;
  totals: {
    payable: number;
    payable_count: number;
    payable_with_weekly_float: number;
    payable_without_weekly_float: number;
    confirmed: number;
    confirmed_count: number;
    approved_not_paid: number;
    probable_count: number;
    screenshot_matched_count: number;
    exception_count: number;
    exception_amount: number;
  };
  by_week: LandlordPayablesWeek[];
  exceptions: Array<{
    payout_id: string;
    landlord: string | null;
    amount: number;
    paid_at: string | null;
    payout_status: string;
    exception: LandlordPayoutException;
    exceptions: LandlordPayoutException[];
    state: LandlordPayoutState;
    paid_amount: number | null;
    payout_reference: string | null;
  }>;
  evidence: { statement_imports: number; last_statement_line_at: string | null; last_provider_email_out: string | null };
  /** Present only when a week was requested. */
  lines: LandlordPayoutSettlement[] | null;
}

/** One statement line as the import function expects it (the upload screen maps CSV columns to this). */
export interface ProviderStatementLine {
  transaction_id: string;
  direction: 'out' | 'in';
  /**
   * The provider's status. Only successful lines count as evidence; a reversed line cancels the same transaction.
   * Accepted wordings: successful/success/succeeded/completed, failed/failure/declined/rejected,
   * reversed/reversal/refunded, pending/processing/initiated. Anything else is rejected.
   */
  status: string;
  amount: number;
  fee?: number | null;
  counterparty?: string | null;
  counterparty_name?: string | null;
  /** ISO timestamp with offset, e.g. 2026-10-20T14:05:00+03:00 */
  tx_at: string;
}

export interface ImportProviderStatementInput {
  channel: 'mtn_momo' | 'airtel_money' | 'bank';
  accountRef: string;
  file: File;
  lines: ProviderStatementLine[];
  periodFrom?: string | null;
  periodTo?: string | null;
  notes?: string | null;
}

export interface ImportProviderStatementResult {
  ok: boolean;
  already_imported: boolean;
  import_id: string;
  lines: number;
  inserted: number;
  /** Kept lines whose status is not successful (failed, reversed or pending): stored as record, never evidence. */
  not_successful: number;
  duplicates: number;
  rejected: number;
  rejected_lines?: Array<{ line: number; reason: string }>;
  voided?: boolean;
}

export const LANDLORD_PAYABLES_KEY = ['landlord-payables'] as const;

// The generated Database types do not know these functions until Lovable regenerates them after the migration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rpc = (fn: string, args?: Record<string, unknown>) => supabase.rpc(fn as any, args as any);

/** SHA-256 of the uploaded file's bytes, hex — the server uses it to refuse importing the same file twice. */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param weekStart  with `weeklyFloat`, also returns that week's payouts (`lines`)
 * @param weeklyFloat true = the CFO weekly float group, false = payouts without a weekly float, omitted = both
 */
export function useLandlordPayablesByWeek(weekStart?: string | null, weeklyFloat?: boolean | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...LANDLORD_PAYABLES_KEY, weekStart ?? 'all', weeklyFloat ?? 'any'],
    enabled: options.enabled ?? true,
    staleTime: 60_000,
    queryFn: async (): Promise<LandlordPayablesReport> => {
      const { data, error } = await rpc('get_landlord_payables_by_week', {
        p_week_start: weekStart ?? null,
        p_weekly_float: weeklyFloat ?? null,
      });
      if (error) throw new Error(error.message);
      return data as unknown as LandlordPayablesReport;
    },
  });
}

/** FinOps / CFO: import a provider statement (evidence only). Importing the same file again is a no-op. */
export function useImportProviderStatement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ImportProviderStatementInput): Promise<ImportProviderStatementResult> => {
      const fileSha = await sha256Hex(input.file);
      const { data, error } = await rpc('import_provider_statement', {
        p_channel: input.channel,
        p_account_ref: input.accountRef,
        p_file_name: input.file.name,
        p_file_sha256: fileSha,
        p_lines: input.lines,
        p_period_from: input.periodFrom ?? null,
        p_period_to: input.periodTo ?? null,
        p_notes: input.notes ?? null,
      });
      if (error) throw new Error(error.message);
      return data as unknown as ImportProviderStatementResult;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: LANDLORD_PAYABLES_KEY }),
  });
}

/** CFO only: void a wrong import (reason of at least 10 characters). Its lines stop counting; nothing is deleted. */
export function useVoidProviderStatementImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ importId, reason }: { importId: string; reason: string }) => {
      const { data, error } = await rpc('void_provider_statement_import', { p_import_id: importId, p_reason: reason });
      if (error) throw new Error(error.message);
      return data as unknown as { ok: boolean; import_id: string; lines_voided: number };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: LANDLORD_PAYABLES_KEY }),
  });
}
