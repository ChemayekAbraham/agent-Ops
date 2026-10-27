import {
  buildReportReference,
  extractRecipientQuery,
  isEmailFromToolData,
  sanitizeWelileTermsServer,
  StaffEmailRecipient,
  ZoeReportReference,
} from "./emailDraft.ts";
import { MSG } from "./messages.ts";

export interface ZoeReminderDraft {
  draft_id: string;
  kind: "reminder";
  status: "ready";
  title: string;
  remind_at: string;
  remind_at_kampala: string;
  note: string | null;
}

export interface ZoeNotificationDraft {
  draft_id: string;
  kind: "notification";
  status: "ready" | "pick_recipient";
  recipient_user_id: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  recipient_roles: string[];
  title: string;
  message: string;
  candidates: StaffEmailRecipient[];
}

export interface ZoeScheduleDraft {
  draft_id: string;
  kind: "schedule";
  status: "ready" | "pick_recipient";
  title: string;
  frequency: "daily" | "weekly";
  day_of_week: number | null;
  send_time_kampala: string;
  recipient_user_id: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  recipient_roles: string[];
  custom_message: string;
  report_reference: ZoeReportReference;
  candidates: StaffEmailRecipient[];
}

export type ZoeIdeaCategory =
  | "general"
  | "desk_wait"
  | "collections"
  | "calling"
  | "payouts"
  | "zoe_quality";

export interface ZoeIdeaDraft {
  draft_id: string;
  kind: "idea";
  action_type: "idea";
  status: "ready";
  title: string;
  suggestion: string;
  evidence_summary: string;
  figures: Record<string, unknown>;
  source_label: string;
  period_label: string;
  category: ZoeIdeaCategory;
  screen_path: string;
}

export type ZoeActionDraft =
  | ZoeReminderDraft
  | ZoeNotificationDraft
  | ZoeScheduleDraft
  | ZoeIdeaDraft;

export type ActionDraftOutcome<T extends ZoeActionDraft> =
  | {
      kind: "refused";
      reason: "data_email_forbidden" | "not_staff";
      message: string;
    }
  | {
      kind: "pick_recipient";
      question: string;
      options: string[];
      draft: T;
    }
  | {
      kind: "draft_ready";
      replyText: string;
      draft: T;
    };

/**
 * Resolves a human date/time or ISO string into an ISO timestamp and Kampala display label.
 * Defaults to tomorrow at 09:00 Kampala time if no valid future date/time is given.
 */
export function resolveReminderTimestamp(
  rawRemindAt: string | undefined,
  todayKampala: string,
): { remindAtIso: string; remindAtKampala: string } {
  const trimmed = String(rawRemindAt ?? "").trim();

  // Check if YYYY-MM-DD HH:mm or YYYY-MM-DDTHH:mm
  const isoLike = trimmed.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/);
  if (isoLike) {
    const datePart = isoLike[1];
    const timePart = isoLike[2];
    return {
      remindAtIso: `${datePart}T${timePart}:00+03:00`,
      remindAtKampala: `${datePart} ${timePart}`,
    };
  }

  // Check if YYYY-MM-DD only -> default to 09:00 Kampala time
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return {
      remindAtIso: `${trimmed}T09:00:00+03:00`,
      remindAtKampala: `${trimmed} 09:00`,
    };
  }

  // Check if HH:mm only -> today at HH:mm Kampala time
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) {
    return {
      remindAtIso: `${todayKampala}T${trimmed}:00+03:00`,
      remindAtKampala: `${todayKampala} ${trimmed}`,
    };
  }

  // Fallback: tomorrow at 09:00 Kampala time
  const baseMs = Date.parse(`${todayKampala}T00:00:00Z`) + 86_400_000;
  const tomorrowDate = new Date(baseMs).toISOString().slice(0, 10);
  return {
    remindAtIso: `${tomorrowDate}T09:00:00+03:00`,
    remindAtKampala: `${tomorrowDate} 09:00`,
  };
}

/**
 * Pure builder for `draft_reminder` ("a reminder for myself").
 * Never writes to the database — returns a draft card requiring a user click.
 */
export function buildReminderDraft(params: {
  title: string;
  remindAt?: string;
  note?: string;
  todayKampala: string;
}): { replyText: string; draft: ZoeReminderDraft } {
  const cleanTitle = sanitizeWelileTermsServer(params.title.trim());
  const cleanNote = params.note?.trim()
    ? sanitizeWelileTermsServer(params.note.trim())
    : null;
  const { remindAtIso, remindAtKampala } = resolveReminderTimestamp(
    params.remindAt,
    params.todayKampala,
  );

  const draft: ZoeReminderDraft = {
    draft_id: crypto.randomUUID(),
    kind: "reminder",
    status: "ready",
    title: cleanTitle,
    remind_at: remindAtIso,
    remind_at_kampala: remindAtKampala,
    note: cleanNote,
  };

  const replyText =
    `I have prepared a reminder draft for you ("${cleanTitle}" at ${remindAtKampala} Kampala time). ` +
    `Review the draft card below and click Save Reminder to confirm, or Cancel to discard.\n\n` +
    `Source: My Space Zoe Reminder Draft · Period: ${remindAtKampala}`;

  return { replyText, draft };
}

/**
 * Pure builder for `draft_staff_notification` ("an in-app notification to a staff colleague").
 * Looks up recipient ONLY via `staff_assistant_email_recipients` and never writes to `notifications`
 * until the user clicks Send Notification on the draft card.
 */
export function buildStaffNotificationDraft(params: {
  recipientSearch: string;
  recipients: StaffEmailRecipient[];
  rawToolOutputs: readonly string[];
  userText: string;
  title: string;
  message: string;
  todayKampala: string;
}): ActionDraftOutcome<ZoeNotificationDraft> {
  if (
    isEmailFromToolData(
      params.recipientSearch,
      params.rawToolOutputs,
      params.userText,
    )
  ) {
    return {
      kind: "refused",
      reason: "data_email_forbidden",
      message: MSG.dataEmailForbidden,
    };
  }

  if (params.recipients.length === 0) {
    return {
      kind: "refused",
      reason: "not_staff",
      message: MSG.recipientNotStaff,
    };
  }

  const cleanTitle = sanitizeWelileTermsServer(params.title.trim());
  const cleanMessage = sanitizeWelileTermsServer(params.message.trim());
  const extractedQuery = extractRecipientQuery(
    params.recipientSearch,
  ).toLowerCase();
  const exactEmailMatch = params.recipients.find(
    (r) => r.email.toLowerCase() === extractedQuery,
  );

  if (params.recipients.length > 1 && !exactEmailMatch) {
    const options = params.recipients
      .slice(0, 3)
      .map((r) => `Notify ${r.full_name} (${r.email})`);
    const question = `Several active Welile staff members match "${params.recipientSearch}". Please pick which colleague should receive the in-app notification:`;

    const draft: ZoeNotificationDraft = {
      draft_id: crypto.randomUUID(),
      kind: "notification",
      status: "pick_recipient",
      recipient_user_id: null,
      recipient_name: null,
      recipient_email: null,
      recipient_roles: [],
      title: cleanTitle,
      message: cleanMessage,
      candidates: params.recipients,
    };

    return {
      kind: "pick_recipient",
      question,
      options,
      draft,
    };
  }

  const selected = exactEmailMatch ?? params.recipients[0];
  const draft: ZoeNotificationDraft = {
    draft_id: crypto.randomUUID(),
    kind: "notification",
    status: "ready",
    recipient_user_id: selected.staff_user_id,
    recipient_name: selected.full_name,
    recipient_email: selected.email,
    recipient_roles: selected.roles,
    title: cleanTitle,
    message: cleanMessage,
    candidates: [selected],
  };

  const replyText =
    `I have prepared an in-app notification draft for ${selected.full_name} (${selected.email}): "${cleanTitle}". ` +
    `Review the draft card below and click Send Notification to deliver it, or Cancel to discard.\n\n` +
    `Source: staff_assistant_email_recipients · Period: ${params.todayKampala}`;

  return {
    kind: "draft_ready",
    replyText,
    draft,
  };
}

/**
 * Pure builder for `draft_report_schedule` ("a schedule that emails a report daily or weekly to Welile staff only").
 * Looks up recipients strictly via `staff_assistant_email_recipients` and never stores or sends
 * until the user clicks Activate Schedule on the draft card.
 */
export function buildReportScheduleDraft(params: {
  recipientSearch: string;
  recipients: StaffEmailRecipient[];
  rawToolOutputs: readonly string[];
  userText: string;
  frequency: "daily" | "weekly";
  dayOfWeek?: number | null;
  sendTimeKampala?: string;
  customMessage?: string;
  reportPayload: Record<string, unknown>;
  periodLabel: string;
  todayKampala: string;
}): ActionDraftOutcome<ZoeScheduleDraft> {
  if (
    isEmailFromToolData(
      params.recipientSearch,
      params.rawToolOutputs,
      params.userText,
    )
  ) {
    return {
      kind: "refused",
      reason: "data_email_forbidden",
      message: MSG.dataEmailForbidden,
    };
  }

  if (params.recipients.length === 0) {
    return {
      kind: "refused",
      reason: "not_staff",
      message: MSG.recipientNotStaff,
    };
  }

  const reportRef = buildReportReference(
    params.reportPayload,
    params.todayKampala,
    params.periodLabel,
  );
  const frequency = params.frequency === "weekly" ? "weekly" : "daily";
  const sendTimeKampala =
    params.sendTimeKampala &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(params.sendTimeKampala.trim())
      ? params.sendTimeKampala.trim()
      : "07:30";
  const dayOfWeek =
    frequency === "weekly"
      ? typeof params.dayOfWeek === "number" &&
        params.dayOfWeek >= 0 &&
        params.dayOfWeek <= 6
        ? params.dayOfWeek
        : 1
      : null;

  const title = sanitizeWelileTermsServer(
    `${frequency === "weekly" ? "Weekly" : "Daily"} ${reportRef.title}`,
  );
  const customMessage = sanitizeWelileTermsServer(
    params.customMessage?.trim() ||
      `Scheduled ${frequency} Zoe report (${reportRef.title}) at ${sendTimeKampala} Kampala time.`,
  );

  const extractedQuery = extractRecipientQuery(
    params.recipientSearch,
  ).toLowerCase();
  const exactEmailMatch = params.recipients.find(
    (r) => r.email.toLowerCase() === extractedQuery,
  );

  if (params.recipients.length > 1 && !exactEmailMatch) {
    const options = params.recipients
      .slice(0, 3)
      .map(
        (r) =>
          `Schedule ${frequency} report to ${r.full_name} (${r.email})`,
      );
    const question = `Several active Welile staff members match "${params.recipientSearch}". Please pick who should receive the ${frequency} scheduled report:`;

    const draft: ZoeScheduleDraft = {
      draft_id: crypto.randomUUID(),
      kind: "schedule",
      status: "pick_recipient",
      title,
      frequency,
      day_of_week: dayOfWeek,
      send_time_kampala: sendTimeKampala,
      recipient_user_id: null,
      recipient_name: null,
      recipient_email: null,
      recipient_roles: [],
      custom_message: customMessage,
      report_reference: reportRef,
      candidates: params.recipients,
    };

    return {
      kind: "pick_recipient",
      question,
      options,
      draft,
    };
  }

  const selected = exactEmailMatch ?? params.recipients[0];
  const draft: ZoeScheduleDraft = {
    draft_id: crypto.randomUUID(),
    kind: "schedule",
    status: "ready",
    title,
    frequency,
    day_of_week: dayOfWeek,
    send_time_kampala: sendTimeKampala,
    recipient_user_id: selected.staff_user_id,
    recipient_name: selected.full_name,
    recipient_email: selected.email,
    recipient_roles: selected.roles,
    custom_message: customMessage,
    report_reference: reportRef,
    candidates: [selected],
  };

  const replyText =
    `I have prepared a ${frequency} report schedule draft (${reportRef.title} at ${sendTimeKampala} Kampala time) for ${selected.full_name} (${selected.email}). ` +
    `Review the draft card below and click Save Schedule to activate it, or Cancel to discard.\n\n` +
    `Source: ${reportRef.source} · Period: ${reportRef.period}`;

  return {
    kind: "draft_ready",
    replyText,
    draft,
  };
}

const ALLOWED_IDEA_SCREEN_PATHS = new Set<string>([
  "/me",
  "/me/zoe",
  "/me/ideas",
  "/me/payslips",
  "/me/work",
  "/me/tickets",
  "/me/requisitions",
  "/me/concerns",
  "/me/food",
  "/me/reports",
  "/me/staff-reports",
  "/your-profile",
  "/cfo/cash-position",
  "/cfo/receivables-analysis",
  "/cfo/payables-forecast",
  "/cfo-dashboard",
  "/financial-ops",
  "/coo-dashboard",
  "/ceo-dashboard",
  "/executive-hub",
  "/executive-hub?tab=agent-ops",
  "/executive-hub?tab=partner-ops",
  "/hr-dashboard",
  "/tenant-ops/workspace",
  "/landlord-ops",
  "/landlord-ops/principal-recovered",
  "/crm/dashboard",
  "/operations",
  "/admin/dashboard",
]);

/**
 * Pure builder for `draft_welile_idea` ("Ideas for Welile").
 * Prepares a click-confirmed idea draft card grounded in official tool figures.
 * Never saves, never changes any setting or business record, and never contacts anyone.
 */
export function buildIdeaDraft(params: {
  title: string;
  suggestion: string;
  evidenceSummary: string;
  category?: ZoeIdeaCategory;
  screenPath?: string;
  sourceLabel?: string;
  figures?: Record<string, unknown>;
  reportPayload?: Record<string, unknown> | null;
  periodLabel: string;
  todayKampala?: string;
}): { replyText: string; draft: ZoeIdeaDraft } {
  const cleanTitle = sanitizeWelileTermsServer(params.title.trim());
  const cleanSuggestion = sanitizeWelileTermsServer(params.suggestion.trim());
  const cleanEvidence = sanitizeWelileTermsServer(params.evidenceSummary.trim());

  const validCategories: readonly ZoeIdeaCategory[] = [
    "general",
    "desk_wait",
    "collections",
    "calling",
    "payouts",
    "zoe_quality",
  ];
  const category: ZoeIdeaCategory =
    params.category && validCategories.includes(params.category)
      ? params.category
      : "general";

  const defaultScreenByCategory: Record<ZoeIdeaCategory, string> = {
    general: "/me/ideas",
    desk_wait: "/tenant-ops/workspace",
    collections: "/executive-hub?tab=agent-ops",
    calling: "/me/staff-reports",
    payouts: "/landlord-ops",
    zoe_quality: "/crm/dashboard",
  };

  const rawScreen = params.screenPath?.trim() ||
    (typeof params.reportPayload?.screen_path === "string"
      ? params.reportPayload.screen_path.trim()
      : "") ||
    defaultScreenByCategory[category];
  const screenPath = ALLOWED_IDEA_SCREEN_PATHS.has(rawScreen)
    ? rawScreen
    : defaultScreenByCategory[category];

  const sourceLabel =
    (params.sourceLabel && params.sourceLabel.trim()) ||
    (typeof params.reportPayload?.source === "string" &&
      params.reportPayload.source.trim()
      ? params.reportPayload.source.trim()
      : "staff_assistant_insights");
  const periodLabel =
    params.periodLabel.trim() || `as of ${params.todayKampala ?? "today"}`;

  const figures: Record<string, unknown> = { ...(params.figures ?? {}) };
  if (params.reportPayload && typeof params.reportPayload === "object") {
    for (const [k, v] of Object.entries(params.reportPayload)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        figures[k] = v;
      } else if (typeof v === "string" && v.length <= 60 && /\d/.test(v) && k !== "source") {
        figures[k] = v;
      }
    }
  }

  const draft: ZoeIdeaDraft = {
    draft_id: crypto.randomUUID(),
    kind: "idea",
    action_type: "idea",
    status: "ready",
    title: cleanTitle,
    suggestion: cleanSuggestion,
    evidence_summary: cleanEvidence,
    figures,
    source_label: sourceLabel,
    period_label: periodLabel,
    category,
    screen_path: screenPath,
  };

  const replyText =
    `I have prepared an "Ideas for Welile" draft card: "${cleanTitle}". ` +
    `Suggestion: ${cleanSuggestion} ` +
    `Evidence: ${cleanEvidence} ` +
    `Review the draft card below and click Save Idea to record it for managers, the COO, and the CEO (or Cancel to discard). Zoe never acts on an idea, never changes any setting or business record, and never contacts anyone.\n\n` +
    `Source: ${sourceLabel} · Period: ${periodLabel}`;

  return { replyText, draft };
}
