import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  format,
  startOfDay,
  endOfDay,
  subDays,
  eachDayOfInterval,
} from 'date-fns';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { Users, UserPlus, LogIn, TrendingUp, CalendarRange, Activity } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { KPICard } from './KPICard';
import { Download, FileText } from 'lucide-react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { UserAnalyticsDrilldown, type DrilldownScope } from './UserAnalyticsDrilldown';
import { RetentionCohortView } from './RetentionCohortView';
import { AnalyticsExportJobsPanel } from './AnalyticsExportJobsPanel';

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);

  void logAnalyticsExport(filename);
}

// Bulk export of population-wide user analytics (CSV and PDF paths), not
// logged before this. Plain client-side insert so the audit_logs
// IP-capture trigger sees the real browser IP directly. Never blocks the
// actual download.
async function logAnalyticsExport(filename: string) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('audit_logs').insert({
      user_id: user?.id ?? null,
      action_type: 'analytics_report_exported',
      table_name: 'export',
      record_id: null,
      metadata: { filename },
    });
  } catch (e) {
    console.warn('[UserAnalyticsView] audit log insert failed:', e);
  }
}

function toCSV(rows: Array<Record<string, any>>): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = (v: any) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
}

type RangePreset = 'last_7' | 'last_30' | 'last_90' | 'custom';

function rangeBounds(preset: RangePreset, cs: string, ce: string) {
  const now = new Date();
  switch (preset) {
    case 'last_7': return { start: startOfDay(subDays(now, 6)), end: endOfDay(now) };
    case 'last_30': return { start: startOfDay(subDays(now, 29)), end: endOfDay(now) };
    case 'last_90': return { start: startOfDay(subDays(now, 89)), end: endOfDay(now) };
    case 'custom': return { start: startOfDay(new Date(cs)), end: endOfDay(new Date(ce)) };
  }
}

export function UserAnalyticsView() {
  const now = new Date();
  const [preset, setPreset] = useState<RangePreset>('last_7');
  const [customStart, setCustomStart] = useState(format(subDays(now, 6), 'yyyy-MM-dd'));
  const [customEnd, setCustomEnd] = useState(format(now, 'yyyy-MM-dd'));
  const [drillScope, setDrillScope] = useState<DrilldownScope | null>(null);

  const { start, end } = rangeBounds(preset, customStart, customEnd);
  const days = eachDayOfInterval({ start, end });
  const startISO = start.toISOString();
  const endISO = end.toISOString();
  const openDrill = (s: DrilldownScope) => setDrillScope(s);

  // Daily signups
  const { data: signupSeries, isLoading: loadingSignups } = useQuery({
    queryKey: ['user-analytics-signups-v2', preset, customStart, customEnd],
    queryFn: async () => {
      // Server-side aggregation — client fetch was capped at 1,000 rows and
      // silently truncated multi-thousand-signup ranges.
      const { data, error } = await supabase.rpc('get_daily_signups', {
        p_start: start.toISOString(),
        p_end: end.toISOString(),
      });
      if (error) throw error;
      const map = new Map<string, { signups: number; referred: number; organic: number }>();
      days.forEach((d) => map.set(format(d, 'yyyy-MM-dd'), { signups: 0, referred: 0, organic: 0 }));
      (data || []).forEach((r: any) => {
        const k = format(new Date(r.day), 'yyyy-MM-dd');
        if (map.has(k)) {
          map.set(k, {
            signups: Number(r.signups) || 0,
            referred: Number(r.referred) || 0,
            organic: Number(r.organic) || 0,
          });
        }
      });
      return Array.from(map.entries()).map(([k, v]) => ({ date: format(new Date(k), 'MMM d'), ...v }));
    },
    staleTime: 300000,
  });

  // Daily active users (distinct successful logins)
  const { data: activeSeries, isLoading: loadingActive } = useQuery({
    queryKey: ['user-analytics-active-v3', preset, customStart, customEnd],
    queryFn: async () => {
      // Server-side DISTINCT — pulling 200k rows client-side was slow and
      // still risked truncation on high-traffic days.
      const { data, error } = await supabase.rpc('get_daily_active_users', {
        p_start: start.toISOString(),
        p_end: end.toISOString(),
      });
      if (error) throw error;
      const map = new Map<string, number>();
      days.forEach((d) => map.set(format(d, 'yyyy-MM-dd'), 0));
      (data || []).forEach((r: any) => {
        const k = format(new Date(r.day), 'yyyy-MM-dd');
        if (map.has(k)) map.set(k, Number(r.active) || 0);
      });
      return Array.from(map.entries()).map(([k, v]) => ({ date: format(new Date(k), 'MMM d'), active: v }));
    },
    staleTime: 300000,
  });

  // Totals
  const { data: totals } = useQuery({
    queryKey: ['user-analytics-totals', preset, customStart, customEnd],
    queryFn: async () => {
      const [signups, allUsers, loginAttempts, loginSuccess] = await Promise.all([
        supabase.from('profiles').select('*', { count: 'exact', head: true })
          .gte('created_at', start.toISOString()).lte('created_at', end.toISOString()),
        supabase.from('profiles').select('*', { count: 'exact', head: true }),
        supabase.from('otp_login_audit').select('*', { count: 'exact', head: true })
          .gte('created_at', start.toISOString()).lte('created_at', end.toISOString()),
        supabase.from('otp_login_audit').select('*', { count: 'exact', head: true })
          .eq('outcome', 'success')
          .gte('created_at', start.toISOString()).lte('created_at', end.toISOString()),
      ]);
      return {
        signups: signups.count || 0,
        allUsers: allUsers.count || 0,
        loginAttempts: loginAttempts.count || 0,
        loginSuccess: loginSuccess.count || 0,
      };
    },
    staleTime: 300000,
  });

  // Role distribution snapshot
  const { data: roleDist } = useQuery({
    queryKey: ['user-analytics-roles-v2'],
    queryFn: async () => {
      // The bare `.select('role')` was capped at 1,000 rows, so a platform
      // with 200k+ role rows reported only a few hundred per role.
      const { data, error } = await supabase.rpc('get_user_role_distribution');
      if (error) throw error;
      return (data || [])
        .map((r: any) => ({ role: r.role as string, count: Number(r.count) || 0 }))
        .sort((a, b) => b.count - a.count);
    },
    staleTime: 600000,
  });

  const totalActive = useMemo(
    () => (activeSeries || []).reduce((s, r) => s + r.active, 0),
    [activeSeries],
  );
  const loginRate = totals && totals.loginAttempts > 0
    ? Math.round((totals.loginSuccess / totals.loginAttempts) * 100)
    : 0;

  const presets: { label: string; value: RangePreset }[] = [
    { label: 'Last 7d', value: 'last_7' },
    { label: 'Last 30d', value: 'last_30' },
    { label: 'Last 90d', value: 'last_90' },
    { label: 'Custom', value: 'custom' },
  ];

  const rangeLabel = `${format(start, 'yyyy-MM-dd')}_to_${format(end, 'yyyy-MM-dd')}`;

  const buildDatasets = () => ({
    summary: [
      { metric: 'Total Users', value: totals?.allUsers ?? 0 },
      { metric: 'New Signups (range)', value: totals?.signups ?? 0 },
      { metric: 'Active User-Days', value: totalActive },
      { metric: 'Login Attempts', value: totals?.loginAttempts ?? 0 },
      { metric: 'Login Success', value: totals?.loginSuccess ?? 0 },
      { metric: 'Login Success Rate (%)', value: loginRate },
    ],
    signups: (signupSeries || []).map((r) => ({
      date: r.date, signups: r.signups, referred: r.referred, organic: r.organic,
    })),
    active: (activeSeries || []).map((r) => ({ date: r.date, active_users: r.active })),
    roles: (roleDist || []).map((r) => ({ role: r.role, count: r.count })),
  });

  const handleExportCSV = () => {
    const d = buildDatasets();
    const sections = [
      `User Analytics Report,,${rangeLabel}`,
      '',
      'Summary',
      toCSV(d.summary),
      '',
      'Daily Signups',
      toCSV(d.signups),
      '',
      'Daily Active Users',
      toCSV(d.active),
      '',
      'Users by Role',
      toCSV(d.roles),
    ];
    downloadBlob(sections.join('\n'), `user-analytics_${rangeLabel}.csv`, 'text/csv;charset=utf-8');
  };

  const handleExportPDF = () => {
    const d = buildDatasets();
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    doc.setFontSize(14);
    doc.text('User Analytics Report', 40, 40);
    doc.setFontSize(10);
    doc.text(`Range: ${format(start, 'yyyy-MM-dd')} to ${format(end, 'yyyy-MM-dd')}`, 40, 58);

    let y = 78;
    const section = (title: string, head: string[], body: any[][]) => {
      doc.setFontSize(11);
      doc.text(title, 40, y);
      y += 6;
      autoTable(doc, {
        startY: y,
        head: [head],
        body,
        headStyles: { fillColor: [30, 41, 59] },
        styles: { fontSize: 9 },
        margin: { left: 40, right: 40 },
      });
      y = (doc as any).lastAutoTable.finalY + 18;
    };

    section('Summary', ['Metric', 'Value'], d.summary.map((r) => [r.metric, String(r.value)]));
    section('Daily Signups', ['Date', 'Signups', 'Referred', 'Organic'],
      d.signups.map((r) => [r.date, r.signups, r.referred, r.organic]));
    section('Daily Active Users', ['Date', 'Active Users'],
      d.active.map((r) => [r.date, r.active_users]));
    section('Users by Role', ['Role', 'Count'], d.roles.map((r) => [r.role, r.count]));

    const pdfFilename = `user-analytics_${rangeLabel}.pdf`;
    doc.save(pdfFilename);
    void logAnalyticsExport(pdfFilename);
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="rounded-2xl border border-border bg-card p-3 sm:p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <CalendarRange className="w-4 h-4 text-primary" /> User Analytics
          </h3>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={handleExportCSV} className="text-xs">
              <Download className="w-3.5 h-3.5 mr-1" /> CSV
            </Button>
            <Button size="sm" variant="outline" onClick={handleExportPDF} className="text-xs">
              <FileText className="w-3.5 h-3.5 mr-1" /> PDF
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <Button
              key={p.value}
              size="sm"
              variant={preset === p.value ? 'secondary' : 'outline'}
              onClick={() => setPreset(p.value)}
              className="text-xs"
            >
              {p.label}
            </Button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label className="text-xs">From</Label>
              <Input type="date" value={customStart} max={customEnd}
                onChange={(e) => setCustomStart(e.target.value)} className="w-44" />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">To</Label>
              <Input type="date" value={customEnd} min={customStart}
                max={format(new Date(), 'yyyy-MM-dd')}
                onChange={(e) => setCustomEnd(e.target.value)} className="w-44" />
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard title="Total Users" value={(totals?.allUsers ?? 0).toLocaleString()} icon={Users}
          onClick={() => openDrill({ kind: 'total_users' })} />
        <KPICard title="New Signups" value={(totals?.signups ?? 0).toLocaleString()} icon={UserPlus}
          color="bg-green-500/10 text-green-600" subtitle="in range · click to view"
          onClick={() => openDrill({ kind: 'signups', start: startISO, end: endISO })} />
        <KPICard title="Active User-Days" value={totalActive.toLocaleString()} icon={Activity}
          color="bg-blue-500/10 text-blue-600" subtitle="click for distinct users"
          onClick={() => openDrill({ kind: 'dau', start: startISO, end: endISO })} />
        <KPICard title="Login Success" value={`${loginRate}%`} icon={LogIn}
          color="bg-amber-500/10 text-amber-600"
          subtitle={`${totals?.loginSuccess ?? 0}/${totals?.loginAttempts ?? 0} · click for users`}
          onClick={() => openDrill({ kind: 'login_success', start: startISO, end: endISO })} />
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <TrendingUp className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold">Daily Signups (Referred vs Organic)</h3>
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={signupSeries || []}>
              <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="referred" stackId="a" fill="hsl(var(--primary))" name="Referred" />
              <Bar dataKey="organic" stackId="a" fill="hsl(var(--muted-foreground))" name="Organic" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold">Daily Active Users</h3>
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={activeSeries || []}>
              <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Area type="monotone" dataKey="active" stroke="hsl(var(--primary))"
                fill="hsl(var(--primary))" fillOpacity={0.2} name="Active users" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold mb-3">Users by Role <span className="text-[10px] font-normal text-muted-foreground">(click a role to view)</span></h3>
        <div className="space-y-2">
          {(roleDist || []).map((r) => {
            const max = roleDist?.[0]?.count || 1;
            return (
              <button
                key={r.role}
                type="button"
                onClick={() => openDrill({ kind: 'role', role: r.role })}
                className="w-full text-left rounded-md px-1 py-1 -mx-1 hover:bg-muted/40 transition-colors"
              >
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-medium capitalize">{r.role.replace(/_/g, ' ')}</span>
                  <span className="text-muted-foreground">{r.count.toLocaleString()}</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-primary"
                    style={{ width: `${(r.count / max) * 100}%` }} />
                </div>
              </button>
            );
          })}
          {(!roleDist || roleDist.length === 0) && (
            <p className="text-xs text-muted-foreground">No role data available.</p>
          )}
        </div>
      </div>

      {(loadingSignups || loadingActive) && (
        <p className="text-xs text-muted-foreground text-center">Loading analytics…</p>
      )}

      <UserAnalyticsDrilldown
        open={!!drillScope}
        onOpenChange={(v) => { if (!v) setDrillScope(null); }}
        scope={drillScope}
      />

      <RetentionCohortView />

      <AnalyticsExportJobsPanel start={start} end={end} rangeLabel={rangeLabel} />
    </div>
  );
}