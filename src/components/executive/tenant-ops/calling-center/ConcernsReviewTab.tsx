/**
 * Issues Review — every concern forwarded out of the Calling Center, from both
 * outbound recorded calls and received calls.
 *
 * Read-only over the append-only concern trail, plus two write paths that reuse
 * the shared dialog: forward a concern taken from an outbound recorded call, and
 * add a progress note as the sender. Moving a concern along (accept, start,
 * complete) belongs to the person it was forwarded to, in their My Space.
 */
import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertTriangle, ClipboardList, Download, Forward, PhoneOutgoing, Search } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { KPICard } from '../../KPICard';
import { ForwardConcernDialog, type ForwardConcernSource } from './ForwardConcernDialog';
import { useCcCallHistory } from '@/hooks/useCcCallHistory';
import { ConcernControlPanel } from './ConcernControlPanel';
import {
  CONCERN_ACTION_LABEL,
  CONCERN_PRIORITY_LABEL,
  CONCERN_STATUS_LABEL,
  concernOverdueHours,
  concernTimeLeft,
  isConcernOverdue,
  useConcernEvents,
  useConcernReviewers,
  useForwardedConcerns,
  type ConcernStatus,
  type ForwardedConcern,
} from '@/hooks/useCallingConcerns';
import { generateIssuesReviewPdf } from '@/lib/callingCenterConcernPdf';

const DAY_CHOICES = [7, 30, 60, 90];

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

/** Group similar concern titles so repeats are visible without guessing. */
function repeatThemes(rows: ForwardedConcern[]) {
  const key = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^a-z ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 3)
      .join(' ');
  const map = new Map<string, { theme: string; count: number }>();
  rows.forEach((r) => {
    const k = key(r.title);
    if (!k) return;
    const hit = map.get(k);
    if (hit) hit.count += 1;
    else map.set(k, { theme: r.title, count: 1 });
  });
  return Array.from(map.values())
    .filter((t) => t.count > 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

function ConcernTimelineDialog({ concern, reviewerNames, onClose }: { concern: ForwardedConcern | null; reviewerNames: string[]; onClose: () => void }) {
  const events = useConcernEvents(concern?.id ?? null);
  return (
    <Dialog open={!!concern} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm font-bold">{concern?.title}</DialogTitle>
        </DialogHeader>
        {concern && (
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-muted/40 p-2.5 text-[11px]">
              <p>
                <span className="font-semibold">{concern.forwarded_by_name ?? 'Officer'}</span> forwarded this to{' '}
                <span className="font-semibold">
                  {concern.original_forwarded_to_name ?? concern.forwarded_to_name ?? 'staff member'}
                </span>{' '}
                on {stamp(concern.created_at)}
              </p>
              {concern.reassigned_count > 0 && (
                <p className="mt-0.5 font-semibold text-primary">
                  Now with {concern.forwarded_to_name ?? '—'} after {concern.reassigned_count} change
                  {concern.reassigned_count === 1 ? '' : 's'}
                </p>
              )}
              <p className="mt-0.5 text-muted-foreground">
                {concern.source_kind === 'received_call' ? 'From a call that came in' : 'From a call we made'}
                {concern.caller_name ? ` · about ${concern.caller_name}` : ''}
              </p>
              {reviewerNames.length > 0 && (
                <p className="mt-1">
                  Reviewers: <span className="font-semibold">{reviewerNames.join(', ')}</span>
                </p>
              )}
            </div>
            {concern.context && <p className="text-[11px] leading-snug">{concern.context}</p>}
            <ConcernControlPanel concern={concern} />
            <div className="space-y-2">
              {events.isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : (
                (events.data ?? []).map((e) => (
                  <div key={e.id} className="rounded-lg border border-border/70 p-2.5">
                    <p className="text-[11px] font-semibold">
                      {CONCERN_ACTION_LABEL[e.action] ?? e.action.replace('_', ' ')} ·{' '}
                      {e.actor_name ?? 'Staff member'}
                    </p>
                    <p className="text-[10px] text-muted-foreground">{stamp(e.created_at)}</p>
                    {e.action === 'reassigned' && (
                      <p className="mt-1 text-[11px] leading-snug">
                        From <span className="font-semibold">{e.prev_user_name ?? '—'}</span> to{' '}
                        <span className="font-semibold">{e.new_user_name ?? '—'}</span>
                      </p>
                    )}
                    {e.action === 'due_changed' && (
                      <p className="mt-1 text-[11px] leading-snug">
                        From {stamp(e.prev_due_at)} to {stamp(e.new_due_at)}
                      </p>
                    )}
                    {e.action === 'reviewer_added' && (
                      <p className="mt-1 text-[11px] leading-snug">Added {e.new_user_name ?? 'staff member'}</p>
                    )}
                    {e.note && <p className="mt-1 text-[11px] leading-snug">{e.note}</p>}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function OutboundForwardPicker({ onPick }: { onPick: (s: ForwardConcernSource) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const { data, isLoading } = useCcCallHistory('tenant', 30);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const recorded = (data ?? []).filter((r) => !!r.outcome);
    const list = q
      ? recorded.filter((r) =>
          [r.subjectName, r.comment ?? '', r.categoryLabel ?? '', r.officer ?? ''].join(' ').toLowerCase().includes(q),
        )
      : recorded;
    return list.slice(0, 60);
  }, [data, search]);

  return (
    <>
      <Button size="sm" variant="outline" className="h-8 text-[11px] font-semibold" onClick={() => setOpen(true)}>
        <PhoneOutgoing className="mr-1 h-3.5 w-3.5" />
        Forward from a call we made
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm font-bold">Pick the call this concern came from</DialogTitle>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tenant, comment or officer"
              className="h-9 pl-9 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            {isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : rows.length === 0 ? (
              <p className="p-4 text-center text-xs text-muted-foreground">No recorded calls match.</p>
            ) : (
              rows.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="w-full rounded-lg border border-border p-2.5 text-left hover:border-primary/40 hover:bg-muted/50"
                  onClick={() => {
                    setOpen(false);
                    onPick({
                      source_kind: 'outbound_call',
                      cycle_row_id: r.cycleRowId,
                      caller_name: r.subjectName,
                      caller_user_id: r.subjectId,
                      subject_type: 'tenant',
                      suggestedTitle: (r.categoryLabel ?? r.comment ?? '').slice(0, 110),
                      suggestedContext: [r.comment, r.categoryLabel ? `Category: ${r.categoryLabel}` : '']
                        .filter(Boolean)
                        .join('\n\n'),
                    });
                  }}
                >
                  <p className="text-xs font-bold">{r.subjectName}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {stamp(r.recordedAt ?? r.revealedAt)} · {r.categoryLabel ?? 'No category'} ·{' '}
                    {r.officer ?? 'Officer'}
                  </p>
                  {r.comment && <p className="mt-1 text-[11px] leading-snug">{r.comment}</p>}
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ConcernsReviewTab() {
  const [days, setDays] = useState(60);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [forwardSource, setForwardSource] = useState<ForwardConcernSource | null>(null);
  const [openConcern, setOpenConcern] = useState<ForwardedConcern | null>(null);
  const [exporting, setExporting] = useState(false);

  const { data, isLoading } = useForwardedConcerns({ days });
  const all = useMemo(() => data ?? [], [data]);
  const reviewers = useConcernReviewers(all.map((c) => c.id));
  const reviewersByConcern = useMemo(() => {
    const map = new Map<string, string[]>();
    (reviewers.data ?? []).forEach((r) => {
      const list = map.get(r.concern_id) ?? [];
      if (r.full_name && !list.includes(r.full_name)) list.push(r.full_name);
      map.set(r.concern_id, list);
    });
    return map;
  }, [reviewers.data]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((c) => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      if (sourceFilter !== 'all' && c.source_kind !== sourceFilter) return false;
      if (!q) return true;
      return [c.title, c.context ?? '', c.caller_name ?? '', c.forwarded_by_name ?? '', c.forwarded_to_name ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [all, search, statusFilter, sourceFilter]);

  const kpis = useMemo(
    () => ({
      total: all.length,
      open: all.filter((c) => c.status !== 'completed').length,
      completed: all.filter((c) => c.status === 'completed').length,
      overdue: all.filter(isConcernOverdue).length,
    }),
    [all],
  );

  const exportPdf = async () => {
    setExporting(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const pct = (n: number) => (rows.length ? Math.round((n / rows.length) * 100) : 0);
      const bySource = ['outbound_call', 'received_call'].map((s) => {
        const count = rows.filter((c) => c.source_kind === s).length;
        return { label: s === 'outbound_call' ? 'Calls we made' : 'Calls that came in', count, pct: pct(count) };
      });
      const byStatus = (Object.keys(CONCERN_STATUS_LABEL) as ConcernStatus[]).map((s) => {
        const count = rows.filter((c) => c.status === s).length;
        return { label: CONCERN_STATUS_LABEL[s], count, pct: pct(count) };
      });
      const byPriority = Object.keys(CONCERN_PRIORITY_LABEL).map((p) => ({
        label: CONCERN_PRIORITY_LABEL[p],
        count: rows.filter((c) => c.priority === p).length,
      }));
      const receivers = new Map<string, ForwardedConcern[]>();
      rows.forEach((c) => {
        const k = c.forwarded_to_name ?? 'Staff member';
        receivers.set(k, [...(receivers.get(k) ?? []), c]);
      });
      const byReceiver = Array.from(receivers.entries())
        .map(([name, list]) => {
          const done = list.filter((c) => c.status === 'completed' && c.completed_at);
          const avg =
            done.length > 0
              ? done.reduce(
                  (a, c) => a + (new Date(c.completed_at as string).getTime() - new Date(c.created_at).getTime()),
                  0,
                ) /
                done.length /
                3_600_000
              : null;
          const lateHours = list.map(concernOverdueHours).filter((h) => h > 0);
          const onTime = done.filter((c) => concernOverdueHours(c) === 0).length;
          return {
            name,
            total: list.length,
            completed: done.length,
            overdue: list.filter(isConcernOverdue).length,
            avgHours: avg == null ? '—' : `${avg.toFixed(1)} hours`,
            reassignedIn: list.filter((c) => c.reassigned_count > 0 && c.forwarded_to_name === name).length,
            onTime,
            avgLate: lateHours.length
              ? `${(lateHours.reduce((a, b) => a + b, 0) / lateHours.length).toFixed(1)} hours`
              : '—',
          };
        })
        .sort((a, b) => b.total - a.total);

      // Deadline performance across the filtered set.
      const withDue = rows.filter((c) => !!c.due_at);
      const late = rows.filter((c) => concernOverdueHours(c) > 0);
      const lateTotal = late.reduce((a, c) => a + concernOverdueHours(c), 0);
      const deadlinePerformance = [
        { label: 'Concerns with an answer time', value: String(withDue.length) },
        { label: 'Standard 24 hours', value: String(withDue.filter((c) => !c.due_is_custom).length) },
        { label: 'Answer time adjusted', value: String(withDue.filter((c) => c.due_is_custom).length) },
        {
          label: 'Answered within the time',
          value: String(rows.filter((c) => c.status === 'completed' && concernOverdueHours(c) === 0).length),
        },
        { label: 'Ran past the time', value: String(late.length) },
        {
          label: 'Average time past due',
          value: late.length ? `${(lateTotal / late.length).toFixed(1)} hours` : '—',
        },
        {
          label: 'Longest past due',
          value: late.length ? `${Math.max(...late.map(concernOverdueHours)).toFixed(1)} hours` : '—',
        },
      ];

      // Reassignment history, straight from the append-only trail.
      let reassignments: {
        when: string;
        concern: string;
        from: string;
        to: string;
        by: string;
        reason: string;
      }[] = [];
      const reassignedRows = rows.filter((c) => c.reassigned_count > 0);
      if (reassignedRows.length) {
        const { data: evts } = await (supabase as any)
          .from('cc_forwarded_concern_events')
          .select('concern_id, action, actor_name, prev_user_name, new_user_name, reason, created_at')
          .in(
            'concern_id',
            reassignedRows.slice(0, 300).map((c) => c.id),
          )
          .eq('action', 'reassigned')
          .order('created_at', { ascending: true });
        const titleById = new Map(rows.map((c) => [c.id, c.title]));
        reassignments = (evts ?? []).map((e: any) => ({
          when: stamp(e.created_at),
          concern: titleById.get(e.concern_id) ?? '—',
          from: e.prev_user_name ?? '—',
          to: e.new_user_name ?? '—',
          by: e.actor_name ?? '—',
          reason: e.reason ?? '—',
        }));
      }


      const recommendations: { title: string; detail: string }[] = [];
      const overdue = rows.filter(isConcernOverdue).length;
      if (overdue > 0)
        recommendations.push({
          title: `${overdue} concern${overdue === 1 ? '' : 's'} past the expected answer time`,
          detail: 'Follow these up with the staff member first; they are the ones callers will chase again.',
        });
      const untouched = rows.filter((c) => c.status === 'sent').length;
      if (untouched > 0)
        recommendations.push({
          title: `${untouched} not yet picked up`,
          detail: 'The person it was sent to has not confirmed they have it. Confirm they saw it in their My Space.',
        });
      if (reassignments.length)
        recommendations.push({
          title: `${reassignments.length} hand-off${reassignments.length === 1 ? '' : 's'} changed to someone else`,
          detail:
            'Check whether the concerns are being sent to the right desk first — repeated changes usually mean the wrong person is being picked.',
        });
      const themes = repeatThemes(rows);
      if (themes.length)
        recommendations.push({
          title: 'Some concerns keep coming back',
          detail: `The most repeated is “${themes[0].theme}”, raised ${themes[0].count} times. Fixing the cause will cut the calls.`,
        });
      if (!recommendations.length)
        recommendations.push({
          title: 'Nothing outstanding',
          detail: 'Every concern in this period was picked up and answered within the expected time.',
        });

      const blob = await generateIssuesReviewPdf(
        {
          tiles: [
            { label: 'Concerns forwarded', value: String(rows.length) },
            { label: 'Still open', value: String(rows.filter((c) => c.status !== 'completed').length) },
            { label: 'Completed', value: String(rows.filter((c) => c.status === 'completed').length) },
            { label: 'Past due', value: String(overdue) },
          ],
          bySource,
          byStatus,
          byPriority,
          byReceiver,
          repeatThemes: themes,
          deadlinePerformance,
          reassignments,
          rows: rows.map((c) => {
            const late = concernOverdueHours(c);
            return {
              when: stamp(c.created_at),
              source: c.source_kind === 'received_call' ? 'Came in' : 'We called',
              title: c.title,
              caller: c.caller_name ?? '—',
              from: c.forwarded_by_name ?? '—',
              firstTo: c.original_forwarded_to_name ?? c.forwarded_to_name ?? '—',
              to: c.forwarded_to_name ?? '—',
              changes: String(c.reassigned_count ?? 0),
              reviewers: (reviewersByConcern.get(c.id) ?? [c.forwarded_to_name ?? '—']).join(', '),
              status: CONCERN_STATUS_LABEL[c.status as ConcernStatus] ?? c.status,
              due: `${stamp(c.due_at)}${c.due_is_custom ? ' (adjusted)' : ''}`,
              completed: stamp(c.completed_at),
              pastDue: late > 0 ? `${late.toFixed(1)}h` : '—',
              outcome: c.outcome ?? '—',
            };
          }),
          recommendations,
        },
        {
          generatedBy: auth?.user?.user_metadata?.full_name ?? 'Tenant Operations',
          email: auth?.user?.email ?? '—',
          generatedAt: new Date(),
          reportPeriod: `Last ${days} days`,
        },
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `calling-center-issues-review-${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not build the review.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <KPICard title="Forwarded" value={kpis.total} icon={Forward} color="bg-primary/10 text-primary" />
        <KPICard title="Still open" value={kpis.open} icon={ClipboardList} color="bg-amber-500/10 text-amber-600" />
        <KPICard title="Completed" value={kpis.completed} icon={ClipboardList} color="bg-emerald-500/10 text-emerald-600" />
        <KPICard title="Past due" value={kpis.overdue} icon={AlertTriangle} color="bg-destructive/10 text-destructive" />
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 border-b bg-muted/30 p-3">
          <CardTitle className="flex items-center gap-2 text-xs font-bold">
            <ClipboardList className="h-4 w-4 text-primary" />
            Forwarded concerns
          </CardTitle>
          <div className="flex flex-wrap items-center gap-1.5">
            <OutboundForwardPicker onPick={setForwardSource} />
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-[11px] font-semibold"
              onClick={exportPdf}
              disabled={exporting || !rows.length}
            >
              <Download className="mr-1 h-3.5 w-3.5" />
              {exporting ? 'Building…' : 'Issues review report'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 p-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label className="text-[11px] font-semibold text-muted-foreground">Period</Label>
              <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
                <SelectTrigger className="h-9 w-[130px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAY_CHOICES.map((d) => (
                    <SelectItem key={d} value={String(d)} className="text-xs">
                      Last {d} days
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] font-semibold text-muted-foreground">Status</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-9 w-[160px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs">
                    All
                  </SelectItem>
                  {(Object.keys(CONCERN_STATUS_LABEL) as ConcernStatus[]).map((s) => (
                    <SelectItem key={s} value={s} className="text-xs">
                      {CONCERN_STATUS_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] font-semibold text-muted-foreground">Came from</Label>
              <Select value={sourceFilter} onValueChange={setSourceFilter}>
                <SelectTrigger className="h-9 w-[160px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs">
                    Both
                  </SelectItem>
                  <SelectItem value="outbound_call" className="text-xs">
                    Calls we made
                  </SelectItem>
                  <SelectItem value="received_call" className="text-xs">
                    Calls that came in
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-[200px] flex-1 space-y-1">
              <Label className="text-[11px] font-semibold text-muted-foreground">Search</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Concern, caller, sender or receiver"
                  className="h-9 w-full pl-9 text-xs"
                />
              </div>
            </div>
          </div>

          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-center">
              <ClipboardList className="mx-auto h-5 w-5 text-muted-foreground" />
              <p className="mt-2 text-xs text-muted-foreground">No concerns forwarded in this period.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {rows.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setOpenConcern(c)}
                  className="w-full rounded-xl border border-border bg-card p-3 text-left hover:border-primary/40"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-bold">{c.title}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {c.source_kind === 'received_call' ? 'Came in' : 'We called'}
                        {c.caller_name ? ` · ${c.caller_name}` : ''} · {c.forwarded_by_name ?? 'Officer'} →{' '}
                        {c.forwarded_to_name ?? 'Staff member'} · {stamp(c.created_at)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge className={`${statusTone[c.status] ?? ''} text-[10px] hover:opacity-100`}>
                        {CONCERN_STATUS_LABEL[c.status as ConcernStatus] ?? c.status}
                      </Badge>
                      {isConcernOverdue(c) ? (
                        <Badge variant="outline" className="border-destructive/40 text-[10px] text-destructive">
                          {concernTimeLeft(c).label}
                        </Badge>
                      ) : (
                        c.status !== 'completed' && (
                          <Badge variant="outline" className="text-[10px]">
                            {concernTimeLeft(c).label}
                          </Badge>
                        )
                      )}
                      {c.reassigned_count > 0 && (
                        <Badge variant="outline" className="border-primary/40 text-[10px] text-primary">
                          Reassigned {c.reassigned_count}×
                        </Badge>
                      )}
                      <Badge variant="outline" className="text-[10px] capitalize">
                        {CONCERN_PRIORITY_LABEL[c.priority] ?? c.priority}
                      </Badge>
                    </div>
                  </div>
                  {c.reassigned_count > 0 && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      First sent to {c.original_forwarded_to_name ?? '—'} · changed by{' '}
                      {c.last_reassigned_by_name ?? '—'}
                    </p>
                  )}
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Reviewers: {(reviewersByConcern.get(c.id) ?? [c.forwarded_to_name ?? 'Staff member']).join(', ')}
                  </p>
                  {c.outcome && (
                    <p className="mt-1.5 text-[11px] leading-snug text-emerald-700">Resolved: {c.outcome}</p>
                  )}
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ForwardConcernDialog open={!!forwardSource} source={forwardSource} onClose={() => setForwardSource(null)} />
      <ConcernTimelineDialog
        concern={openConcern}
        reviewerNames={openConcern ? reviewersByConcern.get(openConcern.id) ?? [] : []}
        onClose={() => setOpenConcern(null)}
      />
    </div>
  );
}
