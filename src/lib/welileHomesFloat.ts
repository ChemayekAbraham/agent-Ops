/**
 * Welile Homes float request flow — the only browser entry points.
 *
 * Server functions (docs/pending-migrations/welile_homes_float_link.sql):
 *   wh_request_float       agent requests float for specific subscriptions (links stored)
 *   wh_float_advance       Agent Ops / Tenant Ops / COO approve, reject or return
 *   wh_cfo_disburse_float  CFO: credit + ledger + status in one transaction (no fallback here)
 *
 * Until that migration is applied the functions do not exist. Request and stage moves then fall
 * back to the previous direct writes so the desks keep working; every fallback is guarded on the
 * expected current status so two reviewers can never move the same request twice. Once the
 * migration is live the server functions are used and the database refuses the old writes.
 * Disbursement never falls back: money only moves through the server.
 */
import { supabase } from '@/integrations/supabase/client';

/** PostgREST ilike pattern for Welile Homes requests (reason always starts with "Welile Homes"). */
export const WH_REASON_ILIKE = '%welile%homes%';

export function isWelileHomesReason(reason?: string | null): boolean {
  return /welile.*homes/i.test(reason ?? '');
}

export function isMissingServerFunction(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  const code = String(e?.code ?? '');
  const msg = String(e?.message ?? '');
  return code === 'PGRST202' || code === '42883' || /could not find the function/i.test(msg);
}

export type WhFloatAction = 'approve' | 'reject' | 'return';

/** Same transition table as wh_float_advance. */
const TRANSITIONS: Record<string, Partial<Record<WhFloatAction, string>>> = {
  pending: { approve: 'agent_ops_approved', reject: 'rejected' },
  agent_ops_approved: { approve: 'tenant_ops_approved', reject: 'rejected', return: 'pending' },
  tenant_ops_approved: { approve: 'coo_approved', reject: 'rejected', return: 'agent_ops_approved' },
  coo_approved: { reject: 'rejected', return: 'tenant_ops_approved' },
};

export interface WhResult {
  status: string;
  /** 'server' = new linked flow; 'legacy' = migration not applied yet. */
  mode: 'server' | 'legacy';
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
  if (!error) return { status: String(data?.status ?? ''), mode: 'server' };
  if (!isMissingServerFunction(error)) throw new Error(error.message);

  const next = TRANSITIONS[args.expectedStatus]?.[args.action];
  if (!next) throw new Error(`"${args.action}" is not available at stage "${args.expectedStatus}"`);

  const patch: Record<string, unknown> = { status: next, updated_at: new Date().toISOString() };
  if (args.action !== 'approve') patch.rejection_reason = note;

  const { data: rows, error: upErr } = await supabase
    .from('float_requests')
    .update(patch as never)
    .eq('id', args.requestId)
    .eq('status', args.expectedStatus)
    .select('id');
  if (upErr) throw new Error(upErr.message);
  if (!rows || rows.length === 0) {
    throw new Error('This request was already changed by someone else. Refresh and try again.');
  }
  return { status: next, mode: 'legacy' };
}

export async function requestWelileHomesFloat(args: {
  agentId: string;
  subscriptionIds: string[];
  /** Used only by the pre-migration fallback; the server computes the amount itself. */
  legacyAmount: number;
  tenantCount: number;
  recipientPhone?: string | null;
  notes?: string | null;
}): Promise<WhResult & { requestId?: string }> {
  const ids = Array.from(new Set(args.subscriptionIds.filter(Boolean)));
  if (ids.length === 0) throw new Error('Select at least one tenant');

  const { data, error } = await (supabase.rpc as any)('wh_request_float', {
    p_subscription_ids: ids,
    p_recipient_phone: args.recipientPhone?.trim() || null,
    p_notes: args.notes?.trim() || null,
  });
  if (!error) return { status: 'pending', mode: 'server', requestId: data?.request_id };
  if (!isMissingServerFunction(error)) throw new Error(error.message);

  const notes = args.notes?.trim();
  const { data: row, error: insErr } = await supabase
    .from('float_requests')
    .insert({
      agent_id: args.agentId,
      requested_amount: args.legacyAmount,
      reason: `Welile Homes landlord float (${args.tenantCount} tenants)${notes ? `: ${notes}` : ''}`,
      expected_recipient_phone: args.recipientPhone?.trim() || null,
      status: 'pending',
    })
    .select('id')
    .single();
  if (insErr) throw new Error(insErr.message);
  return { status: 'pending', mode: 'legacy', requestId: row?.id };
}
