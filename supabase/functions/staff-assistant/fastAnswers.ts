/**
 * Part D item (4) — 30 fixed, checked fast answers (`ZOE_FAST_ANSWERS`).
 *
 * Provides 30 deterministic, role-checked templates for the 30 most common staff
 * questions across My Space, Tenant Ops, Landlord Ops, Agent Ops, Partner Ops,
 * CFO & Financial Ops, COO & CEO, HR & Calling Center, and Welile Glossary/Processes.
 *
 * Every template maps to an official read-only Zoe tool (`tool`) and RPC (`rpc`),
 * respects role-based access control (`canUseTool`), and formats figures strictly
 * from the live tool payload so `checkAnswer` passes deterministically.
 */

import { formatPeriodLabel } from "./dates.ts";
import { canUseTool, findTool, type StaffTool } from "./tools.ts";

export interface FastAnswerTemplate {
  readonly id: string;
  readonly category:
    | "my_space"
    | "tenant_ops"
    | "landlord_ops"
    | "agent_ops"
    | "partner_ops"
    | "finance_cfo"
    | "executive"
    | "hr_calling"
    | "glossary_kb";
  readonly title: string;
  readonly tool: string;
  readonly rpc: string;
  readonly defaultArgs: Record<string, unknown>;
  readonly pattern: RegExp;
}

export const ZOE_FAST_ANSWERS: ReadonlyArray<FastAnswerTemplate> = [
  // ---- My Space (8) ----
  {
    id: "FA-01",
    category: "my_space",
    title: "My Space profile & enabled roles",
    tool: "get_my_profile",
    rpc: "assistant_staff_my_profile",
    defaultArgs: {},
    pattern: /^(?:show\s+)?my\s+(?:my\s+space\s+)?profile(?:\s+and\s+(?:enabled\s+)?roles)?[?.!]*$/i,
  },
  {
    id: "FA-02",
    category: "my_space",
    title: "My pending tasks in My Work",
    tool: "get_my_tasks",
    rpc: "assistant_staff_my_tasks",
    defaultArgs: {},
    pattern: /^(?:show\s+|what\s+are\s+)?my\s+(?:pending\s+|assigned\s+)?tasks(?:\s+in\s+my\s+work)?[?.!]*$/i,
  },
  {
    id: "FA-03",
    category: "my_space",
    title: "My HR support tickets",
    tool: "get_my_tickets",
    rpc: "assistant_staff_my_tickets",
    defaultArgs: {},
    pattern: /^(?:show\s+|what\s+are\s+)?my\s+(?:hr\s+)?(?:support\s+)?tickets[?.!]*$/i,
  },
  {
    id: "FA-04",
    category: "my_space",
    title: "My staff requisitions status",
    tool: "get_my_requisitions",
    rpc: "assistant_staff_my_requisitions",
    defaultArgs: {},
    pattern: /^(?:show\s+|what\s+is\s+the\s+status\s+of\s+)?my\s+(?:staff\s+)?requisitions[?.!]*$/i,
  },
  {
    id: "FA-05",
    category: "my_space",
    title: "My recent payslips",
    tool: "get_my_payslips",
    rpc: "assistant_staff_my_payslips",
    defaultArgs: {},
    pattern: /^(?:show\s+|what\s+are\s+)?my\s+(?:recent\s+|latest\s+)?payslips[?.!]*$/i,
  },
  {
    id: "FA-06",
    category: "my_space",
    title: "My salary advances",
    tool: "get_my_advances",
    rpc: "assistant_staff_my_advances",
    defaultArgs: {},
    pattern: /^(?:show\s+|what\s+are\s+)?my\s+(?:salary\s+)?advances(?:\s+and\s+outstanding\s+balance)?[?.!]*$/i,
  },
  {
    id: "FA-07",
    category: "my_space",
    title: "My personal wallet balance",
    tool: "get_my_wallet",
    rpc: "assistant_staff_my_wallet",
    defaultArgs: {},
    pattern: /^(?:show\s+|what\s+is\s+)?my\s+(?:personal\s+)?wallet\s+balance[?.!]*$/i,
  },
  {
    id: "FA-08",
    category: "my_space",
    title: "My calls logged this week",
    tool: "get_my_calls",
    rpc: "assistant_staff_my_calls",
    defaultArgs: { period: "this_week" },
    pattern: /^(?:show\s+|how\s+many\s+)?(?:my\s+calls|calls\s+have\s+i\s+logged)\s+this\s+week[?.!]*$/i,
  },

  // ---- Tenant Ops (6) ----
  {
    id: "FA-09",
    category: "tenant_ops",
    title: "First 7 Days collection summary",
    tool: "get_tops_first_seven_summary",
    rpc: "assistant_staff_tops_first_seven_summary",
    defaultArgs: {},
    pattern: /^(?:show\s+)?(?:the\s+)?(?:tenant\s+ops\s+)?first\s+7\s+days\s+(?:collection\s+)?summary[?.!]*$/i,
  },
  {
    id: "FA-10",
    category: "tenant_ops",
    title: "Tenant Ops arrears ageing breakdown",
    tool: "get_tops_arrears_ageing",
    rpc: "assistant_staff_tops_arrears_ageing",
    defaultArgs: {},
    pattern: /^(?:show\s+|what\s+is\s+)?(?:the\s+)?(?:tenant\s+ops\s+)?arrears\s+ageing(?:\s+breakdown)?(?:\s+today)?[?.!]*$/i,
  },
  {
    id: "FA-11",
    category: "tenant_ops",
    title: "Uncovered Rent Plans (landlord not paid)",
    tool: "get_tops_landlord_not_paid",
    rpc: "assistant_staff_tops_landlord_not_paid",
    defaultArgs: {},
    pattern: /^(?:show\s+|how\s+many\s+active\s+rent\s+plans\s+are\s+in\s+)?(?:the\s+)?landlord\s+not\s+paid\s+report[?.!]*$/i,
  },
  {
    id: "FA-12",
    category: "tenant_ops",
    title: "Tenant Ops weekly collection performance",
    tool: "get_tops_weekly_performance",
    rpc: "assistant_staff_tops_weekly_performance",
    defaultArgs: {},
    pattern: /^(?:show\s+|what\s+is\s+)?(?:our\s+|the\s+)?tenant\s+ops\s+weekly\s+(?:collection\s+)?performance(?:\s+this\s+week)?[?.!]*$/i,
  },
  {
    id: "FA-13",
    category: "tenant_ops",
    title: "Open Rent Plan requests by stage",
    tool: "get_tops_rent_requests_by_stage",
    rpc: "assistant_staff_tops_rent_requests_by_stage",
    defaultArgs: {},
    pattern: /^(?:show\s+)?(?:open\s+)?rent\s+plan\s+requests\s+by\s+stage[?.!]*$/i,
  },
  {
    id: "FA-14",
    category: "tenant_ops",
    title: "Rent Plan time on desk",
    tool: "get_tops_time_on_desk",
    rpc: "assistant_staff_tops_time_on_desk",
    defaultArgs: {},
    pattern: /^(?:show\s+|what\s+is\s+)?(?:the\s+)?time\s+on\s+desk\s+for\s+(?:open\s+)?rent\s+plan\s+requests[?.!]*$/i,
  },

  // ---- Landlord Ops (4) ----
  {
    id: "FA-15",
    category: "landlord_ops",
    title: "Landlord Ops 7-day summary",
    tool: "get_lops_home_range",
    rpc: "assistant_staff_lops_home_range",
    defaultArgs: { period: "last_7_days" },
    pattern: /^(?:show\s+)?(?:the\s+)?landlord\s+ops\s+summary(?:\s+for\s+the\s+last\s+7\s+days)?[?.!]*$/i,
  },
  {
    id: "FA-16",
    category: "landlord_ops",
    title: "Landlord Ops verification queue",
    tool: "get_lops_verification_queue",
    rpc: "assistant_staff_lops_verification_queue",
    defaultArgs: {},
    pattern: /^(?:show\s+|how\s+many\s+items\s+are\s+in\s+)?(?:the\s+)?landlord\s+ops\s+verification\s+queue[?.!]*$/i,
  },
  {
    id: "FA-17",
    category: "landlord_ops",
    title: "Landlord Calling Center summary",
    tool: "get_lops_calling_summary",
    rpc: "assistant_staff_lops_calling_summary",
    defaultArgs: { period: "last_7_days" },
    pattern: /^(?:show\s+)?(?:the\s+)?landlord\s+calling\s+center\s+summary[?.!]*$/i,
  },
  {
    id: "FA-18",
    category: "landlord_ops",
    title: "Landlord Calling Center coverage",
    tool: "get_lops_calling_coverage",
    rpc: "assistant_staff_lops_calling_coverage",
    defaultArgs: {},
    pattern: /^(?:show\s+|what\s+is\s+)?(?:the\s+)?landlord\s+calling\s+center\s+coverage[?.!]*$/i,
  },

  // ---- Agent Ops (3) ----
  {
    id: "FA-19",
    category: "agent_ops",
    title: "Agent Ops network overview",
    tool: "get_aops_network_overview",
    rpc: "assistant_staff_aops_network_overview",
    defaultArgs: { period: "last_30_days" },
    pattern: /^(?:show\s+)?(?:the\s+)?agent\s+ops\s+network\s+overview[?.!]*$/i,
  },
  {
    id: "FA-20",
    category: "agent_ops",
    title: "Agent Ops silent collectors",
    tool: "get_aops_silent_collectors",
    rpc: "assistant_staff_aops_silent_collectors",
    defaultArgs: {},
    pattern: /^(?:show\s+|which\s+(?:field\s+)?agents\s+are\s+)?silent\s+collectors(?:\s+today)?[?.!]*$/i,
  },
  {
    id: "FA-21",
    category: "agent_ops",
    title: "Agent Ops sub-agent teams",
    tool: "get_aops_subagent_teams",
    rpc: "assistant_staff_aops_subagent_teams",
    defaultArgs: { period: "last_30_days" },
    pattern: /^(?:show\s+)?main\s+agent\s+and\s+sub-?agent\s+teams(?:\s+in\s+agent\s+ops)?[?.!]*$/i,
  },

  // ---- Partner Ops (2) ----
  {
    id: "FA-22",
    category: "partner_ops",
    title: "Pending Supporter portfolios",
    tool: "get_pops_pending_summary",
    rpc: "assistant_staff_pops_pending_summary",
    defaultArgs: {},
    pattern: /^(?:show\s+)?pending\s+supporter\s+portfolios(?:\s+in\s+partner\s+ops)?[?.!]*$/i,
  },
  {
    id: "FA-23",
    category: "partner_ops",
    title: "Supporter Returns due this week",
    tool: "get_pops_returns_due",
    rpc: "assistant_staff_pops_returns_due",
    defaultArgs: { period: "this_week" },
    pattern: /^(?:show\s+|how\s+much\s+in\s+)?supporter\s+returns(?:\s+is)?\s+due\s+this\s+week[?.!]*$/i,
  },

  // ---- CFO & Financial Ops (3) ----
  {
    id: "FA-24",
    category: "finance_cfo",
    title: "Spendable Treasury Cash Position (A1 + A5)",
    tool: "get_cfo_treasury_cash_position",
    rpc: "assistant_staff_cfo_treasury_cash_position",
    defaultArgs: {},
    pattern: /^(?:show\s+|what\s+is\s+)?(?:our\s+)?(?:spendable\s+)?treasury\s+cash\s+position(?:\s*\(a1\s+and\s+a5\))?(?:\s+today)?[?.!]*$/i,
  },
  {
    id: "FA-25",
    category: "finance_cfo",
    title: "CFO Money Flow Summary",
    tool: "get_cfo_money_flow_summary",
    rpc: "assistant_staff_cfo_money_flow_summary",
    defaultArgs: {},
    pattern: /^(?:show\s+)?cfo\s+money\s+(?:in\s+and\s+money\s+out|flow\s+summary)(?:\s+for\s+the\s+last\s+7\s+days)?[?.!]*$/i,
  },
  {
    id: "FA-26",
    category: "finance_cfo",
    title: "CFO Receivables and Payables Summary",
    tool: "get_cfo_receivables_and_payables",
    rpc: "assistant_staff_cfo_receivables_and_payables",
    defaultArgs: {},
    pattern: /^(?:show\s+)?(?:the\s+)?cfo\s+receivables\s+and\s+payables(?:\s+summary)?[?.!]*$/i,
  },

  // ---- COO, CEO & HR (2) ----
  {
    id: "FA-27",
    category: "executive",
    title: "COO Command Center overview",
    tool: "get_coo_overview",
    rpc: "assistant_staff_coo_overview",
    defaultArgs: {},
    pattern: /^(?:show\s+)?(?:the\s+)?coo\s+(?:command\s+center\s+)?overview[?.!]*$/i,
  },
  {
    id: "FA-28",
    category: "hr_calling",
    title: "Detailed staff calling report",
    tool: "get_hr_calling_detailed_report",
    rpc: "assistant_staff_hr_calling_detailed_report",
    defaultArgs: { period: "this_week" },
    pattern: /^(?:show\s+)?(?:the\s+)?detailed\s+staff\s+calling\s+report(?:\s+for\s+this\s+week)?[?.!]*$/i,
  },

  // ---- Welile Glossary & Knowledge Base (2) ----
  {
    id: "FA-29",
    category: "glossary_kb",
    title: "Expected vs Collected rent definition",
    tool: "search_knowledge_base",
    rpc: "assistant_staff_search_knowledge_base",
    defaultArgs: { query: "expected vs collected rent" },
    pattern: /^what\s+is\s+the\s+difference\s+between\s+expected\s+rent\s+and\s+collected\s+rent[?.!]*$/i,
  },
  {
    id: "FA-30",
    category: "glossary_kb",
    title: "Treasury Cash Position vs Agent Float definition",
    tool: "search_knowledge_base",
    rpc: "assistant_staff_search_knowledge_base",
    defaultArgs: { query: "treasury cash position a1 a5 vs agent float a2" },
    pattern: /^what\s+is\s+the\s+difference\s+between\s+treasury\s+cash\s+position\s*(?:\(a1\s*\+\s*a5\))?\s+and\s+agent\s+float\s*(?:\(a2\))?[?.!]*$/i,
  },
];

/**
 * Matches a staff message against the 30 fixed fast-answer templates and verifies
 * that the caller's enabled roles authorize the template's tool.
 */
export function matchFastAnswerTemplate(
  userMessage: string,
  callerRoles?: readonly string[],
): { template: FastAnswerTemplate; toolDef: StaffTool } | null {
  const cleaned = (userMessage ?? "").trim();
  if (!cleaned) return null;

  for (const tpl of ZOE_FAST_ANSWERS) {
    if (!tpl.pattern.test(cleaned)) continue;
    const toolDef = findTool(tpl.tool);
    if (!toolDef) continue;
    if (Array.isArray(callerRoles) && !canUseTool(toolDef, callerRoles)) continue;
    return { template: tpl, toolDef };
  }
  return null;
}

function fmtUgxValue(key: string, val: number): string {
  const isUgx =
    /ugx|amount|balance|arrears|collected|expected|principal|returns|pay|cash|float|revenue|cost|fee|disbursed/i.test(
      key,
    );
  if (isUgx) {
    return `UGX ${Math.round(val).toLocaleString("en-US")}`;
  }
  return Math.round(val).toLocaleString("en-US");
}

/**
 * Formats a deterministic, grounded fast answer from a live tool payload so every
 * figure comes verbatim from `payload` and passes `checkAnswer`.
 */
export function formatFastAnswerFromToolPayload(
  template: FastAnswerTemplate,
  payload: Record<string, unknown>,
  todayKampala: string,
): string {
  const source =
    typeof payload.source === "string" && payload.source.trim()
      ? payload.source.trim()
      : template.rpc;
  const period = formatPeriodLabel(payload.period) ?? `as of ${todayKampala}`;

  const bullets: string[] = [];
  const dataObj =
    payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : payload;

  for (const [k, v] of Object.entries(dataObj)) {
    if (bullets.length >= 6) break;
    if (k === "rows" || k === "period" || k === "source" || k === "args") continue;
    if (typeof v === "number" && Number.isFinite(v)) {
      const label = k.replace(/_/g, " ");
      bullets.push(`- **${label}**: ${fmtUgxValue(k, v)}`);
    } else if (typeof v === "string" && v.trim() && v.length <= 80) {
      const label = k.replace(/_/g, " ");
      bullets.push(`- **${label}**: ${v.trim()}`);
    }
  }

  if (bullets.length === 0 && typeof payload.row_count === "number") {
    bullets.push(`- **row count**: ${payload.row_count.toLocaleString("en-US")}`);
  }

  if (Array.isArray(payload.rows) && payload.rows.length > 0) {
    const firstRow = payload.rows[0];
    if (firstRow && typeof firstRow === "object" && !Array.isArray(firstRow)) {
      const r = firstRow as Record<string, unknown>;
      if (typeof r.title === "string" && typeof r.summary === "string") {
        bullets.push(`- **${r.title}**: ${r.summary}`);
      }
    }
  }

  const body =
    bullets.length > 0
      ? `Here is the latest **${template.title}** summary:\n${bullets.join("\n")}`
      : `Checked **${template.title}** (${source}).`;

  return `${body}\n\nSource: ${source} · Period: ${period}`;
}
