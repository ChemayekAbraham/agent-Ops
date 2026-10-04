import type { AppRole } from '@/hooks/auth/types';

/**
 * Deposit purposes are role-scoped. Agents can route money into agent-only
 * buckets (operational float, partnership deposits on behalf of partners).
 * Funders/Supporters and other end-users should never see those agent-only
 * labels on their receipts or history — they're internal-to-agents concepts.
 */
export type DepositPurposeId =
  | 'operational_float'
  | 'personal_deposit'
  | 'partnership_deposit'
  | 'personal_rent_repayment'
  | 'other';

const AGENT_ONLY_PURPOSES: ReadonlySet<DepositPurposeId> = new Set([
  'operational_float',
  'partnership_deposit',
]);

/** Roles that are permitted to see the agent-only purpose labels. */
const AGENT_PURPOSE_ROLES: ReadonlySet<AppRole> = new Set<AppRole>([
  'agent',
  'manager',
]);

/**
 * Returns true if the given purpose should be visible to this viewer.
 * Funders/supporters/tenants/landlords never see agent-only purposes.
 */
export function canViewDepositPurpose(
  purpose: string | null | undefined,
  viewerRole: AppRole | null | undefined,
): boolean {
  if (!purpose) return false;
  if (!AGENT_ONLY_PURPOSES.has(purpose as DepositPurposeId)) return true;
  if (!viewerRole) return false;
  return AGENT_PURPOSE_ROLES.has(viewerRole);
}