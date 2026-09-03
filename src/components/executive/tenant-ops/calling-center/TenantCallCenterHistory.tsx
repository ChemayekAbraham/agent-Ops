/**
 * Call history for the Tenant Calling Center.
 *
 * Read-only over the SAME records the Tenant Calling Hub writes — the `cc_*`
 * spine (`cc_call_attempts` + `cc_feedback` + `cc_followups`). There is no
 * separate Calling Center history: calls made in the Hub before the Center
 * launched and calls made in the Center afterwards appear in one list, with
 * their original dates, statuses and comments intact.
 */
import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Download } from 'lucide-react';
import {
  CC_OUTCOME_LABEL,
  isAnsweredOutcome,
  useCcCallHistory,
  type CcHistoryRow,
} from '@/hooks/useCcCallHistory';

const DAY_CHOICES = [7, 30, 90];

const stamp = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

const statusLabel = (r: CcHistoryRow) =>
  r.outcome ? CC_OUTCOME_LABEL[r.outcome] : 'Open (not yet recorded)';

function toCsv(rows: CcHistoryRow[]) {
  const head = [
    'Revealed at',
    'Recorded at',
    'Tenant',
    'Attempt no',
    'Status',
    'Category',
    'Severity',
    'Comment',
    'Follow-up due',
    'Follow-up completed',
    'Officer',
    'Source',
  ];
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const body = rows.map((r) =>
    [
      r.revealedAt,
      r.recordedAt ?? '',
      r.subjectName,
      r.attemptNo,
      statusLabel(r),
      r.categoryLabel ?? '',
      r.severity ?? '',
      r.comment ?? r.voidReason ?? '',
      r.followUpDueAt ?? '',
      r.followUpCompletedAt ?? '',
      r.officer ?? '',
      r.source ?? '',
    ]
      .map(esc)
      .join(','),
  );
  return [head.map(esc).join(','), ...body].join('\n');
}

export function TenantCallCenterHistory({ showKpis = true }: { showKpis?: boolean }) {
  const [days, setDays] = useState(30);
  const [search, setSearch] = useState('');
  const { data, isLoading } = useCcCallHistory('tenant', days);

  const all = useMemo(() => data ?? [], [data]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) =>
      [r.subjectName, r.officer ?? '', r.categoryLabel ?? '', r.comment ?? ''].join(' ').toLowerCase().includes(q),
    );
  }, [all, search]);

  const kpis = useMemo(() => {
    const recorded = all.filter((r) => !!r.outcome);
    const answered = recorded.filter((r) => isAnsweredOutcome(r.outcome)).length;
    return {
      total: all.length,
      answered,
      answerRate: recorded.length ? Math.round((answered / recorded.length) * 100) : 0,
      open: all.length - recorded.length,
    };
  }, [all]);

  const download = () => {
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tenant-calls-last-${days}-days.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      {showKpis && (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {[
            { label: 'Calls attempted', value: kpis.total },
            { label: 'Answered', value: kpis.answered },
            { label: 'Answer rate', value: `${kpis.answerRate}%` },
            { label: 'Awaiting outcome', value: kpis.open },
          ].map((k) => (
            <Card key={k.label} className="rounded-xl border-border/60 p-3">
              <p className="text-[11px] text-muted-foreground">{k.label}</p>
              <p className="text-lg font-bold tabular-nums">{k.value}</p>
            </Card>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="h-8 w-[140px] text-xs">
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
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tenant, officer, category or comment"
          className="h-8 w-full text-xs sm:max-w-xs"
        />
        <Button variant="outline" size="sm" className="h-8 text-xs" onClick={download} disabled={!rows.length}>
          <Download className="mr-1 h-3 w-3" />
          CSV
        </Button>
      </div>

      <Card className="min-w-0 overflow-x-auto rounded-2xl border-border/60 p-2 sm:p-3">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : !rows.length ? (
          <p className="p-6 text-center text-xs text-muted-foreground">No tenant calls in this window.</p>
        ) : (
          <table className="w-full min-w-[760px] text-xs">
            <thead>
              <tr className="border-b text-left text-[11px] text-muted-foreground">
                <th className="py-1.5 pr-2 font-semibold">When</th>
                <th className="py-1.5 pr-2 font-semibold">Tenant</th>
                <th className="py-1.5 pr-2 font-semibold">Status</th>
                <th className="py-1.5 pr-2 font-semibold">Category</th>
                <th className="py-1.5 pr-2 font-semibold">Comment</th>
                <th className="py-1.5 pr-2 font-semibold">Follow-up</th>
                <th className="py-1.5 pr-2 font-semibold">Officer</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 400).map((r) => (
                <tr key={r.id} className="border-b border-border/50 last:border-0 align-top">
                  <td className="py-1.5 pr-2 whitespace-nowrap text-muted-foreground">
                    {stamp(r.recordedAt ?? r.revealedAt)}
                  </td>
                  <td className="py-1.5 pr-2 font-semibold">{r.subjectName}</td>
                  <td className="py-1.5 pr-2">
                    <Badge
                      variant={isAnsweredOutcome(r.outcome) ? 'default' : r.outcome ? 'outline' : 'secondary'}
                      className="text-[10px]"
                    >
                      {statusLabel(r)}
                    </Badge>
                  </td>
                  <td className="py-1.5 pr-2 text-muted-foreground">{r.categoryLabel ?? '—'}</td>
                  <td className="max-w-[240px] py-1.5 pr-2 text-muted-foreground">
                    {r.comment ?? r.voidReason ?? '—'}
                  </td>
                  <td className="py-1.5 pr-2 whitespace-nowrap text-muted-foreground">
                    {r.followUpDueAt
                      ? `${stamp(r.followUpDueAt)}${r.followUpCompletedAt ? ' (done)' : ''}`
                      : '—'}
                  </td>
                  <td className="py-1.5 pr-2 text-muted-foreground">{r.officer ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
