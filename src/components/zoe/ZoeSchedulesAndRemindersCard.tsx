import React, { useState } from 'react';
import {
  AlertCircle,
  CalendarClock,
  Clock,
  Loader2,
  Trash2,
} from 'lucide-react';
import {
  cancelZoeReminder,
  cancelZoeSchedule,
  type ConfirmZoeActionResult,
  type ZoeRemindersAndSchedulesPayload,
} from '@/lib/zoe';

export interface ZoeSchedulesAndRemindersCardProps {
  data: ZoeRemindersAndSchedulesPayload;
  onCancelReminder?: (reminderId: string) => Promise<ConfirmZoeActionResult>;
  onCancelSchedule?: (scheduleId: string) => Promise<ConfirmZoeActionResult>;
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
 * Displays the caller's active reminders and scheduled report emails inside Zoe,
 * with a one-click Cancel button on each item.
 */
export const ZoeSchedulesAndRemindersCard: React.FC<ZoeSchedulesAndRemindersCardProps> = ({
  data,
  onCancelReminder = cancelZoeReminder,
  onCancelSchedule = cancelZoeSchedule,
}) => {
  const [cancelledReminderIds, setCancelledReminderIds] = useState<string[]>([]);
  const [cancelledScheduleIds, setCancelledScheduleIds] = useState<string[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const visibleReminders = data.reminders.filter((r) => !cancelledReminderIds.includes(r.id));
  const visibleSchedules = data.schedules.filter((s) => !cancelledScheduleIds.includes(s.id));

  const handleCancelReminder = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    setErrorMessage(null);
    try {
      const res = await onCancelReminder(id);
      if (!res.ok) {
        setErrorMessage(res.error || 'Could not cancel reminder.');
      } else {
        setCancelledReminderIds((prev) => [...prev, id]);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not cancel reminder.');
    } finally {
      setBusyId(null);
    }
  };

  const handleCancelSchedule = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    setErrorMessage(null);
    try {
      const res = await onCancelSchedule(id);
      if (!res.ok) {
        setErrorMessage(res.error || 'Could not cancel schedule.');
      } else {
        setCancelledScheduleIds((prev) => [...prev, id]);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not cancel schedule.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      data-testid="zoe-schedules-and-reminders-card"
      className="mt-3 space-y-3 rounded-lg border border-border bg-card p-3.5 text-card-foreground shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
        <div>
          <h4 className="text-xs font-semibold text-foreground sm:text-sm">
            My Active Reminders & Scheduled Report Emails
          </h4>
          <p className="text-xs text-muted-foreground">
            {visibleReminders.length}{' '}
            {visibleReminders.length === 1 ? 'reminder' : 'reminders'} ·{' '}
            {visibleSchedules.length}{' '}
            {visibleSchedules.length === 1 ? 'schedule' : 'schedules'} · Morning Brief:{' '}
            {data.morning_brief_enabled
              ? `On (${data.morning_brief_time_kampala} Kampala)`
              : 'Off'}
          </p>
        </div>
      </div>

      {errorMessage && (
        <div
          role="alert"
          data-testid="zoe-list-cancel-error"
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Reminders list */}
      <div className="space-y-1.5">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Clock className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          <span>Active Reminders ({visibleReminders.length})</span>
        </p>
        {visibleReminders.length === 0 ? (
          <p
            data-testid="zoe-no-active-reminders"
            className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
          >
            You have no active reminders.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {visibleReminders.map((rem) => (
              <li
                key={rem.id}
                data-testid={`zoe-reminder-item-${rem.id}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/80 bg-muted/30 px-3 py-2 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-foreground">{rem.title}</p>
                  <p className="text-muted-foreground">
                    Due: <span className="font-mono">{rem.remind_at}</span>
                    {rem.note ? ` · ${rem.note}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busyId === rem.id}
                  data-testid={`zoe-cancel-reminder-${rem.id}`}
                  onClick={() => void handleCancelReminder(rem.id)}
                  className="inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                >
                  {busyId === rem.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  <span>Cancel</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Schedules list */}
      <div className="space-y-1.5">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <CalendarClock className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          <span>Scheduled Report Emails ({visibleSchedules.length})</span>
        </p>
        {visibleSchedules.length === 0 ? (
          <p
            data-testid="zoe-no-active-schedules"
            className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
          >
            You have no active report schedules.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {visibleSchedules.map((sched) => (
              <li
                key={sched.id}
                data-testid={`zoe-schedule-item-${sched.id}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/80 bg-muted/30 px-3 py-2 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-foreground">
                    {sched.title} ({sched.report_rpc})
                  </p>
                  <p className="text-muted-foreground">
                    {sched.frequency === 'weekly'
                      ? `Weekly (${DAY_NAMES[sched.day_of_week ?? 1] ?? 'Monday'})`
                      : 'Daily'}{' '}
                    at {sched.send_time_kampala} EAT · To:{' '}
                    {sched.recipient_emails.join(', ')}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busyId === sched.id}
                  data-testid={`zoe-cancel-schedule-${sched.id}`}
                  onClick={() => void handleCancelSchedule(sched.id)}
                  className="inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                >
                  {busyId === sched.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  <span>Cancel</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default ZoeSchedulesAndRemindersCard;
