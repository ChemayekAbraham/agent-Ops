import { rpc } from './reviewApi';
import { STAGE_STATUS, type CheckEntry, type Decision, type Stage } from './reviewTypes';
import { cooDecide, cooDecisionSummary, mergeApproveResults, type AskReason } from '@/lib/cooDecide';

/**
 * The second call.
 *
 * `pipeline_record_review` records the review. At Agent / Tenant / Landlord Ops
 * it also moves the request on a pass (E64) and on a reject (E69, back to the
 * agent); everywhere else the move below is the desk's own server call.
 *
 * Nothing here writes `rent_requests`: row security refuses any direct update
 * from desk staff, and it does so silently (no error, no row changed), so a
 * client write would only look like it worked.
 *
 * Nothing here invents a money path: the COO's `fund` is the existing
 * `coo_approve_rent_requests`, the server's own COO approval.
 */

type Ok = { ok: true; message: string };
type Failed = { ok: false; message: string };
export type MoveResult = Ok | Failed;

const fail = (message: string): Failed => ({ ok: false, message });
const done = (message: string): Ok => ({ ok: true, message });

/**
 * E64: at these desks `pipeline_record_review(..., 'pass')` moves the request
 * itself (Agent Ops to Tenant Ops, Tenant Ops to Landlord Ops, Landlord Ops to
 * partner_ops_approved, the COO queue). The client must not update
 * rent_requests: row security silently refuses it.
 */
export const PASS_SENT_TO = {
  agent_ops: 'Sent to Tenant Ops',
  tenant_ops: 'Sent to Landlord Ops',
  landlord_ops: 'Sent to the COO',
} as const;
export type ServerPassStage = keyof typeof PASS_SENT_TO;

/** True when the review call alone moves the request on a pass. */
export function passMovesOnServer(stage: Stage, decision: Decision): stage is ServerPassStage {
  return decision === 'pass' && stage in PASS_SENT_TO;
}

/** E69: at the same desks a recorded reject goes back to the agent, on the server. */
export function rejectMovesOnServer(stage: Stage, decision: Decision): stage is ServerPassStage {
  return decision === 'reject' && stage in PASS_SENT_TO;
}

/** What the desks say once a request has gone back to the agent in the field. */
export const SENT_BACK_TO_AGENT = 'Sent back to the agent';

/** Where each desk's pass sends the request: the toast after any pass. */
export function passSentTo(stage: Stage): string {
  if (stage in PASS_SENT_TO) return PASS_SENT_TO[stage as ServerPassStage];
  if (stage === 'service_centre') return 'Sent to Agent Ops';
  return 'Moved on';
}

/** The server's own words for a failed call, unchanged. */
export function asIs(e: unknown): string {
  return String((e as { message?: string } | null)?.message ?? e ?? 'Something went wrong.');
}

/* ───────────────────────── transfer, then pass ─────────────────────────
 * `pipeline_record_review` names the transfer's next step itself: "call
 * ops_transfer_pipeline_request_agent, then pass". So a transfer is the
 * transfer call first (nothing is recorded if it is refused), then the pass,
 * which moves the request on to Tenant Ops on the server (E64).
 *
 * The pass carries the reviewer's ticks, where "Agent performance" failed for
 * the old agent, so the server reads it as going against its "transfer"; the
 * reason on record is the transfer's own, AGENT_PERFORMANCE ("Transfer or
 * hold for agent recovery"), unless the reviewer chose one.
 */
export const TRANSFER_PASS_REASON = 'AGENT_PERFORMANCE';

export type TransferInput = {
  requestId: string;
  results: CheckEntry[];
  targetAgentId: string | null | undefined;
  /** At least 10 characters: the transfer's reason, and the pass's note. */
  note: string;
  reasonCode?: string | null;
  /** The receiving agent's name, for the confirmation. */
  targetName?: string | null;
};

export type TransferOutcome =
  | { kind: 'moved'; message: string }
  /** Nothing happened: the transfer was refused. */
  | { kind: 'transfer_failed'; message: string }
  /** The tenant is with the new agent; only the pass is left. Retry the pass, never the transfer. */
  | { kind: 'pass_failed'; message: string };

const transferredWords = (name?: string | null) => `Transferred${name ? ` to ${name}` : ''}. ${PASS_SENT_TO.agent_ops}`;

/** The pass half of a transfer: the review that moves the request on. Also the retry. */
export async function recordTransferPass(input: TransferInput): Promise<MoveResult> {
  const { error } = await rpc('pipeline_record_review', {
    p_request_id: input.requestId,
    p_stage: 'agent_ops',
    p_results: input.results,
    p_decision: 'pass',
    p_reason_code: input.reasonCode || TRANSFER_PASS_REASON,
    p_note: input.note.trim() || null,
    p_target_agent_id: null,
  });
  return error ? fail(asIs(error)) : done(transferredWords(input.targetName));
}

export async function transferThenPass(input: TransferInput): Promise<TransferOutcome> {
  if (!input.targetAgentId) return { kind: 'transfer_failed', message: 'Choose the agent to transfer the tenant to.' };
  const { error } = await rpc('ops_transfer_pipeline_request_agent', {
    p_request_id: input.requestId,
    p_to_agent_id: input.targetAgentId,
    p_reason: input.note.trim(),
  });
  if (error) return { kind: 'transfer_failed', message: asIs(error) };
  const passed = await recordTransferPass(input);
  return passed.ok ? { kind: 'moved', message: passed.message } : { kind: 'pass_failed', message: passed.message };
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
  /** Transfer only: the ticks the pass after the transfer carries. */
  results?: CheckEntry[];
  /** Transfer only: the receiving agent's name, for the confirmation. */
  targetName?: string | null;
};

/** True when this decision only records a review — nothing moves. */
export function isRecordOnly(stage: Stage, decision: Decision): boolean {
  if (decision === 'hold' || decision === 'call_again') return true;
  if (stage === 'service_centre' && decision === 'send_back') return true;
  return false;
}

export async function runMove(input: MoveInput): Promise<MoveResult> {
  const { requestId, stage, decision } = input;
  const note = input.note.trim();

  if (isRecordOnly(stage, decision)) return done('Review recorded. The request stays at this desk.');

  // ── Service Centre: one RPC does both the verify/reject and the stamp. ──
  if (stage === 'service_centre' && (decision === 'pass' || decision === 'reject')) {
    const { error } = await rpc('service_center_review_rent_request', {
      p_request_id: requestId,
      p_decision: decision === 'pass' ? 'verify' : 'reject',
      p_comment: note,
    });
    return error ? fail(asIs(error)) : done(decision === 'pass' ? passSentTo(stage) : SENT_BACK_TO_AGENT);
  }

  // ── Agent Ops transfer: the transfer call has already run (transferThenPass);
  //    the move left is the pass, which the server makes. ──
  if (decision === 'transfer') {
    return recordTransferPass({
      requestId,
      results: input.results ?? [],
      targetAgentId: input.targetAgentId,
      note,
      reasonCode: input.reasonCode,
      targetName: input.targetName,
    });
  }

  // ── Partner Ops: attach the funder side, then forward. ──
  if (decision === 'attach_funder') {
    if (!input.proxyAgentId) return fail('Choose the proxy partner to attach.');
    const { data, error } = await rpc('partner_ops_attach_proxy_and_forward', {
      p_request_ids: [requestId],
      p_proxy_agent_id: input.proxyAgentId,
      p_comment: note,
    });
    if (error) return fail(asIs(error));
    const updated = Number((data as { updated?: number } | null)?.updated ?? 0);
    return updated > 0 ? done('Proxy partner attached and forwarded to the COO.') : fail('Nothing was forwarded.');
  }

  // ── Partner Ops' old hidden-from-funders route set the status from the
  //    browser, which row security now refuses. Not offered on any desk. ──
  if (decision === 'to_coo_bucket') return fail('This forward is no longer offered on the desks.');

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
      return fail(asIs(e));
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
      return fail(asIs(e));
    }
  }

  // ── The middle desks: the review already moved the request — on a pass
  //    (E64) and on a reject (E69, back to the agent). ──
  if (passMovesOnServer(stage, decision)) return done(PASS_SENT_TO[stage]);
  if (rejectMovesOnServer(stage, decision)) return done(SENT_BACK_TO_AGENT);
  if (decision === 'pass') return fail(`No forward step is defined for ${stage}.`);

  // Send-backs go through pipeline_send_back_to (sendBackApi) on every desk but
  // Partner Ops; there the server's own return is the move.
  if (decision === 'send_back' || decision === 'reject') {
    const { error } = await rpc('return_rent_request_for_correction', {
      p_request_id: requestId,
      p_stage: STAGE_STATUS[stage],
      p_reason: note,
    });
    return error ? fail(asIs(error)) : done(SENT_BACK_TO_AGENT);
  }

  return fail(`Nothing to run for "${decision}" at ${stage}.`);
}

/** Which decisions need a note of at least ten characters before the server will take them. */
export function needsNote(decision: Decision): boolean {
  return decision === 'send_back' || decision === 'reject' || decision === 'transfer';
}
