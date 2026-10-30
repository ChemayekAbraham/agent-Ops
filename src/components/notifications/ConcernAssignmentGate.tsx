import { usePolling } from '@/hooks/usePolling';
import { useNavigate } from 'react-router-dom';
import { dismissSessionPopup, type SessionPopupPhase } from '@/lib/sessionPopup';
import { useSessionPopup } from '@/hooks/useSessionPopup';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowRight, Loader2, MessageSquareWarning, PhoneCall, Users } from 'lucide-react';
import { useAuthenticatedAudience } from '@/hooks/useAuthenticatedPoll';
import { useMyPendingConcerns, useAcknowledgeConcerns } from '@/hooks/useMyPendingConcerns';
import { CONCERN_PRIORITY_LABEL, CONCERN_STATUS_LABEL } from '@/hooks/useCallingConcerns';

/**
 * ConcernAssignmentGate — popup telling a staff member that a Calling Center
 * concern has been passed to them (from Made Calls or Received Calls).
 *
 * One dialog per browser session, shared with the email prompt and the
 * budget reminder. Closing it (Escape, click outside, Close, or View
 * Concerns) snoozes every interruption dialog until the next session. The
 * concern list itself is unchanged.
 *
 * Concerns that are finished (status = 'completed') never appear. Nothing
 * about forwarding rules, concern statuses or the audit trail is touched —
 * dismiss/View Concerns still call cc_acknowledge_concern, which only feeds
 * the separate "Confirmed" badge in ConcernParticipantsPanel and has no
 * bearing on whether this popup shows.
 */

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

const priorityTone = (priority: string) =>
  priority === 'critical' || priority === 'high'
    ? 'border-destructive/30 bg-destructive/10 text-destructive'
    : 'border-border bg-muted text-muted-foreground';

export function ConcernAssignmentGate() {
  const signedIn = useAuthenticatedAudience();
  const navigate = useNavigate();
  const { data: pending = [], isFetched, isError, refetch } = useMyPendingConcerns(signedIn);
  const acknowledge = useAcknowledgeConcerns();
  const phase: SessionPopupPhase = !signedIn || isError
    ? 'idle'
    : !isFetched
      ? 'unknown'
      : pending.length > 0
        ? 'ready'
        : 'idle';
  const granted = useSessionPopup('concerns', phase);

  // Keep the list current: a new hand-off, or being added to an existing
  // concern, writes a cc_concern_reviewers row for this person. Polled every
  // 60s (+ on focus) and stopped on sign-out. The old Realtime listener was
  // on cc_concern_reviewers, which is not in the publication (doc 147).
  usePolling(() => refetch(), 60_000, { enabled: signedIn });

  const dismiss = async () => {
    dismissSessionPopup();
    try { await acknowledge.mutateAsync(null); } catch { /* retried on next load */ }
  };

  const viewConcerns = async () => {
    dismissSessionPopup();
    try { await acknowledge.mutateAsync(null); } catch { /* retried on next load */ }
    navigate('/me/concerns');
  };

  if (!signedIn || !granted) return null;

  const many = pending.length > 1;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) void dismiss(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquareWarning className="h-5 w-5 text-amber-600" />
            {many ? `${pending.length} concerns need you` : 'A concern was passed to you'}
          </DialogTitle>
          <DialogDescription>
            {many
              ? `${pending.length} caller concerns from the Calling Center have been assigned to you and are waiting to be looked at.`
              : 'A caller concern from the Calling Center has been assigned to you.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {pending.slice(0, 5).map((c) => (
            <div key={c.concern_id} className="rounded-2xl border bg-muted/30 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">
                  {CONCERN_STATUS_LABEL[c.status as keyof typeof CONCERN_STATUS_LABEL] ?? c.status}
                </Badge>
                <Badge variant="outline" className={priorityTone(c.priority)}>
                  {CONCERN_PRIORITY_LABEL[c.priority] ?? c.priority}
                </Badge>
                {c.participant_count > 1 && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Users className="h-3 w-3" /> {c.participant_count} people on it
                  </span>
                )}
              </div>

              <p className="mt-2 font-semibold leading-snug">{c.title}</p>

              {c.caller_name && (
                <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                  <PhoneCall className="h-3 w-3" /> Caller: {c.caller_name}
                </p>
              )}

              {c.context && (
                <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{c.context}</p>
              )}

              <p className="mt-2 text-xs text-muted-foreground">
                Passed on by {c.added_by_name || c.forwarded_by_name || 'a colleague'} · {fmtDate(c.assigned_at)}
              </p>
              {c.due_at && (
                <p className="text-xs text-muted-foreground">Answer needed by {fmtDate(c.due_at)}</p>
              )}
            </div>
          ))}

          {pending.length > 5 && (
            <p className="text-xs text-muted-foreground">
              And {pending.length - 5} more waiting in your Concerns list.
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => void dismiss()} disabled={acknowledge.isPending}>
            Close
          </Button>
          <Button onClick={() => void viewConcerns()} disabled={acknowledge.isPending}>
            {acknowledge.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            View Concerns
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ConcernAssignmentGate;
