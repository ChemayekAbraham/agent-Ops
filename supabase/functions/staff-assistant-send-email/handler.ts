import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";
import { formatPeriodLabel, kampalaToday } from "../staff-assistant/dates.ts";
import {
  formatReportTitleFromTool,
  normalizeStaffRecipients,
  sanitizeWelileTermsServer,
} from "../staff-assistant/emailDraft.ts";
import { canUseTool, findTool } from "../staff-assistant/tools.ts";

export const DEFAULT_MAX_EMAILS_PER_DAY = 30;
export const ZOE_REPORT_EMAIL_TEMPLATE = "zoe-report-shared";
export const ZOE_REPORT_EMAIL_DISPLAY_NAME = "Report shared from Zoe";

export const SendReportEmailRequestSchema = z
  .object({
    draft_id: z.string().uuid(),
    recipient_email: z.string().trim().email().max(254),
    recipient_name: z.string().trim().max(160).optional(),
    subject: z.string().trim().min(3).max(160),
    message: z.string().trim().min(1).max(1000),
    report_reference: z
      .object({
        tool: z.string().trim().min(1).max(80),
        rpc: z.string().trim().max(100).optional(),
        args: z.record(z.unknown()).optional(),
        source: z.string().trim().max(160).optional(),
        period: z.string().trim().max(120).optional(),
        title: z.string().trim().max(160).optional(),
        filename: z.string().trim().max(160).optional(),
      })
      .strict(),
    conversation_id: z.string().uuid().optional(),
    message_id: z.string().uuid().optional(),
  })
  .strict();

export type SendReportEmailRequest = z.infer<typeof SendReportEmailRequestSchema>;

export interface ExtractedReportTable {
  headers: string[];
  rows: Array<Array<string | number | null>>;
  rowCount: number;
  source: string;
  periodLabel: string;
  howCounted: string;
}

const ARRAY_CANDIDATE_KEYS = [
  "rows",
  "payslips",
  "tasks",
  "tickets",
  "requisitions",
  "advances",
  "concerns",
  "orders",
  "detailed_rows",
  "expiring_contracts",
  "approved_requisitions",
  "agents",
  "waiting",
  "landlord_call_log",
  "weekly_all_calls_summary",
  "top_collectors",
  "by_department",
] as const;

const META_SKIP_KEYS = new Set([
  "tool",
  "rpc",
  "args",
  "source",
  "period",
  "row_count",
  "basis",
  "note",
  "how_counted",
  "email_draft",
]);

function formatHeaderLabel(key: string): string {
  return sanitizeWelileTermsServer(
    key
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/\bUgx\b/gi, "UGX")
      .replace(/\bId\b/g, "ID"),
  );
}

function toPrimitiveCell(val: unknown): string | number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") return Number.isFinite(val) ? val : null;
  if (typeof val === "string") return sanitizeWelileTermsServer(val);
  if (typeof val === "boolean") return val ? "Yes" : "No";
  return JSON.stringify(val);
}

/**
 * Extracts exact headers and rows from the freshly re-run `assistant_staff_*` RPC payload.
 * Never trusts client-supplied rows.
 */
export function extractReportTableFromFreshRpc(
  data: Record<string, unknown>,
  fallbackSource: string,
  todayKampala: string,
): ExtractedReportTable {
  const source =
    typeof data.source === "string" && data.source.trim()
      ? sanitizeWelileTermsServer(data.source.trim())
      : fallbackSource;
  const periodLabel = formatPeriodLabel(data.period) ?? todayKampala;
  const explicitBasis =
    (typeof data.basis === "string" && data.basis.trim()) ||
    (typeof data.note === "string" && data.note.trim()) ||
    "";
  const howCounted = sanitizeWelileTermsServer(
    explicitBasis
      ? `${explicitBasis} (Counted directly via official server source ${source} for ${periodLabel}.)`
      : `Counted directly via official read-only server source (${source}) for ${periodLabel} with zero client-side recalculation.`,
  );

  // 1. Check row arrays
  for (const key of ARRAY_CANDIDATE_KEYS) {
    const candidate = data[key];
    if (Array.isArray(candidate) && candidate.length > 0) {
      const objRows = candidate.filter(
        (r): r is Record<string, unknown> => Boolean(r) && typeof r === "object" && !Array.isArray(r),
      );
      if (objRows.length > 0) {
        const keySet = new Set<string>();
        for (const row of objRows) {
          for (const k of Object.keys(row)) keySet.add(k);
        }
        const keys = Array.from(keySet);
        const headers = keys.map(formatHeaderLabel);
        const rows = objRows.map((row) => keys.map((k) => toPrimitiveCell(row[k])));
        return {
          headers,
          rows,
          rowCount: rows.length,
          source,
          periodLabel,
          howCounted,
        };
      }
    }
  }

  // 2. Period summary fallback (flatten scalar metrics from data)
  const summaryRows: Array<Array<string | number | null>> = [];
  const visit = (obj: Record<string, unknown>, prefix = "", depth = 0) => {
    if (depth > 2 || summaryRows.length >= 50) return;
    for (const [k, v] of Object.entries(obj)) {
      if (META_SKIP_KEYS.has(k) || v === null || v === undefined) continue;
      const label = prefix
        ? `${formatHeaderLabel(prefix)} - ${formatHeaderLabel(k)}`
        : formatHeaderLabel(k);
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
        summaryRows.push([label, toPrimitiveCell(v)]);
      } else if (typeof v === "object" && !Array.isArray(v)) {
        visit(v as Record<string, unknown>, prefix ? `${prefix}_${k}` : k, depth + 1);
      }
    }
  };
  visit(data);

  return {
    headers: ["Metric", "Value"],
    rows: summaryRows,
    rowCount: summaryRows.length,
    source,
    periodLabel,
    howCounted,
  };
}

export interface SendEmailDependencies {
  /** Authenticated sender decoded from JWT. */
  getSender: () => Promise<{ id: string; email: string; fullName: string } | null>;
  /** Enabled staff roles held by the sender. */
  getSenderRoles: (userId: string) => Promise<string[]>;
  /** Re-checks `public.staff_assistant_has_access()` using the sender's JWT. */
  checkHasAccess: () => Promise<boolean>;
  /** Confirms recipient via `public.staff_assistant_is_staff_email(p_email)` using the sender's JWT. */
  checkIsStaffEmail: (email: string) => Promise<boolean>;
  /** Looks up canonical recipient via `public.staff_assistant_email_recipients(p_search)` using the sender's JWT. */
  lookupStaffRecipients: (search: string) => Promise<unknown>;
  /** Confirms that the recipient's own roles can read the report (`public.staff_assistant_can_user_read_report`). */
  checkRecipientCanReadReport?: (
    recipientUserId: string,
    reportRpc: string,
    ownerId: string,
  ) => Promise<boolean>;
  /** Validates and consumes a server-stored draft in `public.staff_assistant_drafts` (`public.staff_assistant_consume_draft`). */
  consumeDraft?: (
    draftId: string,
    payload: Record<string, unknown>,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Checks AAL2 MFA when the report tool is marked sensitive. */
  checkSenderMfa: (userId: string) => Promise<{ ok: boolean }>;
  /** Re-runs the `assistant_staff_*` RPC using the sender's own JWT (`userClient`). */
  runReportRpcAsSender: (
    rpcName: string,
    rpcArgs: Record<string, unknown>,
  ) => Promise<{ data: Record<string, unknown> | null; error: { code?: string; message: string } | null }>;
  /** Reads `max_emails_per_day` (default 30) and count of emails sent today by `userId`. */
  getDailyEmailUsage: (userId: string) => Promise<{ sentToday: number; maxEmailsPerDay: number }>;
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
  /** Invokes `send-transactional-email` with template `"zoe-report-shared"` ("Report shared from Zoe"). */
  sendTransactionalEmail: (payload: {
    templateName: string;
    recipientEmail: string;
    idempotencyKey: string;
    templateData: Record<string, unknown>;
  }) => Promise<{ ok: boolean; error?: string }>;
  /** Writes to `public.audit_logs` and `public.system_events`. */
  writeAuditAndSystemEvent: (entry: {
    senderId: string;
    senderName: string;
    senderEmail: string;
    recipientUserId: string;
    recipientName: string;
    recipientEmail: string;
    subject: string;
    toolName: string;
    rpcName: string;
    source: string;
    periodLabel: string;
    rowCount: number;
    attachmentFilename: string;
    messageId?: string;
    conversationId?: string;
  }) => Promise<void>;
}

export interface SendEmailResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Pure, dependency-injected handler for `staff-assistant-send-email`.
 * Enforces every security and governance rule:
 *   1. Authenticated sender + `staff_assistant_has_access()` is true
 *   2. Recipient confirmed via `staff_assistant_is_staff_email` AND `staff_assistant_email_recipients`
 *   3. Never uses an unverified address or an address scraped from report data
 *   4. Enforces 30 emails per person per day (`max_emails_per_day`)
 *   5. Re-runs the report RPC as the sender (`userClient`) to prove they can see it
 *   6. Sends via `send-transactional-email` using template `"zoe-report-shared"` ("Report shared from Zoe") with PDF attached
 *   7. Writes `audit_logs` and `system_events`
 */
export async function handleStaffAssistantSendEmail(
  rawBody: unknown,
  deps: SendEmailDependencies,
): Promise<SendEmailResult> {
  // 1. Authenticate caller
  const sender = await deps.getSender();
  if (!sender) {
    return {
      status: 401,
      body: { error: "Please sign in again." },
    };
  }

  // 2. Re-check `staff_assistant_has_access()`
  const hasAccess = await deps.checkHasAccess();
  if (!hasAccess) {
    return {
      status: 403,
      body: { error: "Zoe in My Space is only available to enabled Welile staff roles." },
    };
  }

  // 3. Validate request body
  const parsed = SendReportEmailRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: "Invalid email send request payload." },
    };
  }
  const req = parsed.data;
  const candidateEmail = req.recipient_email.trim().toLowerCase();

  // 4. Confirm recipient with `staff_assistant_is_staff_email` AND `staff_assistant_email_recipients`
  const isStaffEmail = await deps.checkIsStaffEmail(candidateEmail);
  if (!isStaffEmail) {
    return {
      status: 403,
      body: {
        error:
          "Refused: Zoe can only send report emails to active Welile staff members with a verified profile email.",
        code: "RECIPIENT_NOT_STAFF",
      },
    };
  }

  const rawRecipients = await deps.lookupStaffRecipients(candidateEmail);
  const recipients = normalizeStaffRecipients(rawRecipients);
  const canonicalRecipient = recipients.find(
    (r) => r.email.toLowerCase() === candidateEmail,
  );
  if (!canonicalRecipient) {
    return {
      status: 403,
      body: {
        error:
          "Refused: recipient could not be resolved through staff_assistant_email_recipients.",
        code: "RECIPIENT_NOT_STAFF",
      },
    };
  }

  // 5. Enforce daily email limit (30 emails per person per day from `staff_assistant_config`)
  const usage = await deps.getDailyEmailUsage(sender.id);
  const maxPerDay = usage.maxEmailsPerDay ?? DEFAULT_MAX_EMAILS_PER_DAY;
  if (maxPerDay <= 0 || usage.sentToday >= maxPerDay) {
    return {
      status: 429,
      body: {
        error: `You have reached your daily limit of ${maxPerDay} Zoe report emails today. Your quota resets tomorrow in Kampala time.`,
        code: "EMAIL_DAILY_LIMIT_REACHED",
        remaining_emails_today: 0,
      },
    };
  }

  // 6. Re-run the report as the sender to prove they are authorized to view it
  const tool = findTool(req.report_reference.tool);
  if (!tool) {
    return {
      status: 400,
      body: { error: "Unknown Zoe report tool reference." },
    };
  }

  const senderRoles = await deps.getSenderRoles(sender.id);
  if (!canUseTool(tool, senderRoles)) {
    return {
      status: 403,
      body: {
        error: "You do not have role permission to view or email this report.",
        code: "ROLE_RESTRICTED",
      },
    };
  }

  // 6b. Check that the recipient's own roles can read this report (Finding H4)
  const isPersonalReport = tool.rpc.startsWith("assistant_staff_my_");
  const recipientAllowedByTool =
    canUseTool(tool, canonicalRecipient.roles) &&
    (!isPersonalReport || canonicalRecipient.staff_user_id === sender.id);
  const recipientAllowedByDb = deps.checkRecipientCanReadReport
    ? await deps.checkRecipientCanReadReport(
        canonicalRecipient.staff_user_id,
        tool.rpc,
        sender.id,
      )
    : true;

  if (!recipientAllowedByTool || !recipientAllowedByDb) {
    return {
      status: 403,
      body: {
        error:
          "Refused: that colleague's role does not have permission to view this report. You may share a sign-in link to My Space instead of attaching the report data.",
        code: "RECIPIENT_ROLE_RESTRICTED",
        sign_in_url: "https://welilereceipts.com/me/zoe",
      },
    };
  }

  if (tool.sensitive) {
    const mfa = await deps.checkSenderMfa(sender.id);
    if (!mfa.ok) {
      return {
        status: 403,
        body: {
          error:
            "This report contains sensitive figures and requires two-factor verification (MFA) before it can be shared.",
          mfa_required: true,
        },
      };
    }
  }

  const validatedToolArgs = tool.schema.safeParse(req.report_reference.args ?? {});
  if (!validatedToolArgs.success) {
    return {
      status: 400,
      body: { error: "Invalid report tool arguments in report_reference." },
    };
  }

  // 6c. Consume the server-side draft (Finding M9: unexpired, unused, owned by caller, identical payload)
  if (deps.consumeDraft) {
    const consumed = await deps.consumeDraft(req.draft_id, {
      kind: "email",
      recipient_email: canonicalRecipient.email,
      subject: req.subject,
      message: req.message,
      report_reference: {
        tool: tool.name,
        rpc: tool.rpc,
        args: validatedToolArgs.data,
      },
    });
    if (!consumed.ok) {
      return {
        status: 403,
        body: {
          error:
            consumed.error ||
            "This email draft has expired, was already sent, or does not match the drafted report. Please ask Zoe to prepare a fresh draft.",
          code: "DRAFT_INVALID_OR_EXPIRED",
        },
      };
    }
  }

  const rpcArgs = tool.toRpcArgs(validatedToolArgs.data);
  const { data: freshReportData, error: rpcErr } = await deps.runReportRpcAsSender(
    tool.rpc,
    rpcArgs,
  );
  if (rpcErr || !freshReportData) {
    const isDenied = rpcErr?.code === "42501";
    return {
      status: isDenied ? 403 : 500,
      body: {
        error: isDenied
          ? "You are not authorized to run or share this report."
          : "Could not re-run the official report for email attachment.",
        code: isDenied ? "ROLE_RESTRICTED" : "REPORT_EXECUTION_FAILED",
      },
    };
  }

  // 7. Extract table/summary strictly from the freshly re-run report output and build the PDF
  const today = kampalaToday();
  const extracted = extractReportTableFromFreshRpc(freshReportData, tool.rpc, today);
  const reportTitle = sanitizeWelileTermsServer(
    req.report_reference.title && req.report_reference.title.trim()
      ? req.report_reference.title.trim()
      : formatReportTitleFromTool(tool.name, extracted.source),
  );
  const subject = sanitizeWelileTermsServer(req.subject);
  const message = sanitizeWelileTermsServer(req.message);
  const generatedAt = `${new Date().toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Kampala",
  })} EAT`;

  const slug = reportTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 44);
  const attachmentFilename =
    req.report_reference.filename && req.report_reference.filename.endsWith(".pdf")
      ? req.report_reference.filename
      : `welile-zoe-${slug || "report"}-${today}.pdf`;

  const pdfBase64 = await deps.renderPdfBase64({
    report_title: reportTitle,
    source: extracted.source,
    period_label: extracted.periodLabel,
    generated_at: generatedAt,
    sender_name: sender.fullName,
    sender_email: sender.email,
    recipient_name: canonicalRecipient.full_name,
    recipient_email: canonicalRecipient.email,
    how_counted: extracted.howCounted,
    row_count: extracted.rowCount,
    headers: extracted.headers,
    rows: extracted.rows,
  });

  // 8. Send through `send-transactional-email` and the email queue using template "Report shared from Zoe"
  //    Note: inline rows/headers are NEVER placed in templateData or email HTML body (Finding H4).
  const idempotencyKey = `zoe-email-${sender.id}-${crypto.randomUUID()}`;
  const sendRes = await deps.sendTransactionalEmail({
    templateName: ZOE_REPORT_EMAIL_TEMPLATE,
    recipientEmail: canonicalRecipient.email,
    idempotencyKey,
    templateData: {
      recipient_name: canonicalRecipient.full_name,
      recipient_email: canonicalRecipient.email,
      sender_name: sender.fullName,
      sender_email: sender.email,
      subject,
      message,
      report_title: reportTitle,
      source: extracted.source,
      period_label: extracted.periodLabel,
      generated_at: generatedAt,
      row_count: extracted.rowCount,
      how_counted: extracted.howCounted,
      attachment_filename: attachmentFilename,
      attachment_base64: pdfBase64,
    },
  });

  if (!sendRes.ok) {
    return {
      status: 502,
      body: {
        error: sendRes.error || "Failed to enqueue report email via send-transactional-email.",
      },
    };
  }

  // 9. Write `audit_logs` and `system_events`
  await deps.writeAuditAndSystemEvent({
    senderId: sender.id,
    senderName: sender.fullName,
    senderEmail: sender.email,
    recipientUserId: canonicalRecipient.staff_user_id,
    recipientName: canonicalRecipient.full_name,
    recipientEmail: canonicalRecipient.email,
    subject,
    toolName: tool.name,
    rpcName: tool.rpc,
    source: extracted.source,
    periodLabel: extracted.periodLabel,
    rowCount: extracted.rowCount,
    attachmentFilename,
    messageId: req.message_id,
    conversationId: req.conversation_id,
  });

  return {
    status: 200,
    body: {
      ok: true,
      sent: true,
      template_name: ZOE_REPORT_EMAIL_TEMPLATE,
      template_display_name: ZOE_REPORT_EMAIL_DISPLAY_NAME,
      recipient_email: canonicalRecipient.email,
      recipient_name: canonicalRecipient.full_name,
      subject,
      attachment_filename: attachmentFilename,
      row_count: extracted.rowCount,
      remaining_emails_today: Math.max(0, maxPerDay - usage.sentToday - 1),
    },
  };
}
