import type { AppRole } from '@/hooks/auth/types';
import { dashboardLabel, type DashboardAccessKey } from '@/lib/dashboardAccessKeys';
import { isPublicRole } from '@/lib/roleConstants';

export interface DashboardAccessRule {
  key: DashboardAccessKey;
  label: string;
  route: string;
  allowedRoles: AppRole[];
  requiredPermission: string | string[] | undefined;
  skipAllowlist: boolean;
}

// Main guarded dashboard routes only. Unmatched keys are reported separately;
// inventing a guard for a tab or an unguarded page would misrepresent access.
export const DASHBOARD_ACCESS_RULES: DashboardAccessRule[] = [
  { key: 'ceo', label: dashboardLabel('ceo'), route: '/ceo/dashboard', allowedRoles: ['ceo', 'super_admin', 'cto'], requiredPermission: 'ceo', skipAllowlist: false },
  { key: 'cto', label: dashboardLabel('cto'), route: '/cto/dashboard', allowedRoles: ['cto', 'super_admin'], requiredPermission: 'cto', skipAllowlist: false },
  { key: 'cfo', label: dashboardLabel('cfo'), route: '/cfo/dashboard', allowedRoles: ['cfo', 'super_admin', 'cto'], requiredPermission: 'cfo', skipAllowlist: false },
  { key: 'coo', label: dashboardLabel('coo'), route: '/coo/dashboard', allowedRoles: ['coo', 'super_admin', 'cto'], requiredPermission: 'coo', skipAllowlist: false },
  { key: 'cmo', label: dashboardLabel('cmo'), route: '/cmo/dashboard', allowedRoles: ['cmo', 'super_admin', 'cto'], requiredPermission: 'cmo', skipAllowlist: false },
  { key: 'crm', label: dashboardLabel('crm'), route: '/crm/dashboard', allowedRoles: ['crm', 'super_admin', 'cto'], requiredPermission: 'crm', skipAllowlist: false },
  { key: 'director', label: dashboardLabel('director'), route: '/director/dashboard', allowedRoles: ['ceo', 'super_admin', 'manager'], requiredPermission: 'director', skipAllowlist: false },
  { key: 'financial-ops', label: dashboardLabel('financial-ops'), route: '/admin/financial-ops', allowedRoles: ['super_admin', 'manager', 'coo', 'cfo', 'employee', 'operations'], requiredPermission: 'financial-ops', skipAllowlist: false },
  { key: 'company-ops', label: dashboardLabel('company-ops'), route: '/admin/users', allowedRoles: ['super_admin', 'manager', 'cto'], requiredPermission: 'company-ops', skipAllowlist: false },
  { key: 'platform-users', label: dashboardLabel('platform-users'), route: '/platform-users', allowedRoles: ['super_admin', 'ceo', 'coo', 'cfo', 'cto', 'cmo', 'crm', 'hr', 'manager', 'operations', 'employee'], requiredPermission: undefined, skipAllowlist: true },
  { key: 'landlord-ops', label: dashboardLabel('landlord-ops'), route: '/landlord-ops', allowedRoles: ['ceo', 'cto', 'cmo', 'crm', 'coo', 'cfo', 'super_admin', 'manager', 'employee', 'operations'], requiredPermission: 'landlord-ops', skipAllowlist: false },
  { key: 'hr', label: dashboardLabel('hr'), route: '/hr/dashboard', allowedRoles: ['hr', 'super_admin'], requiredPermission: 'hr', skipAllowlist: false },
  { key: 'rd', label: dashboardLabel('rd'), route: '/rd/*', allowedRoles: ['rd', 'super_admin', 'cto', 'ceo', 'employee'], requiredPermission: 'rd', skipAllowlist: false },
  { key: 'kyc', label: dashboardLabel('kyc'), route: '/admin/kyc', allowedRoles: ['super_admin', 'manager', 'cfo', 'operations'], requiredPermission: 'kyc', skipAllowlist: false },
];

export function toServerRules() {
  return DASHBOARD_ACCESS_RULES.map(({ key, allowedRoles, requiredPermission, skipAllowlist }) => ({
    key,
    list_keys: requiredPermission
      ? (Array.isArray(requiredPermission) ? requiredPermission : [requiredPermission])
      : [key],
    allowlist_applies: !skipAllowlist && (
      !!requiredPermission || (allowedRoles.length > 0 && allowedRoles.every((r) => !isPublicRole(r)))
    ),
    allowed_roles: allowedRoles,
    ...(key === 'platform-users' ? { also_requires_role: 'manager', data_gate: 'platform_user_admin' } : {}),
  }));
}