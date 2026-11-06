import { formatPeriodLabel, kampalaToday } from "./dates.ts";
import { sanitizeWelileTermsServer } from "./emailDraft.ts";
import { canUseTool, findTool, StaffTool } from "./tools.ts";

export const MAX_MORNING_BRIEF_ITEMS = 3;

export interface MorningBriefSection {
  id: string;
  title: string;
  tool: string;
  rpc: string;
  source: string;
  period: string;
  row_count: number;
  summary: string;
  screen_path?: string;
  current_value?: number;
  four_week_avg?: number;
  pct_change?: number;
  direction?: "up" | "down" | "flat";
}

export interface MorningBriefPayload {
  enabled: boolean;
  should_display: boolean;
  dismissed_today: boolean;
  kampala_date: string;
  scheduled_time_kampala: string;
  is_after_0730_kampala: boolean;
  sections: MorningBriefSection[];
  active_reminders_count: number;
  active_schedules_count: number;
  in_app_only?: boolean;
  outbound_email_enabled?: false;
  outbound_sms_enabled?: false;
}

const TOOL_SCREEN_PATH_MAP: Record<string, string> = {
  get_my_tasks: "/me/work",
  get_my_pending_concerns: "/me/reports",
  get_my_requisitions: "/me/requisitions",
  get_my_tickets: "/me/work",
  get_my_canteen: "/me",
  get_tops_first_seven_summary: "/tenant-ops",
  get_tops_weekly_performance: "/tenant-ops",
  get_lops_home_range: "/landlord-ops",
  get_lops_calling_summary: "/landlord-ops/calling",
  get_aops_metrics_totals: "/executive-hub?tab=agent-ops",
  get_aops_network_overview: "/executive-hub?tab=agent-ops",
  get_pops_pending_summary: "/partner-ops",
  get_pso_cohort_performance: "/partner-ops",
  get_cfo_treasury_cash_position: "/cfo/dashboard",
  get_fops_verification_and_requisitions: "/financial-ops",
  get_coo_overview: "/coo/dashboard",
  get_ceo_growth_and_approvals: "/ceo/dashboard",
  get_hr_contracts_and_birthdays: "/hr/dashboard",
};

export function screenPathForBriefTool(toolName: string): string {
  return TOOL_SCREEN_PATH_MAP[toolName] ?? "/me";
}

/**
 * Checks whether the current time in Africa/Kampala (UTC+3) is at or after 07:30.
 */
export function isPastKampalaBriefTime(
  briefTime = "07:30",
  nowMs: number = Date.now(),
): boolean {
  const kampalaMs = nowMs + 3 * 60 * 60 * 1000;
  const d = new Date(kampalaMs);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const currentHm = `${hh}:${mm}`;
  return currentHm >= briefTime;
}

function formatUgx(val: unknown): string | null {
  if (typeof val === "number" && Number.isFinite(val)) {
    return `UGX ${Math.round(val).toLocaleString("en-US")}`;
  }
  return null;
}

function summarizeToolPayload(
  toolName: string,
  payload: Record<string, unknown>,
): { rowCount: number; summary: string } {
  const rowCount =
    typeof payload.row_count === "number" && Number.isFinite(payload.row_count)
      ? payload.row_count
      : Array.isArray(payload.rows)
      ? payload.rows.length
      : Array.isArray(payload.tasks)
      ? payload.tasks.length
      : Array.isArray(payload.concerns)
      ? payload.concerns.length
      : Array.isArray(payload.requisitions)
      ? payload.requisitions.length
      : Array.isArray(payload.tickets)
      ? payload.tickets.length
      : 0;

  const dataObj =
    payload.data &&
    typeof payload.data === "object" &&
    !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : {};

  if (toolName === "get_my_tasks") {
    const pendingTasks =
      typeof dataObj.pending_tasks_count === "number"
        ? dataObj.pending_tasks_count
        : rowCount;
    const overdueCount =
      typeof payload.overdue_count === "number"
        ? payload.overdue_count
        : typeof dataObj.overdue_count === "number"
        ? dataObj.overdue_count
        : 0;
    return {
      rowCount,
      summary: sanitizeWelileTermsServer(
        `${pendingTasks} pending task(s) in My Work (${overdueCount} overdue).`,
      ),
    };
  }

  if (toolName === "get_my_pending_concerns") {
    return {
      rowCount,
      summary: sanitizeWelileTermsServer(
        `${rowCount} pending Calling Center concern(s) awaiting your review.`,
      ),
    };
  }

  if (toolName === "get_my_requisitions") {
    return {
      rowCount,
      summary: sanitizeWelileTermsServer(
        `${rowCount} staff requisition(s) tracked in My Space.`,
      ),
    };
  }

  if (toolName === "get_my_tickets") {
    const openCount =
      typeof payload.open_count === "number"
        ? payload.open_count
        : typeof dataObj.open_count === "number"
        ? dataObj.open_count
        : rowCount;
    return {
      rowCount,
      summary: sanitizeWelileTermsServer(
        `${openCount} open HR ticket(s) out of ${rowCount} total.`,
      ),
    };
  }

  if (toolName === "get_my_canteen") {
    return {
      rowCount,
      summary: sanitizeWelileTermsServer(
        `Today's canteen menu and ${rowCount} recent food order(s).`,
      ),
    };
  }

  if (toolName === "get_tops_first_seven_summary") {
    const funded =
      typeof dataObj.funded_plans === "number" ? dataObj.funded_plans : rowCount;
    const onTrack =
      typeof dataObj.paying_on_track === "number" ? dataObj.paying_on_track : 0;
    return {
      rowCount,
      summary: sanitizeWelileTermsServer(
        `First 7 Days onboarding: ${funded} funded Rent Plan(s), ${onTrack} paying on track.`,
      ),
    };
  }

  if (toolName === "get_tops_weekly_performance") {
    const collected =
      formatUgx(dataObj.weekly_collected_ugx) ??
      formatUgx(dataObj.collected_ugx) ??
      `${rowCount} record(s)`;
    return {
      rowCount,
      summary: sanitizeWelileTermsServer(
        `Tenant Ops weekly collections snapshot: ${collected}.`,
      ),
    };
  }

  if (toolName === "get_lops_home_range") {
    const verified =
      typeof dataObj.landlords_verified === "number"
        ? dataObj.landlords_verified
        : rowCount;
    const payouts =
      typeof dataObj.payouts_completed === "number"
        ? dataObj.payouts_completed
        : 0;
    return {
      rowCount,
      summary: sanitizeWelileTermsServer(
        `Landlord Ops pipeline: ${verified} landlord(s) verified, ${payouts} payout(s) completed.`,
      ),
    };
  }

  if (toolName === "get_lops_calling_summary") {
    const calls =
      typeof dataObj.total_calls === "number" ? dataObj.total_calls : rowCount;
    return {
      rowCount,
      summary: sanitizeWelileTermsServer(
        `Landlord Calling Center summary: ${calls} call(s) logged this week.`,
      ),
    };
  }

  if (toolName === "get_aops_metrics_totals" || toolName === "get_aops_network_overview") {
    const houses =
      typeof dataObj.houses_listed === "number"
        ? `${dataObj.houses_listed} house(s) listed`
        : typeof dataObj.qualifying_agents === "number"
        ? `${dataObj.qualifying_agents} qualifying agent(s)`
        : `${rowCount} record(s)`;
    return {
      rowCount,
      summary: sanitizeWelileTermsServer(`Agent Ops snapshot: ${houses}.`),
    };
  }

  if (toolName === "get_pops_pending_summary" || toolName === "get_pso_cohort_performance") {
    const pendingCount =
      typeof dataObj.pending_count === "number"
        ? `${dataObj.pending_count} pending Supporter portfolio(s)`
        : typeof dataObj.funded_notes_count === "number"
        ? `${dataObj.funded_notes_count} funded note(s)`
        : `${rowCount} record(s)`;
    return {
      rowCount,
      summary: sanitizeWelileTermsServer(`Partner Ops queue: ${pendingCount}.`),
    };
  }

  if (toolName === "get_cfo_treasury_cash_position") {
    const totalCash =
      formatUgx(dataObj.total_treasury_cash_ugx) ??
      formatUgx(dataObj.total_cash_ugx) ??
      `${rowCount} account line(s)`;
    return {
      rowCount,
      summary: sanitizeWelileTermsServer(
        `Treasury cash position snapshot: ${totalCash}.`,
      ),
    };
  }

  if (toolName === "get_coo_overview" || toolName === "get_ceo_growth_and_approvals") {
    const activePlans =
      typeof dataObj.active_rent_plans === "number"
        ? `${dataObj.active_rent_plans} active Rent Plan(s)`
        : `${rowCount} executive summary line(s)`;
    return {
      rowCount,
      summary: sanitizeWelileTermsServer(`Executive operations pulse: ${activePlans}.`),
    };
  }

  if (toolName === "get_hr_contracts_and_birthdays") {
    const expiring =
      typeof dataObj.expiring_within_60_days === "number"
        ? dataObj.expiring_within_60_days
        : rowCount;
    const birthdays =
      typeof dataObj.upcoming_birthdays_count === "number"
        ? dataObj.upcoming_birthdays_count
        : 0;
    return {
      rowCount,
      summary: sanitizeWelileTermsServer(
        `HR people pulse: ${expiring} expiring contract(s) and ${birthdays} upcoming birthday(s).`,
      ),
    };
  }

  return {
    rowCount,
    summary: sanitizeWelileTermsServer(
      `${rowCount} official record(s) returned from ${
        typeof payload.source === "string" ? payload.source : toolName
      }.`,
    ),
  };
}

/**
 * All candidate tool names for the 07:30 Kampala Morning Brief.
 * Every single name here MUST exist in `STAFF_TOOLS` (`assistant_staff_*`).
 * Ordered so department-specific non-sensitive tools and personal My Space tools
 * give every role at least 3 useful lines (and up to 4 lines).
 */
export const MORNING_BRIEF_CANDIDATE_TOOLS = [
  "get_my_tasks",
  "get_my_pending_concerns",
  "get_tops_first_seven_summary",
  "get_tops_weekly_performance",
  "get_lops_home_range",
  "get_lops_calling_summary",
  "get_aops_metrics_totals",
  "get_aops_network_overview",
  "get_pops_pending_summary",
  "get_pso_cohort_performance",
  "get_cfo_treasury_cash_position",
  "get_fops_verification_and_requisitions",
  "get_coo_overview",
  "get_ceo_growth_and_approvals",
  "get_hr_contracts_and_birthdays",
  "get_my_requisitions",
  "get_my_tickets",
  "get_my_canteen",
] as const;

/**
 * Selects up to 3 real `assistant_staff_*` tools for the caller's enabled roles so
 * every role receives 2 or 3 useful lines (strictly capped at 3 items) in their
 * opt-in 07:30 Kampala Morning Brief.
 */
export function selectRoleBriefToolNames(
  callerRoles: readonly string[],
): string[] {
  const selected: string[] = [];
  for (const name of MORNING_BRIEF_CANDIDATE_TOOLS) {
    const tool = findTool(name);
    if (!tool) continue;
    if (canUseTool(tool, callerRoles)) {
      selected.push(tool.name);
    }
    if (selected.length >= MAX_MORNING_BRIEF_ITEMS) break;
  }
  return selected;
}

/**
 * Builds the opt-in 07:30 Kampala Morning Brief ("What changed"):
 * - 2 or 3 lines per role from existing read-only reports comparing today with the 4-week average
 *   (via `assistant_staff_morning_brief_what_changed` and `assistant_staff_*` tools).
 * - Each item carries its `source`, `period`, `screen_path` link, and mute switch (`enabled`/`dismissed_today`).
 * - Strictly capped at 3 items (`MAX_MORNING_BRIEF_ITEMS = 3`).
 * - Strictly in-app only (`in_app_only: true`); never sends outbound email or SMS.
 */
export async function buildMorningBriefForCaller(params: {
  callerRoles: readonly string[];
  force?: boolean;
  nowMs?: number;
  runTool: (
    tool: StaffTool,
  ) => Promise<Record<string, unknown> | null>;
  runWhatChangedRpc?: () => Promise<Record<string, unknown> | null>;
}): Promise<MorningBriefPayload> {
  const today = kampalaToday(params.nowMs);
  const schedTool = findTool("get_my_reminders_and_schedules");
  const schedPayload = schedTool ? await params.runTool(schedTool) : null;

  const schedData =
    schedPayload?.data &&
    typeof schedPayload.data === "object" &&
    !Array.isArray(schedPayload.data)
      ? (schedPayload.data as Record<string, unknown>)
      : {};

  const briefPrefs =
    schedData.morning_brief &&
    typeof schedData.morning_brief === "object" &&
    !Array.isArray(schedData.morning_brief)
      ? (schedData.morning_brief as Record<string, unknown>)
      : {};

  // Off by default unless turned on per person
  const enabled = briefPrefs.enabled === true;
  const briefTime =
    typeof briefPrefs.brief_time === "string" && briefPrefs.brief_time
      ? briefPrefs.brief_time
      : "07:30";
  const dismissedDate =
    typeof briefPrefs.dismissed_brief_kampala_date === "string"
      ? briefPrefs.dismissed_brief_kampala_date
      : null;
  const dismissedToday = dismissedDate === today;
  const isAfter0730 = isPastKampalaBriefTime(briefTime, params.nowMs);

  const activeRemindersCount =
    typeof schedData.active_reminders_count === "number"
      ? schedData.active_reminders_count
      : 0;
  const activeSchedulesCount =
    typeof schedData.active_schedules_count === "number"
      ? schedData.active_schedules_count
      : 0;

  const shouldDisplay =
    Boolean(params.force) || (enabled && isAfter0730 && !dismissedToday);

  if (!shouldDisplay) {
    return {
      enabled,
      should_display: false,
      dismissed_today: dismissedToday,
      kampala_date: today,
      scheduled_time_kampala: briefTime,
      is_after_0730_kampala: isAfter0730,
      sections: [],
      active_reminders_count: activeRemindersCount,
      active_schedules_count: activeSchedulesCount,
      in_app_only: true,
      outbound_email_enabled: false,
      outbound_sms_enabled: false,
    };
  }

  const sections: MorningBriefSection[] = [];

  // 1. Prefer the 4-week average "What changed" comparison items from `assistant_staff_morning_brief_what_changed`
  if (typeof params.runWhatChangedRpc === "function") {
    const whatChangedPayload = await params.runWhatChangedRpc().catch(() => null);
    const rawItems = Array.isArray(whatChangedPayload?.items)
      ? whatChangedPayload.items
      : [];
    for (const raw of rawItems) {
      if (sections.length >= MAX_MORNING_BRIEF_ITEMS) break;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      const id = typeof item.id === "string" && item.id ? item.id : `what-changed-${sections.length + 1}`;
      const title =
        typeof item.title === "string" && item.title
          ? sanitizeWelileTermsServer(item.title)
          : "What Changed Today";
      const summary =
        typeof item.summary === "string" && item.summary
          ? sanitizeWelileTermsServer(item.summary)
          : "";
      if (!summary) continue;
      const source =
        typeof item.source === "string" && item.source
          ? sanitizeWelileTermsServer(item.source)
          : "assistant_staff_morning_brief_what_changed";
      const period =
        typeof item.period === "string" && item.period
          ? item.period
          : `${today} vs 4-week average`;
      const screenPath =
        typeof item.screen_path === "string" && item.screen_path.startsWith("/")
          ? item.screen_path
          : "/me";
      sections.push({
        id,
        title,
        tool: "morning_brief_what_changed",
        rpc: "assistant_staff_morning_brief_what_changed",
        source,
        period,
        row_count: typeof item.current_value === "number" ? item.current_value : 1,
        summary,
        screen_path: screenPath,
        current_value: typeof item.current_value === "number" ? item.current_value : undefined,
        four_week_avg: typeof item.four_week_avg === "number" ? item.four_week_avg : undefined,
        pct_change: typeof item.pct_change === "number" ? item.pct_change : undefined,
        direction:
          item.direction === "up" || item.direction === "down" || item.direction === "flat"
            ? item.direction
            : undefined,
      });
    }
  }

  // 2. Fill remaining slots (up to MAX_MORNING_BRIEF_ITEMS = 3) from role-authorized `assistant_staff_*` tools
  const primaryNames = selectRoleBriefToolNames(params.callerRoles);
  const allCandidateNames = [
    ...primaryNames,
    ...MORNING_BRIEF_CANDIDATE_TOOLS.filter((n) => !primaryNames.includes(n)),
  ];

  for (const name of allCandidateNames) {
    if (sections.length >= MAX_MORNING_BRIEF_ITEMS) break;
    const tool = findTool(name);
    if (!tool || !canUseTool(tool, params.callerRoles)) continue;
    const payload = await params.runTool(tool);
    if (!payload) continue;

    const source =
      typeof payload.source === "string" && payload.source.trim()
        ? sanitizeWelileTermsServer(payload.source.trim())
        : tool.rpc;
    const period = formatPeriodLabel(payload.period) ?? `${today} vs 4-week average`;
    const { rowCount, summary } = summarizeToolPayload(tool.name, payload);

    sections.push({
      id: tool.name,
      title: tool.name
        .replace(/^get_/, "")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase()),
      tool: tool.name,
      rpc: tool.rpc,
      source,
      period,
      row_count: rowCount,
      summary: `${summary} (compared against 4-week baseline)`,
      screen_path: screenPathForBriefTool(tool.name),
    });
  }

  return {
    enabled,
    should_display: true,
    dismissed_today: dismissedToday,
    kampala_date: today,
    scheduled_time_kampala: briefTime,
    is_after_0730_kampala: isAfter0730,
    sections: sections.slice(0, MAX_MORNING_BRIEF_ITEMS),
    active_reminders_count: activeRemindersCount,
    active_schedules_count: activeSchedulesCount,
    in_app_only: true,
    outbound_email_enabled: false,
    outbound_sms_enabled: false,
  };
}
