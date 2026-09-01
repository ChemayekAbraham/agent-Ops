import { useEffect, useState } from 'react';
import { Paperclip } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/hr/api/client';

export interface TicketDetailRow {
  id: string;
  ref: string;
  title: string;
  body: string | null;
  severity: string;
  origin?: string | null;
  raised_at: string;
  reported_at?: string | null;
  reporter_name?: string | null;
  reporter_contact?: string | null;
  reporter_channel?: string | null;
  reporter_words?: string | null;
  severity_basis?: string | null;
  resolution_summary?: string | null;
  close_reason?: string | null;
  task_id?: string | null;
  closed_no_task_at?: string | null;
  hr_ticket_surfaces?: { label: string } | null;
}

export interface TicketPeople {
  raised_by_name?: string | null;
  closed_by_name?: string | null;
  assignee_name?: string | null;
  task_title?: string | null;
}

interface Attachment {
  id: string;
  file_name: string | null;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
}

interface TicketDetailDialogProps {
  ticket: TicketDetailRow | null;
  people?: TicketPeople;
  creatorLabel?: string;
  stateLabel: string;
  severityLabel: string;
  canClaim?: boolean;
  claiming?: boolean;
  onClaim?: () => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
}

const CHANNEL_LABEL: Record<string, string> = {
  phone: 'Phone',
  whatsapp: 'WhatsApp',
  email: 'Email',
  in_person: 'In person',
  in_app: 'In the app',
};

function when(value?: string | null) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function sizeLabel(bytes: number | null) {
  if (!bytes) return '';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 break-words text-sm font-medium text-foreground">{value || '—'}</p>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  );
}

export default function TicketDetailDialog({
  ticket,
  people,
  creatorLabel,
  stateLabel,
  severityLabel,
  canClaim,
  claiming,
  onClaim,
  onOpenChange,
}: TicketDetailDialogProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  useEffect(() => {
    if (!ticket?.id) {
      setAttachments([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('hr_task_attachments')
        .select('id, file_name, storage_path, mime_type, size_bytes')
        .eq('ticket_id', ticket.id);
      if (cancelled) return;
      if (error) {
        setAttachments([]);
        return;
      }
      setAttachments((data ?? []) as unknown as Attachment[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [ticket?.id]);

  const openAttachment = async (path: string) => {
    const { data } = await supabase.storage.from('task-evidence').createSignedUrl(path, 300);
    if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <Dialog open={!!ticket} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto p-0">
        {ticket ? (
          <>
            <DialogHeader className="space-y-2 border-b border-border/60 bg-muted/30 px-5 py-4 text-left">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md border border-border/60 bg-background px-2 py-0.5 font-mono text-[11px] font-medium text-muted-foreground">
                  {ticket.ref}
                </span>
                <Badge
                  variant="outline"
                  className={
                    ticket.severity === 'critical'
                      ? 'rounded-full border-destructive/30 bg-destructive/10 px-2.5 py-0.5 text-[11px] font-medium text-destructive'
                      : 'rounded-full border-border bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground'
                  }
                >
                  {severityLabel}
                </Badge>
                <Badge
                  variant="outline"
                  className="rounded-full border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-primary"
                >
                  {stateLabel}
                </Badge>
              </div>
              <DialogTitle className="text-base font-semibold leading-snug tracking-tight">
                {ticket.title}
              </DialogTitle>
              <DialogDescription className="text-xs">
                Raised by {creatorLabel || people?.raised_by_name || '—'} · {when(ticket.raised_at)}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 px-5 pb-5">
              <div className="rounded-xl border border-border/60 bg-card p-3.5">
                <SectionLabel>Description</SectionLabel>
                <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed">
                  {ticket.body || '—'}
                </p>
              </div>

              <Separator className="bg-border/60" />


              <div className="grid gap-2.5 sm:grid-cols-2">
                <Field label="Area" value={ticket.hr_ticket_surfaces?.label} />
                <Field label="How bad" value={severityLabel} />
                <Field label="Why this severity" value={ticket.severity_basis} />
                <Field
                  label="Origin"
                  value={ticket.origin === 'external' ? 'External' : 'Internal'}
                />
                <Field label="Raised" value={when(ticket.raised_at)} />
                <Field label="Reported" value={when(ticket.reported_at)} />
                <Field label="Raised by" value={creatorLabel || people?.raised_by_name} />
                <Field label="Status" value={stateLabel} />
              </div>

              {(ticket.reporter_name ||
                ticket.reporter_contact ||
                ticket.reporter_channel ||
                ticket.reporter_words) && (
                <>
                  <Separator className="bg-border/60" />
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    <Field label="Reporter" value={ticket.reporter_name} />
                    <Field label="Contact" value={ticket.reporter_contact} />
                    <Field
                      label="Channel"
                      value={
                        ticket.reporter_channel
                          ? CHANNEL_LABEL[ticket.reporter_channel] ?? ticket.reporter_channel
                          : null
                      }
                    />
                    <Field label="Their words" value={ticket.reporter_words} />
                  </div>
                </>
              )}

              {(people?.assignee_name || people?.task_title || ticket.closed_no_task_at) && (
                <>
                  <Separator className="bg-border/60" />
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    <Field label="Picked up by" value={people?.assignee_name} />
                    <Field label="Work item" value={people?.task_title} />
                    <Field label="Closed" value={when(ticket.closed_no_task_at)} />
                    <Field label="Closed by" value={people?.closed_by_name} />
                    <Field label="Close reason" value={ticket.close_reason} />
                    <Field label="Resolution" value={ticket.resolution_summary} />
                  </div>
                </>
              )}

              <Separator className="bg-border/60" />
              <div className="space-y-2">
                <SectionLabel>Attachments</SectionLabel>
                {attachments.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border/70 px-3 py-2.5 text-sm text-muted-foreground">
                    None attached
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {attachments.map((a) => (
                      <li
                        key={a.id}
                        className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm transition-colors hover:border-primary/30 hover:bg-primary/[0.05]"
                      >
                        <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <button
                          type="button"
                          className="truncate rounded text-left font-medium underline-offset-2 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => void openAttachment(a.storage_path)}
                        >
                          {a.file_name || a.storage_path.split('/').pop()}
                        </button>
                        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                          {sizeLabel(a.size_bytes)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {canClaim && onClaim ? (
                <div className="flex flex-wrap justify-end gap-2 border-t border-border/60 pt-3">
                  <Button
                    size="sm"
                    className="h-9 rounded-full px-5 font-semibold shadow-sm"
                    disabled={claiming}
                    onClick={() => void onClaim()}
                  >
                    {claiming ? 'Claiming…' : 'Claim'}
                  </Button>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
