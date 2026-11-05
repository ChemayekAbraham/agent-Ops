/**
 * Welile Homes float request flow — the only browser entry points.
 *
 * Server functions (applied 2026-11-02; source docs/pending-migrations/welile_homes_float_link.sql):
 *   wh_request_float       agent requests float for specific subscriptions (links stored)
 *   wh_float_advance       Agent Ops / Tenant Ops / Landlord Ops / COO approve; any stage returns or rejects
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

/**
 * Stage chain (server-enforced in wh_float_advance):
 * pending → Agent Ops → agent_ops_approved → Tenant Ops → tenant_ops_approved → Landlord Ops →
 * landlord_ops_approved → COO → coo_approved → CFO disburses (wh_cfo_disburse_float).
 * Any stage may return to the agent (returned_to_agent) or reject, each with a reason.
 */
export const WH_FLOAT_STAGES = [
  { key: 'agent', label: 'Agent', status: null as string | null },
  { key: 'agent_ops', label: 'Agent Ops', status: 'pending' },
  { key: 'tenant_ops', label: 'Tenant Ops', status: 'agent_ops_approved' },
  { key: 'landlord_ops', label: 'Landlord Ops', status: 'tenant_ops_approved' },
  { key: 'coo', label: 'COO', status: 'landlord_ops_approved' },
  { key: 'cfo', label: 'CFO', status: 'coo_approved' },
] as const;

/** Which desk must act on a request in this status, or null when nobody needs to. */
export function whStageForStatus(status?: string | null): string | null {
  return WH_FLOAT_STAGES.find((s) => s.status === status)?.key ?? null;
}

export function whStatusLabel(status?: string | null): string {
  switch (status) {
    case 'pending': return 'Pending – awaiting Agent Ops review';
    case 'agent_ops_approved': return 'Awaiting Tenant Ops review';
    case 'tenant_ops_approved': return 'Awaiting Landlord Ops review';
    case 'landlord_ops_approved': return 'Awaiting COO approval';
    case 'coo_approved': return 'Awaiting CFO disbursement';
    case 'approved': case 'funded': case 'disbursed': return 'Disbursed by CFO';
    case 'returned_to_agent': return 'Returned to agent';
    case 'rejected': return 'Rejected';
    default: return status || 'Unknown';
  }
}

export interface WhFloatEvent {
  float_request_id: string;
  from_status: string | null;
  to_status: string;
  action: 'submitted' | 'approved' | 'returned' | 'rejected' | 'disbursed' | string;
  stage: string | null;
  actor_id: string | null;
  actor_name: string | null;
  note: string | null;
  created_at: string;
}

export async function fetchWhFloatHistory(requestIds: string[]): Promise<Map<string, WhFloatEvent[]>> {
  const out = new Map<string, WhFloatEvent[]>();
  const ids = Array.from(new Set(requestIds.filter(Boolean)));
  if (ids.length === 0) return out;
  const { data, error } = await (supabase.rpc as any)('wh_float_request_history', { p_request_ids: ids });
  if (error) throw new Error(error.message);
  for (const e of (data ?? []) as WhFloatEvent[]) {
    const list = out.get(e.float_request_id) ?? [];
    list.push(e);
    out.set(e.float_request_id, list);
  }
  return out;
}

export interface WhReviewRow {
  id: string; agent_id: string; agent_name: string | null; agent_phone: string | null;
  requested_amount: number; reason: string | null; expected_recipient_phone: string | null;
  status: string; rejection_reason: string | null; created_at: string; updated_at: string | null;
  tenant_count: number;
}

export async function fetchWhReviewQueue(): Promise<WhReviewRow[]> {
  const { data, error } = await (supabase.rpc as any)('wh_float_review_queue', { p_limit: 300 });
  if (error) throw new Error(error.message);
  return (data ?? []) as WhReviewRow[];
}
