import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ExecutiveDataTable, Column } from './ExecutiveDataTable';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { KPICard } from './KPICard';
import { SmsFailoverAlerts } from './SmsFailoverAlerts';
import { MessageSquare, Loader2, CheckCircle2, XCircle, Radio, CalendarDays, CalendarRange, Calendar, FileDown, Wallet } from 'lucide-react';
import { Send } from 'lucide-react';
import { format, formatDistanceToNow, subDays, startOfWeek, startOfMonth, endOfMonth, startOfDay, subMonths, differenceInCalendarDays } from 'date-fns';
import { downloadSmsTrafficPdf } from '@/lib/smsTrafficReportPdf';
import { formatUGX } from '@/lib/rentCalculations';
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
  provider_message_id: string | null;
  cost: string | null;
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

// `sms_delivery_log.source` is a free-form tag set by each sender (~55 distinct
// values in prod). Group them into a handful of categories for the CTO view;
// anything unrecognised falls into "Other" and still shows its raw source.
const CATEGORY_RULES: { category: string; test: (s: string) => boolean }[] = [
  {
    category: 'OTP & Verification',
    test: (s) => /otp|password-reset|verify-code/.test(s),
  },
  {
    category: 'Broadcasts',
    test: (s) => s.startsWith('broadcast'),
  },
  {
    category: 'Agent Alerts',
    test: (s) => /agent/.test(s) && !s.startsWith('approve'),
  },
  {
    category: 'Rent Collection & Arrears',
    test: (s) =>
      s.startsWith('advance_') ||
      s.startsWith('tenant_arrears') ||
      s.startsWith('tenant_self_repayment') ||
      s.startsWith('tenant_rent_intake') ||
      s.startsWith('tenant_notify:payment_'),
  },
  {
    category: 'Tenant & Rent Plan Notices',
    test: (s) =>
      s.startsWith('tenant_notify') ||
      s.startsWith('rent_plan') ||
      s.startsWith('rent_access') ||
      s.startsWith('signup_rent') ||
      s.startsWith('landlord') ||
      s.startsWith('welile_home') ||
      s.startsWith('notify-house'),
  },
  {
    category: 'Supporter & Partner',
    test: (s) => /promissory|supporter|signup-invite|notify-email-routing|notify-id-name/.test(s),
  },
  {
    category: 'Wallet, Deposits & Payouts',
    test: (s) =>
      /withdraw|payout|commission|deposit|finops|cfo-|requisition|hr-pay|wallet|gmail-poll|approve-/.test(s),
  },
];

function smsCategory(source: string | null): string {
  const s = (source || '').toLowerCase();
  if (!s) return 'Uncategorised';
  return CATEGORY_RULES.find((r) => r.test(s))?.category ?? 'Other';
}

// OTP / password-reset bodies carry live codes — never show them in a table
// or preview, even to the CTO.
function displayMessage(log: { message: string | null; category: string }): string {
  const msg = log.message ?? '';
  return log.category === 'OTP & Verification' ? msg.replace(/\d{4,8}/g, '••••••') : msg;
}

// GSM-7 segment count (160 single / 153 per part when concatenated). Messages
// with non-GSM characters use UCS-2 (70 / 67) — approximate with a char check.
function smsSegments(text: string) {
  const unicode = /[^\x00-\x7F£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ ¡ÄÖÑÜ§¿äöñüà€]/.test(text);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  const len = text.length;
  return { len, segments: len <= single ? (len ? 1 : 0) : Math.ceil(len / multi), unicode };
}

type SmsRow = SmsLog & { category: string; message_preview: string };

type DailyTrafficRow = {
  day: string;
  total: number;
  delivered: number;
  failed: number;
  yoola: number;
  africastalking: number;
  other: number;
};

// Daily provider-reported spend (get_sms_cost_daily). cost_ugx sums only
// UGX-denominated / bare-numeric cost strings; foreign-currency rows are
// counted, never converted (no invented exchange rates).
type DailyCostRow = {
  day: string;
  cost: number;
  foreign: number;
  uncosted: number;
};

export function SmsDeliveryLogViewer() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [previewRow, setPreviewRow] = useState<SmsRow | null>(null);
  const [generating, setGenerating] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  // 'current' = this month; 'custom' = a user-picked date range; otherwise a
  // 'yyyy-MM' key for a past month.
  const [monthFilter, setMonthFilter] = useState('current');
  const [customFrom, setCustomFrom] = useState<Date | undefined>();
  const [customTo, setCustomTo] = useState<Date | undefined>();

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
      { value: 'custom', label: 'Custom range' },
    ];
    for (let i = 1; i < 12; i++) {
      const d = subMonths(new Date(), i);
      opts.push({ value: format(d, 'yyyy-MM'), label: format(d, 'MMMM yyyy') });
    }
    return opts;
  })();

  const isPastMonth = monthFilter !== 'current' && monthFilter !== 'custom';
  const isCustom = monthFilter === 'custom';
  const customActive = isCustom && !!customFrom && !!customTo && customFrom.getTime() <= customTo.getTime();
  // "scoped" covers every non-default window uniformly: a past month or a
  // valid custom range. Everything downstream filters by rangeStart/rangeEnd.
  const scoped = isPastMonth || customActive;
  const selectedMonthDate = isPastMonth ? new Date(`${monthFilter}-01T00:00:00`) : new Date();
  const selectedMonthStart = startOfMonth(selectedMonthDate);
  const selectedMonthEnd = endOfMonth(selectedMonthDate);
  const rangeStart = customActive ? startOfDay(customFrom) : selectedMonthStart;
  const rangeEnd = customActive ? endOfDay(customTo) : selectedMonthEnd;
  const scopeLabel = customActive
    ? `${format(customFrom, 'dd MMM')} – ${format(customTo, 'dd MMM yyyy')}`
    : isPastMonth
    ? format(selectedMonthDate, 'MMMM yyyy')
    : 'This month';
  const customFromKey = customFrom ? format(customFrom, 'yyyy-MM-dd') : '';
  const customToKey = customTo ? format(customTo, 'yyyy-MM-dd') : '';
  // How far back the daily rollup must reach to cover the chosen scope.
  const rollupDays = Math.max(90, differenceInCalendarDays(new Date(), rangeStart) + 40);

  const { data: logs = [], isLoading } = useQuery({
    queryKey: ['cto-sms-delivery-log', monthFilter, customFromKey, customToKey, debouncedSearch],
    queryFn: async () => {
      const q = debouncedSearch;
      let query = supabase
        .from('sms_delivery_log')
        .select('id, created_at, recipient_phone, recipient_name, message, status, provider, provider_response, reference_id, source, error, provider_message_id, cost')
        .order('created_at', { ascending: false })
        .limit(q ? 1000 : 500);
      if (scoped) {
        query = query
          .gte('created_at', rangeStart.toISOString())
          .lte('created_at', rangeEnd.toISOString());
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

  // Spend metrics: server-side daily rollup of provider-reported cost strings.
  const { data: costRows = [], isLoading: costLoading } = useQuery({
    queryKey: ['cto-sms-cost', rollupDays],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_sms_cost_daily', { p_days: rollupDays });
      if (error) throw error;
      return ((data || []) as any[]).map((r) => ({
        day: String(r.day),
        cost: Number(r.cost_ugx) || 0,
        foreign: Number(r.msgs_foreign) || 0,
        uncosted: Number(r.msgs_uncosted) || 0,
      })) as DailyCostRow[];
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const rows = metrics || [];
  const now = new Date();
  const dayStart = startOfDay(now).getTime();
  const weekStart = startOfWeek(now, { weekStartsOn: 1 }).getTime();
  const monthStart = selectedMonthStart.getTime();
  const monthEnd = selectedMonthEnd.getTime();

  const costOf = (predicate: (t: number) => boolean) => {
    let cost = 0, foreign = 0;
    for (const r of costRows) {
      const t = startOfDay(new Date(`${r.day}T00:00:00`)).getTime();
      if (!predicate(t)) continue;
      cost += r.cost;
      foreign += r.foreign;
    }
    return { cost, foreign };
  };
  const inRange = (start: number, end: number) => (t: number) => t >= startOfDay(new Date(start)).getTime() && t <= startOfDay(new Date(end)).getTime();
  const todaySpend = costOf((t) => t >= dayStart);
  const thisMonthSpend = isPastMonth ? costOf(inRange(monthStart, monthEnd)) : costOf((t) => t >= monthStart);

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

  // Debounce the search box so each keystroke doesn't fire a backend query.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  // Search is applied server-side (see queryKey above) so we don't re-filter
  // client-side — otherwise phone variants like "0788…" vs "256788…" would
  // hide rows that the server correctly matched by last-9 digits.
  const tableRows: SmsRow[] = useMemo(
    () =>
      logs.map((l) => {
        const category = smsCategory(l.source);
        return { ...l, category, message_preview: displayMessage({ message: l.message, category }) };
      }),
    [logs],
  );

  // Per-category rollup of the loaded rows (the same set the table shows).
  const categorySummary = useMemo(() => {
    const map = new Map<string, { category: string; total: number; sent: number; failed: number; lastSentAt: string | null }>();
    for (const r of tableRows) {
      const e = map.get(r.category) ?? { category: r.category, total: 0, sent: 0, failed: 0, lastSentAt: null };
      e.total += 1;
      if (isSuccess(r.status)) e.sent += 1; else e.failed += 1;
      if (!e.lastSentAt || r.created_at > e.lastSentAt) e.lastSentAt = r.created_at;
      map.set(r.category, e);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [tableRows]);

  const categoryFilterOptions = categorySummary.map((c) => ({ value: c.category, label: c.category }));

  const categoryColumns: Column<(typeof categorySummary)[number]>[] = [
    { key: 'category', label: 'Category' },
    { key: 'total', label: 'Total', render: (v) => Number(v).toLocaleString() },
    { key: 'sent', label: 'Delivered', render: (v) => <span className="text-green-600 font-medium">{Number(v).toLocaleString()}</span> },
    {
      key: 'failed',
      label: 'Failed',
      render: (v) => (
        <span className={Number(v) > 0 ? 'text-destructive font-medium' : 'text-muted-foreground'}>{Number(v).toLocaleString()}</span>
      ),
    },
    { key: 'lastSentAt', label: 'Last Activity', render: (v) => (v ? format(new Date(v as string), 'dd MMM HH:mm') : '—') },
  ];

  const recentColumns: Column<SmsRow>[] = [
    { key: 'created_at', label: 'Time', render: (v) => format(new Date(v as string), 'dd MMM HH:mm') },
    {
      key: 'category',
      label: 'Category',
      render: (v, row) => (
        <div className="leading-tight">
          <span className="text-xs font-medium">{String(v)}</span>
          {row.source && <p className="text-[10px] text-muted-foreground font-mono">{row.source}</p>}
        </div>
      ),
    },
    {
      key: 'recipient_phone',
      label: 'Recipient',
      render: (v, row) => (
        <div className="leading-tight">
          <span className="text-xs font-medium">{row.recipient_name || String(v)}</span>
          {row.recipient_name && <p className="text-[10px] text-muted-foreground">{String(v)}</p>}
        </div>
      ),
    },
    {
      key: 'message_preview',
      label: 'Message',
      sortable: false,
      className: 'max-w-[320px] truncate text-xs text-muted-foreground',
    },
    {
      key: 'status',
      label: 'Status',
      render: (v) => {
        const s = String(v);
        const cls = isSuccess(s)
          ? 'bg-green-500/10 text-green-600'
          : s === 'queued' || s === 'pending'
          ? 'bg-amber-500/10 text-amber-700'
          : 'bg-destructive/10 text-destructive';
        return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{s}</span>;
      },
    },
    {
      key: 'provider',
      label: 'Provider',
      render: (v) => <Badge className={`text-[10px] px-1.5 py-0 ${providerColor(String(v))}`}>{providerLabel(String(v))}</Badge>,
    },
    { key: 'error', label: 'Error', className: 'max-w-[240px] truncate text-xs text-muted-foreground' },
  ];

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

      {/* Traffic metrics — daily / weekly / monthly / spend */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
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
        <KPICard
          title={isPastMonth ? `Spend — ${format(selectedMonthDate, 'MMM yyyy')}` : 'Spend This Month'}
          value={formatUGX(thisMonthSpend.cost)}
          icon={Wallet}
          color="bg-amber-500/10 text-amber-600"
          loading={costLoading}
          subtitle={`Today: ${formatUGX(todaySpend.cost)} · provider charges for SMS sent${thisMonthSpend.foreign > 0 ? ` · ${thisMonthSpend.foreign} foreign-currency rows excluded` : ''}`}
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
        <KPICard title="Total (loaded)" value={total.toLocaleString()} icon={Radio} loading={isLoading} />
        <KPICard title="Yoola Delivered" value={yoolaSent.toLocaleString()} icon={CheckCircle2} color="bg-primary/10 text-primary" loading={isLoading} />
        <KPICard title="AT Fallback Delivered" value={atSent.toLocaleString()} icon={CheckCircle2} color="bg-amber-500/10 text-amber-600" loading={isLoading} />
        <KPICard title="Failed Attempts" value={failed.toLocaleString()} icon={XCircle} color={failed > 0 ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'} loading={isLoading} />
      </div>

      {/* Summary by category */}
      <div>
        <h3 className="text-sm font-semibold mb-3">Summary by Category</h3>
        <ExecutiveDataTable
          data={categorySummary}
          columns={categoryColumns}
          loading={isLoading}
          title="SMS categories"
        />
      </div>

      {/* Sent SMS list */}
      <div>
        <h3 className="text-sm font-semibold mb-3">Sent SMS</h3>
        <p className="text-xs text-muted-foreground mb-2">
          Search hits the database directly (name, phone, message text, category source or reference) — not just the rows shown. Click a row to preview the SMS. OTP codes are masked.
        </p>
        <ExecutiveDataTable
          data={tableRows}
          columns={recentColumns}
          loading={isLoading && !debouncedSearch}
          title={debouncedSearch ? `SMS search results for "${debouncedSearch}"` : 'Sent SMS'}
          onRowClick={(row: SmsRow) => setPreviewRow(row)}
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search by name, phone, message text or reference…"
          searching={isLoading && !!debouncedSearch}
          filters={[
            { key: 'category', label: 'Category', options: categoryFilterOptions },
            {
              key: 'status',
              label: 'Status',
              options: [
                { value: 'sent', label: 'Sent' },
                { value: 'failed', label: 'Failed' },
                { value: 'queued', label: 'Queued' },
              ],
            },
            {
              key: 'provider',
              label: 'Provider',
              options: [
                { value: 'yoola', label: 'Yoola' },
                { value: 'africastalking', label: "Africa's Talking" },
              ],
            },
          ]}
        />
      </div>

      <Dialog open={!!previewRow} onOpenChange={(o) => !o && setPreviewRow(null)}>
        <DialogContent className="max-w-lg w-[95vw] max-h-[90vh] overflow-y-auto">
          {previewRow && (() => {
            const ok = isSuccess(previewRow.status);
            const seg = smsSegments(previewRow.message_preview);
            const attempts: any[] = Array.isArray(previewRow.provider_response?.attempts)
              ? previewRow.provider_response.attempts
              : [];
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="text-base">{previewRow.category}</DialogTitle>
                  <DialogDescription className="text-xs">
                    To <span className="font-medium text-foreground">{previewRow.recipient_name || previewRow.recipient_phone}</span>
                    {previewRow.recipient_name && <> ({previewRow.recipient_phone})</>}
                    {' • '}
                    <span className="capitalize">{previewRow.status}</span>
                    {' • '}
                    {format(new Date(previewRow.created_at), 'dd MMM yyyy HH:mm:ss')}
                  </DialogDescription>
                </DialogHeader>

                {/* Phone-style message bubble */}
                <div className="rounded-xl border border-border bg-muted/30 p-4">
                  <div className="max-w-[90%] rounded-2xl rounded-tl-sm bg-card border border-border px-3.5 py-2.5 shadow-sm">
                    {previewRow.message_preview ? (
                      <p className="text-sm whitespace-pre-wrap break-words">{previewRow.message_preview}</p>
                    ) : (
                      <p className="text-sm italic text-muted-foreground">No message body was archived for this SMS.</p>
                    )}
                  </div>
                  <p className="mt-2 text-[10px] text-muted-foreground">
                    {seg.len} characters · {seg.segments} SMS part{seg.segments === 1 ? '' : 's'}{seg.unicode ? ' (unicode)' : ''}
                  </p>
                </div>

                <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-xs">
                  <dt className="text-muted-foreground">Provider</dt>
                  <dd><Badge className={`text-[10px] px-1.5 py-0 ${providerColor(previewRow.provider)}`}>{providerLabel(previewRow.provider)}</Badge></dd>
                  <dt className="text-muted-foreground">Source</dt>
                  <dd className="font-mono">{previewRow.source || '—'}</dd>
                  {previewRow.reference_id && (<><dt className="text-muted-foreground">Reference</dt><dd className="font-mono break-all">{previewRow.reference_id}</dd></>)}
                  {previewRow.provider_message_id && (<><dt className="text-muted-foreground">Provider msg ID</dt><dd className="font-mono break-all">{previewRow.provider_message_id}</dd></>)}
                  {previewRow.cost && (<><dt className="text-muted-foreground">Cost</dt><dd>{previewRow.cost}</dd></>)}
                  {previewRow.error && (<><dt className="text-muted-foreground">Error</dt><dd className="text-destructive break-words">{previewRow.error}</dd></>)}
                </dl>

                {attempts.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold mb-1.5">Provider attempts</h4>
                    <div className="flex flex-col gap-1">
                      {attempts.map((a, i) => (
                        <div key={i} className="text-[11px] text-muted-foreground flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{i + 1}.</span>
                          <Badge className={`text-[9px] px-1 py-0 ${providerColor(a.provider)}`}>{providerLabel(a.provider)}</Badge>
                          <span className={a.accepted ?? a.ok ? 'text-emerald-600' : 'text-destructive'}>
                            {a.accepted ?? a.ok ? 'accepted' : a.attempted === false ? 'skipped' : 'failed'}
                          </span>
                          {(a.reason || a.error) && <span className="italic break-words">{a.reason || a.error}</span>}
                          {a.started_at && a.finished_at && (
                            <span className="text-muted-foreground/60">
                              ({Math.max(0, new Date(a.finished_at).getTime() - new Date(a.started_at).getTime())}ms)
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {!ok && !previewRow.error && attempts.length === 0 && (
                  <p className="text-xs text-muted-foreground">No failure detail was recorded for this attempt.</p>
                )}
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
