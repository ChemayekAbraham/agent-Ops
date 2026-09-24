/**
 * Tenant details modal for the Calling Center.
 *
 * Presentation only. Pressing "Call" here runs the *existing* dialer path
 * (`dialer.dial(row)`) unchanged — reveal, ringing, statuses, comments and
 * follow-ups all keep behaving exactly as before. This modal simply puts the
 * tenant's relevant detail in front of the officer before the line opens, so
 * the queue list itself can stay lean.
 *
 * For a tenant whose call is finished (they have left the active calling queue)
 * the existing call history is shown first, and the same Call button reopens the
 * line — no second calling system, no new call records.
 */
import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { History, Loader2, PencilLine, Phone } from 'lucide-react';
import type { CcCallingHub, CcRow, CcSeverity } from '@/hooks/useCcCallingHub';
import { CC_OUTCOME_LABEL } from '@/hooks/useCcCallHistory';
import { useCcSubjectCallHistory } from '@/hooks/useCcSubjectCallHistory';
import { useCcFeedbackAmendments, type CcFeedbackAmendment } from '@/hooks/useCcFeedbackAmendments';
import { EditCallFeedbackDialog } from './EditCallFeedbackDialog';
import { TenantCallContextPanel } from './TenantCallContextPanel';
import { TenantCallPacePanel } from './TenantCallPacePanel';
import { TenantPaymentHistoryPanel } from './TenantPaymentHistoryPanel';

const titleCase = (v?: string | null) => (v ? String(v).replace(/_/g, ' ') : null);

const stamp = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

/**
 * Rows in these states are done with the active queue: the outcome has been
 * recorded and the roster row is no longer waiting to be called. For those the
 * history leads, because the officer is deciding whether to call back.
 */
const OUT_OF_QUEUE_STATES = new Set(['engaged', 'closed', 'unreachable', 'parked']);

/** One line per tracked edit, showing what changed and why. */
function EditTrail({ amendments }: { amendments: CcFeedbackAmendment[] }) {
  if (!amendments.length) return null;
  return (
    <div className="mt-1.5 space-y-1 border-t border-dashed border-border/60 pt-1.5">
      {amendments.map((a) => (
        <div key={a.id} className="text-[10px] text-muted-foreground">
          <span className="font-semibold text-foreground">Edited</span> {stamp(a.editedAt)}
          {a.editorName ? ` · ${a.editorName}` : ''} — {a.reason}
          {a.oldCategoryLabel && a.newCategoryLabel && a.oldCategoryLabel !== a.newCategoryLabel && (
            <span>
              {' '}
              · category {a.oldCategoryLabel} → {a.newCategoryLabel}
            </span>
          )}
          {a.oldSeverity && a.newSeverity && a.oldSeverity !== a.newSeverity && (
            <span>
              {' '}
              · severity {a.oldSeverity} → {a.newSeverity}
            </span>
          )}
          {a.oldNote && a.oldNote !== a.newNote && (
            <p className="mt-0.5 italic">Previously: “{a.oldNote}”</p>
          )}
        </div>
      ))}
    </div>
  );
}

function PastCallsPanel({
  hub,
  subjectId,
  enabled,
}: {
  hub: CcCallingHub;
  subjectId: string | null;
  enabled: boolean;
}) {
  const { data, isLoading } = useCcSubjectCallHistory('tenant', subjectId, enabled);
  const calls = data ?? [];

  const attemptIds = useMemo(() => calls.map((c) => c.id), [calls]);
  const { data: amendments } = useCcFeedbackAmendments(attemptIds, enabled);
  const trailByAttempt = useMemo(() => {
    const map = new Map<string, CcFeedbackAmendment[]>();
    (amendments ?? []).forEach((a) => {
      map.set(a.attemptId, [...(map.get(a.attemptId) ?? []), a]);
    });
    return map;
  }, [amendments]);

  const [editing, setEditing] = useState<{
    feedbackId: string;
    categoryId: string | null;
    severity: CcSeverity | null;
    comment: string | null;
    attemptNo: number;
  } | null>(null);

  return (
    <div className="rounded-xl border border-primary/25 bg-primary/5 p-2.5">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-primary">
        <History className="h-3.5 w-3.5" />
        Previous calls {calls.length > 0 && <span className="tabular-nums">({calls.length})</span>}
      </p>
      {isLoading ? (
        <div className="space-y-1.5">
          <Skeleton className="h-9 w-full rounded-lg" />
          <Skeleton className="h-9 w-full rounded-lg" />
        </div>
      ) : !calls.length ? (
        <p className="text-[11px] text-muted-foreground">No call has been recorded for this tenant yet.</p>
      ) : (
        <ul className="max-h-44 space-y-1.5 overflow-y-auto">
          {calls.slice(0, 12).map((c) => (
            <li key={c.id} className="rounded-lg border border-border/60 bg-background/80 px-2 py-1.5 text-[11px]">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="text-[10px]">
                  #{c.attemptNo}
                </Badge>
                <span className="font-semibold">
                  {c.outcome ? CC_OUTCOME_LABEL[c.outcome] : 'Open (outcome not recorded)'}
                </span>
                <span className="text-muted-foreground">{stamp(c.recordedAt ?? c.revealedAt)}</span>
                {c.officerName && <span className="text-muted-foreground">· {c.officerName}</span>}
                {(trailByAttempt.get(c.id)?.length ?? 0) > 0 && (
                  <Badge variant="secondary" className="text-[10px] font-semibold">
                    Edited
                  </Badge>
                )}
                {c.feedbackId && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-6 gap-1 px-1.5 text-[10px] font-semibold text-primary hover:bg-primary/10"
                    onClick={() =>
                      setEditing({
                        feedbackId: c.feedbackId!,
                        categoryId: c.categoryId,
                        severity: c.severity,
                        comment: c.comment,
                        attemptNo: c.attemptNo,
                      })
                    }
                  >
                    <PencilLine className="h-3 w-3" />
                    Edit feedback
                  </Button>
                )}
              </div>
              {(c.categoryLabel || c.comment || c.voidReason) && (
                <p className="mt-0.5 text-muted-foreground">
                  {c.categoryLabel && <span className="font-medium text-foreground">{c.categoryLabel}: </span>}
                  {c.comment || c.voidReason}
                </p>
              )}
              <EditTrail amendments={trailByAttempt.get(c.id) ?? []} />
            </li>
          ))}
        </ul>
      )}
      <EditCallFeedbackDialog hub={hub} open={!!editing} call={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

export function TenantCallDetailsDialog({
  hub,
  row,
  open,
  starting,
  canCall,
  wipBlocked,
  onCall,
  onClose,
}: {
  hub: CcCallingHub;
  row: CcRow | null;
  open: boolean;
  starting: boolean;
  canCall: boolean;
  wipBlocked: boolean;
  onCall: (row: CcRow) => void;
  onClose: () => void;
}) {
  const outOfQueue = !!row?.state && OUT_OF_QUEUE_STATES.has(String(row.state));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-lg flex-col gap-0 overflow-hidden p-0">
        {row && (
          <>
            <DialogHeader className="space-y-1 border-b bg-muted/30 p-4 text-left">
              <DialogTitle className="truncate text-sm font-bold sm:text-base">{row.name}</DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-1.5 text-[11px]">
                {row.district && (
                  <Badge variant="outline" className="text-[10px]">
                    {row.district}
                  </Badge>
                )}
                {row.state && (
                  <Badge variant="outline" className="text-[10px]">
                    {titleCase(row.state)}
                  </Badge>
                )}
                <span className="text-muted-foreground">
                  {row.attempts_made} attempt{row.attempts_made === 1 ? '' : 's'} so far
                </span>
              </DialogDescription>
            </DialogHeader>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {outOfQueue && <PastCallsPanel hub={hub} subjectId={row.subject_id} enabled={open} />}
              <TenantPaymentHistoryPanel tenantId={row.subject_id} enabled={open} />
              <TenantCallContextPanel
                hub={hub}
                subjectId={row.subject_id}
                fallbackName={row.name}
                district={row.district}
                linkedAgent={row.linked_agent}
                phone={null}
                row={row}
              />
              <TenantCallPacePanel subjectId={row.subject_id} />
            </div>

            <div className="flex items-center gap-2 border-t bg-background p-3">
              <Button type="button" variant="outline" className="h-11 text-xs font-semibold" onClick={onClose}>
                Close
              </Button>
              <Button
                type="button"
                className="h-11 flex-1 text-xs font-semibold"
                disabled={!canCall || starting}
                onClick={() => onCall(row)}
              >
                {starting ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Phone className="mr-1.5 h-4 w-4" />
                )}
                {outOfQueue ? 'Call again' : `Call ${row.name.split(/\s+/)[0]}`}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
