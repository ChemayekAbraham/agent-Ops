import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  Bell,
  CalendarClock,
  CheckCircle2,
  Clock,
  ExternalLink,
  Lightbulb,
  Loader2,
  Pencil,
  Send,
  UserCheck,
  X,
} from 'lucide-react';
import {
  confirmZoeIdeaDraft,
  confirmZoeNotificationDraft,
  confirmZoeReminderDraft,
  confirmZoeScheduleDraft,
  type ConfirmZoeActionResult,
  type ConfirmZoeIdeaInput,
  type ConfirmZoeNotificationInput,
  type ConfirmZoeReminderInput,
  type ConfirmZoeScheduleInput,
  type ZoeActionDraft,
  type ZoeStaffRecipientCandidate,
} from '@/lib/zoe';

export interface ZoeActionDraftCardProps {
  draft: ZoeActionDraft;
  conversationId?: string | null;
  messageId?: string | null;
  onConfirmReminder?: (input: ConfirmZoeReminderInput) => Promise<ConfirmZoeActionResult>;
  onConfirmNotification?: (input: ConfirmZoeNotificationInput) => Promise<ConfirmZoeActionResult>;
  onConfirmSchedule?: (input: ConfirmZoeScheduleInput) => Promise<ConfirmZoeActionResult>;
  onConfirmIdea?: (input: ConfirmZoeIdeaInput) => Promise<ConfirmZoeActionResult>;
}

const DAY_NAMES: Record<number, string> = {
  0: 'Sunday',
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
};

/**
 * Interactive "draft card, then click" card for Zoe action tools:
 *   1. Personal reminder (`draft_reminder` -> `staff_assistant_create_reminder`)
 *   2. In-app notification to a staff colleague (`draft_staff_notification` -> `staff_assistant_send_colleague_notification`)
 *   3. Recurring report email schedule to Welile staff (`draft_report_schedule` -> `staff_assistant_create_schedule`)
 *
 * Never executes automatically; only clicking the primary action button runs the RPC.
 */
export const ZoeActionDraftCard: React.FC<ZoeActionDraftCardProps> = ({
  draft,
  conversationId = null,
  messageId = null,
  onConfirmReminder = confirmZoeReminderDraft,
  onConfirmNotification = confirmZoeNotificationDraft,
  onConfirmSchedule = confirmZoeScheduleDraft,
  onConfirmIdea = confirmZoeIdeaDraft,
}) => {
  // Shared states
  const [isEditing, setIsEditing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCancelled, setIsCancelled] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Idea states
  const [ideaTitle, setIdeaTitle] = useState(
    draft.action_type === 'idea' ? draft.title : '',
  );
  const [ideaSuggestion, setIdeaSuggestion] = useState(
    draft.action_type === 'idea' ? draft.suggestion : '',
  );
  const [ideaEvidence, setIdeaEvidence] = useState(
    draft.action_type === 'idea' ? draft.evidence_summary : '',
  );

  // Reminder states
  const [reminderTitle, setReminderTitle] = useState(
    draft.action_type === 'reminder' ? draft.title : '',
  );
  const [remindAt, setRemindAt] = useState(
    draft.action_type === 'reminder' ? draft.remind_at : '',
  );
  const [reminderNote, setReminderNote] = useState(
    draft.action_type === 'reminder' ? (draft.note ?? '') : '',
  );

  // Notification states
  const initialNotifRecipient: ZoeStaffRecipientCandidate | null =
    draft.action_type === 'notification' && draft.recipient_email
      ? {
          staff_user_id: draft.recipient_user_id ?? '',
          full_name: draft.recipient_name ?? draft.recipient_email,
          email: draft.recipient_email,
          roles: draft.recipient_roles,
        }
      : null;
  const [selectedNotifRecipient, setSelectedNotifRecipient] =
    useState<ZoeStaffRecipientCandidate | null>(initialNotifRecipient);
  const [notifTitle, setNotifTitle] = useState(
    draft.action_type === 'notification' ? draft.title : '',
  );
  const [notifMessage, setNotifMessage] = useState(
    draft.action_type === 'notification' ? draft.message : '',
  );

  // Schedule states
  const [scheduleTitle, setScheduleTitle] = useState(
    draft.action_type === 'schedule' ? draft.title : '',
  );
  const [scheduleFrequency, setScheduleFrequency] = useState<'daily' | 'weekly'>(
    draft.action_type === 'schedule' ? draft.frequency : 'daily',
  );
  const [scheduleDayOfWeek, setScheduleDayOfWeek] = useState<number>(
    draft.action_type === 'schedule' && typeof draft.day_of_week === 'number'
      ? draft.day_of_week
      : 1,
  );
  const [scheduleSendTime, setScheduleSendTime] = useState(
    draft.action_type === 'schedule' ? draft.send_time_kampala : '07:30',
  );
  const [scheduleMessage, setScheduleMessage] = useState(
    draft.action_type === 'schedule' ? draft.custom_message : '',
  );
  const [selectedScheduleEmails, setSelectedScheduleEmails] = useState<string[]>(
    draft.action_type === 'schedule' ? draft.recipient_emails : [],
  );

  if (isCancelled) {
    return (
      <div
        data-testid={`zoe-action-draft-cancelled-${draft.action_type}`}
        className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground"
      >
        <span>Draft cancelled. Nothing was saved or sent.</span>
        <button
          type="button"
          onClick={() => setIsCancelled(false)}
          className="inline-flex min-h-[44px] items-center rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
        >
          Restore draft
        </button>
      </div>
    );
  }

  if (confirmed) {
    return (
      <div
        data-testid={`zoe-action-draft-confirmed-${draft.action_type}`}
        className="mt-3 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs text-foreground"
      >
        <div className="flex items-center gap-2 font-semibold text-primary">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            {draft.action_type === 'reminder' && 'Reminder saved for your My Space'}
            {draft.action_type === 'notification' && 'In-app notification sent to staff colleague'}
            {draft.action_type === 'schedule' && 'Scheduled report email saved'}
            {draft.action_type === 'idea' && 'Idea saved to Ideas for Welile'}
          </span>
        </div>
        <p className="mt-1 leading-relaxed text-muted-foreground">
          {draft.action_type === 'reminder' && (
            <>
              Saved <span className="font-semibold text-foreground">{reminderTitle}</span> for{' '}
              <span className="font-mono">{remindAt}</span>.
            </>
          )}
          {draft.action_type === 'notification' && (
            <>
              Sent <span className="font-semibold text-foreground">{notifTitle}</span> to{' '}
              <span className="font-semibold text-foreground">
                {selectedNotifRecipient?.full_name} ({selectedNotifRecipient?.email})
              </span>
              .
            </>
          )}
          {draft.action_type === 'schedule' && (
            <>
              Scheduled <span className="font-semibold text-foreground">{scheduleTitle}</span> (
              {scheduleFrequency === 'weekly'
                ? `Weekly on ${DAY_NAMES[scheduleDayOfWeek] ?? 'Monday'}`
                : 'Daily'}{' '}
              at {scheduleSendTime} Kampala) to{' '}
              <span className="font-semibold text-foreground">
                {selectedScheduleEmails.join(', ')}
              </span>
              .
            </>
          )}
          {draft.action_type === 'idea' && (
            <>
              Saved <span className="font-semibold text-foreground">{ideaTitle}</span> with evidence
              from <span className="font-mono">{draft.source_label}</span>. Visible to managers, the
              COO, and the CEO in Ideas for Welile. Zoe changes no settings or business records.
            </>
          )}
        </p>
        {draft.action_type === 'idea' && (
          <div className="mt-2">
            <Link
              to="/me/ideas"
              data-testid="zoe-idea-confirmed-link"
              className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold text-primary hover:bg-muted"
            >
              <span>Open Ideas for Welile</span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            </Link>
          </div>
        )}
      </div>
    );
  }

  const handleConfirm = async () => {
    if (isSubmitting) return;
    setActionError(null);

    if (draft.action_type === 'reminder') {
      if (!reminderTitle.trim()) {
        setActionError('Please enter a reminder title.');
        return;
      }
      setIsSubmitting(true);
      try {
        const wasModified =
          reminderTitle.trim() !== draft.title.trim() ||
          remindAt.trim() !== draft.remind_at.trim() ||
          (reminderNote || '').trim() !== (draft.note ?? '').trim();

        const res = await onConfirmReminder({
          draft_id: draft.draft_id,
          rebind_draft: wasModified,
          title: reminderTitle,
          remind_at: remindAt,
          note: reminderNote || null,
          conversation_id: conversationId,
        });
        if (!res.ok) {
          setActionError(res.error || 'Could not save reminder.');
        } else {
          setConfirmed(true);
          setIsEditing(false);
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Could not save reminder.');
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (draft.action_type === 'notification') {
      if (!selectedNotifRecipient?.email) {
        setActionError('Please select a verified Welile staff colleague first.');
        return;
      }
      if (!notifTitle.trim() || !notifMessage.trim()) {
        setActionError('Please provide both a title and a message.');
        return;
      }
      setIsSubmitting(true);
      try {
        const wasModified =
          selectedNotifRecipient.email.toLowerCase() !==
            (draft.recipient_email ?? '').toLowerCase() ||
          notifTitle.trim() !== draft.title.trim() ||
          notifMessage.trim() !== draft.message.trim();

        const res = await onConfirmNotification({
          draft_id: draft.draft_id,
          rebind_draft: wasModified,
          recipient_email: selectedNotifRecipient.email,
          title: notifTitle,
          message: notifMessage,
          conversation_id: conversationId,
        });
        if (!res.ok) {
          setActionError(res.error || 'Could not send colleague notification.');
        } else {
          setConfirmed(true);
          setIsEditing(false);
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Could not send colleague notification.');
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (draft.action_type === 'schedule') {
      if (selectedScheduleEmails.length === 0) {
        setActionError('Please select at least one verified Welile staff recipient.');
        return;
      }
      setIsSubmitting(true);
      try {
        const initialEmailsSorted = [...draft.recipient_emails]
          .map((e) => e.toLowerCase())
          .sort()
          .join(',');
        const currentEmailsSorted = [...selectedScheduleEmails]
          .map((e) => e.toLowerCase())
          .sort()
          .join(',');
        const wasModified =
          scheduleTitle.trim() !== draft.title.trim() ||
          scheduleFrequency !== draft.frequency ||
          (scheduleFrequency === 'weekly' && scheduleDayOfWeek !== (draft.day_of_week ?? 1)) ||
          scheduleSendTime.trim() !== draft.send_time_kampala.trim() ||
          (scheduleMessage || '').trim() !== draft.custom_message.trim() ||
          initialEmailsSorted !== currentEmailsSorted;

        const res = await onConfirmSchedule({
          draft_id: draft.draft_id,
          rebind_draft: wasModified,
          title: scheduleTitle,
          report_tool: draft.report_tool,
          report_rpc: draft.report_rpc,
          report_args: draft.report_args,
          frequency: scheduleFrequency,
          recipient_emails: selectedScheduleEmails,
          day_of_week: scheduleFrequency === 'weekly' ? scheduleDayOfWeek : null,
          send_time_kampala: scheduleSendTime,
          custom_message: scheduleMessage || null,
          conversation_id: conversationId,
        });
        if (!res.ok) {
          setActionError(res.error || 'Could not save report schedule.');
        } else {
          setConfirmed(true);
          setIsEditing(false);
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Could not save report schedule.');
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (draft.action_type === 'idea') {
      if (!ideaTitle.trim() || !ideaSuggestion.trim() || !ideaEvidence.trim()) {
        setActionError('Please keep a title, suggestion, and evidence summary.');
        return;
      }
      setIsSubmitting(true);
      try {
        const wasModified =
          ideaTitle.trim() !== draft.title.trim() ||
          ideaSuggestion.trim() !== draft.suggestion.trim() ||
          ideaEvidence.trim() !== draft.evidence_summary.trim();

        const res = await onConfirmIdea({
          draft_id: draft.draft_id,
          rebind_draft: wasModified,
          title: ideaTitle,
          suggestion: ideaSuggestion,
          evidence_summary: ideaEvidence,
          figures: draft.figures,
          source_label: draft.source_label,
          period_label: draft.period_label,
          category: draft.category,
          screen_path: draft.screen_path,
          conversation_id: conversationId,
          message_id: messageId,
        });
        if (!res.ok) {
          setActionError(res.error || 'Could not save idea.');
        } else {
          setConfirmed(true);
          setIsEditing(false);
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Could not save idea.');
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  const toggleScheduleRecipient = (email: string) => {
    setSelectedScheduleEmails((prev) =>
      prev.includes(email) ? prev.filter((e) => e !== email) : [...prev, email],
    );
    setActionError(null);
  };

  return (
    <div
      data-testid={`zoe-action-draft-card-${draft.action_type}`}
      className="mt-3 rounded-lg border border-primary/30 bg-card p-3.5 text-card-foreground shadow-sm"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border pb-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            {draft.action_type === 'reminder' && <Clock className="h-4 w-4" aria-hidden="true" />}
            {draft.action_type === 'notification' && <Bell className="h-4 w-4" aria-hidden="true" />}
            {draft.action_type === 'schedule' && (
              <CalendarClock className="h-4 w-4" aria-hidden="true" />
            )}
            {draft.action_type === 'idea' && <Lightbulb className="h-4 w-4" aria-hidden="true" />}
          </span>
          <div>
            <h4 className="text-xs font-semibold text-foreground sm:text-sm">
              {draft.action_type === 'reminder' &&
                'Personal Reminder Draft · Never saved until you click Save Reminder'}
              {draft.action_type === 'notification' &&
                'Staff Notification Draft · Never sent until you click Send Notification'}
              {draft.action_type === 'schedule' &&
                'Scheduled Report Draft · Never scheduled until you click Save Schedule'}
              {draft.action_type === 'idea' &&
                'Idea for Welile Draft · Never saved until you click Save Idea'}
            </h4>
            <p className="text-xs text-muted-foreground">
              {draft.action_type === 'reminder' && 'Delivers to your My Space notifications when due'}
              {draft.action_type === 'notification' && 'In-app notification to verified Welile staff only'}
              {draft.action_type === 'schedule' &&
                `Source: ${draft.source} · Verified Welile staff recipients only`}
              {draft.action_type === 'idea' &&
                'Visible to managers, COO, and CEO · Zoe never changes business data or settings'}
            </p>
          </div>
        </div>
      </div>

      {/* REMINDER DRAFT BODY */}
      {draft.action_type === 'reminder' && (
        <dl className="mt-3 space-y-2 text-xs">
          <div className="rounded-md border border-border/80 bg-muted/30 px-3 py-2">
            <dt className="font-medium text-muted-foreground">Reminder Title</dt>
            {isEditing ? (
              <input
                type="text"
                value={reminderTitle}
                onChange={(e) => setReminderTitle(e.target.value)}
                data-testid="zoe-reminder-title-input"
                maxLength={160}
                className="mt-1 min-h-[44px] w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground"
              />
            ) : (
              <dd data-testid="zoe-reminder-title" className="mt-0.5 font-semibold text-foreground">
                {reminderTitle}
              </dd>
            )}
          </div>

          <div className="rounded-md border border-border/80 bg-muted/30 px-3 py-2">
            <dt className="font-medium text-muted-foreground">Remind At (Kampala Time)</dt>
            {isEditing ? (
              <input
                type="text"
                value={remindAt}
                onChange={(e) => setRemindAt(e.target.value)}
                data-testid="zoe-reminder-time-input"
                className="mt-1 min-h-[44px] w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground"
              />
            ) : (
              <dd data-testid="zoe-reminder-time" className="mt-0.5 font-semibold text-foreground">
                {draft.remind_at_kampala_label || remindAt}
              </dd>
            )}
          </div>

          {(reminderNote || isEditing) && (
            <div className="rounded-md border border-border/80 bg-muted/30 px-3 py-2">
              <dt className="font-medium text-muted-foreground">Note</dt>
              {isEditing ? (
                <textarea
                  value={reminderNote}
                  onChange={(e) => setReminderNote(e.target.value)}
                  data-testid="zoe-reminder-note-input"
                  rows={2}
                  maxLength={500}
                  className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground"
                />
              ) : (
                <dd data-testid="zoe-reminder-note" className="mt-0.5 text-foreground">
                  {reminderNote}
                </dd>
              )}
            </div>
          )}
        </dl>
      )}

      {/* COLLEAGUE NOTIFICATION DRAFT BODY */}
      {draft.action_type === 'notification' && (
        <>
          {((!selectedNotifRecipient && draft.candidates.length > 0) ||
            draft.candidates.length > 1) && (
            <div
              data-testid="zoe-notification-recipient-picker"
              className="mt-3 rounded-md border border-primary/25 bg-primary/5 p-2.5"
            >
              <p className="text-xs font-semibold text-foreground">
                {selectedNotifRecipient
                  ? 'Matched staff colleagues (tap to switch):'
                  : 'Several active staff colleagues matched. Please pick the recipient:'}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {draft.candidates.map((cand) => {
                  const isSelected =
                    selectedNotifRecipient?.email.toLowerCase() === cand.email.toLowerCase();
                  return (
                    <button
                      key={cand.staff_user_id || cand.email}
                      type="button"
                      data-testid={`zoe-notif-candidate-${cand.email}`}
                      onClick={() => {
                        setSelectedNotifRecipient(cand);
                        setActionError(null);
                      }}
                      className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-left text-xs font-medium transition-colors ${
                        isSelected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-background text-foreground hover:bg-muted'
                      }`}
                    >
                      <UserCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>
                        {cand.full_name} ({cand.email})
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <dl className="mt-3 space-y-2 text-xs">
            <div className="rounded-md border border-border/80 bg-muted/30 px-3 py-2">
              <dt className="font-medium text-muted-foreground">To (Verified Welile Staff)</dt>
              <dd data-testid="zoe-notif-to" className="mt-0.5 font-semibold text-foreground">
                {selectedNotifRecipient
                  ? `${selectedNotifRecipient.full_name} <${selectedNotifRecipient.email}>`
                  : 'Select a staff colleague above'}
              </dd>
            </div>

            <div className="rounded-md border border-border/80 bg-muted/30 px-3 py-2">
              <dt className="font-medium text-muted-foreground">Title</dt>
              {isEditing ? (
                <input
                  type="text"
                  value={notifTitle}
                  onChange={(e) => setNotifTitle(e.target.value)}
                  data-testid="zoe-notif-title-input"
                  maxLength={160}
                  className="mt-1 min-h-[44px] w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground"
                />
              ) : (
                <dd data-testid="zoe-notif-title" className="mt-0.5 font-semibold text-foreground">
                  {notifTitle}
                </dd>
              )}
            </div>

            <div className="rounded-md border border-border/80 bg-muted/30 px-3 py-2">
              <dt className="font-medium text-muted-foreground">Message</dt>
              {isEditing ? (
                <textarea
                  value={notifMessage}
                  onChange={(e) => setNotifMessage(e.target.value)}
                  data-testid="zoe-notif-message-input"
                  rows={3}
                  maxLength={800}
                  className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground"
                />
              ) : (
                <dd
                  data-testid="zoe-notif-message"
                  className="mt-0.5 whitespace-pre-wrap leading-relaxed text-foreground"
                >
                  {notifMessage}
                </dd>
              )}
            </div>
          </dl>
        </>
      )}

      {/* REPORT SCHEDULE DRAFT BODY */}
      {draft.action_type === 'schedule' && (
        <>
          {draft.candidates.length > 0 && (
            <div
              data-testid="zoe-schedule-recipient-picker"
              className="mt-3 rounded-md border border-primary/25 bg-primary/5 p-2.5"
            >
              <p className="text-xs font-semibold text-foreground">
                Verified Welile staff recipients (tap to toggle):
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {draft.candidates.map((cand) => {
                  const isSelected = selectedScheduleEmails.includes(cand.email);
                  return (
                    <button
                      key={cand.staff_user_id || cand.email}
                      type="button"
                      data-testid={`zoe-schedule-candidate-${cand.email}`}
                      onClick={() => toggleScheduleRecipient(cand.email)}
                      className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-left text-xs font-medium transition-colors ${
                        isSelected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-background text-foreground hover:bg-muted'
                      }`}
                    >
                      <UserCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>
                        {cand.full_name} ({cand.email})
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <dl className="mt-3 space-y-2 text-xs">
            <div className="rounded-md border border-border/80 bg-muted/30 px-3 py-2">
              <dt className="font-medium text-muted-foreground">Schedule Title & Report</dt>
              {isEditing ? (
                <input
                  type="text"
                  value={scheduleTitle}
                  onChange={(e) => setScheduleTitle(e.target.value)}
                  data-testid="zoe-schedule-title-input"
                  maxLength={160}
                  className="mt-1 min-h-[44px] w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground"
                />
              ) : (
                <dd data-testid="zoe-schedule-title" className="mt-0.5 font-semibold text-foreground">
                  {scheduleTitle} ({draft.report_rpc})
                </dd>
              )}
            </div>

            <div className="rounded-md border border-border/80 bg-muted/30 px-3 py-2">
              <dt className="font-medium text-muted-foreground">Cadence (Kampala Time)</dt>
              {isEditing ? (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <select
                    value={scheduleFrequency}
                    onChange={(e) =>
                      setScheduleFrequency(e.target.value === 'weekly' ? 'weekly' : 'daily')
                    }
                    data-testid="zoe-schedule-frequency-select"
                    className="min-h-[44px] rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground"
                  >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                  </select>
                  {scheduleFrequency === 'weekly' && (
                    <select
                      value={scheduleDayOfWeek}
                      onChange={(e) => setScheduleDayOfWeek(Number(e.target.value))}
                      data-testid="zoe-schedule-day-select"
                      className="min-h-[44px] rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground"
                    >
                      {Object.entries(DAY_NAMES).map(([num, label]) => (
                        <option key={num} value={num}>
                          {label}
                        </option>
                      ))}
                    </select>
                  )}
                  <input
                    type="text"
                    value={scheduleSendTime}
                    onChange={(e) => setScheduleSendTime(e.target.value)}
                    data-testid="zoe-schedule-time-input"
                    className="min-h-[44px] w-24 rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground"
                  />
                </div>
              ) : (
                <dd
                  data-testid="zoe-schedule-cadence"
                  className="mt-0.5 font-semibold text-foreground"
                >
                  {scheduleFrequency === 'weekly'
                    ? `Weekly on ${DAY_NAMES[scheduleDayOfWeek] ?? 'Monday'} at ${scheduleSendTime} EAT`
                    : `Daily at ${scheduleSendTime} EAT`}
                </dd>
              )}
            </div>

            <div className="rounded-md border border-border/80 bg-muted/30 px-3 py-2">
              <dt className="font-medium text-muted-foreground">Recipients (Verified Staff Only)</dt>
              <dd data-testid="zoe-schedule-recipients" className="mt-0.5 font-semibold text-foreground">
                {selectedScheduleEmails.length > 0
                  ? selectedScheduleEmails.join(', ')
                  : 'Select at least one staff recipient above'}
              </dd>
            </div>
          </dl>
        </>
      )}

      {/* IDEA FOR WELILE DRAFT BODY */}
      {draft.action_type === 'idea' && (
        <dl className="mt-3 space-y-2 text-xs">
          <div className="rounded-md border border-border/80 bg-muted/30 px-3 py-2">
            <dt className="font-medium text-muted-foreground">Idea Title</dt>
            {isEditing ? (
              <input
                type="text"
                value={ideaTitle}
                onChange={(e) => setIdeaTitle(e.target.value)}
                data-testid="zoe-idea-title-input"
                maxLength={200}
                className="mt-1 min-h-[44px] w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground"
              />
            ) : (
              <dd data-testid="zoe-idea-title" className="mt-0.5 font-semibold text-foreground">
                {ideaTitle}
              </dd>
            )}
          </div>

          <div className="rounded-md border border-border/80 bg-muted/30 px-3 py-2">
            <dt className="font-medium text-muted-foreground">Suggested Improvement</dt>
            {isEditing ? (
              <textarea
                value={ideaSuggestion}
                onChange={(e) => setIdeaSuggestion(e.target.value)}
                data-testid="zoe-idea-suggestion-input"
                rows={3}
                maxLength={2000}
                className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground"
              />
            ) : (
              <dd
                data-testid="zoe-idea-suggestion"
                className="mt-0.5 whitespace-pre-wrap leading-relaxed text-foreground"
              >
                {ideaSuggestion}
              </dd>
            )}
          </div>

          <div className="rounded-md border border-border/80 bg-muted/30 px-3 py-2">
            <dt className="font-medium text-muted-foreground">Evidence & Official Figures</dt>
            {isEditing ? (
              <textarea
                value={ideaEvidence}
                onChange={(e) => setIdeaEvidence(e.target.value)}
                data-testid="zoe-idea-evidence-input"
                rows={2}
                maxLength={1200}
                className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground"
              />
            ) : (
              <dd
                data-testid="zoe-idea-evidence"
                className="mt-0.5 whitespace-pre-wrap leading-relaxed text-foreground"
              >
                {ideaEvidence}
              </dd>
            )}
          </div>

          <div className="rounded-md border border-border/80 bg-muted/30 px-3 py-2">
            <dt className="font-medium text-muted-foreground">Source & Period</dt>
            <dd data-testid="zoe-idea-source" className="mt-0.5 font-semibold text-foreground">
              {draft.source_label} · {draft.period_label}
            </dd>
          </div>
        </dl>
      )}

      {actionError && (
        <div
          data-testid={`zoe-action-draft-error-${draft.action_type}`}
          role="alert"
          className="mt-2.5 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{actionError}</span>
        </div>
      )}

      {/* Action Buttons */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void handleConfirm()}
          disabled={
            isSubmitting ||
            (draft.action_type === 'notification' && !selectedNotifRecipient?.email) ||
            (draft.action_type === 'schedule' && selectedScheduleEmails.length === 0)
          }
          data-testid={`zoe-action-draft-confirm-${draft.action_type}`}
          className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
        >
          {isSubmitting ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <span>
            {draft.action_type === 'reminder' && 'Save Reminder'}
            {draft.action_type === 'notification' && 'Send Notification'}
            {draft.action_type === 'schedule' && 'Save Schedule'}
            {draft.action_type === 'idea' && 'Save Idea'}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setIsEditing((prev) => !prev)}
          disabled={isSubmitting}
          data-testid={`zoe-action-draft-edit-${draft.action_type}`}
          className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Pencil className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{isEditing ? 'Done editing' : 'Edit'}</span>
        </button>

        <button
          type="button"
          onClick={() => setIsCancelled(true)}
          disabled={isSubmitting}
          data-testid={`zoe-action-draft-cancel-${draft.action_type}`}
          className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Cancel</span>
        </button>
      </div>
    </div>
  );
};

export default ZoeActionDraftCard;
