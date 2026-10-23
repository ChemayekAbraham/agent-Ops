import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  BarChart3,
  Download,
  Phone,
  CheckCircle2,
  PhoneOff,
  MessageSquare,
  Users,
  TrendingUp,
} from 'lucide-react';
import { format, startOfDay } from 'date-fns';
import { isAnsweredOutcome, useCcCallHistory } from '@/hooks/useCcCallHistory';
import { type CcCallingHub } from '@/hooks/useCcCallingHub';
import { formatHumanLabel } from './ccUi';

export function LandlordCallsReport({ hub }: { hub: CcCallingHub }) {
  const [days, setDays] = useState<number>(7);
  const history = useCcCallHistory('landlord', days);

  const rows = history.data ?? [];
  const counts = hub.totalCounts;

  const metrics = useMemo(() => {
    const total = rows.length;
    const engaged = rows.filter((r) => r.outcome === 'engaged').length;
    const callback = rows.filter((r) => r.outcome === 'callback_booked').length;
    const noAnswer = rows.filter((r) => r.outcome === 'no_answer').length;
    const phoneOff = rows.filter((r) => r.outcome === 'phone_off').length;
    const wrongNumber = rows.filter((r) => r.outcome === 'wrong_number').length;
    const refused = rows.filter((r) => r.outcome === 'refused').length;
    const reached = rows.filter((r) => isAnsweredOutcome(r.outcome)).length;
    const reachRate = total > 0 ? Math.round((reached / total) * 100) : 0;
    const engageRate = total > 0 ? Math.round((engaged / total) * 100) : 0;
    const withFeedback = rows.filter((r) => r.comment?.trim()).length;
    const feedbackRate = engaged > 0 ? Math.round((withFeedback / engaged) * 100) : 0;
    const uniqueLandlords = new Set(rows.map((r) => r.subjectId).filter(Boolean)).size;

    const callerMap = new Map<
      string,
      { name: string; total: number; engaged: number; reached: number; feedback: number; landlords: Set<string> }
    >();
    rows.forEach((r) => {
      const key = r.officer || 'Staff Member';
      const entry = callerMap.get(key) ?? {
        name: key,
        total: 0,
        engaged: 0,
        reached: 0,
        feedback: 0,
        landlords: new Set<string>(),
      };
      entry.total += 1;
      if (r.outcome === 'engaged') entry.engaged += 1;
      if (isAnsweredOutcome(r.outcome)) entry.reached += 1;
      if (r.comment?.trim()) entry.feedback += 1;
      if (r.subjectId) entry.landlords.add(r.subjectId);
      callerMap.set(key, entry);
    });
    const callers = Array.from(callerMap.values()).sort((a, b) => b.total - a.total);

    const catMap = new Map<string, number>();
    rows.forEach((r) => {
      const cat = r.categoryLabel?.trim();
      if (!cat) return;
      catMap.set(cat, (catMap.get(cat) ?? 0) + 1);
    });
    const categories = Array.from(catMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    const dayMap = new Map<string, { day: string; total: number; engaged: number }>();
    rows.forEach((r) => {
      const when = r.recordedAt || r.revealedAt;
      const d = format(startOfDay(new Date(when)), 'yyyy-MM-dd');
      const cur = dayMap.get(d) ?? { day: d, total: 0, engaged: 0 };
      cur.total += 1;
      if (r.outcome === 'engaged') cur.engaged += 1;
      dayMap.set(d, cur);
    });
    const daily = Array.from(dayMap.values()).sort((a, b) => a.day.localeCompare(b.day));

    return {
      total,
      engaged,
      callback,
      noAnswer,
      phoneOff,
      wrongNumber,
      refused,
      reached,
      reachRate,
      engageRate,
      withFeedback,
      feedbackRate,
      uniqueLandlords,
      callers,
      categories,
      daily,
    };
  }, [rows]);

  const exportSummaryCsv = () => {
    const lines: string[] = [];
    lines.push('Section,Metric,Value');
    lines.push(`Overview,Total Calls,${metrics.total}`);
    lines.push(`Overview,Unique Landlords Dialed,${metrics.uniqueLandlords}`);
    lines.push(`Overview,Reached,${metrics.reached} (${metrics.reachRate}%)`);
    lines.push(`Overview,Engaged,${metrics.engaged} (${metrics.engageRate}%)`);
    lines.push(`Overview,Calls With Feedback,${metrics.withFeedback}`);
    lines.push(`Overview,No Answer,${metrics.noAnswer}`);
    lines.push(`Overview,Phone Off,${metrics.phoneOff}`);
    lines.push(`Overview,Wrong Number,${metrics.wrongNumber}`);
    lines.push('');
    lines.push('Caller,Total Calls,Reached,Engaged,Reach Rate %,With Feedback,Unique Landlords');
    metrics.callers.forEach((c) => {
      const rate = c.total > 0 ? Math.round((c.reached / c.total) * 100) : 0;
      lines.push(
        `"${c.name}",${c.total},${c.reached},${c.engaged},${rate}%,${c.feedback},${c.landlords.size}`,
      );
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `landlord-calls-report-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const maxDaily = Math.max(1, ...metrics.daily.map((d) => d.total));
  const totalInRound =
    (counts?.to_call ?? 0) +
    (counts?.engaged ?? 0) +
    (counts?.unreachable ?? 0) +
    (counts?.parked ?? 0) +
    (counts?.callback ?? 0);

  return (
    <div className="space-y-4">
      <Card className="p-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          <div>
            <h3 className="text-sm font-semibold">Landlord Calling Center Performance Report</h3>
            <p className="text-[11px] text-muted-foreground">
              Landlord reach rate, payout confirmations, caller productivity & feedback insights
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="h-8 text-xs w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 Days</SelectItem>
              <SelectItem value="30">Last 30 Days</SelectItem>
              <SelectItem value="90">Last 90 Days</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            onClick={exportSummaryCsv}
            disabled={metrics.total === 0}
            className="h-8 text-xs gap-1"
          >
            <Download className="h-3.5 w-3.5" /> Export Report
          </Button>
        </div>
      </Card>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <Card className="p-3">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Total Calls</span>
            <Phone className="h-3.5 w-3.5" />
          </div>
          <div className="text-xl font-bold tabular-nums mt-1">{metrics.total}</div>
          <div className="text-[10px] text-muted-foreground">
            {metrics.uniqueLandlords} unique landlords
          </div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Reach Rate</span>
            <TrendingUp className="h-3.5 w-3.5 text-emerald-600" />
          </div>
          <div className="text-xl font-bold tabular-nums text-emerald-600 mt-1">
            {metrics.reachRate}%
          </div>
          <div className="text-[10px] text-muted-foreground">{metrics.reached} reached</div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Engaged</span>
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
          </div>
          <div className="text-xl font-bold tabular-nums mt-1">{metrics.engaged}</div>
          <div className="text-[10px] text-muted-foreground">{metrics.engageRate}% of calls</div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Feedback Captured</span>
            <MessageSquare className="h-3.5 w-3.5 text-primary" />
          </div>
          <div className="text-xl font-bold tabular-nums mt-1">{metrics.withFeedback}</div>
          <div className="text-[10px] text-muted-foreground">
            {metrics.feedbackRate}% of engaged
          </div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Unanswered / Off</span>
            <PhoneOff className="h-3.5 w-3.5 text-amber-600" />
          </div>
          <div className="text-xl font-bold tabular-nums text-amber-600 mt-1">
            {metrics.noAnswer + metrics.phoneOff}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {metrics.wrongNumber} wrong numbers
          </div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Active Callers</span>
            <Users className="h-3.5 w-3.5" />
          </div>
          <div className="text-xl font-bold tabular-nums mt-1">
            {metrics.callers.length}
          </div>
          <div className="text-[10px] text-muted-foreground">Staff members</div>
        </Card>
      </div>

      {counts && totalInRound > 0 && (
        <Card className="p-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold">Active Landlord Round Progress</span>
            <span className="text-muted-foreground tabular-nums">
              {counts.engaged} / {totalInRound} engaged (
              {Math.round((counts.engaged / totalInRound) * 100)}%)
            </span>
          </div>
          <Progress value={(counts.engaged / totalInRound) * 100} className="h-2" />
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card className="p-3 space-y-2.5">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Outcome Breakdown
          </h4>
          {[
            { label: 'Engaged', count: metrics.engaged, color: 'bg-emerald-500' },
            { label: 'Callback Booked', count: metrics.callback, color: 'bg-violet-500' },
            { label: 'No Answer', count: metrics.noAnswer, color: 'bg-amber-500' },
            { label: 'Phone Off', count: metrics.phoneOff, color: 'bg-orange-500' },
            { label: 'Refused', count: metrics.refused, color: 'bg-sky-500' },
            { label: 'Wrong Number', count: metrics.wrongNumber, color: 'bg-destructive' },
          ].map((o) => {
            const pct = metrics.total > 0 ? Math.round((o.count / metrics.total) * 100) : 0;
            return (
              <div key={o.label} className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span>{o.label}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {o.count} ({pct}%)
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className={`h-full ${o.color}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </Card>

        <Card className="p-3 space-y-2.5">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Landlord Feedback Categories
          </h4>
          {metrics.categories.length === 0 ? (
            <p className="text-xs text-muted-foreground py-6 text-center">
              No categorized landlord feedback recorded in this period yet.
            </p>
          ) : (
            <div className="space-y-2">
              {metrics.categories.slice(0, 8).map((c) => {
                const pct =
                  metrics.withFeedback > 0
                    ? Math.round((c.count / metrics.withFeedback) * 100)
                    : 0;
                return (
                  <div key={c.name} className="flex items-center justify-between text-xs gap-2">
                    <span className="truncate font-medium">{formatHumanLabel(c.name)}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="secondary" className="text-[10px] tabular-nums">
                        {c.count}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground w-9 text-right tabular-nums">
                        {pct}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="p-3 border-b flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Caller Productivity Leaderboard
          </h4>
          <span className="text-[11px] text-muted-foreground">
            {metrics.callers.length} caller(s)
          </span>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">#</TableHead>
                <TableHead className="text-xs">Caller</TableHead>
                <TableHead className="text-xs text-right">Calls</TableHead>
                <TableHead className="text-xs text-right">Unique Landlords</TableHead>
                <TableHead className="text-xs text-right">Reached</TableHead>
                <TableHead className="text-xs text-right">Engaged</TableHead>
                <TableHead className="text-xs text-right">Reach Rate</TableHead>
                <TableHead className="text-xs text-right">Notes Logged</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {metrics.callers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-xs text-muted-foreground py-6">
                    No calls logged in this period.
                  </TableCell>
                </TableRow>
              ) : (
                metrics.callers.map((c, idx) => {
                  const rate = c.total > 0 ? Math.round((c.reached / c.total) * 100) : 0;
                  return (
                    <TableRow key={`${c.name}-${idx}`}>
                      <TableCell className="text-xs font-mono text-muted-foreground">
                        {idx + 1}
                      </TableCell>
                      <TableCell className="text-xs font-medium">{c.name}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums font-semibold">
                        {c.total}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums">
                        {c.landlords.size}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums">
                        {c.reached}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-emerald-600 font-medium">
                        {c.engaged}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums">
                        <Badge variant={rate >= 50 ? 'default' : 'secondary'} className="text-[10px]">
                          {rate}%
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums">
                        {c.feedback}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
