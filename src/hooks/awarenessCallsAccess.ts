import { useAuth } from '@/hooks/useAuth';

/**
 * Live `my_awareness_calls_summary` / `my_awareness_calls_log` allow these
 * staff roles, or a user who is `service_center_manager_id` on some rent
 * request. `has_role` requires `user_roles.enabled = true`. The service-centre
 * case is not a role, so the client still tries once for everyone else.
 */
export const AWARENESS_CALLS_STAFF_ROLES = [
  'tenant_ops',
  'landlord_ops',
  'agent_ops',
  'operations',
  'manager',
  'super_admin',
  'coo',
  'ceo',
  'cto',
  'cfo',
] as const;

const AWARENESS_CALLS_STAFF_ROLE_SET = new Set<string>(AWARENESS_CALLS_STAFF_ROLES);

/**
 * True when `enabledRoles` contains a staff role the RPC accepts.
 * Same source as the CRM inbox: real enabled rows, no synthetic `agent`.
 */
export function hasAwarenessCallsStaffRole(
  enabledRoles: readonly string[] | null | undefined,
): boolean {
  return (enabledRoles ?? []).some((role) => AWARENESS_CALLS_STAFF_ROLE_SET.has(role));
}

/**
 * `ready` waits for the real enabled-role list. `staff` is false for a
 * service-centre manager who has none of the staff roles; that caller is
 * still allowed by the database, so the hooks fetch once.
 */
export function useAwarenessCallsGate(): { ready: boolean; staff: boolean } {
  const { user, session, loading, rolesResolved, enabledRoles } = useAuth();
  const ready = !loading && !!user?.id && !!session?.access_token && rolesResolved;
  return { ready, staff: ready && hasAwarenessCallsStaffRole(enabledRoles) };
}
