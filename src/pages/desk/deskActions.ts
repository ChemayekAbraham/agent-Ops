import { supabase } from '@/integrations/supabase/client';
import { rpc } from './reviewApi';
import { STAGE_STATUS, type Decision, type Stage } from './reviewTypes';
import { cooDecide, cooDecisionSummary, mergeApproveResults, type AskReason } from '@/lib/cooDecide';

/**
 * The second call.
 *
 * `pipeline_record_review` only records the review — it never moves a request.
 * Everything below is the move the desks already make today, called exactly as
 * the existing screens call it, so a request reviewed here lands in the same
 * state as one reviewed on the old screen.
 *
 * Nothing here invents a money path: the COO's `fund` is the existing
 * `coo_approve_rent_requests`, the server's own COO approval.
 */

type Ok = { ok: true; message: string };
type Failed = { ok: false; message: string };
export type MoveResult = Ok | Failed;

const fail = (message: string): Failed => ({ ok: false, message });
const done = (message: string): Ok => ({ ok: true, message });

/** The columns each desk stamps when it acts, as the existing pipeline screen stamps them. */
const STAMP: Partial<Record<Stage, { by: string; at: string; comment: string }>> = {
  agent_ops: { by: 'agent_ops_reviewed_by', at: 'agent_ops_reviewed_at', comment: 'agent_ops_comment' },
  tenant_ops: { by: 'tenant_ops_reviewed_by', at: 'tenant_ops_reviewed_at', comment: 'tenant_ops_comment' },
  landlord_ops: { by: 'landlord_ops_reviewed_by', at: 'landlord_ops_reviewed_at', comment: 'landlord_ops_comment' },
  partner_ops: { by: 'partner_ops_reviewed_by', at: 'partner_ops_reviewed_at', comment: 'partner_ops_comment' },
};

/** The status a desk sets when it passes the request on. Partner Ops has no plain pass. */
const NEXT_STATUS: Partial<Record<Stage, string>> = {
  agent_ops: 'agent_ops_approved',
  tenant_ops: 'tenant_ops_approved',
  landlord_ops: 'landlord_ops_approved',
};

async function patchRequest(requestId: string, patch: Record<string, unknown>): Promise<MoveResult> {
  const { error } = await supabase.from('rent_requests').update(patch as never).eq('id', requestId);
  if (error) return fail(error.message);
  return done('Moved on.');
}

export type MoveInput = {
  requestId: string;
  stage: Stage;
  decision: Decision;
  userId: string;
  /** The reviewer's note. Send-backs, rejects and transfers need at least 10 characters. */
  note: string;
  targetAgentId?: string | null;
  proxyAgentId?: string | null;
  /** COO only: the reason code already chosen for going against the system, if any. */
  reasonCode?: string | null;
  /** COO only: asks the COO why when the server answers REASON_REQUIRED. */
  askReason?: AskReason;
  /** COO only: turns a reason code into its meaning for the summary line. */
  reasonMeaning?: (code: string | null) => string | null;
};

/** True when this decision only records a review — nothing moves. */
export function isRecordOnly(stage: Stage, decision: Decision): boolean {
  if (decision === 'hold' || decision === 'call_again') return true;
  if (stage === 'service_centre' && decision === 'send_back') return true;
  return false;
}

export async function runMove(input: MoveInput): Promise<MoveResult> {
  const { requestId, stage, decision, userId } = input;
  const note = input.note.trim();
  const now = new Date().toISOString();

  if (isRecordOnly(stage, decision)) return done('Review recorded. The request stays at this desk.');

  // ── Service Centre: one RPC does both the verify/reject and the stamp. ──
  if (stage === 'service_centre' && (decision === 'pass' || decision === 'reject')) {
    const { error } = await rpc('service_center_review_rent_request', {
      p_request_id: requestId,
      p_decision: decision === 'pass' ? 'verify' : 'reject',
      p_comment: note,
    });
    return error ? fail(error.message) : done(decision === 'pass' ? 'Verified and sent to Agent Ops.' : 'Rejected.');
  }

  // ── Agent Ops: move the tenant to a stronger agent. ──
  if (decision === 'transfer') {
    if (!input.targetAgentId) return fail('Choose the agent to transfer the tenant to.');
    const { error } = await rpc('ops_transfer_pipeline_request_agent', {
      p_request_id: requestId,
      p_to_agent_id: input.targetAgentId,
      p_reason: note,
    });
    return error ? fail(error.message) : done('Tenant transferred to the chosen agent.');
  }

  // ── Partner Ops: attach the funder side, then forward. ──
  if (decision === 'attach_funder') {
    if (!input.proxyAgentId) return fail('Choose the proxy partner to attach.');
    const { data, error } = await rpc('partner_ops_attach_proxy_and_forward', {
      p_request_ids: [requestId],
      p_proxy_agent_id: input.proxyAgentId,
      p_comment: note,
    });
    if (error) return fail(error.message);
    const updated = Number((data as { updated?: number } | null)?.updated ?? 0);
    return updated > 0 ? done('Proxy partner attached and forwarded to the COO.') : fail('Nothing was forwarded.');
  }

  // ── Partner Ops: the hidden-from-funders route, the same forward Landlord Ops
  //    already makes for a request the funders never see. ──
  if (decision === 'to_coo_bucket') {
    return patchRequest(requestId, {
      status: 'partner_ops_approved',
      partner_ops_reviewed_by: userId,
      partner_ops_reviewed_at: now,
      partner_ops_comment:
        `No proxy attached — not published to the Funder dashboard.` + (note ? ` Partner Ops note: ${note}` : ''),
      updated_at: now,
    });
  }

  // ── COO. ──
  if (stage === 'coo' && decision === 'fund') {
    try {
      const o = await cooDecide(
        rpc as never,
        { ids: [requestId], decision: 'approve', reasonCode: input.reasonCode, reasonText: note || null },
        input.askReason,
      );
      const res = mergeApproveResults(o.response);
      const summary = cooDecisionSummary(o.response, input.reasonMeaning?.(o.reasonCode) ?? o.reasonCode);
      if (res.approved.length > 0) return done(`Approved and sent to the CFO for funding. ${summary}.`);
      return fail(res.skipped[0]?.message || 'The COO approval did not go through — check the reason on the request and try again.');
    } catch (e) {
      return fail((e as Error).message);
    }
  }
  if (stage === 'coo' && decision === 'send_back') {
    try {
      const o = await cooDecide(
        rpc as never,
        { ids: [requestId], decision: 'return', reasonCode: input.reasonCode, reasonText: note },
        input.askReason,
      );
      const item = o.response.items[0];
      if (item && !item.ok) return fail(item.error || 'Not returned.');
      return done(`Returned for correction. ${cooDecisionSummary(o.response, input.reasonMeaning?.(o.reasonCode) ?? o.reasonCode)}.`);
    } catch (e) {
      return fail((e as Error).message);
    }
  }

  // ── The middle desks: pass forwards, send back and reject both return the
  //    request for correction (the existing behaviour of those screens). ──
  if (decision === 'pass') {
    const next = NEXT_STATUS[stage];
    const stamp = STAMP[stage];
    if (!next || !stamp) return fail(`No forward step is defined for ${stage}.`);
    return patchRequest(requestId, {
      status: next,
      [stamp.by]: userId,
      [stamp.at]: now,
      [stamp.comment]: note || null,
      updated_at: now,
    });
  }

  if (decision === 'send_back' || decision === 'reject') {
    const { error } = await rpc('return_rent_request_for_correction', {
      p_request_id: requestId,
      p_stage: STAGE_STATUS[stage],
      p_reason: note,
    });
    if (error) return fail(error.message);
    const stamp = STAMP[stage];
    if (stamp) {
      // Stamp the reviewer and this desk's comment, as the existing screen does.
      await supabase
        .from('rent_requests')
        .update({ [stamp.by]: userId, [stamp.at]: now, [stamp.comment]: note } as never)
        .eq('id', requestId);
    }
    return done('Returned to the agent for correction.');
  }

  return fail(`Nothing to run for "${decision}" at ${stage}.`);
}

/** Which decisions need a note of at least ten characters before the server will take them. */
export function needsNote(decision: Decision): boolean {
  return decision === 'send_back' || decision === 'reject' || decision === 'transfer';
}
