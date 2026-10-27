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

export type ZoeActionDraft =
  | ZoeReminderDraft
  | ZoeStaffNotificationDraft
  | ZoeReportScheduleDraft;

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
  tool: string;
  rpc: string;
  title: string;
  source: string;
  period: string;
  summary: string;
  row_count: number;
}

export interface ZoeMorningBriefPayload {
  available: boolean;
  enabled: boolean;
  should_display_now: boolean;
  kampala_date: string;
  scheduled_time_kampala: string;
  headline: string;
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
