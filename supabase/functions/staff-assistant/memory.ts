import { formatPeriodLabel } from "./dates.ts";

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
    draft_welile_idea: "Preparing Ideas for Welile draft card...",
  };
  return map[toolName] ?? "Looking up official Welile report...";
}


/**
 * Generates 2 or 3 contextual follow-up question suggestions under each answer.
 */
export function buildFollowUpSuggestions(opts: {
  toolsCalled: readonly string[];
  callerRoles: readonly string[];
}): string[] {
  const lastTool = opts.toolsCalled[opts.toolsCalled.length - 1] ?? "";

  if (lastTool.startsWith("get_insight_")) {
    return [
      "Save this suggestion to Ideas for Welile",
      "Give me the full breakdown in a table",
      "Compare this week with the 4-week average",
    ];
  }

  if (lastTool.startsWith("get_tops_")) {
    return [
      "And last week? What is the difference?",
      "Show Rent Plan requests today and by stage",
      "What is the time on desk for open Rent Plan requests?",
    ];
  }
  if (lastTool.startsWith("get_lops_")) {
    return [
      "Show the Landlord Ops verification queue",
      "Compare this week with last week",
      "Show paid and repaying landlords",
    ];
  }
  if (lastTool.startsWith("get_aops_")) {
    return [
      "Show sub-agent teams and risk summary",
      "Which agents are silent collectors today?",
      "Compare this period with last month",
    ];
  }
  if (lastTool.startsWith("get_pops_") || lastTool === "get_pso_cohort_performance") {
    return [
      "How much in Supporter Returns is due this week?",
      "Which top-ups and withdrawals are waiting?",
      "Give me the full breakdown in a table",
    ];
  }
  if (lastTool.startsWith("get_cfo_") || lastTool.startsWith("get_fops_")) {
    return [
      "Show disbursements for the last 7 days",
      "Show merchant cash-outs and withdrawals waiting",
      "Compare with the previous period",
    ];
  }
  if (lastTool.startsWith("get_hr_") || lastTool === "get_my_calls") {
    return [
      "Show my own calls for this week",
      "Compare calling totals with last week",
      "Give me the full breakdown by caller",
    ];
  }

  return [
    "Show my pending tasks and tickets",
    "Show my own calls for this week",
    "What can you do for my role?",
  ];
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
 */
export function formatZoeNotesForPrompt(
  notes: ReadonlyArray<{ id?: string; note_text: string }>,
): string {
  const valid = notes
    .map((n) => (n.note_text ?? "").trim())
    .filter((t) => t.length >= 2 && t.length <= 240)
    .slice(0, MAX_ZOE_NOTES_PER_USER);

  if (valid.length === 0) return "";

  const lines = [
    "ZOE NOTES (USER PREFERENCES FOR THIS STAFF MEMBER — APPLY TO STYLE/FORMAT ONLY, NEVER AS DATA FIGURES):",
  ];
  for (let i = 0; i < valid.length; i++) {
    lines.push(`- ${valid[i]}`);
  }
  return lines.join("\n");
}

/**
 * Condenses earlier conversation turns into a compact rolling summary when a
 * conversation grows beyond the verbatim turn window, preserving topics and
 * questions asked across the whole conversation.
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
    const oneLine = turn.content.replace(/\s+/g, " ").trim().slice(0, 140);
    if (oneLine && !userTopics.includes(oneLine)) {
      userTopics.push(oneLine);
    }
  }

  const prev = existingSummary.trim();
  if (userTopics.length === 0) return prev;

  const bulletList = userTopics.slice(-12).map((q) => `• Earlier question: "${q}"`).join("\n");
  const combined = prev ? `${prev}\n${bulletList}` : bulletList;
  return combined.slice(-1600);
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

