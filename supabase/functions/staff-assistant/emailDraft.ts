import { MSG } from "./messages.ts";

export interface StaffEmailRecipient {
  staff_user_id: string;
  full_name: string;
  email: string;
  roles: string[];
}

export interface ZoeReportReference {
  tool: string;
  rpc: string;
  args: Record<string, unknown>;
  source: string;
  period: string;
  title: string;
  row_count: number;
  filename: string;
}

export interface ZoeEmailDraft {
  draft_id: string;
  status: "ready" | "pick_recipient";
  recipient_user_id: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  recipient_roles: string[];
  subject: string;
  message: string;
  report_reference: ZoeReportReference;
  candidates: StaffEmailRecipient[];
}

export type DraftEmailOutcome =
  | {
      kind: "refused";
      reason: "data_email_forbidden" | "not_staff";
      message: string;
    }
  | {
      kind: "pick_recipient";
      question: string;
      options: string[];
      draft: ZoeEmailDraft;
    }
  | {
      kind: "draft_ready";
      replyText: string;
      draft: ZoeEmailDraft;
    };

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export function sanitizeWelileTermsServer(input: string): string {
  if (!input) return "";
  return input
    .replace(/\bloans\b/gi, "Rent Plans")
    .replace(/\bloan\b/gi, "Rent Plan")
    .replace(/\blenders\b/gi, "Supporters")
    .replace(/\blender\b/gi, "Supporter")
    .replace(/\bROI\b/g, "Returns")
    .replace(/\binterest\s+rate\b/gi, "Returns rate")
    .replace(/\binterest\b/gi, "Returns");
}

/**
 * Extracts a clean search string from a user or model recipient query.
 * If the query contains a parenthesized or angle-bracketed email (e.g. from tapping
 * a multi-match picker option like `Email report to Jane (jane@welile.com)`),
 * returns that exact email so `staff_assistant_email_recipients` resolves the chosen person.
 */
export function extractRecipientQuery(rawSearch: string): string {
  const trimmed = String(rawSearch ?? "").trim();
  const emailMatches = trimmed.match(EMAIL_RE);
  if (emailMatches && emailMatches.length === 1) {
    return emailMatches[0].toLowerCase();
  }
  return trimmed;
}

/**
 * Security Rule: Never use an email address found inside report data (`rawToolOutputs`)
 * unless the caller explicitly typed that exact string in `userText`.
 */
export function isEmailFromToolData(
  recipientSearch: string,
  rawToolOutputs: readonly string[],
  userText: string,
): boolean {
  const searchLower = String(recipientSearch ?? "").trim().toLowerCase();
  if (!searchLower) return false;

  const userLower = String(userText ?? "").toLowerCase();
  const dataEmails = new Set<string>();

  for (const raw of rawToolOutputs) {
    const matches = String(raw ?? "").match(EMAIL_RE) ?? [];
    for (const m of matches) {
      dataEmails.add(m.toLowerCase());
    }
  }

  if (dataEmails.size === 0) return false;

  // Check if recipientSearch itself or any email inside it came from tool data without being in userText
  const candidateEmails = searchLower.match(EMAIL_RE) ?? [searchLower];
  for (const candidate of candidateEmails) {
    const c = candidate.toLowerCase();
    if (dataEmails.has(c) && !userLower.includes(c)) {
      return true;
    }
  }

  return false;
}

export function normalizeStaffRecipients(rows: unknown): StaffEmailRecipient[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object" && !Array.isArray(r))
    .map((r) => ({
      staff_user_id: String(r.staff_user_id ?? "").trim(),
      full_name: String(r.full_name ?? "").trim(),
      email: String(r.email ?? "").trim(),
      roles: Array.isArray(r.roles) ? r.roles.map((x) => String(x)) : [],
    }))
    .filter((r) => Boolean(r.staff_user_id && r.email && r.email.includes("@")));
}

export function formatReportTitleFromTool(toolName: string, sourceLabel: string): string {
  const clean = (toolName || sourceLabel || "Zoe Report")
    .replace(/^assistant_staff_/, "")
    .replace(/^get_/, "")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bCfo\b/g, "CFO")
    .replace(/\bCoo\b/g, "COO")
    .replace(/\bCeo\b/g, "CEO")
    .replace(/\bHr\b/g, "HR")
    .replace(/\bTops\b/g, "Tenant Ops")
    .replace(/\bLops\b/g, "Landlord Ops")
    .replace(/\bAops\b/g, "Agent Ops")
    .replace(/\bPops\b/g, "Partner Ops");
  return sanitizeWelileTermsServer(`${clean} Report`);
}

export function deriveRowCountFromPayload(payload: Record<string, unknown>): number {
  if (typeof payload.row_count === "number" && Number.isFinite(payload.row_count)) {
    return payload.row_count;
  }
  if (Array.isArray(payload.rows) && payload.rows.length > 0) {
    return payload.rows.length;
  }
  const arrayKeys = [
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
  ];
  for (const k of arrayKeys) {
    if (Array.isArray(payload[k]) && (payload[k] as unknown[]).length > 0) {
      return (payload[k] as unknown[]).length;
    }
  }
  if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    const d = payload.data as Record<string, unknown>;
    if (Array.isArray(d.rows)) return d.rows.length;
    return Object.keys(d).length;
  }
  return 1;
}

export function buildReportReference(
  payload: Record<string, unknown>,
  todayKampala: string,
  periodLabel: string,
): ZoeReportReference {
  const tool = typeof payload.tool === "string" ? payload.tool : "my_profile";
  const rpc = typeof payload.rpc === "string" ? payload.rpc : `assistant_staff_${tool}`;
  const source = typeof payload.source === "string" && payload.source ? payload.source : rpc;
  const title = formatReportTitleFromTool(tool, source);
  const rowCount = deriveRowCountFromPayload(payload);
  const args =
    payload.args && typeof payload.args === "object" && !Array.isArray(payload.args)
      ? (payload.args as Record<string, unknown>)
      : {};
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 44);

  return {
    tool,
    rpc,
    args,
    source,
    period: periodLabel || todayKampala,
    title,
    row_count: rowCount,
    filename: `welile-zoe-${slug || "report"}-${todayKampala}.pdf`,
  };
}

/**
 * Pure builder for the `draft_report_email` action tool.
 * Never sends any email.
 */
export function buildReportEmailDraft(params: {
  recipientSearch: string;
  recipients: StaffEmailRecipient[];
  rawToolOutputs: readonly string[];
  userText: string;
  subject?: string;
  message?: string;
  reportPayload: Record<string, unknown>;
  periodLabel: string;
  todayKampala: string;
}): DraftEmailOutcome {
  // 1. Refuse if the email address was scraped from report data and not typed by the user
  if (isEmailFromToolData(params.recipientSearch, params.rawToolOutputs, params.userText)) {
    return {
      kind: "refused",
      reason: "data_email_forbidden",
      message: MSG.dataEmailForbidden,
    };
  }

  // 2. Refuse if `staff_assistant_email_recipients` returned 0 active staff matches
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

  const defaultSubject = `Report shared from Zoe: ${reportRef.title} (${reportRef.period})`;
  const defaultMessage = `Please find attached the ${reportRef.title} for ${reportRef.period} (${reportRef.row_count} ${
    reportRef.row_count === 1 ? "row" : "rows"
  }), generated from official source ${reportRef.source}.`;

  const subject = sanitizeWelileTermsServer(
    params.subject && params.subject.trim() ? params.subject.trim() : defaultSubject,
  );
  const message = sanitizeWelileTermsServer(
    params.message && params.message.trim() ? params.message.trim() : defaultMessage,
  );

  const extractedQuery = extractRecipientQuery(params.recipientSearch).toLowerCase();
  const exactEmailMatch = params.recipients.find(
    (r) => r.email.toLowerCase() === extractedQuery,
  );

  // 3. If several active staff match (and the query wasn't already an exact email match), ask the person to pick
  if (params.recipients.length > 1 && !exactEmailMatch) {
    const options = params.recipients
      .slice(0, 3)
      .map((r) => `Email report to ${r.full_name} (${r.email})`);
    const question = `Several active Welile staff members match "${params.recipientSearch}". Please pick who should receive the report draft:`;

    const draft: ZoeEmailDraft = {
      draft_id: crypto.randomUUID(),
      status: "pick_recipient",
      recipient_user_id: null,
      recipient_name: null,
      recipient_email: null,
      recipient_roles: [],
      subject,
      message,
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

  // 4. Single active staff recipient resolved strictly from `staff_assistant_email_recipients`
  const selected = exactEmailMatch ?? params.recipients[0];
  const draft: ZoeEmailDraft = {
    draft_id: crypto.randomUUID(),
    status: "ready",
    recipient_user_id: selected.staff_user_id,
    recipient_name: selected.full_name,
    recipient_email: selected.email,
    recipient_roles: selected.roles,
    subject,
    message,
    report_reference: reportRef,
    candidates: params.recipients,
  };

  const replyText =
    `I have prepared a report email draft to ${selected.full_name} (${selected.email}) for "${reportRef.title}" (${reportRef.period}).\n` +
    `- Subject: ${subject}\n` +
    `- Attachment: ${reportRef.filename} (${reportRef.row_count} ${reportRef.row_count === 1 ? "row" : "rows"})\n` +
    `- Review the draft card below and press Send when you are ready, or Edit / Cancel.\n\n` +
    `Source: ${reportRef.source} · Period: ${reportRef.period}`;

  return {
    kind: "draft_ready",
    replyText,
    draft,
  };
}
