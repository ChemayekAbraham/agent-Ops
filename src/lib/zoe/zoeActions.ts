/**
 * Action drafts (`reminder`, `notification`, `schedule`), active reminders/schedules listing,
 * and 07:30 Kampala Morning Brief helpers for Zoe (`staff-assistant`).
 *
 * Rules:
 *   - All actions follow the "draft card, then click" rule: Zoe never executes actions
 *     during a chat turn; only a deliberate button press on the draft card calls the
 *     action RPC.
 *   - Frontend NEVER calls `assistant_staff_*` RPCs directly (enforced by `guard-staff-assistant.mjs`).
 *     It calls `staff_assistant_*` action RPCs or the `staff-assistant` edge function (`action: 'morning_brief'`).
 */
import {
  sanitizeWelileTerms,
  type ZoeExportableMessageInput,
} from './zoeReportData';
import type { ZoeStaffRecipientCandidate } from './zoeEmailDraft';

export interface ZoeReminderDraft {
  draft_id: string;
  action_type: 'reminder';
  status: 'ready';
  title: string;
  remind_at: string;
  remind_at_kampala_label: string;
  note: string | null;
}

export interface ZoeStaffNotificationDraft {
  draft_id: string;
  action_type: 'notification';
  status: 'ready' | 'pick_recipient';
  recipient_user_id: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  recipient_roles: string[];
  title: string;
  message: string;
  candidates: ZoeStaffRecipientCandidate[];
}

export interface ZoeReportScheduleDraft {
  draft_id: string;
  action_type: 'schedule';
  status: 'ready' | 'pick_recipient';
  title: string;
  report_tool: string;
  report_rpc: string;
  report_args: Record<string, unknown>;
  source: string;
  period: string;
  frequency: 'daily' | 'weekly';
  day_of_week: number | null;
  day_of_week_label: string | null;
  send_time_kampala: string;
  recipient_emails: string[];
  recipient_names: string[];
  custom_message: string;
  candidates: ZoeStaffRecipientCandidate[];
}

export type ZoeIdeaCategory =
  | 'desk_wait'
  | 'collections'
  | 'calling'
  | 'payouts'
  | 'zoe_quality'
  | 'general';

export type ZoeIdeaStatus = 'new' | 'being_looked_at' | 'done' | 'not_now';

export interface ZoeIdeaDraft {
  draft_id: string;
  action_type: 'idea';
  status: 'ready';
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
  | ZoeStaffNotificationDraft
  | ZoeReportScheduleDraft
  | ZoeIdeaDraft;

export interface ZoeReminderItem {
  id: string;
  title: string;
  note: string | null;
  remind_at: string;
  status: string;
  created_at: string;
}

export interface ZoeScheduleItem {
  id: string;
  title: string;
  report_tool: string;
  report_rpc: string;
  frequency: 'daily' | 'weekly';
  day_of_week: number | null;
  send_time_kampala: string;
  recipient_emails: string[];
  recipient_names: string[];
  custom_message: string | null;
  is_active: boolean;
  next_run_at: string;
  last_run_at: string | null;
  last_run_status: string | null;
}

export interface ZoeRemindersAndSchedulesPayload {
  source: string;
  period: string;
  morning_brief_enabled: boolean;
  morning_brief_time_kampala: string;
  reminders: ZoeReminderItem[];
  schedules: ZoeScheduleItem[];
}

export interface ZoeMorningBriefSection {
  id?: string;
  tool: string;
  rpc: string;
  title: string;
  source: string;
  period: string;
  summary: string;
  row_count?: number;
  screen_path?: string;
  current_value?: number;
  four_week_avg?: number;
  pct_change?: number;
  direction?: 'up' | 'down' | 'flat';
}

export interface ZoeMorningBriefPayload {
  available?: boolean;
  enabled: boolean;
  should_display_now?: boolean;
  should_display?: boolean;
  in_app_only?: boolean;
  max_items?: number;
  kampala_date: string;
  scheduled_time_kampala?: string;
  brief_time_kampala?: string;
  headline?: string;
  sections: ZoeMorningBriefSection[];
  source: string;
  period: string;
}

function parseCandidates(raw: unknown): ZoeStaffRecipientCandidate[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (c): c is Record<string, unknown> =>
        Boolean(c) && typeof c === 'object' && !Array.isArray(c),
    )
    .map((c) => ({
      staff_user_id: String(c.staff_user_id ?? ''),
      full_name: String(c.full_name ?? '').trim(),
      email: String(c.email ?? '').trim(),
      roles: Array.isArray(c.roles) ? c.roles.map((r) => String(r)) : [],
    }))
    .filter((c) => Boolean(c.email));
}

/**
 * Extracts a click-confirmed `ZoeActionDraft` (`reminder`, `notification`, or `schedule`)
 * from a Zoe assistant message if `reportPayload.action_draft` is present.
 */
export function extractZoeActionDraft(
  message: ZoeExportableMessageInput,
): ZoeActionDraft | null {
  if (!message || (message.role && message.role !== 'assistant')) return null;
  const payload = message.reportPayload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const rawDraft = payload.action_draft;
  if (!rawDraft || typeof rawDraft !== 'object' || Array.isArray(rawDraft)) return null;

  const d = rawDraft as Record<string, unknown>;
  const actionType = d.action_type ?? d.kind;

  if (actionType === 'reminder') {
    const title = sanitizeWelileTerms(
      typeof d.title === 'string' && d.title.trim() ? d.title.trim() : 'My Space Reminder',
    );
    const remindAt =
      typeof d.remind_at === 'string' && d.remind_at.trim()
        ? d.remind_at.trim()
        : new Date(Date.now() + 3600_000).toISOString();
    const remindAtLabel =
      typeof d.remind_at_kampala_label === 'string' && d.remind_at_kampala_label.trim()
        ? d.remind_at_kampala_label.trim()
        : typeof d.remind_at_kampala === 'string' && d.remind_at_kampala.trim()
          ? d.remind_at_kampala.trim()
          : remindAt;
    const note =
      typeof d.note === 'string' && d.note.trim() ? sanitizeWelileTerms(d.note.trim()) : null;

    return {
      draft_id: typeof d.draft_id === 'string' && d.draft_id ? d.draft_id : 'rem-draft-1',
      action_type: 'reminder',
      status: 'ready',
      title,
      remind_at: remindAt,
      remind_at_kampala_label: remindAtLabel,
      note,
    };
  }

  if (actionType === 'notification') {
    const candidates = parseCandidates(d.candidates);
    const recipientEmail =
      typeof d.recipient_email === 'string' && d.recipient_email.trim()
        ? d.recipient_email.trim()
        : null;
    const recipientName =
      typeof d.recipient_name === 'string' && d.recipient_name.trim()
        ? d.recipient_name.trim()
        : null;
    const status: 'ready' | 'pick_recipient' =
      d.status === 'pick_recipient' || (!recipientEmail && candidates.length > 1)
        ? 'pick_recipient'
        : 'ready';

    return {
      draft_id: typeof d.draft_id === 'string' && d.draft_id ? d.draft_id : 'notif-draft-1',
      action_type: 'notification',
      status,
      recipient_user_id: typeof d.recipient_user_id === 'string' ? d.recipient_user_id : null,
      recipient_name: recipientName,
      recipient_email: recipientEmail,
      recipient_roles: Array.isArray(d.recipient_roles)
        ? d.recipient_roles.map((r) => String(r))
        : [],
      title: sanitizeWelileTerms(
        typeof d.title === 'string' && d.title.trim()
          ? d.title.trim()
          : 'Message from colleague via Zoe',
      ),
      message: sanitizeWelileTerms(
        typeof d.message === 'string' && d.message.trim() ? d.message.trim() : '',
      ),
      candidates,
    };
  }

  if (actionType === 'schedule') {
    const candidates = parseCandidates(d.candidates);
    const recipientEmails = Array.isArray(d.recipient_emails)
      ? d.recipient_emails.map((e) => String(e).trim()).filter(Boolean)
      : typeof d.recipient_email === 'string' && d.recipient_email.trim()
        ? [d.recipient_email.trim()]
        : [];
    const recipientNames = Array.isArray(d.recipient_names)
      ? d.recipient_names.map((n) => String(n).trim()).filter(Boolean)
      : typeof d.recipient_name === 'string' && d.recipient_name.trim()
        ? [d.recipient_name.trim()]
        : [];
    const frequency: 'daily' | 'weekly' = d.frequency === 'weekly' ? 'weekly' : 'daily';
    const dayOfWeek =
      typeof d.day_of_week === 'number' && Number.isFinite(d.day_of_week)
        ? d.day_of_week
        : frequency === 'weekly'
          ? 1
          : null;
    const status: 'ready' | 'pick_recipient' =
      d.status === 'pick_recipient' || (recipientEmails.length === 0 && candidates.length > 0)
        ? 'pick_recipient'
        : 'ready';

    const rawRef =
      d.report_reference && typeof d.report_reference === 'object' && !Array.isArray(d.report_reference)
        ? (d.report_reference as Record<string, unknown>)
        : {};
    const reportTool =
      typeof d.report_tool === 'string' && d.report_tool.trim()
        ? d.report_tool.trim()
        : typeof rawRef.tool === 'string' && rawRef.tool.trim()
          ? rawRef.tool.trim()
          : 'my_profile';
    const reportRpc =
      typeof d.report_rpc === 'string' && d.report_rpc.trim()
        ? d.report_rpc.trim()
        : typeof rawRef.rpc === 'string' && rawRef.rpc.trim()
          ? rawRef.rpc.trim()
          : 'assistant_staff_my_profile';
    const reportArgs =
      d.report_args && typeof d.report_args === 'object' && !Array.isArray(d.report_args)
        ? (d.report_args as Record<string, unknown>)
        : rawRef.args && typeof rawRef.args === 'object' && !Array.isArray(rawRef.args)
          ? (rawRef.args as Record<string, unknown>)
          : {};
    const sourceLabel =
      typeof d.source === 'string' && d.source
        ? d.source
        : typeof rawRef.source === 'string' && rawRef.source
          ? rawRef.source
          : reportRpc;
    const periodLabel =
      typeof d.period === 'string' && d.period
        ? d.period
        : typeof rawRef.period === 'string' && rawRef.period
          ? rawRef.period
          : 'Scheduled Period';

    return {
      draft_id: typeof d.draft_id === 'string' && d.draft_id ? d.draft_id : 'sched-draft-1',
      action_type: 'schedule',
      status,
      title: sanitizeWelileTerms(
        typeof d.title === 'string' && d.title.trim()
          ? d.title.trim()
          : 'Scheduled Zoe Staff Report',
      ),
      report_tool: reportTool,
      report_rpc: reportRpc,
      report_args: reportArgs,
      source: sourceLabel,
      period: periodLabel,
      frequency,
      day_of_week: dayOfWeek,
      day_of_week_label:
        typeof d.day_of_week_label === 'string' ? d.day_of_week_label : null,
      send_time_kampala:
        typeof d.send_time_kampala === 'string' && /^\d{2}:\d{2}$/.test(d.send_time_kampala)
          ? d.send_time_kampala
          : '07:30',
      recipient_emails: recipientEmails,
      recipient_names: recipientNames,
      custom_message: sanitizeWelileTerms(
        typeof d.custom_message === 'string' && d.custom_message.trim()
          ? d.custom_message.trim()
          : 'Automated report shared from Zoe.',
      ),
      candidates,
    };
  }

  if (actionType === 'idea') {
    const allowedCategories = new Set<ZoeIdeaCategory>([
      'desk_wait',
      'collections',
      'calling',
      'payouts',
      'zoe_quality',
      'general',
    ]);
    const rawCat = typeof d.category === 'string' ? (d.category.trim() as ZoeIdeaCategory) : 'general';
    const category: ZoeIdeaCategory = allowedCategories.has(rawCat) ? rawCat : 'general';

    const title = sanitizeWelileTerms(
      typeof d.title === 'string' && d.title.trim() ? d.title.trim() : 'Welile Improvement Idea',
    );
    const suggestion = sanitizeWelileTerms(
      typeof d.suggestion === 'string' && d.suggestion.trim() ? d.suggestion.trim() : '',
    );
    const evidenceSummary = sanitizeWelileTerms(
      typeof d.evidence_summary === 'string' && d.evidence_summary.trim()
        ? d.evidence_summary.trim()
        : typeof d.evidence === 'string' && d.evidence.trim()
          ? d.evidence.trim()
          : '',
    );
    const figures =
      d.figures && typeof d.figures === 'object' && !Array.isArray(d.figures)
        ? (d.figures as Record<string, unknown>)
        : {};
    const sourceLabel =
      typeof d.source_label === 'string' && d.source_label.trim()
        ? d.source_label.trim()
        : typeof d.source === 'string' && d.source.trim()
          ? d.source.trim()
          : 'Official report';
    const periodLabel =
      typeof d.period_label === 'string' && d.period_label.trim()
        ? d.period_label.trim()
        : typeof d.period === 'string' && d.period.trim()
          ? d.period.trim()
          : 'Last 4 weeks';
    const screenPath =
      typeof d.screen_path === 'string' && d.screen_path.trim().startsWith('/')
        ? d.screen_path.trim()
        : '/me';

    return {
      draft_id: typeof d.draft_id === 'string' && d.draft_id ? d.draft_id : 'idea-draft-1',
      action_type: 'idea',
      status: 'ready',
      title,
      suggestion,
      evidence_summary: evidenceSummary,
      figures,
      source_label: sourceLabel,
      period_label: periodLabel,
      category,
      screen_path: screenPath,
    };
  }

  return null;
}

/**
 * Extracts active reminders and schedules when Zoe calls `get_my_reminders_and_schedules`.
 */
export function extractZoeRemindersAndSchedules(
  message: ZoeExportableMessageInput,
): ZoeRemindersAndSchedulesPayload | null {
  if (!message || (message.role && message.role !== 'assistant')) return null;
  const payload = message.reportPayload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const isToolMatch = payload.tool === 'get_my_reminders_and_schedules';
  const hasArrays = Array.isArray(payload.reminders) || Array.isArray(payload.schedules);
  if (!isToolMatch && !hasArrays) return null;

  const reminders: ZoeReminderItem[] = Array.isArray(payload.reminders)
    ? payload.reminders
        .filter(
          (r): r is Record<string, unknown> =>
            Boolean(r) && typeof r === 'object' && !Array.isArray(r),
        )
        .map((r) => ({
          id: String(r.id ?? ''),
          title: sanitizeWelileTerms(String(r.title ?? 'Reminder')),
          note: typeof r.note === 'string' && r.note.trim() ? sanitizeWelileTerms(r.note) : null,
          remind_at: String(r.remind_at ?? ''),
          status: String(r.status ?? 'pending'),
          created_at: String(r.created_at ?? ''),
        }))
        .filter((r) => Boolean(r.id))
    : [];

  const schedules: ZoeScheduleItem[] = Array.isArray(payload.schedules)
    ? payload.schedules
        .filter(
          (s): s is Record<string, unknown> =>
            Boolean(s) && typeof s === 'object' && !Array.isArray(s),
        )
        .map((s) => ({
          id: String(s.id ?? ''),
          title: sanitizeWelileTerms(String(s.title ?? 'Scheduled Report')),
          report_tool: String(s.report_tool ?? ''),
          report_rpc: String(s.report_rpc ?? ''),
          frequency: (s.frequency === 'weekly' ? 'weekly' : 'daily') as 'daily' | 'weekly',
          day_of_week: typeof s.day_of_week === 'number' ? s.day_of_week : null,
          send_time_kampala: String(s.send_time_kampala ?? '07:30'),
          recipient_emails: Array.isArray(s.recipient_emails)
            ? s.recipient_emails.map((e) => String(e))
            : [],
          recipient_names: Array.isArray(s.recipient_names)
            ? s.recipient_names.map((n) => String(n))
            : [],
          custom_message:
            typeof s.custom_message === 'string' && s.custom_message.trim()
              ? sanitizeWelileTerms(s.custom_message)
              : null,
          is_active: s.is_active !== false,
          next_run_at: String(s.next_run_at ?? ''),
          last_run_at: typeof s.last_run_at === 'string' ? s.last_run_at : null,
          last_run_status: typeof s.last_run_status === 'string' ? s.last_run_status : null,
        }))
        .filter((s) => Boolean(s.id))
    : [];

  return {
    source: String(payload.source ?? message.source ?? 'staff_assistant_reminders + staff_assistant_schedules'),
    period: String(payload.period ?? message.period ?? 'Current active items'),
    morning_brief_enabled: payload.morning_brief_enabled === true,
    morning_brief_time_kampala:
      typeof payload.morning_brief_time_kampala === 'string'
        ? payload.morning_brief_time_kampala
        : '07:30',
    reminders,
    schedules,
  };
}

export interface ConfirmZoeReminderInput {
  draft_id?: string | null;
  rebind_draft?: boolean;
  title: string;
  remind_at: string;
  note?: string | null;
  conversation_id?: string | null;
}

export interface ConfirmZoeActionResult {
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

/**
 * Click-confirmed action: creates a personal reminder in `staff_assistant_reminders`.
 */
export async function confirmZoeReminderDraft(
  input: ConfirmZoeReminderInput,
): Promise<ConfirmZoeActionResult> {
  const { supabase } = await import('@/integrations/supabase/client');
  const sanitizedTitle = sanitizeWelileTerms(input.title.trim());
  const sanitizedNote = input.note ? sanitizeWelileTerms(input.note.trim()) : null;

  let draftId = input.draft_id ?? null;
  if ((input.rebind_draft || !draftId) && typeof supabase.rpc === 'function') {
    const { data: savedDraft, error: draftErr } = await supabase.rpc(
      'staff_assistant_save_draft' as never,
      {
        p_kind: 'reminder',
        p_payload: {
          kind: 'reminder',
          title: sanitizedTitle,
          remind_at: input.remind_at,
          note: sanitizedNote ?? '',
        },
        p_conversation_id: input.conversation_id ?? null,
      } as never,
    );
    if (draftErr) {
      return { ok: false, error: draftErr.message || 'Could not prepare reminder draft.' };
    }
    const row = (savedDraft ?? {}) as Record<string, unknown>;
    if (typeof row.draft_id === 'string' && row.draft_id) {
      draftId = row.draft_id;
    }
  }

  const { data, error } = await supabase.rpc('staff_assistant_create_reminder' as never, {
    p_title: sanitizedTitle,
    p_remind_at: input.remind_at,
    p_note: sanitizedNote,
    p_conversation_id: input.conversation_id ?? null,
    p_draft_id: draftId,
  } as never);

  if (error) {
    return { ok: false, error: error.message || 'Could not save reminder right now.' };
  }
  return { ok: true, data: (data ?? {}) as Record<string, unknown> };
}

/**
 * Cancels one of the caller's own reminders.
 */
export async function cancelZoeReminder(reminderId: string): Promise<ConfirmZoeActionResult> {
  const { supabase } = await import('@/integrations/supabase/client');
  const { data, error } = await supabase.rpc('staff_assistant_cancel_reminder' as never, {
    p_reminder_id: reminderId,
  } as never);

  if (error) {
    return { ok: false, error: error.message || 'Could not cancel reminder right now.' };
  }
  return { ok: true, data: (data ?? {}) as Record<string, unknown> };
}

export interface ConfirmZoeNotificationInput {
  draft_id?: string | null;
  rebind_draft?: boolean;
  recipient_email: string;
  title: string;
  message: string;
  link_path?: string | null;
  conversation_id?: string | null;
}

/**
 * Click-confirmed action: sends an in-app notification to a verified Welile staff colleague.
 */
export async function confirmZoeNotificationDraft(
  input: ConfirmZoeNotificationInput,
): Promise<ConfirmZoeActionResult> {
  const { supabase } = await import('@/integrations/supabase/client');
  const trimmedEmail = input.recipient_email.trim();
  const sanitizedTitle = sanitizeWelileTerms(input.title.trim());
  const sanitizedMessage = sanitizeWelileTerms(input.message.trim());
  const linkPath = input.link_path?.trim() || '/me';

  let draftId = input.draft_id ?? null;
  if ((input.rebind_draft || !draftId) && typeof supabase.rpc === 'function') {
    const { data: savedDraft, error: draftErr } = await supabase.rpc(
      'staff_assistant_save_draft' as never,
      {
        p_kind: 'notification',
        p_payload: {
          kind: 'notification',
          recipient_email: trimmedEmail.toLowerCase(),
          title: sanitizedTitle,
          message: sanitizedMessage,
          link_path: linkPath,
        },
        p_conversation_id: input.conversation_id ?? null,
      } as never,
    );
    if (draftErr) {
      return { ok: false, error: draftErr.message || 'Could not prepare notification draft.' };
    }
    const row = (savedDraft ?? {}) as Record<string, unknown>;
    if (typeof row.draft_id === 'string' && row.draft_id) {
      draftId = row.draft_id;
    }
  }

  const { data, error } = await supabase.rpc(
    'staff_assistant_send_colleague_notification' as never,
    {
      p_recipient_email: trimmedEmail,
      p_title: sanitizedTitle,
      p_message: sanitizedMessage,
      p_conversation_id: input.conversation_id ?? null,
      p_draft_id: draftId,
      p_link_path: linkPath,
    } as never,
  );

  if (error) {
    return { ok: false, error: error.message || 'Could not send colleague notification.' };
  }
  return { ok: true, data: (data ?? {}) as Record<string, unknown> };
}

export interface ConfirmZoeScheduleInput {
  draft_id?: string | null;
  rebind_draft?: boolean;
  title: string;
  report_tool: string;
  report_rpc: string;
  report_args?: Record<string, unknown>;
  frequency: 'daily' | 'weekly';
  recipient_emails: string[];
  day_of_week?: number | null;
  send_time_kampala?: string;
  custom_message?: string | null;
  conversation_id?: string | null;
}

/**
 * Click-confirmed action: creates a recurring report email schedule for Welile staff recipients.
 */
export async function confirmZoeScheduleDraft(
  input: ConfirmZoeScheduleInput,
): Promise<ConfirmZoeActionResult> {
  const { supabase } = await import('@/integrations/supabase/client');
  const sanitizedTitle = sanitizeWelileTerms(input.title.trim());
  const sanitizedMessage = input.custom_message
    ? sanitizeWelileTerms(input.custom_message.trim())
    : null;
  const trimmedEmails = input.recipient_emails.map((e) => e.trim()).filter(Boolean);
  const dayOfWeek = input.frequency === 'weekly' ? (input.day_of_week ?? 1) : null;
  const sendTime = input.send_time_kampala ?? '07:30';

  let draftId = input.draft_id ?? null;
  if ((input.rebind_draft || !draftId) && typeof supabase.rpc === 'function') {
    const { data: savedDraft, error: draftErr } = await supabase.rpc(
      'staff_assistant_save_draft' as never,
      {
        p_kind: 'schedule',
        p_payload: {
          kind: 'schedule',
          title: sanitizedTitle,
          report_tool: input.report_tool,
          report_rpc: input.report_rpc,
          report_args: input.report_args ?? {},
          frequency: input.frequency,
          day_of_week: dayOfWeek,
          send_time_kampala: sendTime,
          recipient_emails: trimmedEmails,
          custom_message: sanitizedMessage ?? '',
        },
        p_conversation_id: input.conversation_id ?? null,
      } as never,
    );
    if (draftErr) {
      return { ok: false, error: draftErr.message || 'Could not prepare schedule draft.' };
    }
    const row = (savedDraft ?? {}) as Record<string, unknown>;
    if (typeof row.draft_id === 'string' && row.draft_id) {
      draftId = row.draft_id;
    }
  }

  const { data, error } = await supabase.rpc('staff_assistant_create_schedule' as never, {
    p_title: sanitizedTitle,
    p_report_tool: input.report_tool,
    p_report_rpc: input.report_rpc,
    p_report_args: input.report_args ?? {},
    p_frequency: input.frequency,
    p_recipient_emails: trimmedEmails,
    p_day_of_week: dayOfWeek,
    p_send_time_kampala: sendTime,
    p_custom_message: sanitizedMessage,
    p_conversation_id: input.conversation_id ?? null,
    p_draft_id: draftId,
  } as never);

  if (error) {
    return { ok: false, error: error.message || 'Could not save report schedule right now.' };
  }
  return { ok: true, data: (data ?? {}) as Record<string, unknown> };
}

/**
 * Cancels one of the caller's own report schedules.
 */
export async function cancelZoeSchedule(scheduleId: string): Promise<ConfirmZoeActionResult> {
  const { supabase } = await import('@/integrations/supabase/client');
  const { data, error } = await supabase.rpc('staff_assistant_cancel_schedule' as never, {
    p_schedule_id: scheduleId,
  } as never);

  if (error) {
    return { ok: false, error: error.message || 'Could not cancel schedule right now.' };
  }
  return { ok: true, data: (data ?? {}) as Record<string, unknown> };
}

/**
 * Fetches the caller's 07:30 Kampala Morning Brief from `staff-assistant` (`action: 'morning_brief'`).
 */
export async function fetchZoeMorningBrief(
  force = false,
): Promise<ZoeMorningBriefPayload | null> {
  const { supabase } = await import('@/integrations/supabase/client');
  const { data, error } = await supabase.functions.invoke<{
    morning_brief?: ZoeMorningBriefPayload;
  }>('staff-assistant', {
    body: { action: 'morning_brief', force },
  });

  if (error || !data?.morning_brief) {
    return null;
  }
  return data.morning_brief;
}

/**
 * Updates the caller's Morning Brief preference (`enabled` off by default, turned on per person).
 */
export async function updateZoeMorningBriefPrefs(input: {
  enabled: boolean;
  brief_time?: string;
  dismiss_today?: boolean;
}): Promise<ConfirmZoeActionResult> {
  const { supabase } = await import('@/integrations/supabase/client');
  const { data, error } = await supabase.rpc('staff_assistant_set_morning_brief_prefs' as never, {
    p_enabled: input.enabled,
    p_brief_time: input.brief_time ?? '07:30',
    p_dismiss_today: input.dismiss_today === true,
  } as never);

  if (error) {
    return { ok: false, error: error.message || 'Could not update Morning Brief preference.' };
  }
  return { ok: true, data: (data ?? {}) as Record<string, unknown> };
}

export interface ConfirmZoeIdeaInput {
  draft_id?: string | null;
  rebind_draft?: boolean;
  title: string;
  suggestion: string;
  evidence_summary: string;
  figures?: Record<string, unknown>;
  source_label: string;
  period_label?: string | null;
  category?: ZoeIdeaCategory;
  screen_path?: string | null;
  conversation_id?: string | null;
  message_id?: string | null;
}

/**
 * Click-confirmed action: saves an evidence-based improvement idea to `staff_assistant_ideas`.
 * Zoe never turns an idea into an action, changes any setting or business record, or contacts anyone.
 */
export async function confirmZoeIdeaDraft(
  input: ConfirmZoeIdeaInput,
): Promise<ConfirmZoeActionResult> {
  const { supabase } = await import('@/integrations/supabase/client');
  const sanitizedTitle = sanitizeWelileTerms(input.title.trim());
  const sanitizedSuggestion = sanitizeWelileTerms(input.suggestion.trim());
  const sanitizedEvidence = sanitizeWelileTerms(input.evidence_summary.trim());
  const sourceLabel = input.source_label.trim() || 'Official report';
  const periodLabel = (input.period_label ?? '').trim();
  const category: ZoeIdeaCategory = input.category ?? 'general';
  const screenPath =
    input.screen_path && input.screen_path.trim().startsWith('/')
      ? input.screen_path.trim()
      : '/me';

  let draftId = input.draft_id ?? null;
  if ((input.rebind_draft || !draftId) && typeof supabase.rpc === 'function') {
    const { data: savedDraft, error: draftErr } = await supabase.rpc(
      'staff_assistant_save_draft' as never,
      {
        p_kind: 'idea',
        p_payload: {
          kind: 'idea',
          title: sanitizedTitle,
          suggestion: sanitizedSuggestion,
          evidence_summary: sanitizedEvidence,
          source_label: sourceLabel,
          period_label: periodLabel,
          category,
          screen_path: screenPath,
        },
        p_conversation_id: input.conversation_id ?? null,
      } as never,
    );
    if (draftErr) {
      return { ok: false, error: draftErr.message || 'Could not prepare idea draft.' };
    }
    const row = (savedDraft ?? {}) as Record<string, unknown>;
    if (typeof row.draft_id === 'string' && row.draft_id) {
      draftId = row.draft_id;
    }
  }

  const { data, error } = await supabase.rpc('staff_assistant_save_idea' as never, {
    p_title: sanitizedTitle,
    p_suggestion: sanitizedSuggestion,
    p_evidence_summary: sanitizedEvidence,
    p_figures: input.figures ?? {},
    p_source_label: sourceLabel,
    p_period_label: periodLabel || null,
    p_category: category,
    p_screen_path: screenPath,
    p_conversation_id: input.conversation_id ?? null,
    p_message_id: input.message_id ?? null,
    p_draft_id: draftId,
  } as never);

  if (error) {
    return { ok: false, error: error.message || 'Could not save idea right now.' };
  }
  return { ok: true, data: (data ?? {}) as Record<string, unknown> };
}

export interface ZoeIdeaRecord {
  id: string;
  created_by: string;
  created_by_name: string;
  created_by_roles: string[];
  title: string;
  suggestion: string;
  evidence_summary: string;
  figures: Record<string, unknown>;
  source_label: string;
  period_label: string | null;
  category: ZoeIdeaCategory;
  screen_path: string | null;
  status: ZoeIdeaStatus;
  status_updated_by: string | null;
  status_updated_by_name: string | null;
  status_updated_at: string | null;
  status_note: string | null;
  created_at: string;
}

export interface ZoeIdeasCounts {
  total: number;
  new: number;
  being_looked_at: number;
  done: number;
  not_now: number;
}

export interface ZoeIdeasListResponse {
  can_manage_ideas: boolean;
  counts: ZoeIdeasCounts;
  ideas: ZoeIdeaRecord[];
}

const IDEA_MANAGER_ROLES = new Set([
  'manager',
  'coo',
  'ceo',
  'cfo',
  'cto',
  'super_admin',
  'operations',
]);

export function canManageZoeIdeas(roles: readonly string[] = []): boolean {
  return roles.some((r) => IDEA_MANAGER_ROLES.has(String(r).toLowerCase().trim()));
}

/**
 * Fetches saved "Ideas for Welile" (`staff_assistant_list_ideas`).
 */
export async function fetchZoeIdeas(
  status: ZoeIdeaStatus | 'all' | null = null,
  limit = 100,
): Promise<ZoeIdeasListResponse> {
  const { supabase } = await import('@/integrations/supabase/client');
  const filterStatus = status && status !== 'all' ? status : null;
  const { data, error } = await supabase.rpc('staff_assistant_list_ideas' as never, {
    p_status: filterStatus,
    p_limit: limit,
  } as never);

  if (error || !data || typeof data !== 'object') {
    return {
      can_manage_ideas: false,
      counts: { total: 0, new: 0, being_looked_at: 0, done: 0, not_now: 0 },
      ideas: [],
    };
  }

  const raw = data as Record<string, unknown>;
  const rawCounts =
    raw.counts && typeof raw.counts === 'object' && !Array.isArray(raw.counts)
      ? (raw.counts as Record<string, unknown>)
      : {};
  const rawIdeas = Array.isArray(raw.ideas) ? raw.ideas : [];

  const ideas: ZoeIdeaRecord[] = rawIdeas
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === 'object' && !Array.isArray(item),
    )
    .map((item) => ({
      id: String(item.id ?? ''),
      created_by: String(item.created_by ?? ''),
      created_by_name: String(item.created_by_name ?? 'Welile Staff'),
      created_by_roles: Array.isArray(item.created_by_roles)
        ? item.created_by_roles.map((r) => String(r))
        : [],
      title: sanitizeWelileTerms(String(item.title ?? '')),
      suggestion: sanitizeWelileTerms(String(item.suggestion ?? '')),
      evidence_summary: sanitizeWelileTerms(String(item.evidence_summary ?? '')),
      figures:
        item.figures && typeof item.figures === 'object' && !Array.isArray(item.figures)
          ? (item.figures as Record<string, unknown>)
          : {},
      source_label: String(item.source_label ?? 'Official report'),
      period_label: typeof item.period_label === 'string' ? item.period_label : null,
      category: (typeof item.category === 'string' ? item.category : 'general') as ZoeIdeaCategory,
      screen_path: typeof item.screen_path === 'string' ? item.screen_path : '/me',
      status: (typeof item.status === 'string' ? item.status : 'new') as ZoeIdeaStatus,
      status_updated_by:
        typeof item.status_updated_by === 'string' ? item.status_updated_by : null,
      status_updated_by_name:
        typeof item.status_updated_by_name === 'string' ? item.status_updated_by_name : null,
      status_updated_at:
        typeof item.status_updated_at === 'string' ? item.status_updated_at : null,
      status_note: typeof item.status_note === 'string' ? item.status_note : null,
      created_at: String(item.created_at ?? ''),
    }))
    .filter((item) => Boolean(item.id));

  return {
    can_manage_ideas: raw.can_manage_ideas === true,
    counts: {
      total: Number(rawCounts.total ?? ideas.length),
      new: Number(rawCounts.new ?? 0),
      being_looked_at: Number(rawCounts.being_looked_at ?? 0),
      done: Number(rawCounts.done ?? 0),
      not_now: Number(rawCounts.not_now ?? 0),
    },
    ideas,
  };
}

/**
 * Updates an idea's status (`new`, `being_looked_at`, `done`, `not_now`).
 * Ordinary screen action for managers/COO/CEO only — never called by Zoe.
 */
export async function updateZoeIdeaStatus(input: {
  idea_id: string;
  status: ZoeIdeaStatus;
  status_note?: string | null;
}): Promise<ConfirmZoeActionResult> {
  const { supabase } = await import('@/integrations/supabase/client');
  const { data, error } = await supabase.rpc('staff_assistant_update_idea_status' as never, {
    p_idea_id: input.idea_id,
    p_status: input.status,
    p_status_note: input.status_note ?? null,
  } as never);

  if (error) {
    return { ok: false, error: error.message || 'Could not update idea status.' };
  }
  return { ok: true, data: (data ?? {}) as Record<string, unknown> };
}

export interface ZoeWeeklyLookAtIssue {
  rank: number;
  category: string;
  title: string;
  evidence: string;
  metric_label: string;
  source: string;
  screen_path: string;
  screen_label: string;
}

export interface ZoeWeeklyUnansweredItem {
  question: string;
  role: string;
  outcome: string;
  ask_count: number;
}

export interface ZoeWeeklyFeedbackSummary {
  thumbs_up_count: number;
  thumbs_down_count: number;
  problem_reports_count: number;
}

export interface ZoeWeeklyAnomalyNote {
  category: string;
  title: string;
  summary: string;
  pct_change: number;
  direction: string;
  source_function: string;
  period_label: string;
  screen_path: string;
}

export interface ZoeWeeklyLookAtSummary {
  source: string;
  week_start: string;
  as_of: string;
  is_monday: boolean;
  in_app_only: boolean;
  new_ideas_count: number;
  issues: ZoeWeeklyLookAtIssue[];
  unanswered_questions?: ZoeWeeklyUnansweredItem[];
  feedback_summary?: ZoeWeeklyFeedbackSummary;
  anomaly_notes?: ZoeWeeklyAnomalyNote[];
}

/**
 * Fetches the Monday "What to look at this week" summary for managers, the COO, and the CEO.
 * In-app only (`in_app_only: true`); never sent outside the app.
 */
export async function fetchZoeWeeklyLookAtSummary(
  asOf: string | null = null,
): Promise<ZoeWeeklyLookAtSummary | null> {
  const { supabase } = await import('@/integrations/supabase/client');
  const { data, error } = await supabase.rpc('staff_assistant_weekly_look_at_summary' as never, {
    p_as_of: asOf,
  } as never);

  if (error || !data || typeof data !== 'object') {
    return null;
  }

  const raw = data as Record<string, unknown>;
  const rawIssues = Array.isArray(raw.issues) ? raw.issues : [];
  const issues: ZoeWeeklyLookAtIssue[] = rawIssues
    .filter(
      (it): it is Record<string, unknown> =>
        Boolean(it) && typeof it === 'object' && !Array.isArray(it),
    )
    .map((it, idx) => ({
      rank: Number(it.rank ?? idx + 1),
      category: String(it.category ?? 'general'),
      title: sanitizeWelileTerms(String(it.title ?? 'Operational priority')),
      evidence: sanitizeWelileTerms(String(it.evidence ?? '')),
      metric_label: sanitizeWelileTerms(String(it.metric_label ?? '')),
      source: String(it.source ?? 'Official report'),
      screen_path:
        typeof it.screen_path === 'string' && it.screen_path.startsWith('/')
          ? it.screen_path
          : '/me',
      screen_label: String(it.screen_label ?? 'Open screen'),
    }));

  const rawUnanswered = Array.isArray(raw.unanswered_questions) ? raw.unanswered_questions : [];
  const unansweredQuestions: ZoeWeeklyUnansweredItem[] = rawUnanswered
    .filter(
      (u): u is Record<string, unknown> =>
        Boolean(u) && typeof u === 'object' && !Array.isArray(u),
    )
    .map((u) => ({
      question: sanitizeWelileTerms(String(u.question ?? '')),
      role: String(u.role ?? 'staff'),
      outcome: String(u.outcome ?? 'unmatched'),
      ask_count: Number(u.ask_count ?? 1),
    }))
    .filter((u) => Boolean(u.question));

  const rawFb =
    raw.feedback_summary && typeof raw.feedback_summary === 'object' && !Array.isArray(raw.feedback_summary)
      ? (raw.feedback_summary as Record<string, unknown>)
      : {};
  const feedbackSummary: ZoeWeeklyFeedbackSummary = {
    thumbs_up_count: Number(rawFb.thumbs_up_count ?? 0),
    thumbs_down_count: Number(rawFb.thumbs_down_count ?? 0),
    problem_reports_count: Number(rawFb.problem_reports_count ?? 0),
  };

  const rawAnomalies = Array.isArray(raw.anomaly_notes) ? raw.anomaly_notes : [];
  const anomalyNotes: ZoeWeeklyAnomalyNote[] = rawAnomalies
    .filter(
      (a): a is Record<string, unknown> =>
        Boolean(a) && typeof a === 'object' && !Array.isArray(a),
    )
    .map((a) => ({
      category: String(a.category ?? 'general'),
      title: sanitizeWelileTerms(String(a.title ?? '')),
      summary: sanitizeWelileTerms(String(a.summary ?? '')),
      pct_change: Number(a.pct_change ?? 0),
      direction: String(a.direction ?? 'flat'),
      source_function: String(a.source_function ?? 'Official report'),
      period_label: String(a.period_label ?? ''),
      screen_path:
        typeof a.screen_path === 'string' && a.screen_path.startsWith('/')
          ? a.screen_path
          : '/me',
    }))
    .filter((a) => Boolean(a.title));

  return {
    source: String(raw.source ?? 'staff_assistant_weekly_look_at_summary'),
    week_start: String(raw.week_start ?? ''),
    as_of: String(raw.as_of ?? ''),
    is_monday: raw.is_monday === true,
    in_app_only: true,
    new_ideas_count: Number(raw.new_ideas_count ?? 0),
    issues: issues.slice(0, 5),
    unanswered_questions: unansweredQuestions,
    feedback_summary: feedbackSummary,
    anomaly_notes: anomalyNotes,
  };
}
