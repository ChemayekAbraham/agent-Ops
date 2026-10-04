/**
 * Maps a dashboard identity (executive-hub tab slug, executive role, or a
 * dashboard permission key) to the `hr_departments.key` values whose budget
 * notices belong on that dashboard.
 *
 * Used only to scope the notification bell; the database enforces the same
 * scope plus the user's dashboard access, so a wrong key here can never widen
 * what a user is allowed to see.
 */
export const DASHBOARD_DEPARTMENT_KEYS: Record<string, string[]> = {
  // Operations hubs
  'tenant-ops': ['tenant_ops'],
  'agent-ops': ['agent_ops'],
  'landlord-ops': ['landlord_ops'],
  'partner-ops': ['partner_ops'],
  'partners-ops': ['partner_ops'],
  'company-ops': ['operations'],
  locations: ['operations'],

  // Executive dashboards
  cfo: ['finance'],
  'financial-ops': ['finance'],
  coo: ['operations'],
  ceo: ['board_of_directors'],
  director: ['board_of_directors'],
  cto: ['engineering', 'product_research_and_development'],
  cmo: ['marketing'],
  crm: ['partnership'],
  hr: ['interns', 'support_and_welfare'],
};

export function departmentKeysForDashboard(dashboard: string | undefined): string[] | undefined {
  if (!dashboard) return undefined;
  return DASHBOARD_DEPARTMENT_KEYS[dashboard.toLowerCase()];
}
