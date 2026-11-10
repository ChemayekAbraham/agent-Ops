import { STAFF_ROLES } from '@/lib/roleConstants';

/**
 * Who may see the 360-day pricing status, and who may change it.
 * The switch stays a CFO / COO / super admin action. Other staff only read.
 * Customer roles (tenant, agent, landlord, supporter, senior agent, sub agent)
 * are not in this list.
 */
const OPS_STAFF_ROLES = [
  'admin',
  'access_admin',
  'tenant_ops',
  'landlord_ops',
  'agent_ops',
  'financial_ops',
  'partner_ops',
] as const;

export const V360_CAN_CHANGE_ROLES = ['cfo', 'coo', 'super_admin'] as const;

export const V360_STAFF_BANNER_ROLES: readonly string[] = [
  ...STAFF_ROLES,
  ...OPS_STAFF_ROLES,
];

const BANNER_ROLE_SET = new Set<string>(V360_STAFF_BANNER_ROLES);
const CHANGE_ROLE_SET = new Set<string>(V360_CAN_CHANGE_ROLES);

export const V360_STAFF_PRICING_MEANING =
  'OFF = new Rent Plans use current pricing; ON = new Rent Plans get 360-day pricing. On a 360-day plan, tenant agent commission is 8% of Gross (6% sub-agent and 2% general agent) and the Cover Pool is segregated. A 360-day plan sets aside 15% for Partner Rent profit share; each partner earns their own Rent profit share rate (new partners: the current new-partner rate), not guaranteed. Existing plans are never repriced.';

export const V360_STAFF_PRICING_CONTROL =
  'CFO, COO and super admin control this switch from their dashboards. Other staff can see the status and cannot change it.';

export function canSeeV360StaffPricingBanner(roles: readonly string[] | null | undefined): boolean {
  if (!roles?.length) return false;
  return roles.some((role) => BANNER_ROLE_SET.has(role));
}

export function canChangeV360NewPlans(roles: readonly string[] | null | undefined): boolean {
  if (!roles?.length) return false;
  return roles.some((role) => CHANGE_ROLE_SET.has(role));
}
