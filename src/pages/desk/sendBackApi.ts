import { rpc } from './reviewApi';
import type { Stage } from './reviewTypes';

/**
 * The server side of "Send back…" (E63): `pipeline_send_back_to` records the
 * review and moves the request in one call. Kept apart from the form so the
 * board's push (boardApi) can use it without importing a component.
 */

/**
 * The desks that send back with `pipeline_send_back_to`. Since E64 Reject is
 * gone from these desks: "Send back" to the field agent is the reject (the
 * server sets the request to rejected); any earlier office takes it back.
 */
export const SEND_BACK_STAGES: ReadonlySet<Stage> = new Set<Stage>(['service_centre', 'agent_ops', 'tenant_ops', 'landlord_ops', 'coo']);

/** A board row whose button is "Send back": a send-back, or the system's reject (E64), on a send-back desk. */
export function isSendBackRow(decision: string | null | undefined, stage: Stage): boolean {
  return (decision === 'send_back' || decision === 'reject') && SEND_BACK_STAGES.has(stage);
}

/** The server's own words for a failed send-back, unchanged. */
export function serverMessage(e: unknown): string {
  return String((e as { message?: string } | null)?.message ?? e ?? 'The send-back did not go through.');
}

export type SendBackResult = { ok?: boolean; to?: string; to_label?: string | null; status?: string | null };

/** What the form starts on: the board's server suggestion (field agent, its reason code and note). */
export type SendBackStart = { to?: string | null; reasonCode?: string | null; note?: string | null };

/** The office for a server-suggested send-back from the board: back to the field agent to correct, as before. */
export const SUGGESTED_OFFICE = 'agent';

/**
 * The one server call behind every send-back. Returns the confirmation, or the
 * server's message unchanged.
 */
export async function sendBackTo(input: {
  requestId: string;
  stage: Stage;
  to: string;
  reasonCode: string | null;
  note: string | null;
}): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const { data, error } = await rpc('pipeline_send_back_to', {
    p_request_id: input.requestId,
    p_from_stage: input.stage,
    p_to: input.to,
    p_reason_code: input.reasonCode,
    p_note: input.note?.trim() || null,
  });
  if (error) return { ok: false, message: serverMessage(error) };
  const r = (data ?? {}) as SendBackResult;
  if (input.to === SUGGESTED_OFFICE) return { ok: true, message: 'Sent back to the agent' };
  return { ok: true, message: `Sent back to ${r.to_label ?? input.to}.` };
}

