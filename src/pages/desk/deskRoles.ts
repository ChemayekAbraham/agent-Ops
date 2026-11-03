// Generated with the desk_feed migration: which roles may open which desk. Keep in step with the SQL.
export const DESK_ROLES: Record<string, string[]> = {
  "coo": [
    "ceo",
    "coo",
    "cto",
    "super_admin"
  ],
  "service-centre": [
    "agent_ops",
    "ceo",
    "coo",
    "cto",
    "manager",
    "operations",
    "super_admin"
  ],
  "agent-ops": [
    "agent_ops",
    "ceo",
    "coo",
    "cto",
    "manager",
    "operations",
    "super_admin"
  ],
  "tenant-ops": [
    "ceo",
    "coo",
    "cto",
    "manager",
    "operations",
    "super_admin",
    "tenant_ops"
  ],
  "landlord-ops": [
    "ceo",
    "coo",
    "cto",
    "landlord_ops",
    "manager",
    "operations",
    "super_admin"
  ],
  "partner-ops": [
    "ceo",
    "cfo",
    "coo",
    "cto",
    "partner_ops",
    "super_admin"
  ],
  "cfo": [
    "ceo",
    "cfo",
    "coo",
    "cto",
    "financial_ops",
    "super_admin"
  ],
  "customer-care": [
    "ceo",
    "coo",
    "crm",
    "cto",
    "manager",
    "operations",
    "super_admin",
    "tenant_ops"
  ]
};
export const ALL_DESK_ROLES: string[] = ["agent_ops", "ceo", "cfo", "coo", "crm", "cto", "financial_ops", "landlord_ops", "manager", "operations", "partner_ops", "super_admin", "tenant_ops"];
