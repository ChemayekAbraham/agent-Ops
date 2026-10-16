import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';

export interface NotificationDetail {
  id: string;
  title: string;
  message: string;
  type: string;
  created_at: string | null;
  metadata: Record<string, unknown> | null;
}

interface RequisitionDetail {
  requisition_code: string;
  title: string;
  requester_name: string | null;
  requester_role: string | null;
  department_key: string | null;
  amount: number | string;
  currency: string;
  category: string | null;
  reason: string;
  needed_by: string | null;
  stage: string;
  current_approver_role: string | null;
  approved_amount: number | string | null;
  rejection_reason: string | null;
  supervisor_note: string | null;
  coo_note: string | null;
  ceo_note: string | null;
  cfo_note: string | null;
  created_at: string;
}

const STAGE_LABELS: Record<string, string> = {
  supervisor: 'Supervisor review',
  coo: 'COO review',
  ceo: 'CEO review',
  cfo: 'CFO review',
  approved: 'Approved',
  rejected: 'Rejected',
};

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-xs text-foreground break-words">{children}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-xs font-bold text-foreground border-b border-border pb-1.5">{children}</h4>
  );
}

function NoteRow({ label, note }: { label: string; note: string | null | undefined }) {
  if (!note || !note.trim()) return null;
  return <Row label={label}>{note}</Row>;
}

/**
 * Full-information dialog opened when a bell notification is tapped.
 * For requisition notifications it loads the full requisition record;
 * otherwise it shows the complete notification text and metadata.
 */
export function NotificationDetailDialog({
  notification,
  open,
  onOpenChange,
}: {
  notification: NotificationDetail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [requisition, setRequisition] = useState<RequisitionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const requisitionId = (notification?.metadata?.requisition_id as string | undefined) ?? null;

  useEffect(() => {
    if (!open || !notification || !requisitionId) {
      setRequisition(null);
      setLoadFailed(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    supabase
      .from('staff_requisitions')
      .select(`requisition_code, title, requester_name, requester_role, department_key,
        amount, currency, category, reason, needed_by, stage, current_approver_role,
        approved_amount, rejection_reason, supervisor_note, coo_note, ceo_note, cfo_note, created_at`)
      .eq('id', requisitionId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        if (data) setRequisition(data as RequisitionDetail);
        else setLoadFailed(true);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, notification, requisitionId]);

  if (!notification) return null;

  const meta = notification.metadata ?? {};
  const metaRows = Object.entries(meta).filter(([key]) => key !== 'requisition_id');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-md max-h-[80vh] overflow-y-auto rounded-2xl">
        <DialogHeader className="space-y-1 text-left">
          <DialogTitle className="text-sm font-bold leading-snug">{notification.title}</DialogTitle>
          <DialogDescription className="text-[11px] text-muted-foreground">
            {formatDateTime(notification.created_at)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pb-2">
          {/* Full notification message — never truncated */}
          <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap">{notification.message}</p>

          {requisitionId && (
            <div className="space-y-3">
              {loading ? (
                <p className="text-xs text-muted-foreground animate-pulse">Loading requisition details…</p>
              ) : requisition ? (
                <>
                  <SectionTitle>Requisition details</SectionTitle>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                    <Row label="Reference">{requisition.requisition_code}</Row>
                    <Row label="Amount">{formatUGX(Number(requisition.amount))}</Row>
                    <div className="col-span-2">
                      <Row label="What it is for">{requisition.title}</Row>
                    </div>
                    <Row label="Requested by">
                      {requisition.requester_name ?? '—'}
                      {requisition.requester_role ? ` · ${requisition.requester_role}` : ''}
                    </Row>
                    <Row label="Department">{requisition.department_key ?? '—'}</Row>
                    <Row label="Category">{requisition.category ?? '—'}</Row>
                    <Row label="Needed by">
                      {requisition.needed_by
                        ? new Date(requisition.needed_by).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                        : '—'}
                    </Row>
                    <div className="col-span-2">
                      <Row label="Reason given">{requisition.reason}</Row>
                    </div>
                    <Row label="Current stage">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className={cn(
                            'inline-block w-1.5 h-1.5 rounded-full',
                            requisition.stage === 'approved' ? 'bg-emerald-500' : requisition.stage === 'rejected' ? 'bg-destructive' : 'bg-amber-500',
                          )}
                        />
                        {STAGE_LABELS[requisition.stage] ?? requisition.stage}
                      </span>
                    </Row>
                    {requisition.approved_amount != null && (
                      <Row label="Approved amount">{formatUGX(Number(requisition.approved_amount))}</Row>
                    )}
                  </div>

                  {(requisition.supervisor_note || requisition.coo_note || requisition.ceo_note || requisition.cfo_note || requisition.rejection_reason) && (
                    <div className="space-y-3 pt-1">
                      <SectionTitle>Review notes</SectionTitle>
                      <NoteRow label="Rejection reason" note={requisition.rejection_reason} />
                      <NoteRow label="Supervisor" note={requisition.supervisor_note} />
                      <NoteRow label="COO" note={requisition.coo_note} />
                      <NoteRow label="CEO" note={requisition.ceo_note} />
                      <NoteRow label="CFO" note={requisition.cfo_note} />
                    </div>
                  )}
                </>
              ) : (
                loadFailed && (
                  <p className="text-xs text-muted-foreground">
                    Requisition details could not be loaded. You may not have access to this record.
                  </p>
                )
              )}
            </div>
          )}

          {metaRows.length > 0 && (
            <div className="space-y-3">
              <SectionTitle>More information</SectionTitle>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                {metaRows.map(([key, value]) => (
                  <Row key={key} label={key.replace(/_/g, ' ')}>
                    {typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}
                  </Row>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
