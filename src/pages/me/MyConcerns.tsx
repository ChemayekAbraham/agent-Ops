/**
 * My Space → Concerns forwarded to me.
 *
 * The same append-only record the Calling Center writes. The sender, the current
 * recipient and anyone still an active recipient on the thread can see a concern
 * and act on it. Two named overseers can see all concerns (any status) and can
 * reassign one or change its answer time. Any other active staff member (same
 * access check as this page) can see and browse every concern that is still
 * open under "Open Concerns" and add themselves to it; once completed, a
 * concern reverts to being visible only to the people above.
 */
import { useMemo, useState } from 'react';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertTriangle, CheckCircle2, ClipboardList, Forward, Inbox, Send, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { ConcernControlPanel } from '@/components/executive/tenant-ops/calling-center/ConcernControlPanel';
import { ConcernParticipantsPanel } from '@/components/executive/tenant-ops/calling-center/ConcernParticipantsPanel';
import { ConcernAttachmentsPanel } from '@/components/executive/tenant-ops/calling-center/ConcernAttachmentsPanel';
import { ConcernCaseContextPanel } from '@/components/executive/tenant-ops/calling-center/ConcernCaseContextPanel';
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
  useOpenConcernsDirectory,
  useJoinConcern,
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
  joinable = false,
}: {
  concern: ForwardedConcern;
  mine: boolean;
  reviewerRows: ConcernReviewer[];
  joinable?: boolean;
}) {
  const events = useConcernEvents(concern.id);
  const act = useConcernEvent();
  const join = useJoinConcern();
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);

  const addMyself = async () => {
    try {
      const res = await join.mutateAsync({ concern_id: concern.id });
      toast.success(res.already_present ? "You're already on this concern." : 'Added — it now shows under "Sent to me".');
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not add you to this concern.');
    }
  };

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
    <div className={`${CC_ROW} scroll-mt-24 overflow-hidden`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="line-clamp-2 text-sm font-bold leading-snug">{concern.title}</p>
          <p className="mt-1 text-xs leading-snug text-muted-foreground">
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

      {concern.context && <p className="mt-3 text-sm leading-relaxed">{concern.context}</p>}
      <div className="mt-1.5 space-y-1.5">
        <ConcernCaseContextPanel concernId={concern.id} fallbackName={concern.caller_name} />
        <ConcernAttachmentsPanel concernId={concern.id} />
      </div>
      {reviewerRows.length > 0 && (
        <div className="mt-1.5">
          <ConcernParticipantsPanel concern={concern} reviewers={reviewerRows} />
        </div>
      )}

      {joinable && (
        <Button
          size="sm"
          className="mt-1.5 h-8 gap-1.5 text-[11px] font-semibold"
          onClick={() => void addMyself()}
          disabled={join.isPending}
        >
          <UserPlus className="h-3.5 w-3.5" />
          Add myself to this concern
        </Button>
      )}
      <div className="mt-1.5">
        <ConcernControlPanel concern={concern} isReceiver={mine} compact />
      </div>

      {concern.status !== 'completed' && !joinable && (
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
  const directory = useOpenConcernsDirectory();
  const allConcerns = useMemo(() => everything.data ?? [], [everything.data]);
  const reviewerIds = useMemo(() => {
    const ids = new Set(allConcerns.map((c) => c.id));
    (directory.data ?? []).forEach((c) => ids.add(c.id));
    return Array.from(ids);
  }, [allConcerns, directory.data]);
  const reviewers = useConcernReviewers(reviewerIds);
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

  // Open concerns not already carried by this person — anyone with access to
  // this page can add themselves from here.
  const openToJoin = useMemo(() => {
    const mineIds = new Set(mine.map((c) => c.id));
    return (directory.data ?? []).filter((c) => !mineIds.has(c.id));
  }, [directory.data, mine]);

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
          <CardContent className="p-3 text-xs leading-relaxed text-muted-foreground">
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
          <div className="sticky top-0 z-20 -mx-1 overflow-x-auto bg-background/95 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/85">
          <TabsList className="inline-flex h-auto min-w-max justify-start gap-1.5 rounded-xl border border-border bg-muted/30 p-1.5">
            <TabsTrigger value="to_me" className="min-h-11 gap-1.5 rounded-lg px-3 text-xs font-semibold">
              <Inbox className="h-3.5 w-3.5" />
              Sent to me
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                {mine.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="from_me" className="min-h-11 gap-1.5 rounded-lg px-3 text-xs font-semibold">
              <Send className="h-3.5 w-3.5" />
              I forwarded
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                {sent.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="open" className="min-h-11 gap-1.5 rounded-lg px-3 text-xs font-semibold">
              <UserPlus className="h-3.5 w-3.5" />
              Open Concerns
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                {openToJoin.length}
              </Badge>
            </TabsTrigger>
            {oversight.length > 0 && (
              <TabsTrigger value="all" className="min-h-11 gap-1.5 rounded-lg px-3 text-xs font-semibold">
                <Forward className="h-3.5 w-3.5" />
                Everyone else
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                  {oversight.length}
                </Badge>
              </TabsTrigger>
            )}
          </TabsList>
          </div>

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

          <TabsContent value="open" className="mt-3 space-y-2">
            <p className="rounded-xl border border-border/80 bg-muted/30 px-2.5 py-2 text-[11px] text-muted-foreground">
              Every concern still open across the Calling Center, not yet yours. Add yourself to help out or take
              over — it moves to "Sent to me" and is logged on the concern's history like any other hand-off.
            </p>
            {directory.isLoading || reviewers.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : openToJoin.length === 0 ? (
              <CCEmpty icon={ClipboardList} title="No open concerns to join" hint="Everything currently open is already assigned to someone." />
            ) : (
              openToJoin.map((c) => (
                <ConcernCard key={c.id} concern={c} mine={false} reviewerRows={reviewersByConcern.get(c.id) ?? []} joinable />
              ))
            )}
          </TabsContent>

          <TabsContent value="all" className="mt-3 space-y-2">
            <p className="rounded-xl border border-border/80 bg-muted/30 px-2.5 py-2 text-[11px] text-muted-foreground">
              You can see these as a designated overseer of concerns. Only the sender and the person handling it can
              move a concern along.
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
