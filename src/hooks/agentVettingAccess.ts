import { useAuth } from '@/hooks/useAuth';

/**
 * Live `get_my_agent_vetting` and the other agent-vetting writes call
 * `_agent_vetting_require_agent()`, which is `has_role(..., 'agent')`.
 * `has_role` requires `user_roles.enabled = true`. EXECUTE is granted to
 * every signed-in user; anyone else gets
 * `RAISE EXCEPTION 'Agent verification is only for agents.'` (42501 / HTTP 403).
 *
 * The dashboard role list also contains a synthetic `agent` so that dashboard
 * stays reachable. That value is not a `user_roles` row.
 */

/** True when `enabledRoles` contains a real enabled `agent` row. */
export function hasEnabledAgentRole(
  enabledRoles: readonly string[] | null | undefined,
): boolean {
  return !!enabledRoles?.includes('agent');
}

export type AgentVettingApplicability = 'loading' | 'not_applicable' | 'ready';

/**
 * `ready` is false while auth or the real enabled-role list is still loading,
 * so a not-yet-known list cannot be treated as "not an agent" and cannot fire
 * the RPC. `allowed` is true only when that list contains `agent`.
 * The client `roles` array is not consulted: it inserts a synthetic `agent`.
 */
export function useAgentVettingGate(): { ready: boolean; allowed: boolean } {
  const { user, session, loading, rolesResolved, enabledRoles } = useAuth();
  const signedIn = !loading && !!user?.id && !!session?.access_token;
  const ready = signedIn && rolesResolved;
  return { ready, allowed: ready && hasEnabledAgentRole(enabledRoles) };
}

export function agentVettingApplicability(gate: { ready: boolean; allowed: boolean }): AgentVettingApplicability {
  if (!gate.ready) return 'loading';
  return gate.allowed ? 'ready' : 'not_applicable';
}

/** Neutral result for a caller who is not a real agent. Not an error. */
export const AGENT_VETTING_NOT_APPLICABLE = 'Agent verification is not applicable.';

/**
 * Where a signed-in non-agent is sent instead of the verification screen.
 * Null means stay (still resolving roles, or the caller is a real agent).
 */
export function agentVettingRedirect(applicability: AgentVettingApplicability): '/dashboard' | null {
  return applicability === 'not_applicable' ? '/dashboard' : null;
}
