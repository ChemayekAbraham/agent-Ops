// Deterministic SQL Firewall, View Catalog, and Role-Area Gate for Zoe's Analyst Lane (Prompt 3).
// Mirrors `public.zoe_ro_validate_query`, `public.zoe_ro_area_allowed`, and `public.staff_assistant_data_catalog`
// so the edge function rejects unsafe or unauthorized queries before they ever reach the database,
// while the database enforces the identical rules at execution time.

export type ZoeRoRoleArea =
  | "finance"
  | "operations"
  | "calling"
  | "hr"
  | "agents"
  | "supporters"
  | "tenants"
  | "landlords";

export interface ZoeRoColumnSpec {
  name: string;
  type: "date" | "numeric" | "integer" | "text" | "boolean";
  description: string;
}

export interface ZoeRoViewCatalogEntry {
  view_name: string;
  role_area: ZoeRoRoleArea;
  requires_aal2: boolean;
  title: string;
  description: string;
  use_for: string;
  do_not_use_for: string;
  official_source: string;
  columns: ReadonlyArray<ZoeRoColumnSpec>;
}

export const ZOE_RO_ROLE_AREAS: ReadonlyArray<ZoeRoRoleArea> = [
  "finance",
  "operations",
  "calling",
  "hr",
  "agents",
  "supporters",
  "tenants",
  "landlords",
];

export const ZOE_RO_AREA_ROLES: Record<ZoeRoRoleArea, ReadonlyArray<string>> = {
  finance: ["cfo", "ceo", "coo", "financial_ops", "manager", "cto", "super_admin"],
  operations: [
    "operations",
    "tenant_ops",
    "landlord_ops",
    "agent_ops",
    "partner_ops",
    "coo",
    "ceo",
    "cfo",
    "cto",
    "manager",
    "super_admin",
  ],
  calling: [
    "tenant_ops",
    "landlord_ops",
    "operations",
    "crm",
    "hr",
    "coo",
    "ceo",
    "cfo",
    "manager",
    "super_admin",
  ],
  hr: ["hr", "coo", "ceo", "cfo", "super_admin"],
  agents: [
    "agent_ops",
    "tenant_ops",
    "operations",
    "coo",
    "ceo",
    "cfo",
    "cto",
    "manager",
    "super_admin",
  ],
  supporters: [
    "partner_ops",
    "financial_ops",
    "cfo",
    "ceo",
    "coo",
    "manager",
    "super_admin",
  ],
  tenants: [
    "tenant_ops",
    "operations",
    "coo",
    "ceo",
    "cfo",
    "cto",
    "manager",
    "super_admin",
  ],
  landlords: [
    "landlord_ops",
    "operations",
    "coo",
    "ceo",
    "cfo",
    "cto",
    "manager",
    "super_admin",
  ],
};

export const ZOE_RO_SENSITIVE_AAL2_AREAS: ReadonlySet<ZoeRoRoleArea> = new Set([
  "finance",
  "hr",
  "supporters",
]);

export const ALLOWED_ANALYST_SQL_FUNCTIONS: ReadonlySet<string> = new Set([
  // Aggregates
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "array_agg",
  "string_agg",
  "bool_and",
  "bool_or",
  "every",
  // Math & conditional
  "coalesce",
  "nullif",
  "greatest",
  "least",
  "abs",
  "round",
  "ceil",
  "ceiling",
  "floor",
  "trunc",
  "sign",
  "mod",
  "power",
  "sqrt",
  // Text
  "lower",
  "upper",
  "initcap",
  "btrim",
  "trim",
  "ltrim",
  "rtrim",
  "left",
  "right",
  "length",
  "char_length",
  "substr",
  "substring",
  "replace",
  "concat",
  "concat_ws",
  "split_part",
  "strpos",
  "position",
  // Dates & times
  "date_trunc",
  "date_part",
  "extract",
  "age",
  "to_char",
  "to_date",
  "now",
  "current_date",
  "current_timestamp",
  "make_date",
  "make_interval",
  "justify_days",
  "justify_hours",
  "justify_interval",
  // Window & ranking
  "row_number",
  "rank",
  "dense_rank",
  "ntile",
  "lag",
  "lead",
  "first_value",
  "last_value",
  // Safe SQL grammar keywords that precede `(`
  "cast",
  "in",
  "not",
  "exists",
  "over",
  "filter",
  "within",
  "values",
  "unnest",
  "as",
  "where",
  "and",
  "or",
  "when",
  "then",
  "else",
  "case",
  "on",
  "from",
  "join",
  "having",
  "by",
  "select",
  "distinct",
  "any",
  "some",
  "all",
  "between",
  "jsonb_build_object",
  "jsonb_agg",
  "to_jsonb",
]);

export const FORBIDDEN_ANALYST_PII_COLUMNS: ReadonlySet<string> = new Set([
  "password",
  "pin_hash",
  "otp",
  "secret",
  "token",
  "activation_token",
  "portfolio_pin",
  "national_id",
  "nin",
  "id_image_hash",
  "selfie_image_hash",
  "signup_device_fp",
  "verification_pin_1",
  "verification_pin_2",
  "aware_payout_otp",
  "aware_merchant_codes",
  "unmasked_phone",
  "raw_phone",
  "account_number",
  "mobile_money_number",
  "subject_phone",
  "caretaker_phone",
  "lc1_chairperson_phone",
  "whatsapp_number",
  "phone_number",
]);

export const ZOE_RO_VIEWS_CATALOG: ReadonlyArray<ZoeRoViewCatalogEntry> = [
  {
    view_name: "zoe_ro.finance_treasury_cash_position",
    role_area: "finance",
    requires_aal2: true,
    title: "Treasury Cash Position (Official)",
    description:
      "Live company treasury cash position built on get_treasury_cash_position(now()). Reports A1 Cash & Bank + A5 Cash in Transit as spendable treasury cash, and A2 Agent Float separately.",
    use_for: "Checking available platform treasury cash (A1 + A5) vs agent float (A2).",
    do_not_use_for:
      "Never sum general_ledger or wallets directly for cash position; never add A2 agent float into spendable treasury cash.",
    official_source: "get_treasury_cash_position",
    columns: [
      { name: "as_of_date", type: "date", description: "Kampala date of the snapshot" },
      {
        name: "total_available_cash_ugx",
        type: "numeric",
        description: "Spendable treasury cash in UGX (A1 + A5)",
      },
      {
        name: "a1_cash_and_bank_ugx",
        type: "numeric",
        description: "Account A1 Cash and Bank Balances in UGX",
      },
      {
        name: "a5_cash_in_transit_ugx",
        type: "numeric",
        description: "Account A5 Cash in Transit in UGX",
      },
      {
        name: "a2_agent_float_ugx",
        type: "numeric",
        description: "Account A2 Cash at Hand — Float held by agents in UGX",
      },
      { name: "official_source", type: "text", description: "Authoritative function name" },
    ],
  },
  {
    view_name: "zoe_ro.finance_receivables_and_payables",
    role_area: "finance",
    requires_aal2: true,
    title: "Company Receivables and Payables Totals",
    description:
      "Authoritative Rent Plan receivables (A3) and company payables from get_receivables_total() and get_payables_total().",
    use_for:
      "Comparing total company Rent Plan receivables against landlord and Supporter payables.",
    do_not_use_for:
      "Do not include agent lending (agents' own money) or uneligible merchandise plans.",
    official_source: "get_receivables_total + get_payables_total",
    columns: [
      { name: "as_of_date", type: "date", description: "Kampala snapshot date" },
      {
        name: "total_receivables_ugx",
        type: "numeric",
        description: "Total Rent Plan receivables in UGX",
      },
      {
        name: "active_rent_plans_count",
        type: "integer",
        description: "Number of active Rent Plans in receivables",
      },
      {
        name: "overdue_receivables_ugx",
        type: "numeric",
        description: "Overdue portion of Rent Plan receivables in UGX",
      },
      {
        name: "total_payables_ugx",
        type: "numeric",
        description: "Total company payables in UGX",
      },
      {
        name: "landlord_payables_ugx",
        type: "numeric",
        description: "Landlord rent payables in UGX",
      },
      {
        name: "supporter_returns_payable_ugx",
        type: "numeric",
        description: "Supporter Returns payable in UGX",
      },
    ],
  },
  {
    view_name: "zoe_ro.finance_requisitions_summary",
    role_area: "finance",
    requires_aal2: true,
    title: "Staff Requisitions Summary",
    description:
      "Internal staff requisitions with department, category, approval stage, and UGX requested/approved amounts (PII omitted).",
    use_for:
      "Filtering or grouping requisitions by department, category, approval stage, or date range.",
    do_not_use_for: "Do not treat uncredited requisitions as paid cash expenses.",
    official_source: "staff_requisitions",
    columns: [
      { name: "requisition_code", type: "text", description: "Human requisition reference code" },
      { name: "title", type: "text", description: "Requisition title" },
      { name: "department_key", type: "text", description: "Department key" },
      { name: "category", type: "text", description: "Expense category" },
      { name: "request_kind", type: "text", description: "Requisition kind" },
      { name: "stage", type: "text", description: "Current approval stage" },
      { name: "final_stage", type: "text", description: "Required final approval stage" },
      { name: "requested_amount_ugx", type: "numeric", description: "Requested amount in UGX" },
      { name: "approved_amount_ugx", type: "numeric", description: "Approved amount in UGX" },
      {
        name: "wallet_credit_status",
        type: "text",
        description: "Disbursement credit status",
      },
      { name: "created_date", type: "date", description: "Kampala date created" },
      { name: "decided_date", type: "date", description: "Kampala date decided" },
    ],
  },
  {
    view_name: "zoe_ro.finance_budget_cycles",
    role_area: "finance",
    requires_aal2: true,
    title: "Company Budget Cycles",
    description: "Budget call cycles, financial years, periods, and statuses from budget_calls.",
    use_for: "Listing budget periods and statuses.",
    do_not_use_for:
      "Do not use for revised line-item amounts (use get_cfo_budget_revised_position for certified line items).",
    official_source: "budget_calls",
    columns: [
      { name: "cycle_title", type: "text", description: "Budget cycle title" },
      { name: "financial_year", type: "text", description: "Financial year label" },
      { name: "period_type", type: "text", description: "Period granularity" },
      { name: "period_start", type: "date", description: "Cycle start date" },
      { name: "period_end", type: "date", description: "Cycle end date" },
      { name: "status", type: "text", description: "Cycle status" },
      { name: "deadline_date", type: "date", description: "Submission deadline date" },
    ],
  },
  {
    view_name: "zoe_ro.operations_daily_collection_coverage",
    role_area: "operations",
    requires_aal2: false,
    title: "Daily Rent Plan Collection Coverage (Expected vs Collected)",
    description:
      "Joins the 00:05 EAT pinned daily bill (agent_expected_day_plans) to non-reversed receipts (agent_collections) on (collection_day, rent_request_id) per welile-expected-vs-collected.",
    use_for:
      "Comparing expected pinned bills, on-schedule collections, capped collections, arrears collected, and true on-schedule coverage % by day.",
    do_not_use_for:
      "Never divide total_cash_collected_ugx by expected_pinned_ugx (that mixes older arrears into today's bill and overstates coverage ~2x).",
    official_source: "agent_expected_day_plans + agent_collections",
    columns: [
      { name: "collection_day", type: "date", description: "Kampala date of the bill and collection" },
      {
        name: "plans_billed_count",
        type: "integer",
        description: "Number of Rent Plans pinned on that day's bill",
      },
      {
        name: "expected_pinned_ugx",
        type: "numeric",
        description: "Pinned daily expected UGX from agent_expected_day_plans",
      },
      {
        name: "collected_on_schedule_ugx",
        type: "numeric",
        description: "UGX collected on that day against plans billed that day",
      },
      {
        name: "collected_capped_ugx",
        type: "numeric",
        description: "UGX collected on schedule capped at LEAST(paid, expected) per plan",
      },
      {
        name: "collected_arrears_ugx",
        type: "numeric",
        description: "UGX collected on that day for older unbilled arrears",
      },
      {
        name: "total_cash_collected_ugx",
        type: "numeric",
        description: "Total non-reversed cash collected on that day (on-schedule + arrears)",
      },
      {
        name: "true_on_schedule_coverage_pct",
        type: "numeric",
        description: "On-schedule coverage percentage (collected_on_schedule_ugx / expected_pinned_ugx * 100)",
      },
      {
        name: "capped_coverage_pct",
        type: "numeric",
        description: "Capped coverage percentage (collected_capped_ugx / expected_pinned_ugx * 100)",
      },
    ],
  },
  {
    view_name: "zoe_ro.operations_rent_plans_by_stage",
    role_area: "operations",
    requires_aal2: false,
    title: "Rent Plans by Stage, City, and House Category",
    description:
      "Aggregated Rent Plans from rent_requests grouped by stage, tenancy_status, request_city, and house_category.",
    use_for:
      "Cross-tabulating Rent Plan counts, rent value, repaid UGX, and outstanding UGX by stage and city.",
    do_not_use_for: "Do not use for daily pinned collection coverage.",
    official_source: "rent_requests",
    columns: [
      { name: "stage", type: "text", description: "Rent Plan pipeline stage" },
      { name: "tenancy_status", type: "text", description: "Tenancy lifecycle status" },
      { name: "request_city", type: "text", description: "City/area of the Rent Plan" },
      { name: "house_category", type: "text", description: "House category" },
      { name: "plans_count", type: "integer", description: "Count of Rent Plans" },
      { name: "total_rent_ugx", type: "numeric", description: "Sum of principal rent_amount in UGX" },
      { name: "total_access_fee_ugx", type: "numeric", description: "Sum of access_fee in UGX" },
      { name: "total_repayment_ugx", type: "numeric", description: "Sum of total_repayment in UGX" },
      { name: "total_repaid_ugx", type: "numeric", description: "Sum of amount_repaid in UGX" },
      { name: "outstanding_ugx", type: "numeric", description: "Sum of remaining repayment in UGX" },
      { name: "avg_daily_repayment_ugx", type: "numeric", description: "Average daily repayment in UGX" },
    ],
  },
  {
    view_name: "zoe_ro.calling_daily_attempts_summary",
    role_area: "calling",
    requires_aal2: false,
    title: "Calling Center Daily Attempts & Outcomes",
    description:
      "Daily Calling Center call attempts from cc_call_attempts (excluding voided rows), grouped by call_day, source_center, channel, outcome, and is_answered.",
    use_for: "Analysing daily or custom-range Calling Center volumes, answer rates, and outcomes.",
    do_not_use_for: "Do not use for individual callee phone numbers (omitted for privacy).",
    official_source: "cc_call_attempts",
    columns: [
      { name: "call_day", type: "date", description: "Kampala date of the call attempt" },
      { name: "source_center", type: "text", description: "Calling Center queue source" },
      { name: "channel", type: "text", description: "Call channel" },
      { name: "outcome", type: "text", description: "Recorded attempt outcome" },
      { name: "is_answered", type: "boolean", description: "True when outcome = engaged" },
      { name: "attempts_count", type: "integer", description: "Number of call attempts" },
      {
        name: "distinct_callers_count",
        type: "integer",
        description: "Number of distinct calling officers",
      },
    ],
  },
  {
    view_name: "zoe_ro.calling_pipeline_awareness_summary",
    role_area: "calling",
    requires_aal2: false,
    title: "Rent Plan Pipeline Awareness Calls Summary",
    description:
      "Daily awareness calls from rent_pipeline_awareness_calls grouped by call_day, caller_team, pipeline_stage, subject_type, call_result, and landlord_consent.",
    use_for: "Checking awareness call reach and landlord consent across pipeline stages.",
    do_not_use_for:
      "Never treat awareness calls as payout approvals (awareness calls never affect approvals).",
    official_source: "rent_pipeline_awareness_calls",
    columns: [
      { name: "call_day", type: "date", description: "Kampala date of the awareness call" },
      { name: "caller_team", type: "text", description: "Calling team" },
      {
        name: "pipeline_stage",
        type: "text",
        description: "Rent Plan pipeline stage at call time",
      },
      { name: "subject_type", type: "text", description: "Subject type (tenant or landlord)" },
      { name: "call_result", type: "text", description: "Call outcome" },
      {
        name: "landlord_consent",
        type: "text",
        description: "Recorded landlord consent status",
      },
      { name: "calls_count", type: "integer", description: "Number of awareness calls" },
    ],
  },
  {
    view_name: "zoe_ro.hr_department_headcount",
    role_area: "hr",
    requires_aal2: true,
    title: "HR Department Headcount & Positions",
    description:
      "Active staff count, primary assignments count, and active positions count per HR department.",
    use_for: "Comparing active staff headcount and positions across departments.",
    do_not_use_for:
      "Do not use for payroll UGX cost (use get_hr_payroll_cost_by_department for certified payroll costs).",
    official_source: "hr_departments + hr_positions + hr_assignments + hr_staff",
    columns: [
      { name: "department_key", type: "text", description: "Department key" },
      { name: "department_name", type: "text", description: "Department display name" },
      { name: "measurement_mode", type: "text", description: "HR measurement mode" },
      {
        name: "active_staff_count",
        type: "integer",
        description: "Count of active staff assigned to the department",
      },
      {
        name: "primary_assignments_count",
        type: "integer",
        description: "Count of primary staff assignments",
      },
      {
        name: "positions_count",
        type: "integer",
        description: "Count of active positions in the department",
      },
    ],
  },
  {
    view_name: "zoe_ro.hr_contracts_overview",
    role_area: "hr",
    requires_aal2: true,
    title: "HR Contracts Overview",
    description:
      "HR contracts grouped by contract_type, signature_status, currency, start_date, end_date, and days_to_expiry.",
    use_for: "Analysing contract counts, signature statuses, and upcoming expiry windows.",
    do_not_use_for: "Do not use for individual staff personal phone/NIN lookups.",
    official_source: "hr_contracts",
    columns: [
      { name: "contract_type", type: "text", description: "Contract type" },
      { name: "signature_status", type: "text", description: "Signature status" },
      { name: "currency", type: "text", description: "Contract currency" },
      { name: "start_date", type: "date", description: "Contract start date" },
      { name: "end_date", type: "date", description: "Contract end date" },
      { name: "days_to_expiry", type: "integer", description: "Days remaining until end_date" },
      { name: "contracts_count", type: "integer", description: "Number of contracts in group" },
      { name: "total_value_ugx", type: "numeric", description: "Sum of contract value_amount" },
    ],
  },
  {
    view_name: "zoe_ro.agents_daily_collections_by_region",
    role_area: "agents",
    requires_aal2: false,
    title: "Agent Daily Collections by Region and District",
    description:
      "Daily agent collection performance grouped by collection_day, region, and district using pinned daily expectations (agent_expected_day_plans) and non-reversed receipts (agent_collections).",
    use_for:
      "Comparing regions or districts (e.g. Wakiso vs Mukono) on expected pinned bills, on-schedule collections, arrears collections, and active agents.",
    do_not_use_for:
      "Do not divide total_cash_collected_ugx by expected_pinned_ugx; use on_schedule_coverage_pct.",
    official_source: "agent_expected_day_plans + agent_collections + profiles",
    columns: [
      { name: "collection_day", type: "date", description: "Kampala collection date" },
      { name: "region", type: "text", description: "Agent region" },
      { name: "district", type: "text", description: "Agent district" },
      {
        name: "active_agents_count",
        type: "integer",
        description: "Distinct agents with bills or collections on that day",
      },
      {
        name: "plans_billed_count",
        type: "integer",
        description: "Number of Rent Plans billed on that day",
      },
      {
        name: "expected_pinned_ugx",
        type: "numeric",
        description: "Pinned expected UGX for that region/district",
      },
      {
        name: "collected_on_schedule_ugx",
        type: "numeric",
        description: "UGX collected on schedule against that day's pinned bill",
      },
      {
        name: "collected_arrears_ugx",
        type: "numeric",
        description: "UGX collected for older arrears",
      },
      {
        name: "total_cash_collected_ugx",
        type: "numeric",
        description: "Total non-reversed cash collected in UGX",
      },
      {
        name: "on_schedule_coverage_pct",
        type: "numeric",
        description: "On-schedule coverage percentage",
      },
    ],
  },
  {
    view_name: "zoe_ro.agents_house_listings_summary",
    role_area: "agents",
    requires_aal2: false,
    title: "Agent House Listings Summary by Region & District",
    description:
      "House listings from house_listings grouped by region, district, house_category, status, service_center_status, and verified flag.",
    use_for:
      "Comparing house listing inventory, verification rates, and average monthly rent across regions and districts.",
    do_not_use_for: "Do not use for active Rent Plan counts (use operations_rent_plans_by_stage).",
    official_source: "house_listings",
    columns: [
      { name: "region", type: "text", description: "Listing region" },
      { name: "district", type: "text", description: "Listing district" },
      { name: "house_category", type: "text", description: "House category" },
      { name: "status", type: "text", description: "Listing availability status" },
      { name: "service_center_status", type: "text", description: "Service Centre review status" },
      { name: "verified", type: "boolean", description: "Whether the house listing is verified" },
      { name: "listings_count", type: "integer", description: "Number of house listings" },
      { name: "avg_monthly_rent_ugx", type: "numeric", description: "Average monthly rent in UGX" },
      { name: "avg_daily_rate_ugx", type: "numeric", description: "Average daily rate in UGX" },
    ],
  },
  {
    view_name: "zoe_ro.supporters_portfolios_summary",
    role_area: "supporters",
    requires_aal2: true,
    title: "Supporter Portfolios & Returns Summary",
    description:
      "Supporter portfolios grouped by status, returns_mode, duration_months, cfo_verified, and auto_reinvest (PII and account numbers omitted).",
    use_for:
      "Analysing Supporter portfolio principal, allocated vs unallocated principal, and total Returns earned.",
    do_not_use_for:
      "Never use banned terms (always say Supporter and Returns). Do not use for individual payout bank numbers.",
    official_source: "investor_portfolios",
    columns: [
      { name: "status", type: "text", description: "Portfolio status" },
      { name: "returns_mode", type: "text", description: "Supporter Returns payout mode" },
      { name: "duration_months", type: "integer", description: "Portfolio duration in months" },
      { name: "display_currency", type: "text", description: "Display currency" },
      { name: "cfo_verified", type: "boolean", description: "Whether verified by CFO" },
      { name: "auto_reinvest", type: "boolean", description: "Whether auto-reinvest is enabled" },
      { name: "portfolios_count", type: "integer", description: "Number of Supporter portfolios" },
      { name: "total_principal_ugx", type: "numeric", description: "Total Supporter principal in UGX" },
      {
        name: "principal_allocated_ugx",
        type: "numeric",
        description: "Allocated Supporter principal in UGX",
      },
      {
        name: "principal_unallocated_ugx",
        type: "numeric",
        description: "Unallocated Supporter principal in UGX",
      },
      {
        name: "total_returns_earned_ugx",
        type: "numeric",
        description: "Total Supporter Returns earned in UGX",
      },
    ],
  },
  {
    view_name: "zoe_ro.supporters_promissory_notes_summary",
    role_area: "supporters",
    requires_aal2: true,
    title: "Supporter Promissory Notes Summary",
    description:
      "Supporter promissory notes grouped by recorded_month, status, support_mode, contribution_type, and follow_up_status.",
    use_for: "Tracking pledged vs collected promissory note UGX by month and status.",
    do_not_use_for: "Do not count uncollected pledges as treasury cash.",
    official_source: "promissory_notes",
    columns: [
      { name: "recorded_month", type: "date", description: "Month the promissory note was recorded" },
      { name: "status", type: "text", description: "Promissory note status" },
      { name: "support_mode", type: "text", description: "Support mode" },
      { name: "contribution_type", type: "text", description: "Contribution type" },
      { name: "follow_up_status", type: "text", description: "Follow-up status" },
      { name: "notes_count", type: "integer", description: "Number of promissory notes" },
      { name: "total_pledged_ugx", type: "numeric", description: "Total pledged amount in UGX" },
      { name: "total_collected_ugx", type: "numeric", description: "Total collected amount in UGX" },
      {
        name: "outstanding_pledge_ugx",
        type: "numeric",
        description: "Remaining uncollected pledge in UGX",
      },
    ],
  },
  {
    view_name: "zoe_ro.tenants_rent_plans_by_city",
    role_area: "tenants",
    requires_aal2: false,
    title: "Tenant Rent Plans by City and Status",
    description:
      "Tenant Rent Plans from rent_requests grouped by request_city, status, tenancy_status, and repayment_frequency.",
    use_for:
      "Comparing tenant Rent Plan counts, rent value, repaid UGX, and outstanding balances across cities.",
    do_not_use_for: "Do not use for individual tenant phone or NIN lookups.",
    official_source: "rent_requests",
    columns: [
      { name: "request_city", type: "text", description: "Tenant request city/area" },
      { name: "status", type: "text", description: "Rent Plan status" },
      { name: "tenancy_status", type: "text", description: "Tenancy status" },
      {
        name: "repayment_frequency",
        type: "text",
        description: "Repayment frequency (daily/weekly/monthly)",
      },
      { name: "plans_count", type: "integer", description: "Number of Rent Plans" },
      { name: "total_rent_ugx", type: "numeric", description: "Total rent amount in UGX" },
      { name: "total_repayment_ugx", type: "numeric", description: "Total scheduled repayment in UGX" },
      { name: "amount_repaid_ugx", type: "numeric", description: "Amount repaid so far in UGX" },
      { name: "outstanding_balance_ugx", type: "numeric", description: "Outstanding balance in UGX" },
      { name: "avg_duration_days", type: "numeric", description: "Average plan duration in days" },
    ],
  },
  {
    view_name: "zoe_ro.tenants_arrears_by_city",
    role_area: "tenants",
    requires_aal2: false,
    title: "Tenant Arrears by City",
    description:
      "Active tenant Rent Plans compared against cumulative pinned daily bills (agent_expected_day_plans) by request_city.",
    use_for: "Comparing city-level arrears balances and counts of plans with arrears.",
    do_not_use_for:
      "Prefer get_tops_arrears_ageing when the user asks for the certified AM-clock arrears ageing buckets.",
    official_source: "rent_requests + agent_expected_day_plans",
    columns: [
      { name: "request_city", type: "text", description: "Tenant request city/area" },
      { name: "active_plans_count", type: "integer", description: "Active Rent Plans in city" },
      {
        name: "plans_with_arrears_count",
        type: "integer",
        description: "Active Rent Plans currently behind pinned schedule",
      },
      {
        name: "total_expected_to_date_ugx",
        type: "numeric",
        description: "Cumulative pinned expected UGX to date",
      },
      { name: "total_repaid_ugx", type: "numeric", description: "Cumulative amount repaid in UGX" },
      { name: "overdue_balance_ugx", type: "numeric", description: "Overdue balance in UGX" },
    ],
  },
  {
    view_name: "zoe_ro.landlords_registry_by_district",
    role_area: "landlords",
    requires_aal2: false,
    title: "Landlords Registry by Region and District",
    description:
      "Registered landlords from landlords grouped by region, district, house_category, verification_status, service_center_status, occupancy, and readiness.",
    use_for:
      "Comparing landlord counts, houses, rooms, verification status, and rent balance due across districts.",
    do_not_use_for:
      "Do not use for individual landlord phone numbers or bank/mobile-money payout numbers.",
    official_source: "landlords",
    columns: [
      { name: "region", type: "text", description: "Landlord region" },
      { name: "district", type: "text", description: "Landlord district" },
      { name: "house_category", type: "text", description: "Property house category" },
      { name: "verification_status", type: "text", description: "Landlord verification status" },
      { name: "service_center_status", type: "text", description: "Service Centre status" },
      { name: "is_occupied", type: "boolean", description: "Whether property is occupied" },
      {
        name: "ready_to_receive",
        type: "boolean",
        description: "Whether landlord is ready to receive payouts",
      },
      { name: "landlords_count", type: "integer", description: "Number of landlords" },
      { name: "total_houses_count", type: "integer", description: "Total houses count" },
      { name: "total_rooms_count", type: "integer", description: "Total rooms count" },
      { name: "avg_monthly_rent_ugx", type: "numeric", description: "Average monthly rent in UGX" },
      {
        name: "total_rent_balance_due_ugx",
        type: "numeric",
        description: "Total rent balance due in UGX",
      },
    ],
  },
  {
    view_name: "zoe_ro.landlords_payouts_summary",
    role_area: "landlords",
    requires_aal2: false,
    title: "Landlord Payouts Summary by Day and Status",
    description:
      "Landlord payouts from landlord_payouts grouped by payout_day, status, mobile_money_provider, and gps_match.",
    use_for: "Analysing daily landlord payout counts and UGX totals by status or provider.",
    do_not_use_for:
      "Prefer get_lops_principal_recovered for the certified float-vs-principal comparison.",
    official_source: "landlord_payouts",
    columns: [
      { name: "payout_day", type: "date", description: "Kampala payout date" },
      { name: "status", type: "text", description: "Payout status" },
      { name: "mobile_money_provider", type: "text", description: "Mobile money provider" },
      { name: "gps_match", type: "boolean", description: "Whether agent GPS matched property GPS" },
      { name: "payouts_count", type: "integer", description: "Number of payouts" },
      { name: "total_payout_ugx", type: "numeric", description: "Total payout amount in UGX" },
    ],
  },
];

const VIEW_BY_NAME: ReadonlyMap<string, ZoeRoViewCatalogEntry> = new Map(
  ZOE_RO_VIEWS_CATALOG.map((v) => [v.view_name, v]),
);

const CALLING_MEMBER_IDS = new Set([
  "5295252d-f477-42a9-92f5-af56e503e33d", // Jane
  "a9258d45-3e27-4827-af71-64344e76fb4f", // Winnie
  "fda0d518-98c4-45e4-83d8-64266b25eefa", // Hanisha
  "fe1e9f51-a2c3-49fc-bd40-b2c143afe628", // Mark Bwayo
]);

export function areaRequiresStaffAal2(area: ZoeRoRoleArea): boolean {
  return ZOE_RO_SENSITIVE_AAL2_AREAS.has(area);
}

export function canCallerAccessZoeRoArea(
  area: ZoeRoRoleArea,
  callerRoles: ReadonlyArray<string>,
  callerUserId?: string,
): boolean {
  const roleSet = new Set(callerRoles.map((r) => r.toLowerCase().trim()));
  if (area === "calling" && callerUserId && CALLING_MEMBER_IDS.has(callerUserId)) {
    return true;
  }
  const allowed = ZOE_RO_AREA_ROLES[area] ?? [];
  return allowed.some((r) => roleSet.has(r));
}

export type AnalystSqlValidationResult =
  | {
      ok: true;
      cleanSql: string;
      executedSql: string;
      viewsUsed: string[];
      roleAreas: ZoeRoRoleArea[];
      requiresAal2: boolean;
    }
  | {
      ok: false;
      code:
        | "empty_or_too_long"
        | "comments_forbidden"
        | "multiple_statements"
        | "prompt_injection"
        | "not_single_select"
        | "forbidden_keyword"
        | "forbidden_function"
        | "forbidden_pii_column"
        | "cross_join_forbidden"
        | "non_zoe_ro_object"
        | "unknown_zoe_ro_view";
      reason: string;
    };

const FORBIDDEN_SQL_KEYWORDS_RE =
  /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|set|reset|show|discard|begin|commit|rollback|savepoint|release|lock|vacuum|analyze|cluster|reindex|explain|prepare|deallocate|execute|call|do|listen|notify|unlisten|load|import|security|owner|into)\b/i;

const FORBIDDEN_SLEEP_OR_SYS_FN_RE =
  /\b(pg_sleep|pg_sleep_for|pg_sleep_until|dblink|dblink_exec|dblink_connect|lo_import|lo_export|lo_unlink|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|set_config|current_setting|pg_advisory_lock|pg_try_advisory_lock|query_to_xml|table_to_xml|database_to_xml)\b/i;

const FORBIDDEN_SCHEMA_PREFIX_RE =
  /\b(public|pg_catalog|information_schema|auth|storage|vault|extensions|supabase_functions|net|cron|pgsodium|realtime)\s*\./i;

const PROMPT_INJECTION_IN_SQL_RE =
  /ignore\s+(all\s+|any\s+)?(previous|prior)\s+instructions|<UNTRUSTED_TOOL_DATA|SUPABASE_[A-Z_]+_KEY|[A-Z_]+_API_KEY|system\s+prompt|developer\s+mode|jailbreak/i;

/**
 * Deterministic SQL validator for `assistant_staff_run_query` (`run_analyst_query`).
 * Enforces every requirement of Prompt 3 item (2) & (4):
 *   - Single SELECT or WITH ... SELECT only
 *   - No `--` or `/*` comments
 *   - No `;` chaining
 *   - No INSERT/UPDATE/DELETE/DROP/TRUNCATE/ALTER/CREATE/GRANT/COPY/SET
 *   - No `pg_sleep`, `dblink`, `set_config`, or functions outside `ALLOWED_ANALYST_SQL_FUNCTIONS`
 *   - No PII/secret columns
 *   - No CROSS JOIN, comma join, or unconditional `ON true` / `ON 1=1` Cartesian join
 *   - Only approved `zoe_ro.<view>` objects (never base tables or other schemas)
 */
export function validateAnalystSqlQuery(rawSql: string): AnalystSqlValidationResult {
  const raw = (rawSql ?? "").trim();
  if (!raw || raw.length > 4000) {
    return {
      ok: false,
      code: "empty_or_too_long",
      reason: "Analyst SQL query must be between 1 and 4,000 characters.",
    };
  }

  // deno-lint-ignore no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(raw)) {
    return {
      ok: false,
      code: "prompt_injection",
      reason: "Control characters are forbidden in Analyst SQL.",
    };
  }

  if (raw.includes("--") || raw.includes("/*") || raw.includes("*/")) {
    return {
      ok: false,
      code: "comments_forbidden",
      reason: "SQL comments (-- or /* */) are forbidden in Analyst queries.",
    };
  }

  const cleanSql = raw.replace(/;\s*$/, "").trim();
  if (cleanSql.includes(";")) {
    return {
      ok: false,
      code: "multiple_statements",
      reason: "Multiple statements or semicolon chaining are forbidden.",
    };
  }

  if (PROMPT_INJECTION_IN_SQL_RE.test(cleanSql)) {
    return {
      ok: false,
      code: "prompt_injection",
      reason: "Prompt injection or secret extraction pattern detected in query.",
    };
  }

  const noLiterals = cleanSql.replace(/'(?:''|[^'])*'/g, "''");
  const lower = noLiterals.trim().toLowerCase();

  if (!/^(select|with)\b/.test(lower)) {
    return {
      ok: false,
      code: "not_single_select",
      reason: "Only a single SELECT or WITH ... SELECT statement is allowed.",
    };
  }

  if (/^with\b/.test(lower) && !/\bselect\b/.test(lower)) {
    return {
      ok: false,
      code: "not_single_select",
      reason: "WITH query must contain a SELECT statement.",
    };
  }

  if (/\bwith\s+recursive\b/.test(lower)) {
    return {
      ok: false,
      code: "forbidden_keyword",
      reason: "WITH RECURSIVE is not allowed in Analyst queries.",
    };
  }

  if (FORBIDDEN_SQL_KEYWORDS_RE.test(lower) || /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/.test(lower)) {
    return {
      ok: false,
      code: "forbidden_keyword",
      reason: "Write, DDL, COPY, SET, INTO, or locking SQL keywords are forbidden.",
    };
  }

  if (FORBIDDEN_SLEEP_OR_SYS_FN_RE.test(lower)) {
    return {
      ok: false,
      code: "forbidden_function",
      reason: "System, sleep (pg_sleep), or network (dblink) functions are forbidden.",
    };
  }

  for (const token of lower.matchAll(/\b([a-z_][a-z0-9_]*)\b/g)) {
    if (FORBIDDEN_ANALYST_PII_COLUMNS.has(token[1])) {
      return {
        ok: false,
        code: "forbidden_pii_column",
        reason: `PII or secret column "${token[1]}" is forbidden in Analyst queries.`,
      };
    }
  }

  if (
    /\bcross\s+join\b/.test(lower) ||
    /\bfrom\s+zoe_ro\.[a-z0-9_]+(?:\s+(?:as\s+)?[a-z0-9_]+)?\s*,/.test(lower) ||
    /\bjoin\s+[^\n]+?\bon\s*\(?\s*(true|1\s*=\s*1)\s*\)?/.test(lower)
  ) {
    return {
      ok: false,
      code: "cross_join_forbidden",
      reason: "CROSS JOIN or unconstrained Cartesian join is forbidden.",
    };
  }

  if (FORBIDDEN_SCHEMA_PREFIX_RE.test(lower)) {
    return {
      ok: false,
      code: "non_zoe_ro_object",
      reason: "Objects outside the zoe_ro schema are forbidden.",
    };
  }

  // Collect CTE names defined via `WITH <cte> AS (` or `, <cte> AS (`
  const cteNames = new Set<string>();
  for (const m of lower.matchAll(/(?:\bwith\s+|,\s*)([a-z_][a-z0-9_]*)\s+as\s*\(/g)) {
    cteNames.add(m[1]);
  }

  // Check every FROM and JOIN target
  const viewsUsed: string[] = [];
  const roleAreas: ZoeRoRoleArea[] = [];
  let requiresAal2 = false;

  for (const m of lower.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/g)) {
    const rel = m[1];
    if (cteNames.has(rel)) continue;

    // Ignore `EXTRACT(... FROM col)` or `TRIM(... FROM col)`
    const escapedRel = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const extractTrimRe = new RegExp(
      `\\b(?:extract|trim|btrim|ltrim|rtrim|substring)\\s*\\([^)]*\\bfrom\\s+${escapedRel}`,
      "i",
    );
    if (extractTrimRe.test(lower)) continue;

    if (!/^zoe_ro\.[a-z0-9_]+$/.test(rel)) {
      return {
        ok: false,
        code: "non_zoe_ro_object",
        reason: `Base table or non-zoe_ro object "${rel}" is forbidden. Query approved zoe_ro.<view> views only.`,
      };
    }

    const entry = VIEW_BY_NAME.get(rel);
    if (!entry) {
      return {
        ok: false,
        code: "unknown_zoe_ro_view",
        reason: `View "${rel}" is not in the approved zoe_ro catalog.`,
      };
    }

    if (!viewsUsed.includes(rel)) viewsUsed.push(rel);
    if (!roleAreas.includes(entry.role_area)) roleAreas.push(entry.role_area);
    if (entry.requires_aal2) requiresAal2 = true;
  }

  if (viewsUsed.length === 0) {
    return {
      ok: false,
      code: "non_zoe_ro_object",
      reason: "Analyst query must read from at least one approved zoe_ro.<view>.",
    };
  }

  // Validate every function call `<ident>(` against ALLOWED_ANALYST_SQL_FUNCTIONS
  for (const m of lower.matchAll(/([a-z_][a-z0-9_.]*)\s*\(/g)) {
    const fnName = m[1];
    if (cteNames.has(fnName)) continue;
    if (!ALLOWED_ANALYST_SQL_FUNCTIONS.has(fnName)) {
      return {
        ok: false,
        code: "forbidden_function",
        reason: `Function "${fnName}()" is not in the Analyst SQL allow-list.`,
      };
    }
  }

  return {
    ok: true,
    cleanSql,
    executedSql: `SELECT * FROM (${cleanSql}) AS _zoe_q LIMIT 500`,
    viewsUsed,
    roleAreas,
    requiresAal2,
  };
}

/**
 * Ensures any reply that used `run_analyst_query` explicitly carries the
 * "Ad hoc, not certified" disclosure required by Prompt 3 item (3).
 */
export function ensureAdHocCertificationNotice(reply: string, usedAnalystQuery: boolean): string {
  if (!usedAnalystQuery) return reply;
  if (/ad[- ]hoc\s*,\s*not\s+certified/i.test(reply)) {
    return reply;
  }
  const trimmed = reply.trim();
  const sourceIdx = trimmed.search(/\n*Source:\s*/i);
  const badgeLine =
    "*(Ad hoc, not certified — the SQL query is available under \"Show the data\".)*";
  if (sourceIdx >= 0) {
    const before = trimmed.slice(0, sourceIdx).trimEnd();
    const after = trimmed.slice(sourceIdx).trimStart();
    return `${before}\n\n${badgeLine}\n\n${after}`;
  }
  return `${trimmed}\n\n${badgeLine}`;
}
