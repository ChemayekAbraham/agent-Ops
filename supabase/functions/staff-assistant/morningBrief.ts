import { formatPeriodLabel, kampalaToday } from "./dates.ts";
import { sanitizeWelileTermsServer } from "./emailDraft.ts";
import { canUseTool, findTool, StaffTool } from "./tools.ts";

export interface MorningBriefSection {
  id: string;
  title: string;
  tool: string;
  rpc: string;
  source: string;
  period: string;
  row_count: number;
  summary: string;
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

function summarizeToolPayload(
  toolName: string,
  payload: Record<string, unknown>,
): { rowCount: number; summary: string } {
  const rowCount =
    typeof payload.row_count === "number" && Number.isFinite(payload.row_count)
      ? payload.row_count
      : Array.isArray(payload.rows)
      ? payload.rows.length
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
    const openTickets =
      typeof dataObj.open_tickets_count === "number"
        ? dataObj.open_tickets_count
        : 0;
    return {
      rowCount,
      summary: sanitizeWelileTermsServer(
        `${pendingTasks} pending task(s) and ${openTickets} open ticket(s) assigned to you.`,
      ),
    };
  }

  if (toolName === "get_my_concerns") {
    return {
      rowCount,
      summary: sanitizeWelileTermsServer(
        `${rowCount} pending Calling Center concern(s) awaiting follow-up.`,
      ),
    };
  }

  if (toolName === "get_cfo_treasury_cash_position") {
    const totalCash =
      typeof dataObj.total_cash_ugx === "number"
        ? `UGX ${Math.round(dataObj.total_cash_ugx).toLocaleString("en-US")}`
        : `${rowCount} account line(s)`;
    return {
      rowCount,
      summary: sanitizeWelileTermsServer(
        `Treasury cash position snapshot: ${totalCash}.`,
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
 * Selects the primary department read tool for the caller's enabled roles so the
 * 07:30 Kampala Morning Brief is built strictly from `assistant_staff_*` tools.
 */
export function selectRoleBriefToolNames(
  callerRoles: readonly string[],
): string[] {
  const candidateNames = [
    "get_my_tasks",
    "get_my_concerns",
    "get_tops_pipeline_waiting_on_lops",
    "get_lops_payout_pipeline",
    "get_aops_network_overview",
    "get_pops_pending_ops_queue",
    "get_cfo_treasury_cash_position",
    "get_hr_contracts_and_birthdays",
    "get_exec_daily_ops_pulse",
  ];

  const selected: string[] = [];
  for (const name of candidateNames) {
    const tool = findTool(name);
    if (!tool) continue;
    if (canUseTool(tool, callerRoles)) {
      selected.push(tool.name);
    }
    if (selected.length >= 4) break;
  }
  return selected;
}

/**
 * Builds the optional 07:30 Kampala Morning Brief strictly by calling `assistant_staff_*`
 * tools via `runTool` (which uses the caller's own JWT `userClient`).
 */
export async function buildMorningBriefForCaller(params: {
  callerRoles: readonly string[];
  force?: boolean;
  nowMs?: number;
  runTool: (
    tool: StaffTool,
  ) => Promise<Record<string, unknown> | null>;
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
    };
  }

  const toolNames = selectRoleBriefToolNames(params.callerRoles);
  const sections: MorningBriefSection[] = [];

  for (const name of toolNames) {
    const tool = findTool(name);
    if (!tool || !canUseTool(tool, params.callerRoles)) continue;
    const payload = await params.runTool(tool);
    if (!payload) continue;

    const source =
      typeof payload.source === "string" && payload.source.trim()
        ? sanitizeWelileTermsServer(payload.source.trim())
        : tool.rpc;
    const period = formatPeriodLabel(payload.period) ?? today;
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
      summary,
    });
  }

  return {
    enabled,
    should_display: true,
    dismissed_today: dismissedToday,
    kampala_date: today,
    scheduled_time_kampala: briefTime,
    is_after_0730_kampala: isAfter0730,
    sections,
    active_reminders_count: activeRemindersCount,
    active_schedules_count: activeSchedulesCount,
  };
}
