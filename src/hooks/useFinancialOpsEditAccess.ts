import { useAuth } from '@/hooks/useAuth';

/**
 * Merchant balance corrections ("Fix balance") are a Financial Ops–only power.
 * This hook drives read-only UI ONLY. Enforcement lives in the database:
 * every write path goes through a `finops_*` gateway function that re-checks
 * the role, logs unauthorized attempts (name, phone, role, IP, device) and
 * fires an immediate security notification.
 */
export function useFinancialOpsEditAccess() {
  const { roles } = useAuth();
  // Must mirror the RPC's own role gate exactly (see set_merchant_desk_float_to /
  // finops_set_merchant_desk_float_to): cfo, financial_ops or super_admin. The
  // database is the real enforcement point either way — this only controls
  // whether the button renders.
  const canEdit =
    Array.isArray(roles) &&
    (roles.includes('financial_ops' as any) ||
      roles.includes('cfo' as any) ||
      roles.includes('super_admin' as any));
  return {
    canEdit,
    readOnlyReason:
      'Read-only: only the Financial Ops role can change merchant balances. Attempts are logged and reported.',
  };
}