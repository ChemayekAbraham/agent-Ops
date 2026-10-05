/**
 * My Space → Concerns forwarded to me.
 *
 * The same append-only record the Calling Center writes. The sender, the current
 * recipient and anyone still an active recipient on the thread can see a concern
 * and act on it. Two named overseers can see all concerns and can reassign one or
 * change its answer time. Nobody else can see any of it.
 */
import { useMemo, useState } from 'react';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertTriangle, CheckCircle2, ChevronDown, ClipboardList, Forward, Inbox, Send, UserPlus } from 'lucide-react';
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
  const [expanded, setExpanded] = useState(false);

  const run = async (action: 'accepted' | 'started' | 'progress_note' | 'completed') => {
    try {
      await act.mutateAsync({ concern_id: concern.id, action, note: note.trim() || null });
      setNote('');
      toast.success(
        action === 'completed'
          ? 'Marked resolved.'
          : action === 'progress_note'
            ? 'Note added.'
            : 'Updated.',
      );
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not update this concern.');
    }
  };

  const done = concern.status === 'completed';
  const overdue = isConcernOverdue(concern);
  const canAct = !done && !joinable;
  const nextStep: { label: string; action: 'accepted' | 'started' } | null =
    mine && concern.status === 'sent'
      ? { label: 'I have got this', action: 'accepted' }
      : mine && concern.status === 'received'
        ? { label: 'Start working', action: 'started' }
        : null;

  return (
    <div
      className={`scroll-mt-24 overflow-hidden rounded-2xl border bg-card shadow-sm ${
        overdue ? 'border-destructive/40' : 'border-border/70'
      }`}
    >
      {/* Summary — always visible, tap to open */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-3 p-3.5 text-left active:bg-muted/40"
        aria-expanded={expanded}
      >
        <span
          className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${
            done ? 'bg-success' : overdue ? 'bg-destructive' : concern.status === 'sent' ? 'bg-warning' : 'bg-primary'
          }`}
        />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[15px] font-semibold leading-snug">{concern.title}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {concern.caller_name ? `${concern.caller_name} · ` : ''}
            {concern.forwarded_by_name ?? 'Officer'} · {stamp(concern.created_at)}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge className={`${statusTone[concern.status] ?? ''} rounded-full text-[11px] font-medium hover:opacity-100`}>
              {CONCERN_STATUS_LABEL[concern.status as ConcernStatus] ?? concern.status}
            </Badge>
            {overdue && (
              <Badge variant="outline" className="rounded-full border-destructive/40 text-[11px] text-destructive">
                Past due
              </Badge>
            )}
            <Badge variant="outline" className="rounded-full text-[11px] font-normal text-muted-foreground">
              {CONCERN_PRIORITY_LABEL[concern.priority] ?? concern.priority}
            </Badge>
          </div>
        </div>
        <ChevronDown
          className={`mt-1 h-5 w-5 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Quick next step without opening */}
      {!expanded && (nextStep || joinable) && (
        <div className="px-3.5 pb-3.5">
          {joinable ? (
            <Button className="h-11 w-full gap-1.5 rounded-xl text-sm font-semibold" onClick={() => void addMyself()} disabled={join.isPending}>
              <UserPlus className="h-4 w-4" />
              Add myself
            </Button>
          ) : nextStep ? (
            <Button className="h-11 w-full rounded-xl text-sm font-semibold" onClick={() => run(nextStep.action)} disabled={act.isPending}>
              {nextStep.label}
            </Button>
          ) : null}
        </div>
      )}

      {expanded && (
      <div className="space-y-3 border-t border-border/60 px-3.5 pb-3.5 pt-3">
      <p className="text-xs text-muted-foreground">
        {concern.source_kind === 'received_call' ? 'Call that came in' : 'Call we made'}
      </p>
      {concern.context && <p className="text-sm leading-relaxed">{concern.context}</p>}
      <div className="space-y-2">
        <ConcernCaseContextPanel concernId={concern.id} fallbackName={concern.caller_name} />
        <ConcernAttachmentsPanel concernId={concern.id} />
      </div>
      {reviewerRows.length > 0 && (
        <ConcernParticipantsPanel concern={concern} reviewers={reviewerRows} />
      )}

      {joinable && (
        <Button
          className="h-11 w-full gap-1.5 rounded-xl text-sm font-semibold"
          onClick={() => void addMyself()}
          disabled={join.isPending}
        >
          <UserPlus className="h-4 w-4" />
          Add myself to this concern
        </Button>
      )}
      <ConcernControlPanel concern={concern} isReceiver={mine} compact />

      {canAct && (
        <div className="space-y-2.5 rounded-xl bg-muted/30 p-3">
          {mine && (
            <div className="grid grid-cols-3 gap-1 rounded-xl bg-background p-1">
              {([
                { key: 'sent', label: 'New', action: null },
                { key: 'received', label: 'Got it', action: 'accepted' },
                { key: 'in_progress', label: 'Working', action: 'started' },
              ] as const).map((s) => {
                const active = concern.status === s.key;
                return (
                  <button
                    key={s.key}
                    type="button"
                    disabled={active || !s.action || act.isPending}
                    onClick={() => s.action && run(s.action)}
                    className={`h-10 rounded-lg text-xs font-semibold transition-colors ${
                      active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground disabled:opacity-40'
                    }`}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          )}
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder={mine ? 'What did you do? (needed to mark done)' : 'Add a note for the person handling it.'}
            className="rounded-xl text-sm"
          />
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              className="h-11 rounded-xl text-sm font-semibold"
              onClick={() => run('progress_note')}
              disabled={act.isPending || note.trim().length < 3}
            >
              Add note
            </Button>
            {mine && (
              <Button
                className="h-11 gap-1.5 rounded-xl bg-success text-sm font-semibold text-success-foreground hover:bg-success/90"
                onClick={() => run('completed')}
                disabled={act.isPending || note.trim().length < 10}
              >
                <CheckCircle2 className="h-4 w-4" />
                Mark done
              </Button>
            )}
          </div>
          {mine && note.trim().length < 10 && (
            <p className="text-[11px] text-muted-foreground">Write at least 10 characters to mark it done.</p>
          )}
        </div>
      )}

      {concern.outcome && (
        <p className="rounded-xl border border-success/25 bg-success/10 px-3 py-2 text-xs leading-snug text-success">
          Resolved: {concern.outcome}
        </p>
      )}

      <Button
        size="sm"
        variant="ghost"
        className="h-9 w-full rounded-xl text-xs text-muted-foreground"
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
      )}
    </div>
  );
}

function CompletedGroup({
  concerns,
  reviewersByConcern,
  mine,
}: {
  concerns: ForwardedConcern[];
  reviewersByConcern: Map<string, ConcernReviewer[] | undefined>;
  mine: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? concerns : concerns.slice(0, 3);
  return (
    <div className="space-y-2 rounded-2xl border border-border/60 bg-muted/20 p-2">
      <div className="flex items-center gap-1.5 px-0.5 pt-0.5">
        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
        <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Completed</p>
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          {concerns.length}
        </Badge>
        {concerns.length > 3 && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-1.5 text-[10px] text-muted-foreground"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? 'Show fewer' : `Show all ${concerns.length}`}
          </Button>
        )}
      </div>
      <div className="space-y-2">
        {visible.map((c) => (
          <div key={c.id} className="opacity-75">
            <ConcernCard concern={c} mine={mine} reviewerRows={reviewersByConcern.get(c.id) ?? []} />
          </div>
        ))}
      </div>
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
        <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card p-3.5 shadow-sm">
          <div className="shrink-0 rounded-xl bg-primary/10 p-2.5">
            <ClipboardList className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold">Calling Center concerns</p>
            <p className="text-xs text-muted-foreground">Tap a concern to see details and update it.</p>
          </div>
          {openCount > 0 && (
            <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-warning/15 px-2.5 py-1 text-xs font-semibold text-warning">
              <AlertTriangle className="h-3.5 w-3.5" />
              {openCount}
            </span>
          )}
        </div>

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
              <>
                {mine.filter((c) => c.status !== 'completed').map((c) => (
                  <ConcernCard key={c.id} concern={c} mine reviewerRows={reviewersByConcern.get(c.id) ?? []} />
                ))}
                {mine.some((c) => c.status === 'completed') && (
                  <CompletedGroup
                    concerns={mine.filter((c) => c.status === 'completed')}
                    reviewersByConcern={reviewersByConcern}
                    mine
                  />
                )}
              </>
            )}
          </TabsContent>

          <TabsContent value="from_me" className="mt-3 space-y-2">
            {fromMe.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : sent.length === 0 ? (
              <CCEmpty icon={ClipboardList} title="You have not forwarded any concerns" hint="Anything you pass on to a colleague will be listed here." />
            ) : (
              <>
                {sent.filter((c) => c.status !== 'completed').map((c) => (
                  <ConcernCard key={c.id} concern={c} mine={false} reviewerRows={reviewersByConcern.get(c.id) ?? []} />
                ))}
                {sent.some((c) => c.status === 'completed') && (
                  <CompletedGroup
                    concerns={sent.filter((c) => c.status === 'completed')}
                    reviewersByConcern={reviewersByConcern}
                    mine={false}
                  />
                )}
              </>
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
