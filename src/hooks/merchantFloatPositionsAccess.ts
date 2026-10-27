import { useAuth } from '@/hooks/useAuth';
import { isUnauthenticatedRpcError } from '@/hooks/useAuthenticatedPoll';

/**
 * Live `get_merchant_float_positions(boolean)` allows these roles, plus
 * service_role (the browser never is). EXECUTE is granted to every signed-in
 * user; anyone else hits `RAISE EXCEPTION 'Not authorized'` (P0001, HTTP 400).
 * `has_role` requires `user_roles.enabled = true`. `financial_ops` is a real
 * role and is not part of the `AppRole` union. `cto` is not on this list.
 */
export const MERCHANT_FLOAT_POSITION_ROLES = [
  'cfo',
  'financial_ops',
  'manager',
  'super_admin',
  'ceo',
  'coo',
] as const;

const MERCHANT_FLOAT_POSITION_ROLE_SET = new Set<string>(MERCHANT_FLOAT_POSITION_ROLES);

/**
 * True when `enabledRoles` contains a role the RPC accepts.
 * `enabledRoles` is the CRM-inbox source: `user_roles` rows with
 * `enabled = true`, without the synthetic dashboard `agent`.
 */
export function hasMerchantFloatPositionRole(
  enabledRoles: readonly string[] | null | undefined,
): boolean {
  return (enabledRoles ?? []).some((role) => MERCHANT_FLOAT_POSITION_ROLE_SET.has(role));
}

/**
 * Postgres `RAISE EXCEPTION 'Not authorized'` from this RPC (P0001 / HTTP 400),
 * a 403, or a missing user JWT. A statement timeout is not one of these — the
 * board may try again.
 */
export function stopMerchantFloatPositionsPoll(error: unknown): boolean {
  if (isUnauthenticatedRpcError(error)) return true;
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: string; message?: string; status?: number; statusCode?: number };
  const code = String(e.code || '').toUpperCase();
  const msg = String(e.message || '').toLowerCase();
  const notAuthorized = msg.includes('not authorized') || msg.includes('not authorised');
  if (!notAuthorized) return false;
  const status = Number(e.status ?? e.statusCode);
  if (status === 400 || status === 403) return true;
  return code === 'P0001' || code === '42501' || code === '';
}

export function merchantFloatPositionsDeniedError(): Error & { code: string } {
  const denied = new Error('Not authorized') as Error & { code: string };
  denied.code = 'P0001';
  return denied;
}

/**
 * `ready` is false while auth or the real enabled-role list is still loading,
 * so a not-yet-known list cannot be treated as a refusal.
 * `allowed` is true only when that list contains a role the RPC accepts.
 * The client `roles` array is not consulted: it inserts a synthetic `agent`.
 */
export function useMerchantFloatPositionsGate(): { ready: boolean; allowed: boolean } {
  const { user, session, loading, rolesResolved, enabledRoles } = useAuth();
  const signedIn = !loading && !!user?.id && !!session?.access_token;
  const ready = signedIn && rolesResolved;
  return { ready, allowed: ready && hasMerchantFloatPositionRole(enabledRoles) };
}
