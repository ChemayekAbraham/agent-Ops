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
import { ConcernControlPanel } from '@/components/executive/tenant-ops/calling-center/ConcernControlPanel';
import {
  CONCERN_ACTION_LABEL,
  CONCERN_PRIORITY_LABEL,
  CONCERN_STATUS_LABEL,
  isConcernOverdue,
  useConcernEvent,
  useConcernEvents,
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

function ConcernCard({ concern, mine }: { concern: ForwardedConcern; mine: boolean }) {
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
    <div className="rounded-xl border border-border bg-card p-3">
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
                className="h-8 border-emerald-500/40 text-[11px] font-semibold text-emerald-700"
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
        <p className="mt-2 rounded-lg bg-emerald-500/10 px-2.5 py-2 text-[11px] leading-snug text-emerald-700">
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
              <div key={e.id} className="rounded-lg border border-border/70 p-2">
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
  const toMe = useForwardedConcerns({ days: 120, scope: 'to_me' });
  const fromMe = useForwardedConcerns({ days: 120, scope: 'from_me' });
  const everything = useForwardedConcerns({ days: 120, scope: 'all' });

  const mine = useMemo(() => toMe.data ?? [], [toMe.data]);
  const sent = useMemo(() => fromMe.data ?? [], [fromMe.data]);
  const oversight = useMemo(() => {
    const ids = new Set([...mine, ...sent].map((c) => c.id));
    return (everything.data ?? []).filter((c) => !ids.has(c.id));
  }, [everything.data, mine, sent]);

  const openCount = mine.filter((c) => c.status !== 'completed').length;

  return (
    <PersonalLayout title="Concerns">
      <div className="space-y-4">
        <Card>
          <CardHeader className="border-b bg-muted/30 p-3">
            <CardTitle className="flex items-center gap-2 text-xs font-bold">
              <ClipboardList className="h-4 w-4 text-primary" />
              Concerns from the Calling Center
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 text-[11px] leading-snug text-muted-foreground">
            When someone in the Calling Center passes a caller's concern to you, it lands here. Confirm you have it,
            work on it, then write what you did before marking it completed. Nothing is ever deleted — every step stays
            on the record.
            {openCount > 0 && (
              <span className="mt-1.5 flex items-center gap-1.5 font-semibold text-amber-700">
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
            {toMe.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : mine.length === 0 ? (
              <p className="p-6 text-center text-xs text-muted-foreground">Nothing has been forwarded to you.</p>
            ) : (
              mine.map((c) => <ConcernCard key={c.id} concern={c} mine />)
            )}
          </TabsContent>

          <TabsContent value="from_me" className="mt-3 space-y-2">
            {fromMe.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : sent.length === 0 ? (
              <p className="p-6 text-center text-xs text-muted-foreground">You have not forwarded any concerns.</p>
            ) : (
              sent.map((c) => <ConcernCard key={c.id} concern={c} mine={false} />)
            )}
          </TabsContent>

          <TabsContent value="all" className="mt-3 space-y-2">
            <p className="rounded-lg border border-border bg-muted/40 px-2.5 py-2 text-[11px] text-muted-foreground">
              You can see these because of your role. Only the sender and the person handling it can move a concern
              along.
            </p>
            {oversight.map((c) => (
              <ConcernCard key={c.id} concern={c} mine={false} />
            ))}
          </TabsContent>
        </Tabs>
      </div>
    </PersonalLayout>
  );
};

export default MyConcerns;
