import type { AppRole } from '@/hooks/useAuth';
import { useAuth } from '@/hooks/useAuth';
import {
  isUnauthenticatedRpcError,
  useAuthenticatedAudience,
} from '@/hooks/useAuthenticatedPoll';

/**
 * Live `get_merchant_float_positions(boolean)` allows these roles, plus
 * service_role (the browser never is). EXECUTE is granted to every signed-in
 * user; anyone else hits `RAISE EXCEPTION 'Not authorized'` (P0001).
 * `financial_ops` is a real `user_roles` value and is not part of `AppRole`.
 */
export const MERCHANT_FLOAT_POSITION_ROLES: readonly AppRole[] = [
  'cfo',
  'financial_ops' as AppRole,
  'manager',
  'super_admin',
  'ceo',
  'coo',
];

/**
 * Postgres `RAISE EXCEPTION 'Not authorized'` from this RPC, or a missing user
 * JWT. A statement timeout is not one of these — the board may try again.
 */
export function stopMerchantFloatPositionsPoll(error: unknown): boolean {
  if (isUnauthenticatedRpcError(error)) return true;
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: string; message?: string };
  const code = String(e.code || '').toUpperCase();
  const msg = String(e.message || '').toLowerCase();
  const notAuthorized = msg.includes('not authorized') || msg.includes('not authorised');
  if (!notAuthorized) return false;
  return code === 'P0001' || code === '42501' || code === '';
}

export function merchantFloatPositionsDeniedError(): Error & { code: string } {
  const denied = new Error('Not authorized') as Error & { code: string };
  denied.code = 'P0001';
  return denied;
}

/**
 * `ready` is false while auth or the role list is still loading, so a
 * not-yet-known role list cannot be treated as a refusal (that error sticks).
 * `allowed` is true only for a role the RPC itself accepts.
 */
export function useMerchantFloatPositionsGate(): { ready: boolean; allowed: boolean } {
  const { loading, rolesResolved } = useAuth();
  const allowed = useAuthenticatedAudience(MERCHANT_FLOAT_POSITION_ROLES);
  return { ready: !loading && (rolesResolved || allowed), allowed };
}
