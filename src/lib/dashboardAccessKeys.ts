/**
 * Dashboard allowlist keys (staff_permissions.permitted_dashboard) with
 * display labels. Must match public.dashboard_access_keys() on the server
 * (migration 20261021180000): a key missing here cannot be shown, a key
 * missing there cannot be granted.
 */
export const DASHBOARD_ACCESS_KEYS = [
  { key: 'ceo', label: 'CEO Dashboard' },
  { key: 'cto', label: 'CTO Dashboard' },
  { key: 'cfo', label: 'CFO Dashboard' },
  { key: 'coo', label: 'COO Dashboard' },
  { key: 'cmo', label: 'CMO Dashboard' },
  { key: 'crm', label: 'CRM Dashboard' },
  { key: 'director', label: 'Director Dashboard' },
  { key: 'financial-ops', label: 'Financial Ops' },
  { key: 'company-ops', label: 'Company Staff' },
  { key: 'platform-users', label: 'Platform Users' },
  { key: 'agent-ops', label: 'Agent Ops' },
  { key: 'tenant-ops', label: 'Tenant Ops' },
  { key: 'landlord-ops', label: 'Landlord Ops' },
  { key: 'partner-ops', label: 'Partner Ops' },
  { key: 'hr', label: 'HR Dashboard' },
  { key: 'rd', label: 'R&D Dashboard' },
  { key: 'kyc', label: 'KYC Console' },
  { key: 'agents-space', label: "Agents' Space" },
] as const;

export type DashboardAccessKey = (typeof DASHBOARD_ACCESS_KEYS)[number]['key'];

export function dashboardLabel(key: string): string {
  return DASHBOARD_ACCESS_KEYS.find((d) => d.key === key)?.label ?? key;
}
