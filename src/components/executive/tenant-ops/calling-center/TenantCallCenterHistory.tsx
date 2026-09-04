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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Clock3, Download, History, PercentCircle, PhoneCall, PhoneIncoming, Search } from 'lucide-react';
import { KPICard } from '../../KPICard';
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
        <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
          {[
            { label: 'Calls attempted', value: kpis.total, icon: PhoneCall, color: 'bg-primary/10 text-primary' },
            { label: 'Answered', value: kpis.answered, icon: PhoneIncoming, color: 'bg-emerald-500/10 text-emerald-600' },
            { label: 'Answer rate', value: `${kpis.answerRate}%`, icon: PercentCircle, color: 'bg-sky-500/10 text-sky-600' },
            { label: 'Awaiting outcome', value: kpis.open, icon: Clock3, color: 'bg-amber-500/10 text-amber-600' },
          ].map((k) => (
            <KPICard key={k.label} title={k.label} value={k.value} icon={k.icon} color={k.color} loading={isLoading} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/30 p-3">
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="h-9 w-full text-xs sm:w-[150px]">
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
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tenant, officer, category or comment"
            className="h-9 w-full pl-9 text-xs"
          />
        </div>
        <Badge variant="secondary" className="h-7 text-[10px]">
          {rows.length.toLocaleString()} shown
        </Badge>
        <Button variant="outline" size="sm" className="h-9 text-xs font-semibold" onClick={download} disabled={!rows.length}>
          <Download className="mr-1.5 h-3.5 w-3.5" />
          CSV
        </Button>
      </div>

      <Card className="min-w-0 overflow-hidden">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 border-b bg-muted/30 p-3">
          <CardTitle className="flex items-center gap-2 text-xs font-bold">
            <History className="h-4 w-4 text-primary" />
            Tenant call history
          </CardTitle>
          <span className="text-[10px] text-muted-foreground">
            Shared records — Calling Hub and Calling Center calls in one list
          </span>
        </CardHeader>
        <CardContent className="min-w-0 overflow-x-auto p-0">
          {isLoading ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : !rows.length ? (
            <div className="p-8 text-center">
              <PhoneCall className="mx-auto h-5 w-5 text-muted-foreground" />
              <p className="mt-2 text-xs text-muted-foreground">No tenant calls in this window.</p>
            </div>
          ) : (
            <table className="w-full min-w-[760px] text-xs">
              <thead>
                <tr className="border-b bg-muted/30 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="p-2.5 font-semibold">When</th>
                  <th className="p-2.5 font-semibold">Tenant</th>
                  <th className="p-2.5 font-semibold">Status</th>
                  <th className="p-2.5 font-semibold">Category</th>
                  <th className="p-2.5 font-semibold">Comment</th>
                  <th className="p-2.5 font-semibold">Follow-up</th>
                  <th className="p-2.5 font-semibold">Officer</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 400).map((r) => (
                  <tr key={r.id} className="border-b border-border/50 align-top transition-colors last:border-0 hover:bg-muted/40">
                    <td className="whitespace-nowrap p-2.5 text-muted-foreground">
                      {stamp(r.recordedAt ?? r.revealedAt)}
                    </td>
                    <td className="p-2.5 font-semibold">{r.subjectName}</td>
                    <td className="p-2.5">
                      <Badge
                        variant={isAnsweredOutcome(r.outcome) ? 'default' : r.outcome ? 'outline' : 'secondary'}
                        className="text-[10px]"
                      >
                        {statusLabel(r)}
                      </Badge>
                    </td>
                    <td className="p-2.5 text-muted-foreground">{r.categoryLabel ?? '—'}</td>
                    <td className="max-w-[240px] p-2.5 text-muted-foreground">
                      {r.comment ?? r.voidReason ?? '—'}
                    </td>
                    <td className="whitespace-nowrap p-2.5 text-muted-foreground">
                      {r.followUpDueAt
                        ? `${stamp(r.followUpDueAt)}${r.followUpCompletedAt ? ' (done)' : ''}`
                        : '—'}
                    </td>
                    <td className="p-2.5 text-muted-foreground">{r.officer ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

