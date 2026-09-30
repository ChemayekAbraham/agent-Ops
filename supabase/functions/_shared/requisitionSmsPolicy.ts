/**
 * Who may receive a requisition SMS or email (cto, hr, super_admin, cfo only).
 *
 * Requisition messages carry a person's name and the amount of money they have
 * asked for. They were going out to whichever role a department happened to
 * route to — agent_ops, cmo, crm, landlord_ops, partner_ops, tenant_ops and
 * more, around 60 handsets. That is both a cost and a confidentiality problem.
 *
 * SMS is now restricted to this list. IN-APP NOTIFICATIONS ARE NOT TOUCHED:
 * whoever actually has to approve a requisition still sees it in the product,
 * so no approval can stall because of this. Only the text message is withheld.
 */
export const REQUISITION_SMS_ROLES = [
  'cto',
  'hr',
  'super_admin',
  'cfo',
] as const;

export type RequisitionSmsRole = (typeof REQUISITION_SMS_ROLES)[number];

/**
 * Narrow a set of user ids to those holding at least one role allowed to
 * receive requisition SMS.
 *
 * Fails CLOSED: if the role lookup errors we return an empty set rather than
 * fall back to messaging everyone, because the failure mode we are fixing is
 * over-sending.
 */
// deno-lint-ignore no-explicit-any
export async function requisitionSmsRecipients(admin: any, userIds: string[]): Promise<Set<string>> {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (ids.length === 0) return new Set();

  try {
    const { data, error } = await admin
      .from('user_roles')
      .select('user_id, role')
      .in('user_id', ids)
      .in('role', REQUISITION_SMS_ROLES as unknown as string[])
      .eq('enabled', true);

    if (error) {
      console.error('[requisitionSmsPolicy] role lookup failed, withholding SMS', error.message);
      return new Set();
    }
    return new Set((data || []).map((r: { user_id: string }) => r.user_id));
  } catch (e) {
    console.error('[requisitionSmsPolicy] role lookup threw, withholding SMS', e);
    return new Set();
  }
}

/** Convenience for the single-recipient case. */
// deno-lint-ignore no-explicit-any
export async function maySendRequisitionSms(admin: any, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const allowed = await requisitionSmsRecipients(admin, [userId]);
  return allowed.has(userId);
}
