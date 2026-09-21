/**
 * Combined Calling Center Report button — sits beside the existing History PDF.
 *
 * Read-only. It gathers exactly the same records the Received Calls tab and the
 * Issues Review tab already read (`cc_received_calls`, `cc_forwarded_concerns`,
 * the reviewer list RPC and the append-only concern event trail), derives the
 * same figures those two reports derive, and hands the whole lot to the combined
 * PDF generator. Nothing here writes, and neither existing report is touched:
 * the queries run on click only, so opening the History tab is no heavier.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FileStack } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import {
  CONCERN_PRIORITY_LABEL,
  CONCERN_STATUS_LABEL,
  RECEIVED_STATUS_LABEL,
  concernOverdueHours,
  isConcernOverdue,
  type ConcernReviewer,
  type ConcernStatus,
  type ForwardedConcern,
  type ReceivedCall,
  type ReceivedCallStatus,
} from '@/hooks/useCallingConcerns';
import type { ReceivedCallPdfRow } from '@/lib/callingCenterConcernPdf';
import { generateCombinedCallingCenterPdf } from '@/lib/callingCenterCombinedPdf';

const anyDb = supabase as any;

const stamp = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';

/** Same grouping the Issues Review report uses to surface repeated concerns. */
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

export function CombinedCallingCenterReportButton({ days = 90 }: { days?: number }) {
  const [busy, setBusy] = useState(false);

  const build = async () => {
    setBusy(true);
    try {
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const { data: auth } = await supabase.auth.getUser();

      const [callsRes, concernsRes] = await Promise.all([
        anyDb
          .from('cc_received_calls')
          .select('*')
          .gte('called_at', since)
          .order('called_at', { ascending: false })
          .limit(1000),
        anyDb
          .from('cc_forwarded_concerns')
          .select('*')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(1000),
      ]);
      if (callsRes.error) throw new Error(callsRes.error.message);
      if (concernsRes.error) throw new Error(concernsRes.error.message);

      const calls = (callsRes.data ?? []) as ReceivedCall[];
      const concerns = (concernsRes.data ?? []) as ForwardedConcern[];

      if (!calls.length && !concerns.length) {
        toast.error('There are no received calls or forwarded concerns in this period.');
        return;
      }

      // Reviewers, so both sections can name everyone currently on a concern.
      let reviewers: ConcernReviewer[] = [];
      if (concerns.length) {
        const { data, error } = await anyDb.rpc('cc_concern_reviewer_list', {
          p_concern_ids: concerns.map((c) => c.id),
        });
        if (error) throw new Error(error.message);
        reviewers = (data ?? []) as ConcernReviewer[];
      }
      const activeReviewerNames = new Map<string, string[]>();
      const anyReviewerNames = new Map<string, string[]>();
      reviewers.forEach((r) => {
        const push = (map: Map<string, string[]>) => {
          const list = map.get(r.concern_id) ?? [];
          if (r.full_name && !list.includes(r.full_name)) list.push(r.full_name);
          map.set(r.concern_id, list);
        };
        push(anyReviewerNames);
        if (r.active) push(activeReviewerNames);
      });

      // ------------------------------------------------ Received calls
      const concernByCall = new Map<string, ForwardedConcern>();
      concerns.forEach((c) => {
        if (c.received_call_id && !concernByCall.has(c.received_call_id)) concernByCall.set(c.received_call_id, c);
      });

      const receivedRows: ReceivedCallPdfRow[] = calls.map((r) => {
        const concern = concernByCall.get(r.id);
        return {
          when: stamp(r.called_at),
          caller: r.caller_name,
          phone: r.caller_phone ?? '—',
          concern: r.concern,
          notes: [r.notes, r.follow_up_note ? `Follow-up note: ${r.follow_up_note}` : null]
            .filter(Boolean)
            .join(' · ') || '—',
          status: RECEIVED_STATUS_LABEL[r.status as ReceivedCallStatus] ?? r.status,
          followUp: r.follow_up_at ? stamp(r.follow_up_at) : '—',
          officer: r.recorded_by_name ?? '—',
          forwardedTo: concern
            ? (anyReviewerNames.get(concern.id) ?? [concern.forwarded_to_name ?? 'Staff member']).join(', ')
            : '—',
        };
      });

      const rPct = (n: number) => (calls.length ? Math.round((n / calls.length) * 100) : 0);
      const receivedByStatus = (Object.keys(RECEIVED_STATUS_LABEL) as ReceivedCallStatus[]).map((s) => {
        const count = calls.filter((c) => c.status === s).length;
        return { label: RECEIVED_STATUS_LABEL[s], count, pct: rPct(count) };
      });
      const receivedOpen = calls.filter((c) => c.status === 'open' || c.status === 'following_up').length;
      const receivedResolved = calls.filter((c) => c.status === 'resolved' || c.status === 'closed').length;
      const receivedForwarded = calls.filter((c) => concernByCall.has(c.id)).length;
      const receivedWithFollowUp = calls.filter((c) => !!c.follow_up_at).length;

      const officerMap = new Map<string, ReceivedCall[]>();
      calls.forEach((c) => {
        const k = c.recorded_by_name ?? 'Officer';
        officerMap.set(k, [...(officerMap.get(k) ?? []), c]);
      });
      const receivedByOfficer = Array.from(officerMap.entries())
        .map(([name, list]) => ({
          name,
          total: list.length,
          open: list.filter((c) => c.status === 'open' || c.status === 'following_up').length,
          resolved: list.filter((c) => c.status === 'resolved' || c.status === 'closed').length,
          forwarded: list.filter((c) => concernByCall.has(c.id)).length,
        }))
        .sort((a, b) => b.total - a.total);

      // ------------------------------------------------- Issues review
      const cPct = (n: number) => (concerns.length ? Math.round((n / concerns.length) * 100) : 0);
      const bySource = ['outbound_call', 'received_call'].map((s) => {
        const count = concerns.filter((c) => c.source_kind === s).length;
        return { label: s === 'outbound_call' ? 'Calls we made' : 'Calls that came in', count, pct: cPct(count) };
      });
      const byStatus = (Object.keys(CONCERN_STATUS_LABEL) as ConcernStatus[]).map((s) => {
        const count = concerns.filter((c) => c.status === s).length;
        return { label: CONCERN_STATUS_LABEL[s], count, pct: cPct(count) };
      });
      const byPriority = Object.keys(CONCERN_PRIORITY_LABEL).map((p) => ({
        label: CONCERN_PRIORITY_LABEL[p],
        count: concerns.filter((c) => c.priority === p).length,
      }));

      const receiverMap = new Map<string, ForwardedConcern[]>();
      concerns.forEach((c) => {
        const k = c.forwarded_to_name ?? 'Staff member';
        receiverMap.set(k, [...(receiverMap.get(k) ?? []), c]);
      });
      const byReceiver = Array.from(receiverMap.entries())
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
          return {
            name,
            total: list.length,
            completed: done.length,
            overdue: list.filter(isConcernOverdue).length,
            avgHours: avg == null ? '—' : `${avg.toFixed(1)} hours`,
            reassignedIn: list.filter((c) => c.reassigned_count > 0 && c.forwarded_to_name === name).length,
            onTime: done.filter((c) => concernOverdueHours(c) === 0).length,
            avgLate: lateHours.length
              ? `${(lateHours.reduce((a, b) => a + b, 0) / lateHours.length).toFixed(1)} hours`
              : '—',
          };
        })
        .sort((a, b) => b.total - a.total);

      const withDue = concerns.filter((c) => !!c.due_at);
      const late = concerns.filter((c) => concernOverdueHours(c) > 0);
      const lateTotal = late.reduce((a, c) => a + concernOverdueHours(c), 0);
      const deadlinePerformance = [
        { label: 'Concerns with an answer time', value: String(withDue.length) },
        { label: 'Standard 24 hours', value: String(withDue.filter((c) => !c.due_is_custom).length) },
        { label: 'Answer time adjusted', value: String(withDue.filter((c) => c.due_is_custom).length) },
        {
          label: 'Answered within the time',
          value: String(concerns.filter((c) => c.status === 'completed' && concernOverdueHours(c) === 0).length),
        },
        { label: 'Ran past the time', value: String(late.length) },
        { label: 'Average time past due', value: late.length ? `${(lateTotal / late.length).toFixed(1)} hours` : '—' },
        {
          label: 'Longest past due',
          value: late.length ? `${Math.max(...late.map(concernOverdueHours)).toFixed(1)} hours` : '—',
        },
      ];

      // Reassignment history, straight from the append-only trail.
      let reassignments: { when: string; concern: string; from: string; to: string; by: string; reason: string }[] = [];
      const reassignedRows = concerns.filter((c) => c.reassigned_count > 0);
      if (reassignedRows.length) {
        const { data: evts } = await anyDb
          .from('cc_forwarded_concern_events')
          .select('concern_id, action, actor_name, prev_user_name, new_user_name, reason, created_at')
          .in(
            'concern_id',
            reassignedRows.slice(0, 300).map((c) => c.id),
          )
          .eq('action', 'reassigned')
          .order('created_at', { ascending: true });
        const titleById = new Map(concerns.map((c) => [c.id, c.title]));
        reassignments = (evts ?? []).map((e: any) => ({
          when: stamp(e.created_at),
          concern: titleById.get(e.concern_id) ?? '—',
          from: e.prev_user_name ?? '—',
          to: e.new_user_name ?? '—',
          by: e.actor_name ?? '—',
          reason: e.reason ?? '—',
        }));
      }

      const themes = repeatThemes(concerns);
      const overdue = concerns.filter(isConcernOverdue).length;
      const untouched = concerns.filter((c) => c.status === 'sent').length;
      const completed = concerns.filter((c) => c.status === 'completed').length;

      const recommendations: { title: string; detail: string }[] = [];
      if (receivedOpen > 0)
        recommendations.push({
          title: `${receivedOpen} received call${receivedOpen === 1 ? '' : 's'} still open`,
          detail: 'These callers have not been told anything final yet. Close them or forward the concern.',
        });
      if (overdue > 0)
        recommendations.push({
          title: `${overdue} concern${overdue === 1 ? '' : 's'} past the expected answer time`,
          detail: 'Follow these up with the staff member first; they are the ones callers will chase again.',
        });
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
      if (themes.length)
        recommendations.push({
          title: 'Some concerns keep coming back',
          detail: `The most repeated is “${themes[0].theme}”, raised ${themes[0].count} times. Fixing the cause will cut the calls.`,
        });
      if (!recommendations.length)
        recommendations.push({
          title: 'Nothing outstanding',
          detail: 'Every call that came in was closed and every concern was answered within the expected time.',
        });

      const blob = await generateCombinedCallingCenterPdf(
        {
          executiveTiles: [
            { label: 'Calls received', value: String(calls.length) },
            { label: 'Concerns forwarded', value: String(concerns.length) },
            { label: 'Completed concerns', value: String(completed) },
            { label: 'Open received calls', value: String(receivedOpen) },
            { label: 'Concerns past due', value: String(overdue) },
          ],
          executiveTotals: [
            { label: 'Received calls recorded', value: String(calls.length), share: '100%' },
            { label: 'Received calls still open or being followed up', value: String(receivedOpen), share: `${rPct(receivedOpen)}%` },
            { label: 'Received calls resolved or closed', value: String(receivedResolved), share: `${rPct(receivedResolved)}%` },
            { label: 'Received calls forwarded to staff', value: String(receivedForwarded), share: `${rPct(receivedForwarded)}%` },
            { label: 'Received calls with a follow-up date set', value: String(receivedWithFollowUp), share: `${rPct(receivedWithFollowUp)}%` },
            { label: 'Concerns forwarded to staff', value: String(concerns.length), share: '100%' },
            { label: 'Concerns completed', value: String(completed), share: `${cPct(completed)}%` },
            { label: 'Concerns still open', value: String(concerns.length - completed), share: `${cPct(concerns.length - completed)}%` },
            { label: 'Concerns not yet picked up', value: String(untouched), share: `${cPct(untouched)}%` },
            { label: 'Concerns past the expected answer time', value: String(overdue), share: `${cPct(overdue)}%` },
            { label: 'Concerns handed to a different person at least once', value: String(reassignedRows.length), share: `${cPct(reassignedRows.length)}%` },
            { label: 'Staff members holding concerns', value: String(byReceiver.length) },
            { label: 'Officers who recorded received calls', value: String(receivedByOfficer.length) },
            { label: 'Repeated concerns identified', value: String(themes.length) },
          ],
          received: {
            tiles: [
              { label: 'Calls received', value: String(calls.length) },
              { label: 'Still open', value: String(receivedOpen) },
              { label: 'Resolved or closed', value: String(receivedResolved) },
              { label: 'Forwarded to staff', value: String(receivedForwarded) },
            ],
            byStatus: receivedByStatus,
            byOfficer: receivedByOfficer,
            rows: receivedRows,
          },
          issues: {
            tiles: [
              { label: 'Concerns forwarded', value: String(concerns.length) },
              { label: 'Still open', value: String(concerns.length - completed) },
              { label: 'Completed', value: String(completed) },
              { label: 'Past due', value: String(overdue) },
            ],
            bySource,
            byStatus,
            byPriority,
            byReceiver,
            repeatThemes: themes,
            deadlinePerformance,
            reassignments,
            rows: concerns.map((c) => {
              const lateHours = concernOverdueHours(c);
              return {
                when: stamp(c.created_at),
                source: c.source_kind === 'received_call' ? 'Came in' : 'We called',
                title: c.title,
                caller: c.caller_name ?? '—',
                from: c.forwarded_by_name ?? '—',
                firstTo: c.original_forwarded_to_name ?? c.forwarded_to_name ?? '—',
                to: c.forwarded_to_name ?? '—',
                changes: String(c.reassigned_count ?? 0),
                reviewers: (activeReviewerNames.get(c.id) ?? [c.forwarded_to_name ?? '—']).join(', '),
                status: CONCERN_STATUS_LABEL[c.status as ConcernStatus] ?? c.status,
                due: `${stamp(c.due_at)}${c.due_is_custom ? ' (adjusted)' : ''}`,
                completed: stamp(c.completed_at),
                pastDue: lateHours > 0 ? `${lateHours.toFixed(1)}h` : '—',
                outcome: c.outcome ?? '—',
              };
            }),
            recommendations,
          },
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
      a.download = `calling-center-combined-report-${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not build the combined report.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button size="sm" variant="outline" className="h-8 text-xs font-semibold" onClick={build} disabled={busy}>
      <FileStack className="mr-1.5 h-3.5 w-3.5" />
      {busy ? 'Building…' : 'Combined Report PDF'}
    </Button>
  );
}
