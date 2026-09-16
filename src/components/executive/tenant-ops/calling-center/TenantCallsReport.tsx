/**
 * Tenant Calls Report — Today / Yesterday / custom range.
 *
 * Read-only over the SAME `cc_*` calling spine the Calling Hub writes to
 * (`useCcCallHistory`). No separate reporting dataset, no new calling logic,
 * no writes: it simply groups and presents the existing attempt records with
 * their existing statuses, feedback and comments.
 */
import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, Archive, BarChart3, FileText, PhoneCall, PhoneMissed, PhoneOutgoing } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { KPICard } from '../../KPICard';
import {
  CC_OUTCOME_LABEL,
  isAnsweredOutcome,
  useCcCallHistory,
  type CcHistoryRow,
} from '@/hooks/useCcCallHistory';
import { generateTenantCallsReportPdf } from '@/lib/tenantCallsReportPdf';
import { analyseCallFeedback } from '@/lib/tenantCallFeedbackAnalysis';
import { FeedbackAnalysisSection } from './FeedbackAnalysisSection';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';

type Preset = 'today' | 'yesterday' | 'custom';

const isoDay = (d: Date) => format(d, 'yyyy-MM-dd');

const statusLabel = (r: CcHistoryRow) => (r.outcome ? CC_OUTCOME_LABEL[r.outcome] : 'Open (not yet recorded)');

const stamp = (iso: string | null) =>
  iso ? format(new Date(iso), 'dd MMM yyyy, HH:mm') : '—';

const ugx = (n: number | null) =>
  n == null ? '—' : `UGX ${Math.round(n).toLocaleString('en-UG')}`;

/** Local-day window → ISO bounds (inclusive from, exclusive to). */
function windowFor(preset: Preset, fromDay: string, toDay: string) {
  const today = new Date();
  if (preset === 'today') {
    const start = new Date(today);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { fromIso: start.toISOString(), toIso: end.toISOString(), label: `Today · ${format(start, 'dd MMM yyyy')}` };
  }
  if (preset === 'yesterday') {
    const start = new Date(today);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 1);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return {
      fromIso: start.toISOString(),
      toIso: end.toISOString(),
      label: `Yesterday · ${format(start, 'dd MMM yyyy')}`,
    };
  }
  const start = new Date(`${fromDay}T00:00:00`);
  const end = new Date(`${toDay}T00:00:00`);
  end.setDate(end.getDate() + 1);
  return {
    fromIso: start.toISOString(),
    toIso: end.toISOString(),
    label: `${format(start, 'dd MMM yyyy')} — ${format(new Date(`${toDay}T00:00:00`), 'dd MMM yyyy')}`,
  };
}

export function TenantCallsReport() {
  const { user } = useAuth();
  const { profile } = useProfile();
  const [preset, setPreset] = useState<Preset>('today');
  const [fromDay, setFromDay] = useState(isoDay(new Date()));
  const [toDay, setToDay] = useState(isoDay(new Date()));
  const [busy, setBusy] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const win = useMemo(() => windowFor(preset, fromDay, toDay), [preset, fromDay, toDay]);
  const periodDays = useMemo(() => {
    if (preset === 'today') {
      const d = isoDay(new Date());
      return { startDay: d, endDay: d };
    }
    if (preset === 'yesterday') {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      const day = isoDay(d);
      return { startDay: day, endDay: day };
    }
    return { startDay: fromDay, endDay: toDay };
  }, [preset, fromDay, toDay]);
  const { data, isLoading, error } = useCcCallHistory('tenant', 30, { fromIso: win.fromIso, toIso: win.toIso });

  const rows = useMemo(
    () => [...(data ?? [])].sort((a, b) => (a.revealedAt < b.revealedAt ? 1 : -1)),
    [data],
  );

  const stats = useMemo(() => {
    const recorded = rows.filter((r) => !!r.outcome);
    const byStatus = new Map<string, number>();
    rows.forEach((r) => {
      const k = statusLabel(r);
      byStatus.set(k, (byStatus.get(k) ?? 0) + 1);
    });
    return {
      total: rows.length,
      engaged: rows.filter((r) => isAnsweredOutcome(r.outcome)).length,
      missed: recorded.filter((r) => !isAnsweredOutcome(r.outcome)).length,
      open: rows.length - recorded.length,
      feedback: rows.filter((r) => !!r.categoryLabel || !!r.comment).length,
      byStatus: [...byStatus.entries()].map(([name, value]) => ({ name, value })),
    };
  }, [rows]);

  const exportPdf = async () => {
    setBusy(true);
    try {
      const generatedAt = new Date();
      const metadataName = user?.user_metadata?.full_name;
      const generatedBy = profile?.full_name?.trim() || (typeof metadataName === 'string' ? metadataName.trim() : '');
      const email = profile?.email?.trim() || user?.email?.trim() || '';
      if (!generatedBy || !email) {
        throw new Error('Your account name and email must be available before generating this report.');
      }
      const blob = await generateTenantCallsReportPdf(
        win.label,
        [
          { label: 'Total calls', value: String(stats.total) },
          { label: 'Engaged / answered', value: String(stats.engaged) },
          { label: 'Missed / unanswered', value: String(stats.missed) },
          { label: 'Open (unrecorded)', value: String(stats.open) },
          { label: 'Feedback recorded', value: String(stats.feedback) },
        ],
        rows.map((r) => ({
          when: stamp(r.recordedAt ?? r.revealedAt),
          tenant: r.subjectName,
          tenantPhone: r.subjectPhone,
          agent: r.agentName,
          agentPhone: r.agentPhone,
          status: statusLabel(r),
          category: r.categoryLabel,
          comment: r.comment ?? r.voidReason,
          context: [
            r.dailyRepayment != null ? `Daily ${ugx(r.dailyRepayment)}` : null,
            r.outstandingBalance != null ? `Balance ${ugx(r.outstandingBalance)}` : null,
            r.planStatus ? `Plan ${r.planStatus}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          officer: r.officer,
        })),
        {
          generatedBy,
          email,
          generatedAt,
          reportPeriod: win.label,
        },
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tenant-calls-report-${isoDay(new Date())}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not build the report');
    } finally {
      setBusy(false);
    }
  };

  const archiveReport = async () => {
    setArchiving(true);
    try {
      const { startDay, endDay } = periodDays;
      const payload = {
        label: win.label,
        stats: [
          { label: 'Total calls', value: String(stats.total) },
          { label: 'Engaged / answered', value: String(stats.engaged) },
          { label: 'Missed / unanswered', value: String(stats.missed) },
          { label: 'Open (unrecorded)', value: String(stats.open) },
          { label: 'Feedback recorded', value: String(stats.feedback) },
        ],
        rows: rows.map((r) => ({
          when: stamp(r.recordedAt ?? r.revealedAt),
          tenant: r.subjectName,
          tenantPhone: r.subjectPhone,
          agent: r.agentName,
          agentPhone: r.agentPhone,
          status: statusLabel(r),
          category: r.categoryLabel,
          comment: r.comment ?? r.voidReason,
          context: [
            r.dailyRepayment != null ? `Daily ${ugx(r.dailyRepayment)}` : null,
            r.outstandingBalance != null ? `Balance ${ugx(r.outstandingBalance)}` : null,
            r.planStatus ? `Plan ${r.planStatus}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          officer: r.officer,
        })),
        metadata: {
          generatedBy: profile?.full_name?.trim() || (typeof user?.user_metadata?.full_name === 'string' ? user.user_metadata.full_name.trim() : ''),
          email: profile?.email?.trim() || user?.email?.trim() || '',
          generatedAt: new Date().toISOString(),
          reportPeriod: win.label,
        },
      };
      const { error: rpcError } = await supabase.rpc('archive_report', {
        p_source: 'call_centre',
        p_source_label: 'Tenant Calls Report',
        p_granularity: 'day',
        p_period_start: startDay,
        p_period_end: endDay,
        p_title: `Tenant Calls Report — ${startDay}`,
        p_payload: payload,
        p_summary: null,
        p_source_ref: null,
      });
      if (rpcError) throw rpcError;
      toast.success('Report archived. It will appear in HR · Report Archive.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not archive the report');
    } finally {
      setArchiving(false);
    }
  };

  const barColor = (name: string) =>
    name.startsWith('Engaged') || name.startsWith('Callback')
      ? 'hsl(var(--primary))'
      : name.startsWith('Open')
        ? 'hsl(var(--muted-foreground))'
        : 'hsl(var(--destructive))';

  return (
    <div className="space-y-3">
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 border-b bg-muted/30 p-3">
          <CardTitle className="flex items-center gap-2 text-xs font-bold">
            <BarChart3 className="h-4 w-4 text-primary" />
            Calls report
          </CardTitle>
          <span className="text-[10px] text-muted-foreground">{win.label}</span>
        </CardHeader>
        <CardContent className="space-y-3 p-3">
          <div className="flex flex-wrap items-center gap-2">
            {(['today', 'yesterday', 'custom'] as Preset[]).map((p) => (
              <Button
                key={p}
                size="sm"
                variant={preset === p ? 'default' : 'outline'}
                className="h-8 text-xs font-semibold capitalize"
                onClick={() => setPreset(p)}
              >
                {p === 'custom' ? 'Custom range' : p}
              </Button>
            ))}
            {preset === 'custom' && (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="date"
                  value={fromDay}
                  max={toDay}
                  onChange={(e) => setFromDay(e.target.value)}
                  className="h-8 w-[150px] text-xs"
                />
                <span className="text-xs text-muted-foreground">to</span>
                <Input
                  type="date"
                  value={toDay}
                  min={fromDay}
                  onChange={(e) => setToDay(e.target.value)}
                  className="h-8 w-[150px] text-xs"
                />
              </div>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Badge variant="secondary" className="h-7 text-[10px]">
                {rows.length.toLocaleString()} calls
              </Badge>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs font-semibold"
                onClick={exportPdf}
                disabled={busy || isLoading}
              >
                <FileText className="mr-1.5 h-3.5 w-3.5" />
                {busy ? 'Building…' : 'PDF'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs font-semibold"
                onClick={archiveReport}
                disabled={archiving || isLoading || rows.length === 0}
              >
                <Archive className="mr-1.5 h-3.5 w-3.5" />
                {archiving ? 'Archiving…' : 'Archive report'}
              </Button>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>Could not load calls: {error instanceof Error ? error.message : 'unknown error'}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-5">
            <KPICard title="Total calls" value={stats.total} icon={PhoneCall} color="bg-primary/10 text-primary" />
            <KPICard
              title="Engaged / answered"
              value={stats.engaged}
              icon={PhoneOutgoing}
              color="bg-emerald-500/10 text-emerald-600"
            />
            <KPICard
              title="Missed / unanswered"
              value={stats.missed}
              icon={PhoneMissed}
              color="bg-destructive/10 text-destructive"
            />
            <KPICard title="Open (unrecorded)" value={stats.open} icon={PhoneCall} color="bg-muted text-foreground" />
            <KPICard
              title="Feedback recorded"
              value={stats.feedback}
              icon={FileText}
              color="bg-amber-500/10 text-amber-600"
            />
          </div>

          <div className="h-[180px] w-full rounded-xl border border-border bg-muted/20 p-2">
            {isLoading ? (
              <Skeleton className="h-full w-full" />
            ) : stats.byStatus.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.byStatus} margin={{ top: 8, right: 8, left: -18, bottom: 4 }}>
                  <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} height={40} angle={-15} textAnchor="end" />
                  <YAxis allowDecimals={false} tick={{ fontSize: 9 }} />
                  <Tooltip contentStyle={{ fontSize: 11 }} />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {stats.byStatus.map((s) => (
                      <Cell key={s.name} fill={barColor(s.name)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                No calls in this period.
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="min-w-0 overflow-hidden">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 border-b bg-muted/30 p-3">
          <CardTitle className="flex items-center gap-2 text-xs font-bold">
            <PhoneCall className="h-4 w-4 text-primary" />
            Calls made in this period
          </CardTitle>
          <span className="text-[10px] text-muted-foreground">Same records as the Calling Hub</span>
        </CardHeader>
        <CardContent className="min-w-0 overflow-x-auto p-0">
          {isLoading ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : !rows.length ? (
            <div className="p-8 text-center">
              <PhoneCall className="mx-auto h-5 w-5 text-muted-foreground" />
              <p className="mt-2 text-xs text-muted-foreground">No tenant calls in this period.</p>
            </div>
          ) : (
            <table className="w-full min-w-[980px] text-xs">
              <thead>
                <tr className="border-b bg-muted/30 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="p-2.5 font-semibold">When</th>
                  <th className="p-2.5 font-semibold">Tenant</th>
                  <th className="p-2.5 font-semibold">Agent</th>
                  <th className="p-2.5 font-semibold">Status</th>
                  <th className="p-2.5 font-semibold">Feedback</th>
                  <th className="p-2.5 font-semibold">Comment</th>
                  <th className="p-2.5 font-semibold">Tenant plan</th>
                  <th className="p-2.5 font-semibold">Officer</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border/50 align-top last:border-0 hover:bg-muted/40">
                    <td className="whitespace-nowrap p-2.5 text-muted-foreground">{stamp(r.recordedAt ?? r.revealedAt)}</td>
                    <td className="p-2.5">
                      <div className="font-semibold">{r.subjectName}</div>
                      <div className="text-[10px] text-muted-foreground">{r.subjectPhone ?? '—'}</div>
                    </td>
                    <td className="p-2.5">
                      <div>{r.agentName ?? '—'}</div>
                      <div className="text-[10px] text-muted-foreground">{r.agentPhone ?? '—'}</div>
                    </td>
                    <td className="p-2.5">
                      <Badge
                        variant={isAnsweredOutcome(r.outcome) ? 'default' : r.outcome ? 'outline' : 'secondary'}
                        className="text-[10px]"
                      >
                        {statusLabel(r)}
                      </Badge>
                    </td>
                    <td className="p-2.5 text-muted-foreground">
                      {r.categoryLabel ?? '—'}
                      {r.severity ? <div className="text-[10px] capitalize">{r.severity}</div> : null}
                    </td>
                    <td className="max-w-[240px] p-2.5 text-muted-foreground">{r.comment ?? r.voidReason ?? '—'}</td>
                    <td className="whitespace-nowrap p-2.5 text-[10px] text-muted-foreground">
                      <div>Daily {ugx(r.dailyRepayment)}</div>
                      <div>Balance {ugx(r.outstandingBalance)}</div>
                      {r.planStatus ? <div className="capitalize">Plan {r.planStatus}</div> : null}
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
