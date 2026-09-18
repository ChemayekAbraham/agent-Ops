/**
 * My Space → Concerns forwarded to me.
 *
 * The same append-only record the Calling Center writes. What a person sees here
 * depends on who they are: the receiver accepts, starts and completes; the sender
 * follows their own hand-offs; HR and the CEO see everything without acting.
 */
import { useMemo, useState } from 'react';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertTriangle, ClipboardList, Forward, Inbox, Send } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { ConcernControlPanel } from '@/components/executive/tenant-ops/calling-center/ConcernControlPanel';
import { ConcernParticipantsPanel } from '@/components/executive/tenant-ops/calling-center/ConcernParticipantsPanel';
import { CCEmpty, CC_ROW } from '@/components/executive/tenant-ops/calling-center/ccUi';

import {
  CONCERN_ACTION_LABEL,
  CONCERN_PRIORITY_LABEL,
  CONCERN_STATUS_LABEL,
  isConcernOverdue,
  useConcernEvent,
  useConcernEvents,
  useConcernReviewers,
  type ConcernReviewer,
  useForwardedConcerns,
  type ConcernStatus,
  type ForwardedConcern,
} from '@/hooks/useCallingConcerns';

const stamp = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';

const statusTone: Record<string, string> = {
  sent: 'bg-amber-500/10 text-amber-700',
  received: 'bg-sky-500/10 text-sky-700',
  in_progress: 'bg-primary/10 text-primary',
  completed: 'bg-emerald-500/10 text-emerald-700',
};

function ConcernCard({
  concern,
  mine,
  reviewerRows,
}: {
  concern: ForwardedConcern;
  mine: boolean;
  reviewerRows: ConcernReviewer[];
}) {
  const events = useConcernEvents(concern.id);
  const act = useConcernEvent();
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);

  const run = async (action: 'accepted' | 'started' | 'progress_note' | 'completed') => {
    try {
      await act.mutateAsync({ concern_id: concern.id, action, note: note.trim() || null });
      setNote('');
      toast.success(
        action === 'completed'
          ? 'Marked completed.'
          : action === 'progress_note'
            ? 'Note added.'
            : 'Updated.',
      );
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not update this concern.');
    }
  };

  return (
    <div className={CC_ROW}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-bold">{concern.title}</p>
          <p className="text-[11px] text-muted-foreground">
            {concern.source_kind === 'received_call' ? 'Call that came in' : 'Call we made'}
            {concern.caller_name ? ` · about ${concern.caller_name}` : ''} · from{' '}
            {concern.forwarded_by_name ?? 'Officer'} · {stamp(concern.created_at)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge className={`${statusTone[concern.status] ?? ''} text-[10px] hover:opacity-100`}>
            {CONCERN_STATUS_LABEL[concern.status as ConcernStatus] ?? concern.status}
          </Badge>
          {isConcernOverdue(concern) && (
            <Badge variant="outline" className="border-destructive/40 text-[10px] text-destructive">
              Past due
            </Badge>
          )}
          <Badge variant="outline" className="text-[10px]">
            {CONCERN_PRIORITY_LABEL[concern.priority] ?? concern.priority}
          </Badge>
        </div>
      </div>

      {concern.context && <p className="mt-2 text-[11px] leading-snug">{concern.context}</p>}
      {reviewerRows.length > 0 && (
        <div className="mt-1.5">
          <ConcernParticipantsPanel concern={concern} reviewers={reviewerRows} />
        </div>
      )}
      <div className="mt-1.5">
        <ConcernControlPanel concern={concern} isReceiver={mine} compact />
      </div>

      {concern.status !== 'completed' && (
        <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder={mine ? 'Add a note, or say what you did to resolve it.' : 'Add a note for the person handling it.'}
            className="text-xs"
          />
          <div className="flex flex-wrap gap-1.5">
            {mine && concern.status === 'sent' && (
              <Button size="sm" className="h-8 text-[11px] font-semibold" onClick={() => run('accepted')} disabled={act.isPending}>
                I have got this
              </Button>
            )}
            {mine && concern.status !== 'in_progress' && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-[11px] font-semibold"
                onClick={() => run('started')}
                disabled={act.isPending}
              >
                Start working on it
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-[11px] font-semibold"
              onClick={() => run('progress_note')}
              disabled={act.isPending || note.trim().length < 3}
            >
              Add note
            </Button>
            {mine && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 border-success/40 text-[11px] font-semibold text-success"
                onClick={() => run('completed')}
                disabled={act.isPending || note.trim().length < 10}
                title="Write what was done (at least 10 characters) before completing"
              >
                Mark completed
              </Button>
            )}
          </div>
        </div>
      )}

      {concern.outcome && (
        <p className="mt-2 rounded-xl border border-success/25 bg-success/10 px-2.5 py-2 text-[11px] leading-snug text-success">
          Resolved: {concern.outcome}
        </p>
      )}

      <Button
        size="sm"
        variant="ghost"
        className="mt-1.5 h-7 px-1.5 text-[11px] text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide history' : 'Show history'}
      </Button>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          {events.isLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : (
            (events.data ?? []).map((e) => (
              <div key={e.id} className="rounded-xl border border-border/70 bg-muted/20 p-2">
                <p className="text-[11px] font-semibold">
                  {CONCERN_ACTION_LABEL[e.action] ?? e.action.replace('_', ' ')} · {e.actor_name ?? 'Staff member'}
                </p>
                <p className="text-[10px] text-muted-foreground">{stamp(e.created_at)}</p>
                {e.action === 'reassigned' && (
                  <p className="mt-0.5 text-[11px] leading-snug">
                    From {e.prev_user_name ?? '—'} to {e.new_user_name ?? '—'}
                  </p>
                )}
                {e.action === 'due_changed' && (
                  <p className="mt-0.5 text-[11px] leading-snug">
                    From {stamp(e.prev_due_at)} to {stamp(e.new_due_at)}
                  </p>
                )}
                {(e.action === 'reviewer_added' || e.action === 'reviewer_removed') && (
                  <div className="mt-0.5 space-y-0.5 text-[11px] leading-snug">
                    <p>
                      {e.action === 'reviewer_added' ? 'Added' : 'Took off'}{' '}
                      <span className="font-semibold">{e.new_user_name ?? e.prev_user_name ?? 'staff member'}</span>
                    </p>
                    {(e.prev_recipients || e.new_recipients) && (
                      <p className="text-muted-foreground">
                        Before: {e.prev_recipients || '—'} · After: {e.new_recipients || '—'}
                      </p>
                    )}
                  </div>
                )}
                {e.note && <p className="mt-0.5 text-[11px] leading-snug">{e.note}</p>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const MyConcerns = () => {
  const { user } = useAuth();
  const fromMe = useForwardedConcerns({ days: 120, scope: 'from_me' });
  const everything = useForwardedConcerns({ days: 120, scope: 'all' });
  const allConcerns = useMemo(() => everything.data ?? [], [everything.data]);
  const reviewers = useConcernReviewers(allConcerns.map((c) => c.id));
  const reviewersByConcern = useMemo(() => {
    const map = new Map<string, typeof reviewers.data>();
    (reviewers.data ?? []).forEach((r) => map.set(r.concern_id, [...(map.get(r.concern_id) ?? []), r]));
    return map;
  }, [reviewers.data]);

  // Only people currently on a concern see it under "Sent to me" — someone taken off
  // keeps their place in the history but no longer carries the work.
  const mine = useMemo(
    () =>
      allConcerns.filter(
        (c) =>
          c.forwarded_to === user?.id ||
          (reviewersByConcern.get(c.id) ?? []).some((r) => r.user_id === user?.id && r.active),
      ),
    [allConcerns, reviewersByConcern, user?.id],
  );
  const sent = useMemo(() => fromMe.data ?? [], [fromMe.data]);
  const oversight = useMemo(() => {
    const ids = new Set([...mine, ...sent].map((c) => c.id));
    return (everything.data ?? []).filter((c) => !ids.has(c.id));
  }, [everything.data, mine, sent]);

  const openCount = mine.filter((c) => c.status !== 'completed').length;

  return (
    <PersonalLayout title="Concerns">
      <div className="space-y-4">
        <Card className="rounded-2xl border-border shadow-sm">
          <CardHeader className="border-b border-border/70 bg-gradient-to-r from-primary/[0.07] via-primary/[0.02] to-transparent p-3">
            <div className="flex items-center gap-2.5">
              <div className="shrink-0 rounded-xl bg-primary/10 p-2">
                <ClipboardList className="h-4 w-4 text-primary" />
              </div>
              <CardTitle className="text-sm font-bold leading-tight">Concerns from the Calling Center</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="p-3 text-[11px] leading-snug text-muted-foreground">
            When someone in the Calling Center passes a caller's concern to you, it lands here. Confirm you have it,
            work on it, then write what you did before marking it completed. Nothing is ever deleted — every step stays
            on the record.
            {openCount > 0 && (
              <span className="mt-1.5 flex items-center gap-1.5 font-semibold text-warning">
                <AlertTriangle className="h-3.5 w-3.5" />
                {openCount} waiting for you.
              </span>
            )}
          </CardContent>
        </Card>

        <Tabs defaultValue="to_me">
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1.5 rounded-xl border border-border bg-muted/30 p-1.5">
            <TabsTrigger value="to_me" className="h-9 gap-1.5 rounded-lg px-2.5 text-xs font-semibold">
              <Inbox className="h-3.5 w-3.5" />
              Sent to me
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                {mine.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="from_me" className="h-9 gap-1.5 rounded-lg px-2.5 text-xs font-semibold">
              <Send className="h-3.5 w-3.5" />
              I forwarded
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                {sent.length}
              </Badge>
            </TabsTrigger>
            {oversight.length > 0 && (
              <TabsTrigger value="all" className="h-9 gap-1.5 rounded-lg px-2.5 text-xs font-semibold">
                <Forward className="h-3.5 w-3.5" />
                Everyone else
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                  {oversight.length}
                </Badge>
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="to_me" className="mt-3 space-y-2">
            {everything.isLoading || reviewers.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : mine.length === 0 ? (
              <CCEmpty icon={ClipboardList} title="Nothing has been forwarded to you" hint="Concerns passed to you from the Calling Center will land here." />
            ) : (
              mine.map((c) => <ConcernCard key={c.id} concern={c} mine reviewerRows={reviewersByConcern.get(c.id) ?? []} />)
            )}
          </TabsContent>

          <TabsContent value="from_me" className="mt-3 space-y-2">
            {fromMe.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : sent.length === 0 ? (
              <CCEmpty icon={ClipboardList} title="You have not forwarded any concerns" hint="Anything you pass on to a colleague will be listed here." />
            ) : (
              sent.map((c) => <ConcernCard key={c.id} concern={c} mine={false} reviewerRows={reviewersByConcern.get(c.id) ?? []} />)
            )}
          </TabsContent>

          <TabsContent value="all" className="mt-3 space-y-2">
            <p className="rounded-xl border border-border/80 bg-muted/30 px-2.5 py-2 text-[11px] text-muted-foreground">
              You can see these because of your role. Only the sender and the person handling it can move a concern
              along.
            </p>
            {oversight.map((c) => (
              <ConcernCard key={c.id} concern={c} mine={false} reviewerRows={reviewersByConcern.get(c.id) ?? []} />
            ))}
          </TabsContent>
        </Tabs>
      </div>
    </PersonalLayout>
  );
};

export default MyConcerns;
