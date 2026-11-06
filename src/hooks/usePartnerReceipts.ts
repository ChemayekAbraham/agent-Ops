import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import type { PartnerReceiptMethod, PartnerReceiptRow } from '@/lib/partnerReceiptPdf';

// The new RPCs are not in the generated types until the migration is applied and types are regenerated.
const rpc = (fn: string, args?: Record<string, unknown>) => (supabase as any).rpc(fn, args);

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export interface ReceiptFilters {
  search: string; from: string; to: string; method: string; status: string; page: number;
}
export const RECEIPT_PAGE_SIZE = 50;

export interface IssueReceiptInput {
  received_from: string; amount: number; method: PartnerReceiptMethod; purpose: string; received_on: string;
  payer_user_id?: string | null; payer_phone?: string; instrument_no?: string; drawn_on?: string;
  branch?: string; deposit_request_id?: string | null; note?: string;
}

export interface DailyClosing {
  day: string; issued_count: number; issued_total: number;
  by_method: Record<string, { count: number; total: number }>;
  voided_count: number; unlinked_count: number; cash_unconfirmed_count: number; cash_unconfirmed_total: number;
  undelivered_count: number; pending_corrections: number;
}

export interface ReceiptEvent { event: string; actor_name: string | null; detail: Record<string, unknown>; at: string }

export interface PendingCorrection {
  id: string; receipt_id: string; kind: 'void' | 'correct'; reason: string; proposed: Record<string, unknown>;
  requested_by: string; requested_at: string;
}

/** Which actions this person may take. The database enforces the same rules; this only hides buttons. */
export function useReceiptAccess() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['partner-receipt-access', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const [issue, approve] = await Promise.all([
        call<boolean>('can_issue_partner_receipt', { _uid: user!.id }),
        call<boolean>('can_approve_partner_receipt_correction', { _uid: user!.id }),
      ]);
      return { canIssue: issue, canApprove: approve, userId: user!.id };
    },
  });
}

export function usePartnerReceipts(f: ReceiptFilters) {
  return useQuery({
    queryKey: ['partner-receipts', f],
    queryFn: () => call<PartnerReceiptRow[]>('search_partner_receipts', {
      p_search: f.search.trim() || null, p_from: f.from || null, p_to: f.to || null,
      p_method: f.method || null, p_status: f.status || null,
      p_limit: RECEIPT_PAGE_SIZE, p_offset: f.page * RECEIPT_PAGE_SIZE,
    }),
  });
}

export function useDailyClosing(day: string) {
  return useQuery({
    queryKey: ['partner-receipts-closing', day],
    queryFn: () => call<DailyClosing>('partner_receipts_daily_closing', { p_day: day }),
  });
}

export function useReceiptHistory(id: string | null) {
  return useQuery({
    queryKey: ['partner-receipt-history', id],
    enabled: !!id,
    queryFn: () => call<ReceiptEvent[]>('get_partner_receipt_history', { p_receipt_id: id }),
  });
}

export function usePendingCorrections(enabled: boolean) {
  return useQuery({
    queryKey: ['partner-receipt-pending-corrections'],
    enabled,
    queryFn: async () => {
      const { data, error } = await (supabase as any).from('partner_receipt_corrections')
        .select('id,receipt_id,kind,reason,proposed,requested_by,requested_at')
        .eq('status', 'pending').order('requested_at');
      if (error) throw new Error(error.message);
      return (data ?? []) as PendingCorrection[];
    },
  });
}

export function useReceiptMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    for (const k of ['partner-receipts', 'partner-receipts-closing', 'partner-receipt-history', 'partner-receipt-pending-corrections']) {
      qc.invalidateQueries({ queryKey: [k] });
    }
  };
  const opts = { onSuccess: refresh };
  return {
    issue: useMutation({
      ...opts,
      mutationFn: (i: IssueReceiptInput) => call<PartnerReceiptRow>('issue_partner_receipt', {
        p_received_from: i.received_from, p_amount: i.amount, p_method: i.method, p_purpose: i.purpose,
        p_received_on: i.received_on, p_payer_user_id: i.payer_user_id ?? null, p_payer_phone: i.payer_phone || null,
        p_instrument_no: i.instrument_no || null, p_drawn_on: i.drawn_on || null, p_branch: i.branch || 'Entebbe',
        p_deposit_request_id: i.deposit_request_id || null, p_note: i.note || null,
      }),
    }),
    confirmCash: useMutation({ ...opts, mutationFn: (id: string) => call('confirm_partner_receipt_cash', { p_receipt_id: id }) }),
    markDelivered: useMutation({
      ...opts,
      mutationFn: (a: { id: string; via: string }) => call('mark_partner_receipt_delivered', { p_receipt_id: a.id, p_via: a.via }),
    }),
    requestCorrection: useMutation({
      ...opts,
      mutationFn: (a: { id: string; kind: 'void' | 'correct'; reason: string; proposed?: Record<string, unknown> }) =>
        call('request_partner_receipt_correction', { p_receipt_id: a.id, p_kind: a.kind, p_reason: a.reason, p_proposed: a.proposed ?? {} }),
    }),
    decide: useMutation({
      ...opts,
      mutationFn: (a: { id: string; approve: boolean; note?: string }) =>
        call('decide_partner_receipt_correction', { p_correction_id: a.id, p_approve: a.approve, p_note: a.note ?? null }),
    }),
  };
}
