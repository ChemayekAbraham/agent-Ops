import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowRight, Loader2, MessageSquareWarning, PhoneCall, Users } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { useMyPendingConcerns, useAcknowledgeConcerns } from '@/hooks/useMyPendingConcerns';
import { CONCERN_PRIORITY_LABEL, CONCERN_STATUS_LABEL } from '@/hooks/useCallingConcerns';

/**
 * ConcernAssignmentGate — popup telling a staff member that a Calling Center
 * concern has been passed to them (from Made Calls or Received Calls).
 *
 * Follows the same shape as RequisitionUsageReportGate: one global shadcn
 * Dialog, driven purely by a live "is anything still open" query, opened on
 * first discovery and re-opened every REMIND_INTERVAL_MS while something
 * stays open, kept fresh by a realtime subscription. Closing it (or clicking
 * View Concerns) only snoozes it — the concern's own status is the sole
 * authority for whether it keeps coming back, so it reappears on every login
 * and every refresh for as long as any concern forwarded to this person is
 * not 'completed', exactly like the Requisitions gate reappears while a
 * report is outstanding.
 *
 * Concerns that are finished (status = 'completed') never appear. Nothing
 * about forwarding rules, concern statuses or the audit trail is touched —
 * dismiss/View Concerns still call cc_acknowledge_concern, which only feeds
 * the separate "Confirmed" badge in ConcernParticipantsPanel and has no
 * bearing on whether this popup shows.
 */

const REMIND_INTERVAL_MS = 5 * 60 * 1000;

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

const priorityTone = (priority: string) =>
  priority === 'critical' || priority === 'high'
    ? 'border-destructive/30 bg-destructive/10 text-destructive'
    : 'border-border bg-muted text-muted-foreground';

export function ConcernAssignmentGate() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: pending = [], refetch } = useMyPendingConcerns(!!user?.id);
  const acknowledge = useAcknowledgeConcerns();
  const [open, setOpen] = useState(false);
  const openedOnceRef = useRef(false);

  // Keep the list live: a new hand-off, or being added to an existing concern,
  // writes a cc_concern_reviewers row for this person.
  useEffect(() => {
    if (!user?.id) return;
    const channel = supabase
      .channel(`concern-assignment-gate-${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'cc_concern_reviewers', filter: `user_id=eq.${user.id}` },
        () => { void refetch(); },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user?.id, refetch]);

  // Open on first discovery (login, and again after every refresh while
  // anything is still open), then keep re-opening on a timer for as long as
  // the tab stays open and something remains unresolved — same shape as
  // RequisitionUsageReportGate.
  useEffect(() => {
    if (pending.length === 0) { openedOnceRef.current = false; setOpen(false); return; }
    if (!openedOnceRef.current) {
      openedOnceRef.current = true;
      setOpen(true);
    }
    const timer = window.setInterval(() => setOpen(true), REMIND_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [pending.length]);

  const dismiss = async () => {
    setOpen(false);
    try { await acknowledge.mutateAsync(null); } catch { /* retried on next load */ }
  };

  const viewConcerns = async () => {
    setOpen(false);
    try { await acknowledge.mutateAsync(null); } catch { /* retried on next load */ }
    navigate('/me/concerns');
  };

  if (!user?.id || pending.length === 0) return null;

  const many = pending.length > 1;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) void dismiss(); }}>
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
