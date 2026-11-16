/**
 * Roles the server's `_desk_viewer_ok` accepts for desk read RPCs such as
 * `agent_eligibility_of` and `pipeline_waiting_list`. Used only to skip calls
 * that would be refused; the server still decides.
 */
export const DESK_VIEWER_ROLES: readonly string[] = [
  'agent_ops', 'operations', 'manager', 'tenant_ops', 'landlord_ops', 'partner_ops',
  'coo', 'ceo', 'cfo', 'cto', 'super_admin', 'financial_ops',
];

export function canViewDeskReads(enabledRoles: readonly string[] | null | undefined): boolean {
  return !!enabledRoles?.some((r) => DESK_VIEWER_ROLES.includes(r));
}
