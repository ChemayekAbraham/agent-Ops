import type { AppRole } from '@/hooks/auth/types';

/** Roles any authenticated user can freely switch to */
export const PUBLIC_ROLES: AppRole[] = ['tenant', 'agent', 'supporter', 'landlord'];

/** Staff/admin roles that require backend assignment */
export const STAFF_ROLES: AppRole[] = [
  'manager', 'super_admin', 'employee', 'operations',
  'ceo', 'coo', 'cfo', 'cto', 'cmo', 'crm', 'hr', 'rd',
];

export function isPublicRole(role: AppRole): boolean {
  return PUBLIC_ROLES.includes(role);
}

export function isStaffRole(role: AppRole): boolean {
  return STAFF_ROLES.includes(role);
}
