/**
 * Email draft extraction and send helper for Zoe (`draft_report_email` -> `staff-assistant-send-email`).
 *
 * Rules:
 *   - `draft_report_email` never sends; it only returns a draft in `reportPayload.email_draft`.
 *   - Only clicking "Send" on the draft card invokes `staff-assistant-send-email`.
 */
import {
  sanitizeWelileTerms,
  type ZoeExportableMessageInput,
} from './zoeReportData';

export interface ZoeStaffRecipientCandidate {
  staff_user_id: string;
  full_name: string;
  email: string;
  roles: string[];
}

export interface ZoeEmailReportReference {
  tool: string;
  rpc: string;
  args: Record<string, unknown>;
  source: string;
  period: string;
  title: string;
  row_count: number;
  filename: string;
}

export interface ZoeEmailDraftPayload {
  draft_id: string;
  status: 'ready' | 'pick_recipient';
  recipient_user_id: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  recipient_roles: string[];
  subject: string;
  message: string;
  report_reference: ZoeEmailReportReference;
  candidates: ZoeStaffRecipientCandidate[];
}

export interface SendZoeReportEmailInput {
  draft_id?: string | null;
  rebind_draft?: boolean;
  recipient_email: string;
  recipient_name?: string | null;
  subject: string;
  message: string;
  report_reference: ZoeEmailReportReference;
  conversation_id?: string | null;
  message_id?: string | null;
}

export interface SendZoeReportEmailResponse {
  ok: boolean;
  sent?: boolean;
  error?: string;
  code?: string;
  sign_in_url?: string;
  recipient_email?: string;
  recipient_name?: string;
  subject?: string;
  attachment_filename?: string;
  remaining_emails_today?: number;
}

/**
 * Extracts a `ZoeEmailDraftPayload` from a Zoe assistant message if `reportPayload.email_draft` is present.
 */
export function extractZoeEmailDraft(
  message: ZoeExportableMessageInput,
): ZoeEmailDraftPayload | null {
  if (!message || (message.role && message.role !== 'assistant')) return null;
  const payload = message.reportPayload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const rawDraft = payload.email_draft;
  if (!rawDraft || typeof rawDraft !== 'object' || Array.isArray(rawDraft)) return null;

  const d = rawDraft as Record<string, unknown>;
  const rawRef =
    d.report_reference && typeof d.report_reference === 'object' && !Array.isArray(d.report_reference)
      ? (d.report_reference as Record<string, unknown>)
      : {};

  const candidates: ZoeStaffRecipientCandidate[] = Array.isArray(d.candidates)
    ? d.candidates
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
        .filter((c) => Boolean(c.email))
    : [];

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

  const tool = typeof rawRef.tool === 'string' && rawRef.tool ? rawRef.tool : String(payload.tool ?? 'my_profile');
  const rpc = typeof rawRef.rpc === 'string' && rawRef.rpc ? rawRef.rpc : String(payload.rpc ?? `assistant_staff_${tool}`);
  const source = typeof rawRef.source === 'string' && rawRef.source ? rawRef.source : String(payload.source ?? rpc);
  const period = typeof rawRef.period === 'string' && rawRef.period ? rawRef.period : String(message.period ?? 'Current Period');
  const title = sanitizeWelileTerms(
    typeof rawRef.title === 'string' && rawRef.title ? rawRef.title : 'Zoe Staff Report',
  );
  const rowCount =
    typeof rawRef.row_count === 'number' && Number.isFinite(rawRef.row_count)
      ? rawRef.row_count
      : Array.isArray(payload.rows)
        ? payload.rows.length
        : 1;
  const filename =
    typeof rawRef.filename === 'string' && rawRef.filename.trim()
      ? rawRef.filename.trim()
      : 'Welile-Zoe-Report.pdf';

  return {
    draft_id: typeof d.draft_id === 'string' && d.draft_id ? d.draft_id : 'draft-1',
    status,
    recipient_user_id: typeof d.recipient_user_id === 'string' ? d.recipient_user_id : null,
    recipient_name: recipientName,
    recipient_email: recipientEmail,
    recipient_roles: Array.isArray(d.recipient_roles)
      ? d.recipient_roles.map((r) => String(r))
      : [],
    subject: sanitizeWelileTerms(
      typeof d.subject === 'string' && d.subject.trim()
        ? d.subject.trim()
        : `Report shared from Zoe: ${title} (${period})`,
    ),
    message: sanitizeWelileTerms(
      typeof d.message === 'string' && d.message.trim()
        ? d.message.trim()
        : `Please find attached the ${title} for ${period}.`,
    ),
    report_reference: {
      tool,
      rpc,
      args:
        rawRef.args && typeof rawRef.args === 'object' && !Array.isArray(rawRef.args)
          ? (rawRef.args as Record<string, unknown>)
          : {},
      source,
      period,
      title,
      row_count: rowCount,
      filename,
    },
    candidates,
  };
}

/**
 * Invokes the `staff-assistant-send-email` edge function when the user clicks "Send" on the draft card.
 */
export async function sendZoeReportEmail(
  input: SendZoeReportEmailInput,
): Promise<SendZoeReportEmailResponse> {
  const { supabase } = await import('@/integrations/supabase/client');
  const sanitizedSubject = sanitizeWelileTerms(input.subject.trim());
  const sanitizedMessage = sanitizeWelileTerms(input.message.trim());
  const trimmedEmail = input.recipient_email.trim();

  let draftId = input.draft_id ?? null;
  if ((input.rebind_draft || !draftId) && typeof supabase.rpc === 'function') {
    const { data: savedDraft, error: draftErr } = await supabase.rpc(
      'staff_assistant_save_draft' as never,
      {
        p_kind: 'email',
        p_payload: {
          kind: 'email',
          recipient_email: trimmedEmail.toLowerCase(),
          subject: sanitizedSubject,
          message: sanitizedMessage,
          report_reference: {
            tool: input.report_reference.tool,
            rpc: input.report_reference.rpc,
            args: input.report_reference.args ?? {},
          },
        },
        p_conversation_id: input.conversation_id ?? null,
      } as never,
    );
    if (draftErr) {
      return {
        ok: false,
        error: draftErr.message || 'Could not prepare email draft for sending.',
      };
    }
    const row = (savedDraft ?? {}) as Record<string, unknown>;
    if (typeof row.draft_id === 'string' && row.draft_id) {
      draftId = row.draft_id;
    }
  }

  const { data, error } = await supabase.functions.invoke<SendZoeReportEmailResponse>(
    'staff-assistant-send-email',
    {
      body: {
        ...(draftId ? { draft_id: draftId } : {}),
        recipient_email: trimmedEmail,
        ...(input.recipient_name ? { recipient_name: input.recipient_name.trim() } : {}),
        subject: sanitizedSubject,
        message: sanitizedMessage,
        report_reference: input.report_reference,
        ...(input.conversation_id ? { conversation_id: input.conversation_id } : {}),
        ...(input.message_id ? { message_id: input.message_id } : {}),
      },
    },
  );

  if (error) {
    return {
      ok: false,
      error: error.message || 'Could not send the report email right now.',
    };
  }

  if (!data || data.ok !== true) {
    return {
      ok: false,
      error: data?.error || 'Could not send the report email right now.',
      code: data?.code,
      sign_in_url: data?.sign_in_url,
    };
  }

  return data;
}
