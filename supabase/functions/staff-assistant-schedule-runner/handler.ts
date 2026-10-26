import { formatPeriodLabel, kampalaToday } from "../staff-assistant/dates.ts";
import {
  formatReportTitleFromTool,
  sanitizeWelileTermsServer,
} from "../staff-assistant/emailDraft.ts";
import { canUseTool, findTool } from "../staff-assistant/tools.ts";
import {
  DEFAULT_MAX_EMAILS_PER_DAY,
  extractReportTableFromFreshRpc,
  ZOE_REPORT_EMAIL_DISPLAY_NAME,
  ZOE_REPORT_EMAIL_TEMPLATE,
} from "../staff-assistant-send-email/handler.ts";

export interface DueScheduleRecord {
  id: string;
  user_id: string;
  title: string;
  report_tool: string;
  report_rpc: string;
  report_args: Record<string, unknown>;
  frequency: "daily" | "weekly";
  day_of_week: number | null;
  send_time_kampala: string;
  recipient_emails: string[];
  recipient_names: string[];
  custom_message: string | null;
  run_count: number;
}

export interface ScheduleRunnerDependencies {
  /** Dispatches any due personal reminders (`staff_assistant_dispatch_due_reminders`). */
  dispatchDueReminders: () => Promise<number>;
  /** Loads due active report schedules (`status = 'active'` and `next_run_at <= now()`). */
  loadDueSchedules: () => Promise<DueScheduleRecord[]>;
  /** Re-checks whether the schedule owner still passes `staff_assistant_has_access()` / `staff_assistant_check_owner_access(ownerId)`. */
  checkOwnerHasAccess: (ownerId: string) => Promise<boolean>;
  /** Loads the schedule owner's current enabled roles and profile metadata. */
  getOwnerProfileAndRoles: (
    ownerId: string,
  ) => Promise<{ fullName: string; email: string; roles: string[] }>;
  /** Re-checks each recipient email via `staff_assistant_is_staff_email` on every run. */
  checkRecipientIsStaffEmail: (email: string) => Promise<boolean>;
  /** Checks the owner's daily email budget (`max_emails_per_day` in `staff_assistant_config`). */
  getDailyEmailUsage: (
    ownerId: string,
  ) => Promise<{ sentToday: number; maxEmailsPerDay: number }>;
  /** Re-runs the `assistant_staff_*` report as the schedule owner (`staff_assistant_run_scheduled_report_as_owner`). */
  runReportAsOwner: (
    ownerId: string,
    rpcName: string,
    rpcArgs: Record<string, unknown>,
  ) => Promise<{
    data: Record<string, unknown> | null;
    error: { code?: string; message: string } | null;
  }>;
  /** Renders the branded PDF attachment bytes (`Uint8Array`) and returns base64. */
  renderPdfBase64: (pdfData: {
    report_title: string;
    source: string;
    period_label: string;
    generated_at: string;
    sender_name: string;
    sender_email: string;
    recipient_name: string;
    recipient_email: string;
    how_counted: string;
    row_count: number;
    headers: string[];
    rows: Array<Array<string | number | null>>;
  }) => Promise<string>;
  /** Sends the scheduled report email through `send-transactional-email`. */
  sendTransactionalEmail: (payload: {
    templateName: string;
    recipientEmail: string;
    idempotencyKey: string;
    templateData: Record<string, unknown>;
  }) => Promise<{ ok: boolean; error?: string }>;
  /** Computes the next run timestamp (`staff_assistant_compute_next_run`). */
  computeNextRunAt: (params: {
    frequency: "daily" | "weekly";
    sendTimeKampala: string;
    dayOfWeek: number | null;
  }) => Promise<string>;
  /** Updates the schedule's status / `last_run_at` / `last_run_status` / `next_run_at` / `run_count`. */
  updateScheduleState: (
    scheduleId: string,
    patch: {
      status?: "active" | "paused" | "cancelled";
      last_run_at: string;
      last_run_status: string;
      next_run_at?: string;
      run_count?: number;
    },
  ) => Promise<void>;
  /** Writes to `audit_logs` and `system_events`. */
  writeScheduleAudit: (entry: {
    scheduleId: string;
    ownerId: string;
    actionType: string;
    eventType: string;
    reason: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
}

export interface ScheduleRunOutcome {
  schedule_id: string;
  owner_id: string;
  status:
    | "sent"
    | "paused_owner_access_revoked"
    | "paused_owner_role_revoked"
    | "paused_recipient_not_staff"
    | "skipped_daily_budget"
    | "error";
  sent_to: string[];
  refused_recipients: string[];
  reason?: string;
}

export interface ScheduleRunnerResult {
  status: number;
  body: {
    ok: boolean;
    kampala_date: string;
    reminders_dispatched: number;
    schedules_processed: number;
    schedules_sent: number;
    outcomes: ScheduleRunOutcome[];
  };
}

/**
 * Pure, dependency-injected cron runner for Zoe scheduled report emails and due reminders.
 *
 * Security invariants enforced on EVERY run:
 *   1. Re-checks the schedule owner's `staff_assistant_has_access()` / `staff_assistant_check_owner_access(user_id)`.
 *   2. Re-checks the schedule owner's current roles against the registered `StaffTool` (`canUseTool`).
 *   3. Re-checks EVERY recipient email via `staff_assistant_is_staff_email` before sending.
 *   4. Re-checks the owner's daily email budget (`max_emails_per_day`, default 30).
 *   5. Re-runs the `assistant_staff_*` report as the schedule owner.
 */
export async function runStaffAssistantSchedules(
  deps: ScheduleRunnerDependencies,
): Promise<ScheduleRunnerResult> {
  const nowIso = new Date().toISOString();
  const todayKampala = kampalaToday();

  const remindersDispatched = await deps.dispatchDueReminders().catch(() => 0);
  const dueSchedules = await deps.loadDueSchedules();
  const outcomes: ScheduleRunOutcome[] = [];
  let schedulesSent = 0;

  for (const sched of dueSchedules) {
    // 1. Re-check owner's Zoe access (`staff_assistant_has_access`)
    const ownerHasAccess = await deps.checkOwnerHasAccess(sched.user_id);
    if (!ownerHasAccess) {
      await deps.updateScheduleState(sched.id, {
        status: "paused",
        last_run_at: nowIso,
        last_run_status: "paused_owner_access_revoked",
      });
      await deps.writeScheduleAudit({
        scheduleId: sched.id,
        ownerId: sched.user_id,
        actionType: "staff_assistant_schedule_paused_access",
        eventType: "staff_assistant.schedule_paused_access",
        reason: "Paused scheduled Zoe report because owner no longer passes staff_assistant_has_access()",
        metadata: { schedule_id: sched.id, report_tool: sched.report_tool },
      });
      outcomes.push({
        schedule_id: sched.id,
        owner_id: sched.user_id,
        status: "paused_owner_access_revoked",
        sent_to: [],
        refused_recipients: sched.recipient_emails,
        reason: "Owner no longer passes staff_assistant_has_access()",
      });
      continue;
    }

    // 2. Re-check owner's current enabled roles against the tool definition
    const ownerProfile = await deps.getOwnerProfileAndRoles(sched.user_id);
    const tool =
      findTool(sched.report_tool) ??
      findTool(sched.report_rpc.replace(/^assistant_staff_/, "get_")) ??
      findTool(sched.report_rpc.replace(/^assistant_staff_/, ""));

    if (!tool || (sched.report_rpc && sched.report_rpc !== tool.rpc)) {
      await deps.updateScheduleState(sched.id, {
        status: "paused",
        last_run_at: nowIso,
        last_run_status: "paused_invalid_tool",
      });
      outcomes.push({
        schedule_id: sched.id,
        owner_id: sched.user_id,
        status: "error",
        sent_to: [],
        refused_recipients: [],
        reason: "Unknown report tool",
      });
      continue;
    }

    if (!canUseTool(tool, ownerProfile.roles)) {
      await deps.updateScheduleState(sched.id, {
        status: "paused",
        last_run_at: nowIso,
        last_run_status: "paused_owner_role_revoked",
      });
      await deps.writeScheduleAudit({
        scheduleId: sched.id,
        ownerId: sched.user_id,
        actionType: "staff_assistant_schedule_paused_role",
        eventType: "staff_assistant.schedule_paused_role",
        reason: `Paused scheduled Zoe report (${tool.name}) because owner role no longer permits this report`,
        metadata: {
          schedule_id: sched.id,
          report_tool: tool.name,
          owner_roles: ownerProfile.roles,
        },
      });
      outcomes.push({
        schedule_id: sched.id,
        owner_id: sched.user_id,
        status: "paused_owner_role_revoked",
        sent_to: [],
        refused_recipients: sched.recipient_emails,
        reason: "Owner role no longer permits this report tool",
      });
      continue;
    }

    // 3. Re-check EVERY recipient's staff status via staff_assistant_is_staff_email on every run
    const verifiedRecipients: Array<{ email: string; name: string }> = [];
    const refusedRecipients: string[] = [];

    for (let i = 0; i < sched.recipient_emails.length; i++) {
      const email = String(sched.recipient_emails[i] ?? "").trim().toLowerCase();
      const name = String(sched.recipient_names[i] ?? email).trim();
      if (!email) continue;
      const isStaff = await deps.checkRecipientIsStaffEmail(email);
      if (isStaff) {
        verifiedRecipients.push({ email, name });
      } else {
        refusedRecipients.push(email);
      }
    }

    if (verifiedRecipients.length === 0) {
      await deps.updateScheduleState(sched.id, {
        status: "paused",
        last_run_at: nowIso,
        last_run_status: "paused_recipient_not_staff",
      });
      await deps.writeScheduleAudit({
        scheduleId: sched.id,
        ownerId: sched.user_id,
        actionType: "staff_assistant_schedule_refused_recipient",
        eventType: "staff_assistant.schedule_refused_recipient",
        reason: "Paused scheduled Zoe report because no recipient passed staff_assistant_is_staff_email",
        metadata: {
          schedule_id: sched.id,
          refused_recipients: refusedRecipients,
        },
      });
      outcomes.push({
        schedule_id: sched.id,
        owner_id: sched.user_id,
        status: "paused_recipient_not_staff",
        sent_to: [],
        refused_recipients: refusedRecipients,
        reason: "Recipient is no longer an active Welile staff email",
      });
      continue;
    }

    // 4. Re-check owner's daily email budget
    const usage = await deps.getDailyEmailUsage(sched.user_id);
    const maxEmails = usage.maxEmailsPerDay || DEFAULT_MAX_EMAILS_PER_DAY;
    if (usage.sentToday + verifiedRecipients.length > maxEmails) {
      const nextRunAt = await deps.computeNextRunAt({
        frequency: sched.frequency,
        sendTimeKampala: sched.send_time_kampala,
        dayOfWeek: sched.day_of_week,
      });
      await deps.updateScheduleState(sched.id, {
        last_run_at: nowIso,
        last_run_status: "skipped_daily_budget",
        next_run_at: nextRunAt,
      });
      outcomes.push({
        schedule_id: sched.id,
        owner_id: sched.user_id,
        status: "skipped_daily_budget",
        sent_to: [],
        refused_recipients: refusedRecipients,
        reason: `Owner reached daily email limit (${maxEmails})`,
      });
      continue;
    }

    // 5. Re-run the report as the schedule owner
    const parsedArgs = tool.schema.safeParse(sched.report_args ?? {});
    const rpcArgs = tool.toRpcArgs(parsedArgs.success ? parsedArgs.data : {});
    const rpcResult = await deps.runReportAsOwner(sched.user_id, tool.rpc, rpcArgs);

    if (rpcResult.error || !rpcResult.data) {
      const isForbidden = rpcResult.error?.code === "42501";
      await deps.updateScheduleState(sched.id, {
        status: isForbidden ? "paused" : "active",
        last_run_at: nowIso,
        last_run_status: isForbidden ? "paused_owner_role_revoked" : "error_rpc_failed",
      });
      outcomes.push({
        schedule_id: sched.id,
        owner_id: sched.user_id,
        status: isForbidden ? "paused_owner_role_revoked" : "error",
        sent_to: [],
        refused_recipients: refusedRecipients,
        reason: rpcResult.error?.message ?? "Report RPC failed",
      });
      continue;
    }

    // 6. Build branded PDF and send to each verified staff recipient
    const extracted = extractReportTableFromFreshRpc(rpcResult.data, tool.rpc, todayKampala);
    const reportTitle = sanitizeWelileTermsServer(
      sched.title || formatReportTitleFromTool(tool.name, extracted.source),
    );
    const periodLabel = formatPeriodLabel(rpcResult.data.period) ?? extracted.periodLabel;
    const slug = reportTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 44);
    const filename = `welile-zoe-${slug || "scheduled-report"}-${todayKampala}.pdf`;
    const subject = sanitizeWelileTermsServer(
      `Scheduled Report from Zoe: ${reportTitle} (${periodLabel})`,
    );
    const messageBody = sanitizeWelileTermsServer(
      sched.custom_message ||
        `Scheduled ${sched.frequency} Zoe report (${reportTitle}) for ${periodLabel}.`,
    );

    const sentTo: string[] = [];
    for (const recipient of verifiedRecipients) {
      const pdfBase64 = await deps.renderPdfBase64({
        report_title: reportTitle,
        source: extracted.source,
        period_label: periodLabel,
        generated_at: nowIso,
        sender_name: ownerProfile.fullName,
        sender_email: ownerProfile.email,
        recipient_name: recipient.name,
        recipient_email: recipient.email,
        how_counted: extracted.howCounted,
        row_count: extracted.rowCount,
        headers: extracted.headers,
        rows: extracted.rows,
      });

      const sendRes = await deps.sendTransactionalEmail({
        templateName: ZOE_REPORT_EMAIL_TEMPLATE,
        recipientEmail: recipient.email,
        idempotencyKey: `zoe-sched-${sched.id}-${todayKampala}-${recipient.email}`,
        templateData: {
          recipient_name: recipient.name,
          recipient_email: recipient.email,
          sender_name: ownerProfile.fullName,
          sender_email: ownerProfile.email,
          subject,
          message: messageBody,
          report_title: reportTitle,
          source: extracted.source,
          period_label: periodLabel,
          row_count: extracted.rowCount,
          generated_at: nowIso,
          how_counted: extracted.howCounted,
          attachment_filename: filename,
          pdf_base64: pdfBase64,
          template_display_name: ZOE_REPORT_EMAIL_DISPLAY_NAME,
        },
      });

      if (sendRes.ok) {
        sentTo.push(recipient.email);
      }
    }

    const nextRunAt = await deps.computeNextRunAt({
      frequency: sched.frequency,
      sendTimeKampala: sched.send_time_kampala,
      dayOfWeek: sched.day_of_week,
    });

    await deps.updateScheduleState(sched.id, {
      status: "active",
      last_run_at: nowIso,
      last_run_status: sentTo.length > 0 ? "sent" : "error_send_failed",
      next_run_at: nextRunAt,
      run_count: (sched.run_count ?? 0) + (sentTo.length > 0 ? 1 : 0),
    });

    if (sentTo.length > 0) {
      schedulesSent += 1;
      await deps.writeScheduleAudit({
        scheduleId: sched.id,
        ownerId: sched.user_id,
        actionType: "staff_assistant_report_email_sent",
        eventType: "staff_assistant.scheduled_report_sent",
        reason: `Sent scheduled ${sched.frequency} Zoe report (${tool.name}) to ${sentTo.join(", ")}`,
        metadata: {
          schedule_id: sched.id,
          report_tool: tool.name,
          report_rpc: tool.rpc,
          frequency: sched.frequency,
          sent_to: sentTo,
          refused_recipients: refusedRecipients,
          row_count: extracted.rowCount,
          attachment_filename: filename,
        },
      });
    }

    outcomes.push({
      schedule_id: sched.id,
      owner_id: sched.user_id,
      status: sentTo.length > 0 ? "sent" : "error",
      sent_to: sentTo,
      refused_recipients: refusedRecipients,
    });
  }

  return {
    status: 200,
    body: {
      ok: true,
      kampala_date: todayKampala,
      reminders_dispatched: remindersDispatched,
      schedules_processed: dueSchedules.length,
      schedules_sent: schedulesSent,
      outcomes,
    },
  };
}
