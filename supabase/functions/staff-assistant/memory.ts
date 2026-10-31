import { formatPeriodLabel } from "./dates.ts";
import { validateZoeNoteText } from "./guards.ts";
import { canUseTool, findTool } from "./tools.ts";

export const PROMPT_ACTIVE_TURNS = 20;
export const PROMPT_ACTIVE_MESSAGES = PROMPT_ACTIVE_TURNS * 2; // 40 messages = 20 turns

export interface MemoryToolEntry {
  tool: string;
  rpc: string;
  source: string;
  period: string;
  args: Record<string, unknown>;
  key_figures: Record<string, number | string>;
  rows_preview: Array<Record<string, unknown>>;
  recorded_at: string;
}

export interface ConversationMemorySummary {
  entries: MemoryToolEntry[];
  updated_at?: string;
}

export interface ZoeChartPayload {
  type: "bar" | "line";
  title: string;
  summary: string;
  xKey: string;
  yKey: string;
  isUgx: boolean;
  data: Array<{ label: string; value: number; formatted?: string }>;
}

const MAX_MEMORY_ENTRIES = 10;
const MAX_KEY_FIGURES = 20;
const MAX_PREVIEW_ROWS = 8;

export function parseConversationMemory(raw: unknown): ConversationMemorySummary {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { entries: [] };
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.entries)) {
    return { entries: [] };
  }
  const entries: MemoryToolEntry[] = [];
  for (const item of obj.entries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.tool !== "string" || typeof rec.source !== "string") continue;
    entries.push({
      tool: rec.tool,
      rpc: typeof rec.rpc === "string" ? rec.rpc : rec.tool,
      source: rec.source,
      period: typeof rec.period === "string" ? rec.period : "",
      args:
        rec.args && typeof rec.args === "object" && !Array.isArray(rec.args)
          ? (rec.args as Record<string, unknown>)
          : {},
      key_figures:
        rec.key_figures && typeof rec.key_figures === "object" && !Array.isArray(rec.key_figures)
          ? (rec.key_figures as Record<string, number | string>)
          : {},
      rows_preview: Array.isArray(rec.rows_preview)
        ? (rec.rows_preview.filter(
            (r) => r && typeof r === "object" && !Array.isArray(r),
          ) as Array<Record<string, unknown>>)
        : [],
      recorded_at: typeof rec.recorded_at === "string" ? rec.recorded_at : "",
    });
  }
  return {
    entries: entries.slice(-MAX_MEMORY_ENTRIES),
    updated_at: typeof obj.updated_at === "string" ? obj.updated_at : undefined,
  };
}

function collectKeyFigures(
  obj: unknown,
  prefix = "",
  out: Record<string, number | string> = {},
): Record<string, number | string> {
  if (Object.keys(out).length >= MAX_KEY_FIGURES) return out;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  const rec = obj as Record<string, unknown>;

  for (const [key, val] of Object.entries(rec)) {
    if (Object.keys(out).length >= MAX_KEY_FIGURES) break;
    if (key === "rows" || key === "period" || key === "source" || key === "args") continue;
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (typeof val === "number" && Number.isFinite(val)) {
      out[pathKey] = val;
    } else if (typeof val === "string" && val.length <= 40 && /\d/.test(val)) {
      out[pathKey] = val;
    } else if (val && typeof val === "object" && !Array.isArray(val) && !prefix) {
      collectKeyFigures(val, key, out);
    }
  }
  return out;
}

export function buildMemoryEntryFromToolResult(args: {
  tool: string;
  rpc: string;
  toolArgs: Record<string, unknown>;
  payload: Record<string, unknown>;
  todayKampala: string;
}): MemoryToolEntry {
  const source =
    typeof args.payload.source === "string" && args.payload.source.trim()
      ? args.payload.source.trim()
      : args.rpc;
  const period =
    formatPeriodLabel(args.payload.period) ?? `as of ${args.todayKampala}`;

  const keyFigures = collectKeyFigures(args.payload);
  if (typeof args.payload.row_count === "number") {
    keyFigures.row_count = args.payload.row_count;
  }

  const rawRows = Array.isArray(args.payload.rows)
    ? args.payload.rows
    : Array.isArray(args.payload.by_stage)
    ? args.payload.by_stage
    : Array.isArray(args.payload.buckets)
    ? args.payload.buckets
    : [];

  const rowsPreview: Array<Record<string, unknown>> = [];
  for (const r of rawRows.slice(0, MAX_PREVIEW_ROWS)) {
    if (r && typeof r === "object" && !Array.isArray(r)) {
      rowsPreview.push(r as Record<string, unknown>);
    }
  }

  return {
    tool: args.tool,
    rpc: args.rpc,
    source,
    period,
    args: args.toolArgs,
    key_figures: keyFigures,
    rows_preview: rowsPreview,
    recorded_at: new Date().toISOString(),
  };
}

export function appendMemoryEntries(
  existing: ConversationMemorySummary,
  newEntries: readonly MemoryToolEntry[],
): ConversationMemorySummary {
  if (newEntries.length === 0) return existing;
  const combined = [...existing.entries, ...newEntries].slice(-MAX_MEMORY_ENTRIES);
  return {
    entries: combined,
    updated_at: new Date().toISOString(),
  };
}

export function formatConversationMemoryForPrompt(
  memory: ConversationMemorySummary,
): string {
  if (!memory.entries || memory.entries.length === 0) return "";
  const lines = memory.entries.map((entry, idx) => {
    const figs = Object.entries(entry.key_figures)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    const previewCount = entry.rows_preview.length;
    const previewStr =
      previewCount > 0 ? ` | preview_rows=${JSON.stringify(entry.rows_preview.slice(0, 4))}` : "";
    return `${idx + 1}. tool=${entry.tool} | source=${entry.source} | period=${entry.period} | args=${JSON.stringify(entry.args)} | figures: ${figs || "none"}${previewStr}`;
  });
  return [
    "EARLIER CONVERSATION TOOL MEMORY (verified server-side figures from earlier turns in this conversation; you may reference these or pass their numbers into `compute` for follow-ups like 'and last week?', 'only Kampala', or 'what is the difference?'):",
    "<UNTRUSTED_TOOL_DATA tool=\"conversation_memory\">",
    ...lines,
    "</UNTRUSTED_TOOL_DATA>",
  ].join("\n");
}

function fmtUgxShort(val: number): string {
  return `UGX ${Math.round(val).toLocaleString("en-US")}`;
}

/**
 * Extracts a compact bar or line chart with a one-line written summary when the
 * tool result is a time series or a ranking/stage breakdown.
 */
export function extractChartFromReportPayload(
  payload: Record<string, unknown> | null,
): ZoeChartPayload | null {
  if (!payload) return null;

  const candidateArrays: Array<{ rows: unknown[]; hint: "bar" | "line" }> = [];
  if (Array.isArray(payload.by_stage) && payload.by_stage.length >= 2) {
    candidateArrays.push({ rows: payload.by_stage, hint: "bar" });
  }
  if (Array.isArray(payload.buckets) && payload.buckets.length >= 2) {
    candidateArrays.push({ rows: payload.buckets, hint: "bar" });
  }
  if (Array.isArray(payload.daily_series) && payload.daily_series.length >= 2) {
    candidateArrays.push({ rows: payload.daily_series, hint: "line" });
  }
  if (Array.isArray(payload.rows) && payload.rows.length >= 2) {
    candidateArrays.push({ rows: payload.rows, hint: "bar" });
  }

  for (const cand of candidateArrays) {
    const sample = cand.rows[0];
    if (!sample || typeof sample !== "object" || Array.isArray(sample)) continue;
    const keys = Object.keys(sample as Record<string, unknown>);

    const labelKey =
      keys.find((k) =>
        /^(?:date|day|week|month|period|stage|bucket|label|department|region|district|agent_name|main_agent_name|caller_name|staff_name|tenant_name|landlord_name|supporter_name|category)$/i.test(
          k,
        ),
      ) ?? keys.find((k) => typeof (sample as Record<string, unknown>)[k] === "string");

    const valueKey =
      keys.find((k) =>
        /^(?:total_ugx|amount_ugx|collected_ugx|arrears_ugx|principal_ugx|returns_ugx|value|request_count|total_calls|houses_listed|sub_agent_count|hours_on_current_desk|count|score)$/i.test(
          k,
        ),
      ) ??
      keys.find(
        (k) =>
          k !== "rank" &&
          typeof (sample as Record<string, unknown>)[k] === "number" &&
          Number.isFinite((sample as Record<string, unknown>)[k] as number),
      );

    if (!labelKey || !valueKey) continue;

    const isTimeSeries = /^(?:date|day|week|month|period)$/i.test(labelKey) || cand.hint === "line";
    const isUgx = /ugx|amount|collected|arrears|principal|returns|pay|balance|cost/i.test(valueKey);

    const points: Array<{ label: string; value: number; formatted?: string }> = [];
    for (const rawRow of cand.rows.slice(0, 10)) {
      if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) continue;
      const r = rawRow as Record<string, unknown>;
      const rawLabel = r[labelKey];
      const rawVal = r[valueKey];
      const numVal = typeof rawVal === "number" ? rawVal : Number(rawVal);
      if (typeof rawLabel !== "string" || !rawLabel.trim() || !Number.isFinite(numVal)) continue;
      points.push({
        label: rawLabel.trim().slice(0, 36),
        value: Math.round(numVal * 100) / 100,
        formatted: isUgx ? fmtUgxShort(numVal) : Math.round(numVal).toLocaleString("en-US"),
      });
    }

    if (points.length < 2) continue;

    const topPoint = [...points].sort((a, b) => b.value - a.value)[0];
    const total = points.reduce((acc, p) => acc + p.value, 0);
    const fmtTop = isUgx ? fmtUgxShort(topPoint.value) : topPoint.value.toLocaleString("en-US");
    const fmtTotal = isUgx ? fmtUgxShort(total) : Math.round(total).toLocaleString("en-US");

    const sourceTitle =
      typeof payload.source === "string"
        ? payload.source.split("(")[0].trim()
        : "Report Breakdown";

    const summary = isTimeSeries
      ? `Peak ${labelKey.replace(/_/g, " ")} is ${topPoint.label} at ${fmtTop} (total ${fmtTotal} across ${points.length} periods).`
      : `Highest is ${topPoint.label} at ${fmtTop} out of ${fmtTotal} across the top ${points.length} items.`;

    return {
      type: isTimeSeries ? "line" : "bar",
      title: sourceTitle,
      summary,
      xKey: labelKey,
      yKey: valueKey,
      isUgx,
      data: points,
    };
  }

  return null;
}

/**
 * Human-readable live status lines streamed to the browser while Zoe runs tools.
 */
export function statusLineForTool(toolName: string): string {
  const map: Record<string, string> = {
    compute: "Comparing figures with safe calculator...",
    get_staff_manual_help: "Checking Welile staff manual...",
    get_my_profile: "Loading your My Space profile...",
    get_my_payslips: "Looking up your payslips...",
    get_my_tasks: "Checking your assigned tasks...",
    get_my_tickets: "Looking up your HR tickets...",
    get_my_requisitions: "Checking your staff requisitions...",
    get_my_advances: "Looking up your salary advances...",
    get_my_pending_concerns: "Checking your pending Calling Center concerns...",
    get_my_canteen: "Checking the canteen menu and orders...",
    get_my_wallet: "Loading your personal wallet balance...",
    get_my_calls: "Looking up your own call logs...",
    get_tops_first_seven_summary: "Looking up First 7 Days collections...",
    get_tops_arrears_ageing: "Looking up arrears ageing buckets...",
    get_tops_landlord_not_paid: "Checking uncovered Rent Plans...",
    get_tops_tenant_classification: "Loading tenant classification summary...",
    get_tops_smartphone_usage: "Checking smartphone collection usage...",
    get_tops_weekly_performance: "Looking up weekly collection performance...",
    get_tops_no_payment_report: "Checking Rent Plans with no recent payment...",
    get_tops_rent_request_lifetime: "Checking Rent Plan pipeline turnaround...",
    get_tops_rent_requests_by_stage: "Looking up Rent Plan requests by stage...",
    get_tops_time_on_desk: "Checking Rent Plan time on desk...",
    get_tops_find_tenant: "Searching tenant registry and payment scores...",
    get_tops_awareness_calls: "Looking up Rent Plan awareness calls...",
    get_lops_home_range: "Loading Landlord Ops summary...",
    get_lops_paid_lists: "Looking up paid landlords list...",
    get_lops_principal_comparison: "Comparing float allocations vs principal collected...",
    get_lops_calling_summary: "Looking up Landlord Calling Center summary...",
    get_lops_calling_coverage: "Checking Landlord Calling Center coverage...",
    get_lops_verification_queue: "Checking Landlord Ops verification queue...",
    get_aops_network_overview: "Loading Agent Ops network overview...",
    get_aops_metrics_totals: "Looking up Agent Ops listing totals...",
    get_aops_metrics_agents: "Looking up per-agent performance metrics...",
    get_aops_listing_quality_and_risk: "Checking agent listing quality and risk flags...",
    get_aops_silent_collectors: "Looking up silent collectors...",
    get_aops_subagent_teams: "Looking up main agent and sub-agent teams...",
    get_pops_pending_summary: "Checking pending Supporter portfolios...",
    get_pops_report_overview: "Looking up Supporter portfolio & Returns overview...",
    get_pops_search_supporters: "Searching Supporter directory...",
    get_pops_returns_due: "Looking up Supporter Returns due...",
    get_pops_topups_and_withdrawals_waiting: "Checking waiting top-ups and withdrawals...",
    get_pso_cohort_performance: "Looking up PSO cohort performance...",
    get_cfo_treasury_cash_position: "Looking up official Treasury cash position...",
    get_cfo_money_flow_summary: "Checking money received and paid out...",
    get_cfo_receivables_and_payables: "Looking up Receivables and Payables forecast...",
    get_cfo_seven_day_expenses: "Checking 7-day platform expenses...",
    get_cfo_budget_revised_position: "Looking up revised budget position...",
    get_fops_verification_and_requisitions: "Checking payout verifications and requisitions...",
    get_fops_disbursements: "Looking up Financial Ops disbursements...",
    get_fops_merchant_cashouts: "Looking up merchant cash-outs and withdrawals...",
    get_coo_overview: "Loading COO Command Center overview...",
    get_ceo_growth_and_approvals: "Loading CEO growth quality & approvals...",
    get_hr_calling_detailed_report: "Looking up detailed staff calling report...",
    get_hr_contracts_and_birthdays: "Checking HR contracts and birthdays...",
    get_hr_payroll_cost_by_department: "Looking up HR payroll cost by department...",
    get_insight_desk_wait_times: "Analyzing Rent Plan wait times by desk and week...",
    get_insight_collection_coverage_trends: "Comparing collection coverage trends and 4-week anomalies...",
    get_insight_calling_reach_and_themes: "Analyzing Calling Center reach rates and feedback themes...",
    get_insight_payout_delays: "Analyzing landlord payout delays and verification queues...",
    get_insight_zoe_feedback_themes: "Reviewing Zoe unanswered questions and feedback themes...",
    get_welile_glossary: "Checking Welile glossary & measurement rules...",
    search_knowledge_base: "Searching Welile Knowledge Base (Postgres full-text search)...",
    get_data_catalog: "Reading approved zoe_ro data catalog...",
    run_analyst_query: "Running read-only Analyst query on zoe_ro views...",
    draft_welile_idea: "Preparing Ideas for Welile draft card...",
    search_web: "Searching outside web sources...",
    read_web_page: "Reading public web page...",
  };
  return map[toolName] ?? "Looking up official Welile report...";
}


export interface FollowUpCandidate {
  text: string;
  requiredTool: string;
}

/**
 * Prompt 4 item (2): Next-question suggestions.
 * After a data answer, suggests up to 3 follow-ups grounded in what the answer actually
 * contained (for example "Break this down by agent", "Compare with last week", "Show only plans below target")
 * and verifies that every suggestion maps to an available tool (`canUseTool`) or the Analyst lane (`run_analyst_query`).
 * Never suggests something Zoe cannot do for the caller's role.
 */
export function buildFollowUpSuggestions(opts: {
  toolsCalled: readonly string[];
  callerRoles: readonly string[];
  reportPayload?: Record<string, unknown> | null;
  userMessage?: string;
}): string[] {
  const lastTool = opts.toolsCalled[opts.toolsCalled.length - 1] ?? "";
  const payload = opts.reportPayload ?? null;

  const isToolAvailable = (toolName: string): boolean => {
    const t = findTool(toolName);
    if (!t) return false;
    return canUseTool(t, opts.callerRoles);
  };

  const canRunAnalyst = isToolAvailable("run_analyst_query");

  // Inspect payload keys & sample rows to ground suggestions in what the answer actually contained
  const payloadKeys = new Set<string>();
  if (payload) {
    for (const k of Object.keys(payload)) payloadKeys.add(k.toLowerCase());
    if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
      for (const k of Object.keys(payload.data as Record<string, unknown>)) {
        payloadKeys.add(k.toLowerCase());
      }
    }
    const sampleRows = Array.isArray(payload.rows)
      ? payload.rows
      : Array.isArray(payload.by_stage)
      ? payload.by_stage
      : Array.isArray(payload.buckets)
      ? payload.buckets
      : [];
    if (sampleRows.length > 0 && sampleRows[0] && typeof sampleRows[0] === "object") {
      for (const k of Object.keys(sampleRows[0] as Record<string, unknown>)) {
        payloadKeys.add(k.toLowerCase());
      }
    }
  }

  const candidates: FollowUpCandidate[] = [];

  // Grounded dimensional follow-ups from payload columns/keys
  if (
    payloadKeys.has("agent_name") ||
    payloadKeys.has("qualifying_agents") ||
    payloadKeys.has("houses_listed") ||
    lastTool.startsWith("get_aops_")
  ) {
    candidates.push({
      text: "Break this down by agent",
      requiredTool: isToolAvailable("get_aops_metrics_agents")
        ? "get_aops_metrics_agents"
        : "run_analyst_query",
    });
  }

  if (
    payloadKeys.has("expected_ugx") ||
    payloadKeys.has("collected_ugx") ||
    payloadKeys.has("arrears_ugx") ||
    payloadKeys.has("paying_on_track") ||
    lastTool === "get_tops_first_seven_summary" ||
    lastTool === "get_tops_weekly_performance" ||
    lastTool === "get_tops_arrears_ageing"
  ) {
    candidates.push({
      text: "Show only Rent Plans below target or with no recent payment",
      requiredTool: isToolAvailable("get_tops_no_payment_report")
        ? "get_tops_no_payment_report"
        : "get_tops_arrears_ageing",
    });
  }

  if (
    payloadKeys.has("city") ||
    payloadKeys.has("district") ||
    payloadKeys.has("region") ||
    lastTool === "run_analyst_query" ||
    lastTool === "get_data_catalog"
  ) {
    candidates.push({
      text: "Group this by city or district in a table",
      requiredTool: "run_analyst_query",
    });
  }

  if (lastTool) {
    candidates.push({
      text: "Compare this vs last week",
      requiredTool: lastTool,
    });
  }

  if (lastTool === "run_analyst_query" || lastTool === "get_data_catalog") {
    candidates.push(
      { text: "Give me this breakdown in a table", requiredTool: "run_analyst_query" },
      {
        text: "Compare this with the official certified report",
        requiredTool: isToolAvailable("get_tops_weekly_performance")
          ? "get_tops_weekly_performance"
          : "run_analyst_query",
      },
    );
  } else if (lastTool.startsWith("get_insight_")) {
    candidates.push(
      { text: "Compare this week with the 4-week average", requiredTool: lastTool },
      { text: "Give me the full breakdown in a table", requiredTool: lastTool },
    );
  } else if (lastTool.startsWith("get_tops_")) {
    candidates.push(
      {
        text: "Show Rent Plan requests today and by stage",
        requiredTool: "get_tops_rent_requests_by_stage",
      },
      {
        text: "What is the time on desk for open Rent Plan requests?",
        requiredTool: "get_tops_time_on_desk",
      },
    );
  } else if (lastTool.startsWith("get_lops_")) {
    candidates.push(
      {
        text: "Show the Landlord Ops verification queue",
        requiredTool: "get_lops_verification_queue",
      },
      { text: "Show paid and repaying landlords", requiredTool: "get_lops_paid_lists" },
    );
  } else if (lastTool.startsWith("get_aops_")) {
    candidates.push(
      { text: "Which agents are silent collectors today?", requiredTool: "get_aops_silent_collectors" },
      { text: "Show sub-agent teams and risk summary", requiredTool: "get_aops_subagent_teams" },
    );
  } else if (lastTool.startsWith("get_pops_") || lastTool === "get_pso_cohort_performance") {
    candidates.push(
      { text: "How much in Supporter Returns is due this week?", requiredTool: "get_pops_returns_due" },
      {
        text: "Which top-ups and withdrawals are waiting?",
        requiredTool: "get_pops_topups_and_withdrawals_waiting",
      },
    );
  } else if (lastTool.startsWith("get_cfo_") || lastTool.startsWith("get_fops_")) {
    candidates.push(
      { text: "Show disbursements for the last 7 days", requiredTool: "get_fops_disbursements" },
      {
        text: "Show merchant cash-outs and withdrawals waiting",
        requiredTool: "get_fops_merchant_cashouts",
      },
    );
  } else if (lastTool.startsWith("get_hr_") || lastTool === "get_my_calls") {
    candidates.push(
      { text: "Show my own calls for this week", requiredTool: "get_my_calls" },
      { text: "Give me the full breakdown by caller", requiredTool: "get_hr_calling_detailed_report" },
    );
  }

  // Fallback My Space suggestions that every role can execute
  candidates.push(
    { text: "Show my pending tasks and tickets", requiredTool: "get_my_tasks" },
    { text: "Show my own calls for this week", requiredTool: "get_my_calls" },
    { text: "Search the Welile Knowledge Base for measurement rules", requiredTool: "search_knowledge_base" },
  );

  const verified: string[] = [];
  for (const cand of candidates) {
    if (verified.length >= 3) break;
    if (verified.includes(cand.text)) continue;
    if (
      isToolAvailable(cand.requiredTool) ||
      (cand.requiredTool === "run_analyst_query" && canRunAnalyst)
    ) {
      verified.push(cand.text);
    }
  }

  return verified.slice(0, 3);
}

/**
 * Prompt 4 item (5): Fixed list of 13 question topics for `staff_assistant_learning_log`.
 * Never stores a second copy of the staff member's question text.
 */
export const ZOE_FIXED_TOPICS = [
  "my_space",
  "tenant_ops",
  "landlord_ops",
  "calling_center",
  "agent_ops",
  "supporters_partner_ops",
  "finance_cfo",
  "coo_ceo_executive",
  "hr_people",
  "welile_glossary_process",
  "general_accounting_writing",
  "research_advice",
  "other",
] as const;

export type ZoeQuestionTopic = (typeof ZOE_FIXED_TOPICS)[number];

export function classifyQuestionTopic(opts: {
  userMessage: string;
  toolsCalled?: readonly string[];
  consultantMode?: boolean;
  researchMode?: boolean;
}): ZoeQuestionTopic {
  const tools = opts.toolsCalled ?? [];
  const primaryTool = tools[0] ?? "";
  const q = (opts.userMessage ?? "").toLowerCase();

  if (opts.researchMode || opts.consultantMode || tools.includes("search_web") || tools.includes("read_web_page")) {
    return "research_advice";
  }
  if (primaryTool.startsWith("get_cfo_") || primaryTool.startsWith("get_fops_")) {
    return "finance_cfo";
  }
  if (primaryTool === "get_coo_overview" || primaryTool === "get_ceo_growth_and_approvals") {
    return "coo_ceo_executive";
  }
  if (
    primaryTool === "get_hr_calling_detailed_report" ||
    primaryTool === "get_my_calls" ||
    primaryTool === "get_lops_calling_summary" ||
    primaryTool === "get_lops_calling_coverage" ||
    primaryTool === "get_tops_awareness_calls" ||
    primaryTool === "get_insight_calling_reach_and_themes"
  ) {
    return "calling_center";
  }
  if (primaryTool.startsWith("get_tops_")) return "tenant_ops";
  if (primaryTool.startsWith("get_lops_")) return "landlord_ops";
  if (primaryTool.startsWith("get_aops_")) return "agent_ops";
  if (primaryTool.startsWith("get_pops_") || primaryTool === "get_pso_cohort_performance") {
    return "supporters_partner_ops";
  }
  if (primaryTool.startsWith("get_hr_")) return "hr_people";
  if (primaryTool.startsWith("get_my_")) return "my_space";
  if (
    primaryTool === "get_welile_glossary" ||
    primaryTool === "search_knowledge_base" ||
    primaryTool === "get_staff_manual_help"
  ) {
    return "welile_glossary_process";
  }

  // Keyword fallback when no tool was called (e.g. general questions or unanswered)
  if (/\b(?:treasury|cash position|receivables|payables|cfo|disbursement|merchant cashout|budget)\b/.test(q)) {
    return "finance_cfo";
  }
  if (/\b(?:calling center|call report|jane|winnie|hanisha|awareness call|my calls)\b/.test(q)) {
    return "calling_center";
  }
  if (/\b(?:first 7 days|arrears|tenant ops|time on desk|no payment)\b/.test(q)) {
    return "tenant_ops";
  }
  if (/\b(?:landlord ops|landlord payout|unverified landlord)\b/.test(q)) {
    return "landlord_ops";
  }
  if (/\b(?:agent ops|silent collector|sub-?agent|house listing)\b/.test(q)) {
    return "agent_ops";
  }
  if (/\b(?:supporter|partner ops|returns due|promissory)\b/.test(q)) {
    return "supporters_partner_ops";
  }
  if (/\b(?:payslip|my tasks|my tickets|my requisition|canteen|my advance|my wallet|my space)\b/.test(q)) {
    return "my_space";
  }
  if (/\b(?:payroll|headcount|expiring contract|birthday|hr)\b/.test(q)) {
    return "hr_people";
  }
  if (/\b(?:glossary|where do i find|how does welile|expected vs collected|am_plan_clock)\b/.test(q)) {
    return "welile_glossary_process";
  }
  if (/\b(?:what should we do|way forward|advice|recommend|why did|review this plan)\b/.test(q)) {
    return "research_advice";
  }
  if (/\b(?:explain|accrual|working capital|balance sheet|depreciation|draft|write a|email|memo|like i'm five|calculate)\b/.test(q)) {
    return "general_accounting_writing";
  }
  return "other";
}

export function classifyFeedbackTheme(
  comment: string | undefined,
  reportKind?: "rating" | "problem_report",
): string {
  const c = (comment ?? "").toLowerCase();
  if (/slow|timeout|latency|wait/.test(c)) return "latency_or_timeout";
  if (/number|figure|wrong|mismatch|off|inaccurate/.test(c)) return "figure_mismatch";
  if (/missing|not found|cannot|can't/.test(c)) return "missing_coverage";
  if (reportKind === "problem_report") return "problem_report";
  return "general_thumbs_down";
}

/**
 * Prompt 4 item (1): Personalised starters helper.
 * Filters starter candidates so every starter maps to a tool the caller's role can run,
 * and caps the result at 3 starters. Never uses other people's text.
 */
export interface PersonalisedStarterItem {
  id: string;
  topic: ZoeQuestionTopic;
  label: string;
  prompt: string;
  tool: string;
  reason?: string;
}

export const FALLBACK_ROLE_STARTERS: readonly PersonalisedStarterItem[] = [
  {
    id: "starter-cfo-treasury",
    topic: "finance_cfo",
    label: "Treasury cash position (A1 + A5)",
    prompt: "What is our spendable Treasury Cash Position (Accounts A1 and A5) today?",
    tool: "get_cfo_treasury_cash_position",
    reason: "role_default",
  },
  {
    id: "starter-tops-first7",
    topic: "tenant_ops",
    label: "First 7 Days collection summary",
    prompt: "How are newly funded Rent Plans performing in the First 7 Days report today?",
    tool: "get_tops_first_seven_summary",
    reason: "role_default",
  },
  {
    id: "starter-lops-summary",
    topic: "landlord_ops",
    label: "Landlord Ops verifications & payouts",
    prompt: "How many landlords were verified and paid out in Landlord Ops over the last 7 days?",
    tool: "get_lops_home_range",
    reason: "role_default",
  },
  {
    id: "starter-aops-overview",
    topic: "agent_ops",
    label: "Agent Ops network & silent collectors",
    prompt: "Show the Agent Ops network overview and silent field collectors today.",
    tool: "get_aops_network_overview",
    reason: "role_default",
  },
  {
    id: "starter-pops-pending",
    topic: "supporters_partner_ops",
    label: "Pending Supporter portfolios",
    prompt: "How many pending Supporter portfolios are in the Partner Ops queue and what is their total UGX?",
    tool: "get_pops_pending_summary",
    reason: "role_default",
  },
  {
    id: "starter-calling-report",
    topic: "calling_center",
    label: "Weekly Calling Center report",
    prompt: "Show the weekly Calling Center report and reach rates for this week.",
    tool: "get_hr_calling_detailed_report",
    reason: "role_default",
  },
  {
    id: "starter-my-tasks",
    topic: "my_space",
    label: "My pending tasks & requisitions",
    prompt: "Show my pending tasks in My Work and the status of my staff requisitions.",
    tool: "get_my_tasks",
    reason: "role_default",
  },
  {
    id: "starter-my-calls",
    topic: "calling_center",
    label: "My calls this week",
    prompt: "How many calls have I logged this week in my personal calling report?",
    tool: "get_my_calls",
    reason: "role_default",
  },
  {
    id: "starter-kb-gotchas",
    topic: "welile_glossary_process",
    label: "Welile measurement rules & glossary",
    prompt: "Explain the difference between Expected vs Collected rent and when the Rent Plan repayment clock starts.",
    tool: "search_knowledge_base",
    reason: "role_default",
  },
];

export function selectRoleVerifiedStarters(
  callerRoles: readonly string[],
  rpcStarters?: ReadonlyArray<Record<string, unknown>>,
): PersonalisedStarterItem[] {
  const out: PersonalisedStarterItem[] = [];
  const isAllowed = (toolName: string): boolean => {
    const t = findTool(toolName);
    return t ? canUseTool(t, callerRoles) : false;
  };

  if (Array.isArray(rpcStarters)) {
    for (const raw of rpcStarters) {
      if (out.length >= 3) break;
      const id = typeof raw.id === "string" ? raw.id : "";
      const label = typeof raw.label === "string" ? raw.label : "";
      const prompt = typeof raw.prompt === "string" ? raw.prompt : "";
      const tool = typeof raw.tool === "string" ? raw.tool : "";
      const topic = (typeof raw.topic === "string" ? raw.topic : "other") as ZoeQuestionTopic;
      if (!id || !label || !prompt || !tool) continue;
      if (!isAllowed(tool)) continue;
      out.push({
        id,
        topic,
        label,
        prompt,
        tool,
        reason: typeof raw.reason === "string" ? raw.reason : "own_30d_topic_history",
      });
    }
  }

  for (const fallback of FALLBACK_ROLE_STARTERS) {
    if (out.length >= 3) break;
    if (out.some((x) => x.id === fallback.id || x.prompt === fallback.prompt)) continue;
    if (!isAllowed(fallback.tool)) continue;
    out.push(fallback);
  }

  return out.slice(0, 3);
}

/**
 * Prompt 4 item (3): Memory that learns.
 * When Zoe notices a repeated preference across the user's messages (for example
 * "in millions", "Kampala Central", "short answers"), she offers once:
 *   "Remember this?" with Save and No thanks.
 * Nothing is saved without a tap. Blocks figures, phone numbers, emails, IDs,
 * and details about other people via `validateZoeNoteText`.
 */
export interface ZoeMemorySuggestion {
  key: string;
  note_text: string;
  prompt: string;
}

const LEARNABLE_PREFERENCE_PATTERNS: ReadonlyArray<{
  key: string;
  regex: RegExp;
  noteText: string;
}> = [
  {
    key: "pref_in_millions",
    regex: /\bin\s+millions\b/i,
    noteText: "Format large amounts in millions",
  },
  {
    key: "pref_kampala_central",
    regex: /\bkampala\s+central\b/i,
    noteText: "Focus on Kampala Central when relevant",
  },
  {
    key: "pref_wakiso",
    regex: /\bwakiso\b/i,
    noteText: "Focus on Wakiso district when relevant",
  },
  {
    key: "pref_mukono",
    regex: /\bmukono\b/i,
    noteText: "Focus on Mukono district when relevant",
  },
  {
    key: "pref_short_answers",
    regex: /\b(?:short\s+answers?|keep\s+it\s+short|be\s+brief|concise\s+answers?)\b/i,
    noteText: "Keep answers short and concise",
  },
  {
    key: "pref_bullet_points",
    regex: /\b(?:in\s+bullet\s+points?|use\s+bullets|bulleted\s+list)\b/i,
    noteText: "Use concise bullet points",
  },
  {
    key: "pref_table_format",
    regex: /\b(?:in\s+a\s+table|table\s+format|as\s+a\s+table)\b/i,
    noteText: "Present breakdowns in a Markdown table",
  },
];

export function detectRepeatedUserPreference(opts: {
  currentMessage: string;
  recentUserMessages: readonly string[];
  existingNotes: ReadonlyArray<{ note_text: string }>;
  dismissedPromptKeys?: readonly string[];
  memoryEnabled?: boolean;
  temporaryChat?: boolean;
}): ZoeMemorySuggestion | null {
  if (opts.memoryEnabled === false || opts.temporaryChat === true) {
    return null;
  }

  const current = (opts.currentMessage ?? "").trim();
  if (!current) return null;

  const existingLower = new Set(
    opts.existingNotes.map((n) => (n.note_text ?? "").trim().toLowerCase()),
  );
  const dismissed = new Set(
    (opts.dismissedPromptKeys ?? []).map((k) => k.trim().toLowerCase()),
  );

  const explicitAlways = /\b(?:always|every\s+time|from\s+now\s+on|by\s+default)\b/i.test(current);

  for (const pat of LEARNABLE_PREFERENCE_PATTERNS) {
    if (!pat.regex.test(current)) continue;
    if (dismissed.has(pat.key.toLowerCase())) continue;
    if (existingLower.has(pat.noteText.toLowerCase())) continue;

    // Count occurrences across recent user messages + current message
    const priorMatches = opts.recentUserMessages.filter((m) => pat.regex.test(m)).length;
    if (priorMatches >= 1 || explicitAlways) {
      const validation = validateZoeNoteText(pat.noteText);
      if (validation.ok) {
        return {
          key: pat.key,
          note_text: validation.cleaned,
          prompt: "Remember this?",
        };
      }
    }
  }

  return null;
}

export const MAX_ZOE_NOTES_PER_USER = 20;

export interface ZoeNoteRecord {
  id: string;
  note_text: string;
  created_at: string;
}

/**
 * Formats the signed-in staff member's personal Zoe notes (up to 20 short preferences)
 * for injection into the dynamic section of the system prompt.
 * Enforces Deliverable (6): re-validates every note with `validateZoeNoteText` so
 * business figures, UGX amounts, or PII can never enter prompt notes.
 */
export function formatZoeNotesForPrompt(
  notes: ReadonlyArray<{ id?: string; note_text: string }>,
): string {
  const valid: string[] = [];
  for (const n of notes) {
    if (valid.length >= MAX_ZOE_NOTES_PER_USER) break;
    const raw = (n.note_text ?? "").trim();
    const check = validateZoeNoteText(raw);
    if (check.ok) {
      valid.push(check.cleaned);
    }
  }

  if (valid.length === 0) return "";

  const lines = [
    "ZOE NOTES (APPROVED USER PREFERENCES FOR THIS STAFF MEMBER — APPLY TO STYLE/FORMAT ONLY, NEVER AS BUSINESS FIGURES):",
  ];
  for (let i = 0; i < valid.length; i++) {
    lines.push(`- ${valid[i]}`);
  }
  return lines.join("\n");
}

function stripBusinessFiguresFromSummaryLine(text: string): string {
  return text
    .replace(/\b(?:UGX|USh|shillings?)\s*[\d,]+(?:\.\d+)?(?:\s*[kmbKMB])?/gi, "[amount]")
    .replace(/\b\d{1,3}(?:,\d{3})+\b/g, "[number]")
    .replace(/\b\d+(?:\.\d+)?\s*[kmbKMB]\b/g, "[number]")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Condenses earlier conversation turns (older than the last 20 turns) into a compact
 * rolling summary when a conversation grows beyond the 20-turn (40-message) verbatim
 * window, preserving topics and questions asked across the conversation without
 * storing business figures.
 */
export function buildRollingConversationSummary(
  olderTurnsOrExisting:
    | ReadonlyArray<{ role: string; content: string | null }>
    | string
    | null
    | undefined,
  existingSummaryOrTurns:
    | string
    | ReadonlyArray<{ role: string; content: string | null }> = "",
): string {
  const olderTurns: ReadonlyArray<{ role: string; content: string | null }> = Array.isArray(
    olderTurnsOrExisting,
  )
    ? olderTurnsOrExisting
    : Array.isArray(existingSummaryOrTurns)
    ? existingSummaryOrTurns
    : [];
  const existingSummary =
    typeof olderTurnsOrExisting === "string"
      ? olderTurnsOrExisting
      : typeof existingSummaryOrTurns === "string"
      ? existingSummaryOrTurns
      : "";

  const userTopics: string[] = [];
  for (const turn of olderTurns) {
    if (turn.role !== "user" || !turn.content) continue;
    const oneLine = stripBusinessFiguresFromSummaryLine(turn.content).slice(0, 140);
    if (oneLine && !userTopics.includes(oneLine)) {
      userTopics.push(oneLine);
    }
  }

  const prev = stripBusinessFiguresFromSummaryLine(existingSummary);
  if (userTopics.length === 0) return prev;

  const bulletList = userTopics.slice(-12).map((q) => `• Earlier question: "${q}"`).join("\n");
  const combined = prev ? `${prev}\n${bulletList}` : bulletList;
  return combined.slice(-1600);
}

/**
 * Deliverable (6): Keeps the last 20 turns (40 messages) verbatim for the prompt
 * and summarizes any older turns beyond the 20-turn window.
 */
export function splitTurnsForPromptMemory<T extends { role: string; content: string | null }>(
  history: readonly T[],
  existingRollingSummary = "",
  maxActiveTurns: number = PROMPT_ACTIVE_TURNS,
): {
  activeTurnWindow: T[];
  olderTurnWindow: T[];
  rollingSummaryText: string;
  rollingSummaryPromptBlock: string;
} {
  const maxMessages = Math.max(2, maxActiveTurns * 2);
  const activeTurnWindow = history.slice(-maxMessages);
  const olderTurnWindow = history.length > maxMessages ? history.slice(0, -maxMessages) : [];
  const rollingSummaryText = buildRollingConversationSummary(
    olderTurnWindow,
    existingRollingSummary,
  );
  const rollingSummaryPromptBlock = rollingSummaryText
    ? `EARLIER CONVERSATION ROLLING SUMMARY (turns older than the last ${maxActiveTurns} turns — topics only, no business figures):\n${rollingSummaryText}`
    : "";

  return {
    activeTurnWindow,
    olderTurnWindow,
    rollingSummaryText,
    rollingSummaryPromptBlock,
  };
}

/**
 * Formats a grounded partial answer when the multi-step loop reaches its round,
 * tool-call, or per-question cost ceiling after gathering one or more tool results.
 * Every number in the returned string comes strictly from `entries[i].key_figures`
 * so `checkAnswer` passes deterministically.
 */
export function synthesizePartialStepLimitReply(
  entries: ReadonlyArray<MemoryToolEntry>,
  prefix = "I reached my limit, here is what I have so far:",
): string {
  if (entries.length === 0) {
    return `${prefix} I was not able to complete all report lookups within the step limit. Please try narrowing the question to a single period or department report.`;
  }

  const lines: string[] = [prefix];
  for (const entry of entries) {
    const kvPairs = Object.entries(entry.key_figures)
      .slice(0, 6)
      .map(([k, v]) => {
        const label = k.replace(/_/g, " ");
        if (typeof v === "number" && Number.isFinite(v)) {
          const formatted = /ugx|amount|arrears|collected|expected|balance|revenue|fee|commission|payout|principal/i.test(k)
            ? fmtUgxShort(v)
            : v.toLocaleString("en-US");
          return `${label}: ${formatted}`;
        }
        return `${label}: ${v}`;
      })
      .join(", ");
    if (kvPairs) {
      lines.push(`- ${entry.tool} (${entry.source}, ${entry.period}): ${kvPairs}`);
    } else {
      lines.push(`- ${entry.tool} (${entry.source}, ${entry.period})`);
    }
  }

  const last = entries[entries.length - 1];
  lines.push("");
  lines.push(`Source: ${last.source} · Period: ${last.period}`);
  return lines.join("\n");
}

