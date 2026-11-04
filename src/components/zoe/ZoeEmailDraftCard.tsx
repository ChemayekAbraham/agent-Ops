import React, { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  Loader2,
  Mail,
  Pencil,
  Send,
  UserCheck,
  X,
} from 'lucide-react';
import {
  exportZoeReportPdf,
  sendZoeReportEmail,
  type SendZoeReportEmailInput,
  type SendZoeReportEmailResponse,
  type ZoeEmailDraftPayload,
  type ZoeExportableReport,
  type ZoeStaffRecipientCandidate,
} from '@/lib/zoe';

export interface ZoeEmailDraftCardProps {
  draft: ZoeEmailDraftPayload;
  report?: ZoeExportableReport | null;
  messageId?: string;
  onSendEmail?: (input: SendZoeReportEmailInput) => Promise<SendZoeReportEmailResponse>;
}

/**
 * Interactive email draft card shown in Zoe chat when `draft_report_email` returns a draft.
 *
 * Displays:
 *   - To (recipient name and email; or a multi-match staff picker when several staff matched)
 *   - Subject
 *   - Short message
 *   - PDF attachment preview (filename, report title, source, period, row count)
 *   - Send, Edit, and Cancel buttons (minimum 44px tap targets, mobile-first, no emojis)
 *
 * Never sends automatically: only pressing "Send" calls `staff-assistant-send-email`.
 */
export const ZoeEmailDraftCard: React.FC<ZoeEmailDraftCardProps> = ({
  draft,
  report = null,
  messageId,
  onSendEmail = sendZoeReportEmail,
}) => {
  const initialRecipient: ZoeStaffRecipientCandidate | null =
    draft.recipient_email
      ? {
          staff_user_id: draft.recipient_user_id ?? '',
          full_name: draft.recipient_name ?? draft.recipient_email,
          email: draft.recipient_email,
          roles: draft.recipient_roles,
        }
      : null;

  const [selectedRecipient, setSelectedRecipient] = useState<ZoeStaffRecipientCandidate | null>(
    initialRecipient,
  );
  const [subject, setSubject] = useState(draft.subject);
  const [message, setMessage] = useState(draft.message);
  const [isEditing, setIsEditing] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isCancelled, setIsCancelled] = useState(false);
  const [sentResult, setSentResult] = useState<SendZoeReportEmailResponse | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  if (isCancelled) {
    return (
      <div
        data-testid="zoe-email-draft-cancelled"
        className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground"
      >
        <span>Email draft cancelled. No email was sent.</span>
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

  if (sentResult?.ok) {
    return (
      <div
        data-testid="zoe-email-draft-sent"
        className="mt-3 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs text-foreground"
      >
        <div className="flex items-center gap-2 font-semibold text-primary">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Report shared from Zoe</span>
        </div>
        <p className="mt-1 leading-relaxed text-muted-foreground">
          Sent <span className="font-medium text-foreground">{subject}</span> with PDF attachment (
          <span className="font-mono">{sentResult.attachment_filename || draft.report_reference.filename}</span>
          ) to{' '}
          <span className="font-semibold text-foreground">
            {sentResult.recipient_name || selectedRecipient?.full_name} (
            {sentResult.recipient_email || selectedRecipient?.email})
          </span>
          .
        </p>
      </div>
    );
  }

  const needsRecipientPick = !selectedRecipient && draft.candidates.length > 0;

  const handleSend = async () => {
    if (isSending) return;
    if (!selectedRecipient?.email) {
      setSendError('Please select a staff recipient before sending.');
      return;
    }
    setIsSending(true);
    setSendError(null);
    try {
      const wasModified =
        selectedRecipient.email.toLowerCase() !== (draft.recipient_email ?? '').toLowerCase() ||
        subject.trim() !== draft.subject.trim() ||
        message.trim() !== draft.message.trim();

      const res = await onSendEmail({
        draft_id: draft.draft_id,
        rebind_draft: wasModified,
        recipient_email: selectedRecipient.email,
        recipient_name: selectedRecipient.full_name,
        subject,
        message,
        report_reference: draft.report_reference,
        message_id: messageId ?? null,
      });
      if (!res.ok) {
        setSendError(res.error || 'Could not send report email.');
      } else {
        setSentResult(res);
        setIsEditing(false);
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Could not send report email.');
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div
      data-testid="zoe-email-draft-card"
      className="mt-3 rounded-lg border border-primary/30 bg-card p-3.5 text-card-foreground shadow-sm"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border pb-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Mail className="h-4 w-4" aria-hidden="true" />
          </span>
          <div>
            <h4 className="text-xs font-semibold text-foreground sm:text-sm">
              Report Email Draft · Never sent until you press Send
            </h4>
            <p className="text-xs text-muted-foreground">
              Template: Report shared from Zoe
            </p>
          </div>
        </div>
      </div>

      {/* Multi-match staff recipient picker when several staff matched */}
      {(needsRecipientPick || draft.candidates.length > 1) && (
        <div
          data-testid="zoe-email-draft-recipient-picker"
          className="mt-3 rounded-md border border-primary/25 bg-primary/5 p-2.5"
        >
          <p className="text-xs font-semibold text-foreground">
            {selectedRecipient
              ? 'Matched staff recipients (tap to switch):'
              : 'Several active staff members matched. Please pick the recipient:'}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {draft.candidates.map((cand) => {
              const isSelected =
                selectedRecipient?.email.toLowerCase() === cand.email.toLowerCase();
              return (
                <button
                  key={cand.staff_user_id || cand.email}
                  type="button"
                  data-testid={`zoe-email-candidate-${cand.email}`}
                  onClick={() => {
                    setSelectedRecipient(cand);
                    setSendError(null);
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

      {/* Draft fields: To, Subject, Message */}
      <dl className="mt-3 space-y-2 text-xs">
        <div className="rounded-md border border-border/80 bg-muted/30 px-3 py-2">
          <dt className="font-medium text-muted-foreground">To (Verified Welile Staff)</dt>
          <dd
            data-testid="zoe-email-draft-to"
            className="mt-0.5 font-semibold text-foreground"
          >
            {selectedRecipient
              ? `${selectedRecipient.full_name} <${selectedRecipient.email}>`
              : 'Select a staff recipient above'}
          </dd>
        </div>

        <div className="rounded-md border border-border/80 bg-muted/30 px-3 py-2">
          <dt className="font-medium text-muted-foreground">Subject</dt>
          {isEditing ? (
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              data-testid="zoe-email-draft-subject-input"
              maxLength={160}
              className="mt-1 min-h-[44px] w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          ) : (
            <dd
              data-testid="zoe-email-draft-subject"
              className="mt-0.5 font-semibold text-foreground"
            >
              {subject}
            </dd>
          )}
        </div>

        <div className="rounded-md border border-border/80 bg-muted/30 px-3 py-2">
          <dt className="font-medium text-muted-foreground">Message</dt>
          {isEditing ? (
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              data-testid="zoe-email-draft-message-input"
              rows={3}
              maxLength={1000}
              className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          ) : (
            <dd
              data-testid="zoe-email-draft-message"
              className="mt-0.5 whitespace-pre-wrap leading-relaxed text-foreground"
            >
              {message}
            </dd>
          )}
        </div>
      </dl>

      {/* Attachment Preview */}
      <div
        data-testid="zoe-email-draft-attachment"
        className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
      >
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <p className="truncate font-semibold text-foreground">
              {draft.report_reference.filename}
            </p>
            <p className="truncate text-muted-foreground">
              {draft.report_reference.title} · {draft.report_reference.period} ·{' '}
              {draft.report_reference.row_count.toLocaleString('en-UG')}{' '}
              {draft.report_reference.row_count === 1 ? 'row' : 'rows'} · PDF attached
            </p>
          </div>
        </div>
        {report && (
          <button
            type="button"
            onClick={() => void exportZoeReportPdf(report)}
            data-testid="zoe-email-draft-preview-pdf"
            className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            <span>Preview PDF</span>
          </button>
        )}
      </div>

      {/* Error message if send failed */}
      {sendError && (
        <div
          data-testid="zoe-email-draft-error"
          role="alert"
          className="mt-2.5 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{sendError}</span>
        </div>
      )}

      {/* Action Buttons: Send, Edit, Cancel */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={isSending || !selectedRecipient?.email}
          data-testid="zoe-email-draft-send"
          className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
        >
          {isSending ? (
            <Loader2 className="h-4 w-4 animate-spin shrink-0" aria-hidden="true" />
          ) : (
            <Send className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <span>Send</span>
        </button>

        <button
          type="button"
          onClick={() => setIsEditing((prev) => !prev)}
          disabled={isSending}
          data-testid="zoe-email-draft-edit"
          className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Pencil className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{isEditing ? 'Done editing' : 'Edit'}</span>
        </button>

        <button
          type="button"
          onClick={() => setIsCancelled(true)}
          disabled={isSending}
          data-testid="zoe-email-draft-cancel"
          className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Cancel</span>
        </button>
      </div>
    </div>
  );
};

export default ZoeEmailDraftCard;
