/**
 * Sole-CFO-approver gate.
 *
 * Backend enforcement for the CFO Dashboard approval queues: only the user(s)
 * listed in `public.cfo_approval_approvers` who also hold the `cfo` role may
 * approve, reject, authorize or disburse a CFO-stage request. Everyone else who
 * can reach the CFO Dashboard is read-only for approvals.
 *
 * The authority check is the database function `public.is_cfo_approver(uuid)`,
 * which is also enforced inside every CFO decision RPC. This helper covers the
 * edge-function approval paths.
 */

/** True only when the user is the designated CFO approver. */
export async function isCfoApprover(
  // deno-lint-ignore no-explicit-any
  serviceClient: any,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId) return false;
  const { data, error } = await serviceClient.rpc('is_cfo_approver', { _user_id: userId });
  if (error) {
    console.error('[cfoApprovalGate] is_cfo_approver failed:', error.message);
    return false; // fail closed
  }
  return data === true;
}

export const CFO_APPROVER_DENIED_MESSAGE = 'This request could not be completed.';

/** Standard, non-disclosing 403 for a caller who may not act here. */
export function cfoApproverDenied(corsHeaders: Record<string, string>): Response {
  return new Response(
    JSON.stringify({ error: CFO_APPROVER_DENIED_MESSAGE }),
    { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
}

/**
 * Returns a 403 Response when the caller may not act as the CFO approver,
 * or `null` when the caller is cleared to proceed.
 */
export async function guardCfoApprover(
  // deno-lint-ignore no-explicit-any
  serviceClient: any,
  userId: string | null | undefined,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  return (await isCfoApprover(serviceClient, userId)) ? null : cfoApproverDenied(corsHeaders);
}
