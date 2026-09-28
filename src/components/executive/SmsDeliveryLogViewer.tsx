import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { KPICard } from './KPICard';
import { SmsFailoverAlerts } from './SmsFailoverAlerts';
import { MessageSquare, Search, Loader2, CheckCircle2, XCircle, Radio, CalendarDays, CalendarRange, Calendar, FileDown } from 'lucide-react';
import { Send } from 'lucide-react';
import { format, formatDistanceToNow, subDays, startOfWeek, startOfMonth, endOfMonth, startOfDay, subMonths, differenceInCalendarDays } from 'date-fns';
import { downloadSmsTrafficPdf } from '@/lib/smsTrafficReportPdf';
import { toast } from 'sonner';

type SmsLog = {
  id: string;
  created_at: string;
  recipient_phone: string;
  recipient_name: string | null;
  message: string | null;
  status: string;
  provider: string;
  provider_response: any;
  reference_id: string | null;
  source: string | null;
  error: string | null;
};

const PROVIDER_LABEL: Record<string, string> = {
  yoola: 'Yoola',
  africastalking: "Africa's Talking",
  africas_talking: "Africa's Talking",
};

function providerLabel(p: string) {
  return PROVIDER_LABEL[(p || '').toLowerCase()] || p || 'Unknown';
}

function providerColor(p: string) {
  const v = (p || '').toLowerCase();
  if (v === 'yoola') return 'bg-primary/10 text-primary border-0';
  if (v.includes('africa')) return 'bg-amber-500/10 text-amber-600 border-0';
  return 'bg-muted text-muted-foreground border-0';
}

function isSuccess(status: string) {
  const s = (status || '').toLowerCase();
  return s === 'sent' || s === 'success' || s === 'delivered' || s === 'accepted';
}

type DailyTrafficRow = {
  day: string;
  total: number;
  delivered: number;
  failed: number;
  yoola: number;
  africastalking: number;
  other: number;
};

export function SmsDeliveryLogViewer() {
  const [search, setSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [generating, setGenerating] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  // 'current' = this month; otherwise a 'yyyy-MM' key for a past month.
  const [monthFilter, setMonthFilter] = useState('current');

  // Test SMS that sends with the WELILE sender id on BOTH providers. All
  // production SMS channels now set WELILE explicitly. Fires one message per
  // provider so we can compare which gateway actually delivers WELILE end-to-end.
  const TEST_SMS_PHONE = '0701355245';
  const TEST_SMS_SENDER = 'WELILE';
  const TEST_PROVIDERS: { id: 'yoola' | 'africastalking'; label: string }[] = [
    { id: 'yoola', label: 'Yoola' },
    { id: 'africastalking', label: "Africa's Talking" },
  ];
  const handleSendTestSms = async () => {
    if (sendingTest) return;
    setSendingTest(true);
    try {
      const results = await Promise.all(
        TEST_PROVIDERS.map(async ({ id, label }) => {
          try {
            const { data, error } = await supabase.functions.invoke('sms-test-send', {
              body: {
                phone: TEST_SMS_PHONE,
                provider: id,
                sender: TEST_SMS_SENDER,
                message: `This is from ${label} test message`,
              },
            });
            if (error) throw error;
            return { label, ok: !!data?.ok, reason: data?.reason as string | undefined };
          } catch (e: any) {
            return { label, ok: false, reason: e?.message as string | undefined };
          }
        }),
      );
      for (const r of results) {
        if (r.ok) {
          toast.success(`${r.label} (WELILE) sent to ${TEST_SMS_PHONE}.`);
        } else {
          toast.error(`${r.label} (WELILE): ${r.reason || 'did not accept the test SMS.'}`);
        }
      }
    } finally {
      setSendingTest(false);
    }
  };

  // Build the last 12 months as selectable options.
  const monthOptions = (() => {
    const opts: { value: string; label: string }[] = [
      { value: 'current', label: 'This Month' },
    ];
    for (let i = 1; i < 12; i++) {
      const d = subMonths(new Date(), i);
      opts.push({ value: format(d, 'yyyy-MM'), label: format(d, 'MMMM yyyy') });
    }
    return opts;
  })();

  const isPastMonth = monthFilter !== 'current';
  const selectedMonthDate = isPastMonth ? new Date(`${monthFilter}-01T00:00:00`) : new Date();
  const selectedMonthStart = startOfMonth(selectedMonthDate);
  const selectedMonthEnd = endOfMonth(selectedMonthDate);
  // How far back the daily rollup must reach to cover the chosen month.
  const rollupDays = Math.max(90, differenceInCalendarDays(new Date(), selectedMonthStart) + 40);

  const { data: logs = [], isLoading } = useQuery({
    queryKey: ['cto-sms-delivery-log', providerFilter, statusFilter, monthFilter, search.trim()],
    queryFn: async () => {
      const q = search.trim();
      let query = supabase
        .from('sms_delivery_log')
        .select('id, created_at, recipient_phone, recipient_name, message, status, provider, provider_response, reference_id, source, error')
        .order('created_at', { ascending: false })
        .limit(q ? 1000 : 300);
      if (providerFilter !== 'all') query = query.eq('provider', providerFilter);
      if (statusFilter === 'success') query = query.in('status', ['sent', 'success', 'delivered', 'accepted']);
      if (statusFilter === 'failed') query = query.not('status', 'in', '(sent,success,delivered,accepted)');
      if (isPastMonth) {
        query = query
          .gte('created_at', selectedMonthStart.toISOString())
          .lte('created_at', selectedMonthEnd.toISOString());
      }
      if (q) {
        // Search server-side so a phone/name outside the latest 300 rows is
        // still found. Normalize phone digits and match on last-9 for
        // 07XX / 2567XX / +2567XX equivalence.
        const digits = q.replace(/\D/g, '');
        const ors: string[] = [
          `recipient_name.ilike.%${q}%`,
          `source.ilike.%${q}%`,
          `reference_id.ilike.%${q}%`,
          `message.ilike.%${q}%`,
        ];
        if (digits.length >= 6) {
          const last9 = digits.slice(-9);
          ors.push(`recipient_phone.ilike.%${last9}%`);
        } else if (q) {
          ors.push(`recipient_phone.ilike.%${q}%`);
        }
        query = query.or(ors.join(','));
      }
      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as SmsLog[];
    },
    staleTime: 30_000,
    // Was refreshed by SmsFailoverAlerts' Realtime INSERT listener on every
    // new SMS; that listener is now polling (doc 147), so poll here too.
    refetchInterval: 60_000,
  });

  // Traffic metrics: aggregate server-side (avoids the Data API 1,000-row cap).
  const { data: metrics, isLoading: metricsLoading } = useQuery({
    queryKey: ['cto-sms-metrics', rollupDays],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_sms_traffic_daily', { p_days: rollupDays });
      if (error) throw error;
      return ((data || []) as any[]).map((r) => ({
        day: String(r.day),
        total: Number(r.total) || 0,
        delivered: Number(r.delivered) || 0,
        failed: Number(r.failed) || 0,
        yoola: Number(r.yoola) || 0,
        africastalking: Number(r.africastalking) || 0,
        other: Number(r.other) || 0,
      })) as DailyTrafficRow[];
    },
    staleTime: 60_000,
  });

  const rows = metrics || [];
  const now = new Date();
  const dayStart = startOfDay(now).getTime();
  const weekStart = startOfWeek(now, { weekStartsOn: 1 }).getTime();
  const monthStart = selectedMonthStart.getTime();
  const monthEnd = selectedMonthEnd.getTime();

  const countSince = (cutoff: number) => {
    let sent = 0, fail = 0;
    for (const r of rows) {
      // r.day is a yyyy-MM-dd date string; compare at day granularity.
      if (startOfDay(new Date(`${r.day}T00:00:00`)).getTime() < startOfDay(new Date(cutoff)).getTime()) continue;
      sent += r.delivered;
      fail += r.failed;
    }
    return { total: sent + fail, sent, fail };
  };
  const countBetween = (start: number, end: number) => {
    let sent = 0, fail = 0;
    for (const r of rows) {
      const t = startOfDay(new Date(`${r.day}T00:00:00`)).getTime();
      if (t < startOfDay(new Date(start)).getTime() || t > startOfDay(new Date(end)).getTime()) continue;
      sent += r.delivered;
      fail += r.failed;
    }
    return { total: sent + fail, sent, fail };
  };
  const today = countSince(dayStart);
  const thisWeek = countSince(weekStart);
  const thisMonth = isPastMonth ? countBetween(monthStart, monthEnd) : countSince(monthStart);

  // Daily traffic chart — last 30 days, or the full selected past month.
  const dailyTraffic = (() => {
    const byDay: Record<string, { delivered: number; failed: number }> = {};
    if (isPastMonth) {
      const days = differenceInCalendarDays(selectedMonthEnd, selectedMonthStart);
      for (let i = 0; i <= days; i++) {
        byDay[format(subDays(selectedMonthEnd, days - i), 'yyyy-MM-dd')] = { delivered: 0, failed: 0 };
      }
    } else {
      for (let i = 29; i >= 0; i--) {
        byDay[format(subDays(now, i), 'yyyy-MM-dd')] = { delivered: 0, failed: 0 };
      }
    }
    for (const r of rows) {
      if (!byDay[r.day]) continue;
      byDay[r.day].delivered += r.delivered;
      byDay[r.day].failed += r.failed;
    }
    return Object.entries(byDay).map(([date, v]) => ({
      day: format(new Date(`${date}T00:00:00`), 'dd MMM'),
      delivered: v.delivered,
      failed: v.failed,
    }));
  })();

  const handleGenerateReport = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      // Server-aggregated rollup — reaches back far enough to cover the
      // selected month, avoiding the Data API 1,000-row cap.
      const { data, error } = await supabase.rpc('get_sms_traffic_daily', { p_days: rollupDays });
      if (error) throw error;
      let report = ((data || []) as any[]).map((r) => ({
        day: String(r.day),
        total: Number(r.total) || 0,
        delivered: Number(r.delivered) || 0,
        failed: Number(r.failed) || 0,
        yoola: Number(r.yoola) || 0,
        at: Number(r.africastalking) || 0,
        other: Number(r.other) || 0,
      }));
      // Scope the report to the selected month when a past month is chosen.
      if (isPastMonth) {
        const startKey = format(selectedMonthStart, 'yyyy-MM-dd');
        const endKey = format(selectedMonthEnd, 'yyyy-MM-dd');
        report = report.filter((r) => r.day >= startKey && r.day <= endKey);
      }
      if (report.length === 0) {
        toast.error('No SMS traffic in the selected window to report.');
        return;
      }
      const reportRows = [...report]
        .sort((a, b) => (a.day < b.day ? 1 : -1))
        .map((a) => ({
          day: format(new Date(`${a.day}T00:00:00`), 'dd MMM yyyy'),
          total: a.total,
          delivered: a.delivered,
          failed: a.failed,
          yoola: a.yoola,
          at: a.at,
          other: a.other,
        }));
      const windowLabel = isPastMonth
        ? format(selectedMonthDate, 'MMMM yyyy')
        : `Last ${rollupDays} days`;
      const rangeLabel = isPastMonth
        ? `${format(selectedMonthStart, 'dd MMM yyyy')} to ${format(selectedMonthEnd, 'dd MMM yyyy')}`
        : `${format(subDays(startOfDay(new Date()), rollupDays - 1), 'dd MMM yyyy')} to ${format(new Date(), 'dd MMM yyyy')}`;
      const contextLabel = `Today: ${today.total.toLocaleString()}  ·  This week: ${thisWeek.total.toLocaleString()}  ·  ${isPastMonth ? windowLabel : 'This month'}: ${thisMonth.total.toLocaleString()}`;
      const fileTag = isPastMonth ? format(selectedMonthDate, 'yyyy-MM') : format(new Date(), 'yyyy-MM-dd');
      await downloadSmsTrafficPdf(
        `sms-otp-traffic-report-${fileTag}.pdf`,
        reportRows,
        { windowLabel, rangeLabel, contextLabel },
      );
      toast.success('SMS traffic report generated.');
    } catch (e: any) {
      toast.error(e?.message || 'Failed to generate report.');
    } finally {
      setGenerating(false);
    }
  };

  // Search is applied server-side (see queryKey above) so we don't re-filter
  // client-side — otherwise phone variants like "0788…" vs "256788…" would
  // hide rows that the server correctly matched by last-9 digits.
  const filtered = logs;

  const total = logs.length;
  const yoolaSent = logs.filter((l) => (l.provider || '').toLowerCase() === 'yoola' && isSuccess(l.status)).length;
  const atSent = logs.filter((l) => (l.provider || '').toLowerCase().includes('africa') && isSuccess(l.status)).length;
  const failed = logs.filter((l) => !isSuccess(l.status)).length;

  return (
    <div className="space-y-4 sm:space-y-6">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-primary" />
          OTP / SMS Delivery Logs
        </h2>
        <p className="text-xs text-muted-foreground">
          Per-provider audit trail — which gateway was attempted (Yoola primary → Africa's Talking fallback), timestamps, and final outcome.
        </p>
      </div>

      <SmsFailoverAlerts />

      {/* Month scope selector + sender-id test button */}
      <div className="flex flex-wrap items-center gap-2">
        <Calendar className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Viewing:</span>
        <Select value={monthFilter} onValueChange={setMonthFilter}>
          <SelectTrigger className="w-[170px] h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {monthOptions.map((m) => (
              <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          onClick={handleSendTestSms}
          disabled={sendingTest}
          className="h-8 text-xs gap-1.5"
          title={`Send a WELILE test SMS to ${TEST_SMS_PHONE} via both Yoola and Africa's Talking`}
        >
          {sendingTest ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Send WELILE test (both) → {TEST_SMS_PHONE}
        </Button>
      </div>

      {/* Traffic metrics — daily / weekly / monthly */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
        <KPICard
          title="Sent Today"
          value={today.total.toLocaleString()}
          icon={CalendarDays}
          color="bg-primary/10 text-primary"
          loading={metricsLoading}
          subtitle={`${today.sent} delivered · ${today.fail} failed`}
        />
        <KPICard
          title="This Week"
          value={thisWeek.total.toLocaleString()}
          icon={CalendarRange}
          color="bg-blue-500/10 text-blue-600"
          loading={metricsLoading}
          subtitle={`${thisWeek.sent} delivered · ${thisWeek.fail} failed`}
        />
        <KPICard
          title={isPastMonth ? format(selectedMonthDate, 'MMMM yyyy') : 'This Month'}
          value={thisMonth.total.toLocaleString()}
          icon={Calendar}
          color="bg-teal-500/10 text-teal-600"
          loading={metricsLoading}
          subtitle={`${thisMonth.sent} delivered · ${thisMonth.fail} failed`}
        />
      </div>

      {/* Daily traffic chart */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <CardTitle className="text-base flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-primary" /> {isPastMonth ? `Daily Traffic — ${format(selectedMonthDate, 'MMM yyyy')}` : 'Daily Traffic (30d)'}
            </CardTitle>
            <Button size="sm" variant="outline" onClick={handleGenerateReport} disabled={generating} className="h-8 text-xs gap-1.5">
              {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
              Generate Report
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {metricsLoading ? (
            <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={dailyTraffic}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="day" tick={{ fontSize: 10 }} interval={2} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="delivered" name="Delivered" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                <Line type="monotone" dataKey="failed" name="Failed" stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <KPICard title="Total (last 300)" value={total.toLocaleString()} icon={Radio} loading={isLoading} />
        <KPICard title="Yoola Delivered" value={yoolaSent.toLocaleString()} icon={CheckCircle2} color="bg-primary/10 text-primary" loading={isLoading} />
        <KPICard title="AT Fallback Delivered" value={atSent.toLocaleString()} icon={CheckCircle2} color="bg-amber-500/10 text-amber-600" loading={isLoading} />
        <KPICard title="Failed Attempts" value={failed.toLocaleString()} icon={XCircle} color={failed > 0 ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'} loading={isLoading} />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
            <CardTitle className="text-base flex items-center gap-2 shrink-0">
              <MessageSquare className="h-4 w-4 text-primary" /> Delivery Attempts
            </CardTitle>
            <div className="flex flex-col sm:flex-row flex-wrap gap-2 w-full sm:w-auto">
              <div className="relative flex-1 min-w-[220px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Trace by name or phone number…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9 h-9 text-xs w-full"
                  aria-label="Trace delivery logs by name or phone number"
                />
              </div>
              <Select value={providerFilter} onValueChange={setProviderFilter}>
                <SelectTrigger className="w-[140px] h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Providers</SelectItem>
                  <SelectItem value="yoola">Yoola</SelectItem>
                  <SelectItem value="africastalking">Africa's Talking</SelectItem>
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[120px] h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="success">Delivered</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <ScrollArea className="max-h-[600px]">
            {isLoading ? (
              <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
            ) : filtered.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">No SMS delivery logs found</div>
            ) : (
              <div className="space-y-1.5">
                {filtered.map((log) => {
                  const ok = isSuccess(log.status);
                  const attempts: any[] = Array.isArray(log.provider_response?.attempts)
                    ? log.provider_response.attempts
                    : [];
                  return (
                    <div key={log.id} className="flex items-start gap-3 p-2.5 rounded-lg border border-border/50 hover:bg-muted/30 transition-colors">
                      <div className="mt-0.5">
                        {ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <XCircle className="h-4 w-4 text-destructive" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge className={`text-[10px] px-1.5 py-0 ${providerColor(log.provider)}`}>{providerLabel(log.provider)}</Badge>
                          <Badge variant={ok ? 'secondary' : 'destructive'} className="text-[10px] px-1.5 py-0">{log.status}</Badge>
                          {log.source && <span className="text-[10px] text-muted-foreground">via {log.source}</span>}
                        </div>
                        <p className="text-sm mt-0.5">
                          <span className="font-medium">{log.recipient_name || log.recipient_phone}</span>
                          {log.recipient_name && <span className="text-muted-foreground text-xs"> · {log.recipient_phone}</span>}
                        </p>
                        {log.error && <p className="text-[11px] text-destructive truncate">{log.error}</p>}
                        {attempts.length > 0 && (
                          <div className="mt-1 flex flex-col gap-0.5">
                            {attempts.map((a, i) => (
                              <div key={i} className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                                <span className="font-medium">{i + 1}.</span>
                                <Badge className={`text-[9px] px-1 py-0 ${providerColor(a.provider)}`}>{providerLabel(a.provider)}</Badge>
                                <span className={a.accepted ? 'text-emerald-600' : 'text-destructive'}>
                                  {a.accepted ? 'accepted' : a.attempted === false ? 'skipped' : 'failed'}
                                </span>
                                {a.reason && <span className="italic truncate">{a.reason}</span>}
                                {a.started_at && a.finished_at && (
                                  <span className="text-muted-foreground/60">
                                    ({Math.max(0, new Date(a.finished_at).getTime() - new Date(a.started_at).getTime())}ms)
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {log.reference_id && <p className="text-[10px] text-muted-foreground/70">Ref: {log.reference_id}</p>}
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-[11px] text-muted-foreground">{formatDistanceToNow(new Date(log.created_at), { addSuffix: true })}</p>
                        <p className="text-[10px] text-muted-foreground/60">{format(new Date(log.created_at), 'dd MMM HH:mm:ss')}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}