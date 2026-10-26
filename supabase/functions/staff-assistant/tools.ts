import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";
import { currentWednesdayWeekStart, ISO_DATE, kampalaToday, PERIODS, Period, resolvePeriod } from "./dates.ts";
import type { OpenAiTool } from "./openai.ts";

/**
 * Every Zoe data tool maps 1-to-1 to a `public.assistant_staff_*` PostgreSQL function
 * that is `STABLE`, `SECURITY DEFINER`, `SET search_path = public`, takes zero user-id
 * parameters, and enforces its own role check + `staff_assistant_has_access()`.
 */
export interface StaffTool {
  name: string;
  rpc: string;
  description: string;
  /**
   * Roles allowed to see and invoke this tool.
   * `["*"]` means any staff member who passes `staff_assistant_has_access()`.
   */
  allowedRoles: readonly string[];
  /**
   * When true, the edge function requires an AAL2 (MFA-verified) session via
   * `requireStaffAal2` from `../_shared/staffMfa.ts` before calling the RPC.
   */
  sensitive?: boolean;
  parameters: Record<string, unknown>;
  schema: z.ZodType<Record<string, unknown>>;
  toRpcArgs: (parsed: Record<string, unknown>) => Record<string, unknown>;
}

const EmptySchema = z.object({}).strict();

const PeriodArgsSchema = z
  .object({
    period: z.enum(PERIODS).optional(),
    from: z.string().regex(ISO_DATE).optional(),
    to: z.string().regex(ISO_DATE).optional(),
  })
  .strict()
  .refine((v) => !(v.period && (v.from || v.to)), {
    message: "Provide either `period` or `from`/`to`, not both.",
  });

const periodProperties = {
  period: {
    type: "string",
    enum: [...PERIODS],
    description:
      "Named period in Africa/Kampala time. Prefer this over explicit dates whenever it fits.",
  },
  from: { type: "string", description: "Start date YYYY-MM-DD (only when `period` is not used)." },
  to: { type: "string", description: "End date YYYY-MM-DD (only when `period` is not used)." },
};

function rangeArgs(parsed: Record<string, unknown>, defaultPeriod: Period = "last_30_days") {
  if (typeof parsed.period === "string") {
    const r = resolvePeriod(parsed.period as Period);
    return { p_from: r.from, p_to: r.to };
  }
  if (typeof parsed.from === "string" || typeof parsed.to === "string") {
    const today = kampalaToday();
    const from = (parsed.from as string | undefined) ?? (parsed.to as string);
    const to = (parsed.to as string | undefined) ?? today;
    return { p_from: from, p_to: to };
  }
  const r = resolvePeriod(defaultPeriod);
  return { p_from: r.from, p_to: r.to };
}

/**
 * Name/phone search term: letters (any script), digits, spaces, and `. ' + -`.
 * Rejects SQL/PostgREST wildcards (`%`, `_`), quotes, commas, parentheses and control chars.
 */
const SAFE_SEARCH = /^[\p{L}\p{N}\s.'+-]{1,40}$/u;

const SearchField = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(SAFE_SEARCH, "Search may only contain letters, digits, spaces and . ' + -");

const TENANT_OPS_ROLES = [
  "tenant_ops",
  "operations",
  "coo",
  "ceo",
  "cfo",
  "cto",
  "manager",
  "super_admin",
] as const;

const TENANT_OPS_FINANCE_ROLES = [
  "tenant_ops",
  "operations",
  "coo",
  "ceo",
  "cfo",
  "super_admin",
] as const;

const TENANT_OPS_OPS_ROLES = [
  "tenant_ops",
  "operations",
  "coo",
  "ceo",
  "cto",
  "manager",
  "super_admin",
] as const;

const LANDLORD_OPS_HOME_ROLES = [
  "landlord_ops",
  "coo",
  "cfo",
  "ceo",
  "manager",
  "super_admin",
] as const;

const LANDLORD_OPS_PAID_ROLES = [
  "landlord_ops",
  "coo",
  "cfo",
  "ceo",
  "super_admin",
] as const;

const LANDLORD_OPS_PRINCIPAL_ROLES = [
  "landlord_ops",
  "cfo",
  "ceo",
  "coo",
  "manager",
  "financial_ops",
  "super_admin",
  "cto",
] as const;

const LANDLORD_CC_ROLES = [
  "landlord_ops",
  "operations",
  "coo",
  "ceo",
  "cfo",
  "cto",
  "manager",
  "hr",
  "super_admin",
] as const;

const AGENT_OPS_NETWORK_ROLES = [
  "operations",
  "coo",
  "ceo",
  "cfo",
  "cto",
  "manager",
  "super_admin",
] as const;

const AGENT_OPS_ROLES = [
  "agent_ops",
  "operations",
  "coo",
  "ceo",
  "cfo",
  "cto",
  "manager",
  "super_admin",
] as const;

const AGENT_OPS_SILENT_ROLES = [
  "agent_ops",
  "tenant_ops",
  "operations",
  "coo",
  "ceo",
  "cfo",
  "cto",
  "manager",
  "super_admin",
] as const;

const PARTNER_OPS_ROLES = [
  "partner_ops",
  "cfo",
  "ceo",
  "coo",
  "manager",
  "super_admin",
] as const;

const PARTNER_OPS_REPORT_ROLES = [
  "partner_ops",
  "financial_ops",
  "cfo",
  "ceo",
  "coo",
  "manager",
  "super_admin",
] as const;

const PSO_ROLES = [
  "partner_ops",
  "hr",
  "coo",
  "ceo",
  "super_admin",
] as const;

const FINANCE_REPORT_ROLES = [
  "cfo",
  "ceo",
  "coo",
  "manager",
  "financial_ops",
  "cto",
  "super_admin",
] as const;

const CFO_CEO_ROLES = ["cfo", "ceo", "super_admin"] as const;

const CFO_BUDGET_ROLES = ["cfo", "ceo", "coo", "super_admin"] as const;

const FINOPS_REQUISITION_ROLES = [
  "financial_ops",
  "cfo",
  "ceo",
  "coo",
  "super_admin",
] as const;

const EXECUTIVE_OVERVIEW_ROLES = [
  "coo",
  "ceo",
  "cfo",
  "manager",
  "super_admin",
] as const;

const HR_CALLING_ROLES = [
  "hr",
  "tenant_ops",
  "landlord_ops",
  "operations",
  "coo",
  "cfo",
  "ceo",
  "manager",
  "super_admin",
] as const;

const HR_CONTRACTS_ROLES = [
  "hr",
  "coo",
  "ceo",
  "cfo",
  "super_admin",
] as const;

const HR_PAYROLL_ROLES = [
  "hr",
  "cfo",
  "coo",
  "ceo",
  "super_admin",
] as const;

export const STAFF_TOOLS: StaffTool[] = [
  // ===========================================================================
  // GROUP A — EVERY STAFF MEMBER (MY SPACE PERSONAL ITEMS, Q1–Q9)
  // ===========================================================================
  {
    name: "get_my_profile",
    rpc: "assistant_staff_my_profile",
    description:
      "Get the signed-in staff member's own My Space profile, HR staff reference, active department and position assignments, enabled roles, and permitted dashboards.",
    allowedRoles: ["*"],
    sensitive: false,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: EmptySchema,
    toRpcArgs: () => ({}),
  },
  {
    name: "get_my_payslips",
    rpc: "assistant_staff_my_payslips",
    description:
      "Get the signed-in staff member's own payslips from My Space (period code, pay date, gross, PAYE, NSSF employee contribution, other deductions, net pay, and payroll run status).",
    allowedRoles: ["*"],
    sensitive: true,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: EmptySchema,
    toRpcArgs: () => ({}),
  },
  {
    name: "get_my_tasks",
    rpc: "assistant_staff_my_tasks",
    description:
      "Get the signed-in staff member's own assigned HR tasks in My Space, optionally filtered by status (pending, in_progress, submitted, completed, cancelled), including due dates and overdue flags.",
    allowedRoles: ["*"],
    sensitive: false,
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "in_progress", "submitted", "completed", "cancelled"],
          description: "Optional task status filter.",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        status: z.enum(["pending", "in_progress", "submitted", "completed", "cancelled"]).optional(),
      })
      .strict(),
    toRpcArgs: (p) => ({
      p_status: (p.status as string | undefined) ?? null,
    }),
  },
  {
    name: "get_my_tickets",
    rpc: "assistant_staff_my_tickets",
    description:
      "Get the signed-in staff member's own HR tickets (raised by them or linked to their assigned tasks), including severity, assignee, task link, and resolution summary.",
    allowedRoles: ["*"],
    sensitive: false,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: EmptySchema,
    toRpcArgs: () => ({}),
  },
  {
    name: "get_my_requisitions",
    rpc: "assistant_staff_my_requisitions",
    description:
      "Get the signed-in staff member's own staff requisitions (amount, approved amount, approval stage, current approver role, wallet credit status), stage transition notices, and usage-report notices.",
    allowedRoles: ["*"],
    sensitive: false,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: EmptySchema,
    toRpcArgs: () => ({}),
  },
  {
    name: "get_my_advances",
    rpc: "assistant_staff_my_advances",
    description:
      "Get the signed-in staff member's own salary advances in My Space, including principal, recovered amount, outstanding balance, recovery mode, recovery months, and status.",
    allowedRoles: ["*"],
    sensitive: true,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: EmptySchema,
    toRpcArgs: () => ({}),
  },
  {
    name: "get_my_pending_concerns",
    rpc: "assistant_staff_my_pending_concerns",
    description:
      "Get Calling Center concerns forwarded or assigned to the signed-in staff member that are still pending review.",
    allowedRoles: ["*"],
    sensitive: false,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: EmptySchema,
    toRpcArgs: () => ({}),
  },
  {
    name: "get_my_canteen",
    rpc: "assistant_staff_my_canteen",
    description:
      "Get the canteen menu for a service date (defaults to today in Kampala) and the signed-in staff member's own canteen food orders.",
    allowedRoles: ["*"],
    sensitive: false,
    parameters: {
      type: "object",
      properties: {
        service_date: {
          type: "string",
          description: "Optional service date YYYY-MM-DD (defaults to today in Kampala).",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        service_date: z.string().regex(ISO_DATE).optional(),
      })
      .strict(),
    toRpcArgs: (p) => ({
      p_service_date: (p.service_date as string | undefined) ?? null,
    }),
  },
  {
    name: "get_my_wallet",
    rpc: "assistant_staff_my_wallet",
    description:
      "Get the signed-in staff member's own personal wallet balances (total balance, withdrawable balance, float balance, locked balance, and advance balance).",
    allowedRoles: ["*"],
    sensitive: true,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: EmptySchema,
    toRpcArgs: () => ({}),
  },

  // ===========================================================================
  // GROUP B — TENANT OPS (Q10–Q17)
  // ===========================================================================
  {
    name: "get_tops_first_seven_summary",
    rpc: "assistant_staff_tops_first_seven_summary",
    description:
      "Tenant Ops First 7 Days onboarding & collection performance summary for newly funded Rent Plans over a date range, optionally filtered by repayment frequency.",
    allowedRoles: TENANT_OPS_ROLES,
    sensitive: false,
    parameters: {
      type: "object",
      properties: {
        ...periodProperties,
        frequency: {
          type: "string",
          enum: ["daily", "weekly", "monthly"],
          description: "Optional repayment frequency filter.",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        period: z.enum(PERIODS).optional(),
        from: z.string().regex(ISO_DATE).optional(),
        to: z.string().regex(ISO_DATE).optional(),
        frequency: z.enum(["daily", "weekly", "monthly"]).optional(),
      })
      .strict()
      .refine((v) => !(v.period && (v.from || v.to)), {
        message: "Provide either `period` or `from`/`to`, not both.",
      }),
    toRpcArgs: (p) => ({
      ...rangeArgs(p, "last_30_days"),
      p_frequency: (p.frequency as string | undefined) ?? null,
    }),
  },
  {
    name: "get_tops_arrears_ageing",
    rpc: "assistant_staff_tops_arrears_ageing",
    description:
      "Tenant Ops arrears ageing report (AM clock): bucket totals and individual overdue Rent Plan rows as of a date.",
    allowedRoles: TENANT_OPS_FINANCE_ROLES,
    sensitive: true,
    parameters: {
      type: "object",
      properties: {
        as_at: {
          type: "string",
          description: "Optional snapshot date YYYY-MM-DD (defaults to today in Kampala).",
        },
        bucket: {
          type: "string",
          description: "Optional ageing bucket filter (e.g. 1_7, 8_14, 15_30, 31_60, 61_90, 90_plus).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Max overdue Rent Plan rows to return (default 50, max 200).",
        },
        dir: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Sort direction (default desc).",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        as_at: z.string().regex(ISO_DATE).optional(),
        bucket: z.string().max(24).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        dir: z.enum(["asc", "desc"]).optional(),
      })
      .strict(),
    toRpcArgs: (p) => ({
      p_as_at: (p.as_at as string | undefined) ?? null,
      p_bucket: (p.bucket as string | undefined) ?? null,
      p_limit: (p.limit as number | undefined) ?? 50,
      p_offset: 0,
      p_dir: (p.dir as string | undefined) ?? "desc",
    }),
  },
  {
    name: "get_tops_landlord_not_paid",
    rpc: "assistant_staff_tops_landlord_not_paid",
    description:
      "Tenant Ops uncovered Rent Plans / Landlord Not Paid summary and rows: funded Rent Plans where the tenant is paying or awaiting landlord payout.",
    allowedRoles: TENANT_OPS_FINANCE_ROLES,
    sensitive: true,
    parameters: {
      type: "object",
      properties: {
        as_at: {
          type: "string",
          description: "Optional snapshot date YYYY-MM-DD (defaults to today in Kampala).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Max rows to return (default 50, max 200).",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        as_at: z.string().regex(ISO_DATE).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
    toRpcArgs: (p) => ({
      p_as_at: (p.as_at as string | undefined) ?? null,
      p_limit: (p.limit as number | undefined) ?? 50,
      p_offset: 0,
    }),
  },
  {
    name: "get_tops_tenant_classification",
    rpc: "assistant_staff_tops_tenant_classification",
    description:
      "Tenant Ops tenant behavioral classification summary across active Rent Plans.",
    allowedRoles: TENANT_OPS_ROLES,
    sensitive: false,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: EmptySchema,
    toRpcArgs: () => ({}),
  },
  {
    name: "get_tops_smartphone_usage",
    rpc: "assistant_staff_tops_smartphone_usage",
    description:
      "Tenant Ops smartphone vs non-smartphone tenant payment & collection usage summary over a date range.",
    allowedRoles: TENANT_OPS_ROLES,
    sensitive: false,
    parameters: {
      type: "object",
      properties: periodProperties,
      additionalProperties: false,
    },
    schema: PeriodArgsSchema,
    toRpcArgs: (p) => rangeArgs(p, "last_30_days"),
  },
  {
    name: "get_tops_weekly_performance",
    rpc: "assistant_staff_tops_weekly_performance",
    description:
      "Tenant Ops weekly collection and Rent Plan performance report (AM clock) anchored on a date (defaults to today in Kampala).",
    allowedRoles: TENANT_OPS_OPS_ROLES,
    sensitive: false,
    parameters: {
      type: "object",
      properties: {
        anchor: {
          type: "string",
          description: "Optional anchor date YYYY-MM-DD (defaults to today in Kampala).",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        anchor: z.string().regex(ISO_DATE).optional(),
      })
      .strict(),
    toRpcArgs: (p) => ({
      p_anchor: (p.anchor as string | undefined) ?? null,
    }),
  },
  {
    name: "get_tops_no_payment_report",
    rpc: "assistant_staff_tops_no_payment_report",
    description:
      "Tenant Ops report of funded Rent Plans with no tenant payment for at least N days (defaults to 20 days).",
    allowedRoles: TENANT_OPS_ROLES,
    sensitive: true,
    parameters: {
      type: "object",
      properties: {
        min_days: {
          type: "integer",
          minimum: 1,
          maximum: 365,
          description: "Minimum days without payment (default 20).",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        min_days: z.number().int().min(1).max(365).optional(),
      })
      .strict(),
    toRpcArgs: (p) => ({
      p_min_days: (p.min_days as number | undefined) ?? 20,
    }),
  },
  {
    name: "get_tops_rent_request_lifetime",
    rpc: "assistant_staff_tops_rent_request_lifetime",
    description:
      "Tenant Ops Rent Plan request lifetime and stage-to-stage pipeline turnaround metrics.",
    allowedRoles: TENANT_OPS_OPS_ROLES,
    sensitive: false,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: EmptySchema,
    toRpcArgs: () => ({}),
  },

  // ===========================================================================
  // GROUP C — LANDLORD OPS (Q18–Q22)
  // ===========================================================================
  {
    name: "get_lops_home_range",
    rpc: "assistant_staff_lops_home_range",
    description:
      "Landlord Ops home dashboard summary over a date range: landlord pipeline counts, verification transitions, and payouts.",
    allowedRoles: LANDLORD_OPS_HOME_ROLES,
    sensitive: false,
    parameters: {
      type: "object",
      properties: periodProperties,
      additionalProperties: false,
    },
    schema: PeriodArgsSchema,
    toRpcArgs: (p) => rangeArgs(p, "last_30_days"),
  },
  {
    name: "get_lops_paid_lists",
    rpc: "assistant_staff_lops_paid_lists",
    description:
      "Landlord Ops paid landlord lists by repayment status tab (paid_repaying, paid_not_repaying, completed, all) with optional name/phone search.",
    allowedRoles: LANDLORD_OPS_PAID_ROLES,
    sensitive: true,
    parameters: {
      type: "object",
      properties: {
        tab: {
          type: "string",
          enum: ["paid_repaying", "paid_not_repaying", "completed", "all"],
          description: "Paid landlord list tab (default paid_repaying).",
        },
        search: {
          type: "string",
          description: "Optional landlord or tenant name/phone search term.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Max rows to return (default 50, max 200).",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        tab: z.enum(["paid_repaying", "paid_not_repaying", "completed", "all"]).optional(),
        search: SearchField.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
    toRpcArgs: (p) => ({
      p_tab: (p.tab as string | undefined) ?? "paid_repaying",
      p_search: (p.search as string | undefined) ?? null,
      p_limit: (p.limit as number | undefined) ?? 50,
      p_offset: 0,
    }),
  },
  {
    name: "get_lops_principal_comparison",
    rpc: "assistant_staff_lops_principal_comparison",
    description:
      "Landlord Ops cumulative non-cancelled float allocations versus non-reversed principal collected, plus float overview.",
    allowedRoles: LANDLORD_OPS_PRINCIPAL_ROLES,
    sensitive: true,
    parameters: {
      type: "object",
      properties: periodProperties,
      additionalProperties: false,
    },
    schema: PeriodArgsSchema,
    toRpcArgs: (p) => {
      if (!p.period && !p.from && !p.to) {
        return { p_from: null, p_to: kampalaToday() };
      }
      return rangeArgs(p, "last_30_days");
    },
  },
  {
    name: "get_lops_calling_summary",
    rpc: "assistant_staff_lops_calling_summary",
    description:
      "Landlord Calling Center daily call summary by staff member and Wednesday–Tuesday weekly report.",
    allowedRoles: LANDLORD_CC_ROLES,
    sensitive: false,
    parameters: {
      type: "object",
      properties: {
        ...periodProperties,
        week_start: {
          type: "string",
          description:
            "Optional Wednesday week start date YYYY-MM-DD for the weekly calling report (defaults to current Wednesday–Tuesday week).",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        period: z.enum(PERIODS).optional(),
        from: z.string().regex(ISO_DATE).optional(),
        to: z.string().regex(ISO_DATE).optional(),
        week_start: z.string().regex(ISO_DATE).optional(),
      })
      .strict()
      .refine((v) => !(v.period && (v.from || v.to)), {
        message: "Provide either `period` or `from`/`to`, not both.",
      }),
    toRpcArgs: (p) => ({
      ...rangeArgs(p, "last_7_days"),
      p_week_start: (p.week_start as string | undefined) ?? currentWednesdayWeekStart(),
    }),
  },
  {
    name: "get_lops_calling_coverage",
    rpc: "assistant_staff_lops_calling_coverage",
    description:
      "Landlord Calling Center registry reach and calling coverage breakdown by region and district.",
    allowedRoles: LANDLORD_CC_ROLES,
    sensitive: false,
    parameters: {
      type: "object",
      properties: {
        as_at: {
          type: "string",
          description: "Optional snapshot date YYYY-MM-DD (defaults to now).",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        as_at: z.string().regex(ISO_DATE).optional(),
      })
      .strict(),
    toRpcArgs: (p) => ({
      p_as_at: typeof p.as_at === "string" ? `${p.as_at}T23:59:59+03:00` : null,
    }),
  },

  // ===========================================================================
  // GROUP D — AGENT OPS (Q23–Q27, 5 tools)
  // ===========================================================================
  {
    name: "get_aops_network_overview",
    rpc: "assistant_staff_aops_network_overview",
    description:
      "Agent Ops network overview over a date range: qualifying agents, active book, bike leases, smartphone adoption, top portfolios, and collection rates.",
    allowedRoles: AGENT_OPS_NETWORK_ROLES,
    sensitive: false,
    parameters: {
      type: "object",
      properties: {
        ...periodProperties,
        min_expected: {
          type: "number",
          minimum: 0,
          description: "Optional minimum expected UGX threshold for collection rate ranking (default 50000).",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        period: z.enum(PERIODS).optional(),
        from: z.string().regex(ISO_DATE).optional(),
        to: z.string().regex(ISO_DATE).optional(),
        min_expected: z.number().min(0).optional(),
      })
      .strict()
      .refine((v) => !(v.period && (v.from || v.to)), {
        message: "Provide either `period` or `from`/`to`, not both.",
      }),
    toRpcArgs: (p) => ({
      ...rangeArgs(p, "last_30_days"),
      p_min_expected: (p.min_expected as number | undefined) ?? 50000,
    }),
  },
  {
    name: "get_aops_metrics_totals",
    rpc: "assistant_staff_aops_metrics_totals",
    description:
      "Agent Ops network metrics totals over a date range: house listings, verified/pending/rejected counts, listing earnings from ledger, and agent advances summary.",
    allowedRoles: AGENT_OPS_ROLES,
    sensitive: false,
    parameters: {
      type: "object",
      properties: periodProperties,
      additionalProperties: false,
    },
    schema: PeriodArgsSchema,
    toRpcArgs: (p) => rangeArgs(p, "last_30_days"),
  },
  {
    name: "get_aops_metrics_agents",
    rpc: "assistant_staff_aops_metrics_agents",
    description:
      "Agent Ops per-agent listing and advance metrics over a date range, with optional name/phone search, scope (qualifying, linked, all), and sort.",
    allowedRoles: AGENT_OPS_ROLES,
    sensitive: true,
    parameters: {
      type: "object",
      properties: {
        ...periodProperties,
        search: {
          type: "string",
          description: "Optional agent name or phone search term.",
        },
        sort: {
          type: "string",
          enum: [
            "name",
            "houses_listed",
            "houses_approved",
            "houses_pending",
            "houses_rejected",
            "listing_earned",
            "clawed_back",
            "net",
            "advance_outstanding",
            "last_listing",
          ],
          description: "Sort field (default houses_listed).",
        },
        scope: {
          type: "string",
          enum: ["qualifying", "linked", "all"],
          description: "Agent scope (default qualifying).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Max rows to return (default 50, max 200).",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        period: z.enum(PERIODS).optional(),
        from: z.string().regex(ISO_DATE).optional(),
        to: z.string().regex(ISO_DATE).optional(),
        search: SearchField.optional(),
        sort: z
          .enum([
            "name",
            "houses_listed",
            "houses_approved",
            "houses_pending",
            "houses_rejected",
            "listing_earned",
            "clawed_back",
            "net",
            "advance_outstanding",
            "last_listing",
          ])
          .optional(),
        scope: z.enum(["qualifying", "linked", "all"]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .strict()
      .refine((v) => !(v.period && (v.from || v.to)), {
        message: "Provide either `period` or `from`/`to`, not both.",
      }),
    toRpcArgs: (p) => ({
      ...rangeArgs(p, "last_30_days"),
      p_search: (p.search as string | undefined) ?? null,
      p_sort: (p.sort as string | undefined) ?? "houses_listed",
      p_scope: (p.scope as string | undefined) ?? "qualifying",
      p_limit: (p.limit as number | undefined) ?? 50,
    }),
  },
  {
    name: "get_aops_listing_quality_and_risk",
    rpc: "assistant_staff_aops_listing_quality_and_risk",
    description:
      "Agent Ops house listing verification quality, waiting queue, and agent advance risk flags (advance with no listings, high advance-to-earnings ratio, inactive listers).",
    allowedRoles: AGENT_OPS_ROLES,
    sensitive: true,
    parameters: {
      type: "object",
      properties: {
        ...periodProperties,
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Max rows per section (default 50, max 100).",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        period: z.enum(PERIODS).optional(),
        from: z.string().regex(ISO_DATE).optional(),
        to: z.string().regex(ISO_DATE).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .strict()
      .refine((v) => !(v.period && (v.from || v.to)), {
        message: "Provide either `period` or `from`/`to`, not both.",
      }),
    toRpcArgs: (p) => ({
      ...rangeArgs(p, "last_30_days"),
      p_limit: (p.limit as number | undefined) ?? 50,
    }),
  },
  {
    name: "get_aops_silent_collectors",
    rpc: "assistant_staff_aops_silent_collectors",
    description:
      "Agent Ops silent collectors report: agents with expected collections today who have not recorded a collection for at least N days, including float blocker status.",
    allowedRoles: AGENT_OPS_SILENT_ROLES,
    sensitive: true,
    parameters: {
      type: "object",
      properties: {
        min_days_silent: {
          type: "integer",
          minimum: 1,
          maximum: 60,
          description: "Minimum days without collection (default 3).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Max rows to return (default 50, max 200).",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        min_days_silent: z.number().int().min(1).max(60).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
    toRpcArgs: (p) => ({
      p_min_days_silent: (p.min_days_silent as number | undefined) ?? 3,
      p_limit: (p.limit as number | undefined) ?? 50,
    }),
  },

  // ===========================================================================
  // GROUP E — PARTNER OPS & PSO (Q28–Q31, 4 tools)
  // ===========================================================================
  {
    name: "get_pops_pending_summary",
    rpc: "assistant_staff_pops_pending_summary",
    description:
      "Partner Ops pending Supporter portfolio queue summary (count, total UGX value, oldest wait days) and monthly promissory notes pending summary.",
    allowedRoles: PARTNER_OPS_ROLES,
    sensitive: false,
    parameters: {
      type: "object",
      properties: {
        month: {
          type: "string",
          description: "Optional month date YYYY-MM-DD (defaults to current month in Kampala).",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        month: z.string().regex(ISO_DATE).optional(),
      })
      .strict(),
    toRpcArgs: (p) => ({
      p_month: (p.month as string | undefined) ?? null,
    }),
  },
  {
    name: "get_pops_report_overview",
    rpc: "assistant_staff_pops_report_overview",
    description:
      "Partner Ops Supporter portfolio & Returns report: all-time and 30-day totals, created portfolios, nearing Returns payouts, paid out Returns, and suspended portfolios.",
    allowedRoles: PARTNER_OPS_REPORT_ROLES,
    sensitive: true,
    parameters: {
      type: "object",
      properties: periodProperties,
      additionalProperties: false,
    },
    schema: PeriodArgsSchema,
    toRpcArgs: (p) => rangeArgs(p, "last_30_days"),
  },
  {
    name: "get_pops_search_supporters",
    rpc: "assistant_staff_pops_search_supporters",
    description:
      "Partner Ops Supporter directory search by name, phone, email, or reference, returning portfolio counts, active portfolios, total principal, and total Returns.",
    allowedRoles: PARTNER_OPS_ROLES,
    sensitive: true,
    parameters: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Optional Supporter name, phone, or reference search term.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Max rows to return (default 50, max 100).",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        search: SearchField.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .strict(),
    toRpcArgs: (p) => ({
      p_search: (p.search as string | undefined) ?? null,
      p_limit: (p.limit as number | undefined) ?? 50,
    }),
  },
  {
    name: "get_pso_cohort_performance",
    rpc: "assistant_staff_pso_cohort_performance",
    description:
      "Partner Support Officer (PSO) cohort performance over a date range: funded promissory notes summary, promised amounts summary, and daily cohort note volume.",
    allowedRoles: PSO_ROLES,
    sensitive: false,
    parameters: {
      type: "object",
      properties: periodProperties,
      additionalProperties: false,
    },
    schema: PeriodArgsSchema,
    toRpcArgs: (p) => rangeArgs(p, "last_30_days"),
  },

  // ===========================================================================
  // GROUP F — CFO & FINANCIAL OPS (Q32–Q36, 6 tools)
  // ===========================================================================
  {
    name: "get_cfo_treasury_cash_position",
    rpc: "assistant_staff_cfo_treasury_cash_position",
    description:
      "Official Treasury cash position from get_treasury_cash_position (single source of truth for platform cash): A1 Cash and Bank, A5 Cash in Custody, and A21/A22 Landlord Float Pool.",
    allowedRoles: FINANCE_REPORT_ROLES,
    sensitive: true,
    parameters: {
      type: "object",
      properties: {
        as_at: {
          type: "string",
          description: "Optional snapshot date YYYY-MM-DD (defaults to now).",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        as_at: z.string().regex(ISO_DATE).optional(),
      })
      .strict(),
    toRpcArgs: (p) => ({
      p_as_at: typeof p.as_at === "string" ? `${p.as_at}T23:59:59+03:00` : null,
    }),
  },
  {
    name: "get_cfo_money_flow_summary",
    rpc: "assistant_staff_cfo_money_flow_summary",
    description:
      "CFO money received (approved deposits today, this month, all-time, pending) and money paid out (completed withdrawals today, yesterday, last 7 days, this month, pending).",
    allowedRoles: CFO_CEO_ROLES,
    sensitive: true,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: EmptySchema,
    toRpcArgs: () => ({}),
  },
  {
    name: "get_cfo_receivables_and_payables",
    rpc: "assistant_staff_cfo_receivables_and_payables",
    description:
      "Official company Receivables total, Payables total (overdue, due today, by category), and predictive Payables forecast across day/week/month/quarter/year.",
    allowedRoles: FINANCE_REPORT_ROLES,
    sensitive: true,
    parameters: {
      type: "object",
      properties: {
        granularity: {
          type: "string",
          enum: ["day", "week", "month", "quarter", "year"],
          description: "Forecast period granularity (default week).",
        },
        periods: {
          type: "integer",
          minimum: 1,
          maximum: 24,
          description: "Number of forecast periods (default 4, max 24).",
        },
        as_at: {
          type: "string",
          description: "Optional anchor date YYYY-MM-DD (defaults to today in Kampala).",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        granularity: z.enum(["day", "week", "month", "quarter", "year"]).optional(),
        periods: z.number().int().min(1).max(24).optional(),
        as_at: z.string().regex(ISO_DATE).optional(),
      })
      .strict(),
    toRpcArgs: (p) => ({
      p_granularity: (p.granularity as string | undefined) ?? "week",
      p_periods: (p.periods as number | undefined) ?? 4,
      p_as_at: (p.as_at as string | undefined) ?? null,
    }),
  },
  {
    name: "get_cfo_seven_day_expenses",
    rpc: "assistant_staff_cfo_seven_day_expenses",
    description:
      "CFO 7-day actual and 7-day predicted platform expenses by ledger expense category (Kampala days).",
    allowedRoles: FINANCE_REPORT_ROLES,
    sensitive: true,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: EmptySchema,
    toRpcArgs: () => ({}),
  },
  {
    name: "get_cfo_budget_revised_position",
    rpc: "assistant_staff_cfo_budget_revised_position",
    description:
      "CFO revised budget position for the active budget cycle: original approved amount, approved supplements, pending supplements, revised amount, actual expenditure, and remaining balance.",
    allowedRoles: CFO_BUDGET_ROLES,
    sensitive: true,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: EmptySchema,
    toRpcArgs: () => ({}),
  },
  {
    name: "get_fops_verification_and_requisitions",
    rpc: "assistant_staff_fops_verification_and_requisitions",
    description:
      "Financial Ops payout destination verification queue counts (waiting, verified, rejected, mismatch, no_id, double) and CFO-approved requisitions over a date range.",
    allowedRoles: FINOPS_REQUISITION_ROLES,
    sensitive: true,
    parameters: {
      type: "object",
      properties: periodProperties,
      additionalProperties: false,
    },
    schema: PeriodArgsSchema,
    toRpcArgs: (p) => rangeArgs(p, "last_30_days"),
  },

  // ===========================================================================
  // GROUP G — COO, CEO & MANAGERS (Q37–Q38, 2 tools)
  // ===========================================================================
  {
    name: "get_coo_overview",
    rpc: "assistant_staff_coo_overview",
    description:
      "COO Command Center live operational summary (collections today/month, agent fleet, tenant book, Rent Plan pipeline stages, pending decisions) and Rent Coverage Statement.",
    allowedRoles: EXECUTIVE_OVERVIEW_ROLES,
    sensitive: true,
    parameters: {
      type: "object",
      properties: {
        ...periodProperties,
        days: {
          type: "integer",
          minimum: 3,
          maximum: 60,
          description: "Trailing window in days when explicit dates are not passed (default 14).",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        period: z.enum(PERIODS).optional(),
        from: z.string().regex(ISO_DATE).optional(),
        to: z.string().regex(ISO_DATE).optional(),
        days: z.number().int().min(3).max(60).optional(),
      })
      .strict()
      .refine((v) => !(v.period && (v.from || v.to)), {
        message: "Provide either `period` or `from`/`to`, not both.",
      }),
    toRpcArgs: (p) => {
      const days = (p.days as number | undefined) ?? 14;
      if (p.period || p.from || p.to) {
        return { p_days: days, ...rangeArgs(p, "last_30_days") };
      }
      return { p_days: days, p_from: null, p_to: null };
    },
  },
  {
    name: "get_ceo_growth_and_approvals",
    rpc: "assistant_staff_ceo_growth_and_approvals",
    description:
      "CEO growth quality report (behavioral signals, trust coverage, capital deployed, active Rent Plans, arrears by trust band, funding tempo) and next pending staff requisition prompt.",
    allowedRoles: EXECUTIVE_OVERVIEW_ROLES,
    sensitive: true,
    parameters: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          minimum: 1,
          maximum: 180,
          description: "Window in days for growth quality metrics (default 30).",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        days: z.number().int().min(1).max(180).optional(),
      })
      .strict(),
    toRpcArgs: (p) => ({
      p_days: (p.days as number | undefined) ?? 30,
    }),
  },

  // ===========================================================================
  // GROUP H — HR & CALLING TEAM (Q39–Q40, 3 tools)
  // ===========================================================================
  {
    name: "get_hr_calling_detailed_report",
    rpc: "assistant_staff_hr_calling_detailed_report",
    description:
      "Staff Calling & Pipeline Feedback detailed report (Jane, Winnie, Hanisha) and weekly all-calls summary across Tenant & Landlord Calling Centers and Rent Plan pipeline reviews.",
    allowedRoles: HR_CALLING_ROLES,
    sensitive: true,
    parameters: {
      type: "object",
      properties: periodProperties,
      additionalProperties: false,
    },
    schema: PeriodArgsSchema,
    toRpcArgs: (p) => rangeArgs(p, "last_7_days"),
  },
  {
    name: "get_hr_contracts_and_birthdays",
    rpc: "assistant_staff_hr_contracts_and_birthdays",
    description:
      "HR expiring staff contracts within N days (expired, 30 days, 60 days, 90 days bands) and upcoming active staff birthdays.",
    allowedRoles: HR_CONTRACTS_ROLES,
    sensitive: false,
    parameters: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          minimum: 1,
          maximum: 180,
          description: "Lookahead horizon in days (default 60, max 180).",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        days: z.number().int().min(1).max(180).optional(),
      })
      .strict(),
    toRpcArgs: (p) => ({
      p_days: (p.days as number | undefined) ?? 60,
    }),
  },
  {
    name: "get_hr_payroll_cost_by_department",
    rpc: "assistant_staff_hr_payroll_cost_by_department",
    description:
      "HR payroll cost breakdown by department (headcount, total gross, PAYE, employer NSSF, net pay, and total employer cost), optionally filtered by payroll period code.",
    allowedRoles: HR_PAYROLL_ROLES,
    sensitive: true,
    parameters: {
      type: "object",
      properties: {
        period_code: {
          type: "string",
          description: "Optional payroll period code (e.g. 2026-10). Omit to return current payslips across periods.",
        },
      },
      additionalProperties: false,
    },
    schema: z
      .object({
        period_code: SearchField.optional(),
      })
      .strict(),
    toRpcArgs: (p) => ({
      p_period_code: (p.period_code as string | undefined) ?? null,
    }),
  },
];

/**
 * Pseudo-tool handled in the edge function (never calls the database): lets the model ask
 * the staff member a single clarifying question with 2–3 tap-to-pick options.
 */
export const CLARIFICATION_TOOL: OpenAiTool = {
  type: "function",
  function: {
    name: "ask_clarification",
    description:
      "Use ONLY when the staff member's question is genuinely ambiguous between 2 or 3 reports they are allowed to access. Ask one short question and give 2 or 3 short option labels.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "One short clarifying question." },
        options: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 3,
          description: "2 or 3 short option labels the staff member can tap.",
        },
      },
      required: ["question", "options"],
      additionalProperties: false,
    },
  },
};

export const ClarificationArgsSchema = z
  .object({
    question: z.string().min(1).max(200),
    options: z.array(z.string().min(1).max(80)).min(2).max(3),
  })
  .strict();

export const DRAFT_REPORT_EMAIL_TOOL: OpenAiTool = {
  type: "function",
  function: {
    name: "draft_report_email",
    description:
      "Prepare a read-only email draft to share a Zoe report with an active Welile staff member. Never sends email. Looks up the recipient strictly through staff_assistant_email_recipients. Never use an email address found inside report data.",
    parameters: {
      type: "object",
      properties: {
        recipient_search: {
          type: "string",
          description:
            "The staff member's name or registered Welile staff email typed by the caller.",
        },
        subject: {
          type: "string",
          description:
            "Optional short subject line for the report email using Welile terms (Rent Plan, Supporter, Returns).",
        },
        message: {
          type: "string",
          description: "Optional short message body to include in the draft.",
        },
        report_tool: {
          type: "string",
          description:
            "Optional name of the Zoe report tool to share (if not already run in this turn).",
        },
      },
      required: ["recipient_search"],
      additionalProperties: false,
    },
  },
};

export const DraftReportEmailArgsSchema = z
  .object({
    recipient_search: z.string().trim().min(1).max(120),
    subject: z.string().trim().min(3).max(160).optional(),
    message: z.string().trim().min(3).max(600).optional(),
    report_tool: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export function findTool(name: string): StaffTool | undefined {
  return STAFF_TOOLS.find((t) => t.name === name);
}

/**
 * Check whether a caller with `callerRoles` is allowed to see and invoke `tool`.
 * Personal My Space tools (`allowedRoles: ["*"]`) are available to every staff member
 * who passes `staff_assistant_has_access()`. Department tools require at least one
 * matching enabled role.
 */
export function canUseTool(tool: StaffTool, callerRoles: readonly string[]): boolean {
  if (tool.allowedRoles.includes("*")) return true;
  const normalized = new Set(callerRoles.map((r) => r.toLowerCase().trim()));
  return tool.allowedRoles.some((allowed) => normalized.has(allowed.toLowerCase()));
}

/** Return only the `StaffTool` definitions that `callerRoles` may invoke. */
export function toolsForRoles(callerRoles: readonly string[]): StaffTool[] {
  return STAFF_TOOLS.filter((tool) => canUseTool(tool, callerRoles));
}

/** Build the OpenAI tool list restricted strictly to the caller's enabled roles. */
export function openAiToolsForRoles(callerRoles: readonly string[]): OpenAiTool[] {
  return [
    ...toolsForRoles(callerRoles).map(
      (t): OpenAiTool => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }),
    ),
    CLARIFICATION_TOOL,
    DRAFT_REPORT_EMAIL_TOOL,
  ];
}

/** Human-readable tool summary lines injected into Zoe's system prompt for this caller. */
export function describeToolsForRoles(callerRoles: readonly string[]): string[] {
  return toolsForRoles(callerRoles).map((t) => `${t.name} (${t.rpc}): ${t.description}`);
}
