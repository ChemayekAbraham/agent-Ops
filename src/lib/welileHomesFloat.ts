/**
 * Welile Homes float request flow — the only browser entry points.
 *
 * Server functions (docs/pending-migrations/welile_homes_float_link.sql):
 *   wh_request_float       agent requests float for specific subscriptions (links stored)
 *   wh_float_advance       Agent Ops / Tenant Ops / COO approve, reject or return
 *   wh_cfo_disburse_float  CFO: credit + ledger + status in one transaction (no fallback here)
 *
 * These are the only paths. There is no direct-write fallback: the database refuses any other
 * write to Welile Homes float requests, and amounts come only from linked tenant dues rows.
 */
import { supabase } from '@/integrations/supabase/client';

/** PostgREST ilike pattern for Welile Homes requests (reason always starts with "Welile Homes"). */
export const WH_REASON_ILIKE = '%welile%homes%';

export function isWelileHomesReason(reason?: string | null): boolean {
  return /welile.*homes/i.test(reason ?? '');
}

export type WhFloatAction = 'approve' | 'reject' | 'return';

export interface WhResult {
  status: string;
}

export async function advanceWelileHomesFloat(args: {
  requestId: string;
  expectedStatus: string;
  action: WhFloatAction;
  note?: string;
}): Promise<WhResult> {
  const note = (args.note ?? '').trim();
  if (args.action !== 'approve' && note.length < 5) {
    throw new Error('Add a reason of at least 5 characters');
  }
  const { data, error } = await (supabase.rpc as any)('wh_float_advance', {
    p_request_id: args.requestId,
    p_expected_status: args.expectedStatus,
    p_action: args.action,
    p_note: note || null,
  });
  if (error) throw new Error(error.message);
  return { status: String(data?.status ?? '') };
}

export async function requestWelileHomesFloat(args: {
  subscriptionIds: string[];
  recipientPhone?: string | null;
  notes?: string | null;
}): Promise<WhResult & { requestId?: string; amount: number; tenantCount: number }> {
  const ids = Array.from(new Set(args.subscriptionIds.filter(Boolean)));
  if (ids.length === 0) throw new Error('Select at least one tenant');
  const { data, error } = await (supabase.rpc as any)('wh_request_float', {
    p_subscription_ids: ids,
    p_recipient_phone: args.recipientPhone?.trim() || null,
    p_notes: args.notes?.trim() || null,
  });
  if (error) throw new Error(error.message);
  return {
    status: 'pending',
    requestId: data?.request_id,
    amount: Number(data?.amount ?? 0),
    tenantCount: Number(data?.tenant_count ?? ids.length),
  };
}
