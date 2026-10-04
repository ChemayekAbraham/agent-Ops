import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CalendarIcon, Download, FileSpreadsheet, Loader2 } from 'lucide-react';
import { format, startOfDay, endOfDay, subDays, startOfMonth } from 'date-fns';
import { toast } from 'sonner';
import { downloadCsv, csvTimestamp } from '@/lib/csvExport';
import { downloadXlsx } from '@/lib/xlsxExport';
import {
  generateTenantCallingHubPdf,
  downloadPdfBlob,
  type CallingPdfTable,
} from '@/lib/tenantCallingHubPdf';
import {
  TENANT_CALL_STATUS_LABEL,
  useTenantCallRecords,
  type TenantCallStatus,
  type TenantCallRecord,
} from '@/hooks/useTenantCallReports';
import type { CallingListRow } from '@/hooks/useTenantCallingList';


type ReportKind =
  | 'calls_comprehensive'
  | 'comprehensive' | 'call_log' | 'all' | 'pending' | 'closed' | 'missed' | 'staff' | 'comments';

const KINDS: { key: ReportKind; label: string; detail: string; file: string }[] = [
  { key: 'calls_comprehensive', label: 'Comprehensive calls report', detail: 'Every call made in the selected day/range — tenant, agent, landlord, call date & time, status, money owed/paid and the comment recorded', file: 'Comprehensive-Calls-Report' },
  { key: 'comprehensive', label: 'Comprehensive tenant report', detail: 'Every tenant on this page — full profile, money, agent, landlord, call counts and all comments', file: 'Comprehensive-Tenant-Report' },
  { key: 'call_log', label: 'Full call log (with tenant detail)', detail: 'One row per call, every tenant + call field, comments included', file: 'Full-Call-Log-With-Tenant-Detail' },
  { key: 'all', label: 'All calls', detail: 'Every call logged in the window', file: 'All-Calls' },
  { key: 'pending', label: 'Pending calls', detail: 'Follow-up still expected', file: 'Pending-Calls' },
  { key: 'closed', label: 'Closed calls', detail: 'Matter resolved', file: 'Closed-Calls' },
  { key: 'missed', label: 'Missed calls', detail: 'Tenant not reached', file: 'Missed-Calls' },
  { key: 'staff', label: 'Calls made per staff', detail: 'Volume by staff member', file: 'Calls-Per-Staff' },
  { key: 'comments', label: 'Comments log', detail: 'Only calls carrying a comment', file: 'Call-Comments-Log' },
];

const KIND_META = new Map(KINDS.map(k => [k.key, k]));


const CALL_HEADERS = [
  'Called at', 'Call status', 'Comment', 'Logged by', 'Logged by ID', 'Follow-up due',
  'Tenant', 'Tenant phone', 'National ID', 'Village', 'District', 'City', 'Region',
  'Agent', 'Agent phone', 'Landlord', 'Landlord phone',
  'Rent (UGX)', 'Expected daily (UGX)', 'Total repayable (UGX)', 'Repaid (UGX)', 'Amount owed (UGX)',
  'Expected to date (UGX)', 'Missed days', 'Repayment %', 'Plan start', 'Days on plan',
  'Plan status', 'Rent request ID', 'Tenant ID',
];

const TENANT_HEADERS = [
  'Tenant', 'Tenant phone', 'National ID', 'Village', 'District', 'City', 'Region',
  'Agent', 'Agent phone', 'Landlord', 'Landlord phone',
  'Rent (UGX)', 'Expected daily (UGX)', 'Total repayable (UGX)', 'Repaid (UGX)', 'Amount owed (UGX)',
  'Expected to date (UGX)', 'Missed days', 'Repayment %', 'Plan start', 'Days on plan', 'Plan status',
  'Current call status', 'Total calls', 'Pending', 'Closed', 'Missed',
  'First call (window)', 'Last call', 'Last follow-up due', 'Latest comment',
  'All comments (window)', 'Calls in window', 'Rent request ID', 'Tenant ID',
];

type Preset = 'today' | '7d' | '30d' | 'month' | 'all';
const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
  { key: 'all', label: 'All time' },
];

const statusOf = (r: { status: TenantCallStatus | null; outcome: string }): TenantCallStatus =>
  (r.status || (r.outcome === 'missed' ? 'missed' : 'pending')) as TenantCallStatus;

/**
 * Date-ranged reports and exports for the Calling Hub. Presentation only —
 * reuses the shared calendar/popover date pattern, `downloadCsv` and
 * `downloadXlsx`. The comprehensive reports honour whatever list/search filter
 * is currently applied on the page.
 */
export function TenantCallReportsPanel({
  rows,
  filteredRows,
  filterLabel,
  searchLabel,
}: {
  /** Full tenant population behind the hub. */
  rows: CallingListRow[];
  /** Rows currently matching the page tab + search (defaults to all rows). */
  filteredRows?: CallingListRow[];
  filterLabel?: string;
  searchLabel?: string;
}) {
  const { user } = useAuth();
  const [dayMode, setDayMode] = useState(false);
  const [preset, setPreset] = useState<Preset>('today');
  const [from, setFrom] = useState<Date | undefined>(startOfDay(new Date()));
  const [to, setTo] = useState<Date | undefined>(new Date());
  const [scope, setScope] = useState<'filtered' | 'everyone'>('filtered');
  const [fmt, setFmt] = useState<'csv' | 'xlsx' | 'pdf'>('csv');
  const [busy, setBusy] = useState<ReportKind | null>(null);
  const [actorName, setActorName] = useState('');

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
      if (!cancelled) setActorName(data?.full_name || user.email || 'Tenant Ops user');
    })();
    return () => { cancelled = true; };
  }, [user?.id, user?.email]);


  const applyPreset = (key: Preset) => {
    const now = new Date();
    setPreset(key);
    if (key === 'all') { setFrom(undefined); setTo(undefined); return; }
    setTo(now);
    if (key === 'today') setFrom(now);
    else if (key === '7d') setFrom(subDays(now, 6));
    else if (key === 'month') setFrom(startOfMonth(now));
    else setFrom(subDays(now, 29));
  };

  const fromISO = from ? startOfDay(from).toISOString() : null;
  const toISO = to ? endOfDay(to).toISOString() : null;
  const { data: records, isLoading } = useTenantCallRecords(fromISO, toISO);

  const scoped = scope === 'everyone' ? rows : (filteredRows ?? rows);

  const byTenant = useMemo(() => {
    const m = new Map<string, CallingListRow>();
    rows.forEach(r => m.set(r.tenant_id, r));
    return m;
  }, [rows]);

  /** Staff names for `called_by` so reports read like a person, not a UUID. */
  const staffIds = useMemo(
    () => [...new Set((records || []).map(r => r.called_by).filter(Boolean))],
    [records],
  );
  const { data: staff } = useQuery({
    queryKey: ['tenant-call-staff-names', staffIds.length, staffIds[0] ?? ''],
    queryFn: async () => {
      const map = new Map<string, string>();
      if (!staffIds.length) return map;
      for (let i = 0; i < staffIds.length; i += 300) {
        const { data } = await supabase
          .from('profiles')
          .select('id, full_name, email')
          .in('id', staffIds.slice(i, i + 300));
        (data || []).forEach((p: any) => map.set(p.id, p.full_name || p.email || p.id));
      }
      return map;
    },
    enabled: staffIds.length > 0,
    staleTime: 300000,
  });
  const staffName = (id: string) => staff?.get(id) || id;

  const callsByTenant = useMemo(() => {
    const m = new Map<string, TenantCallRecord[]>();
    (records || []).forEach(r => {
      const list = m.get(r.tenant_id) || [];
      list.push(r);
      m.set(r.tenant_id, list);
    });
    // Newest first already; keep chronological for the comments narrative.
    m.forEach(list => list.sort((a, b) => a.called_at.localeCompare(b.called_at)));
    return m;
  }, [records]);

  const counts = useMemo(() => {
    const c = { all: 0, pending: 0, closed: 0, missed: 0, comments: 0 };
    (records || []).forEach(r => {
      c.all += 1;
      c[statusOf(r)] += 1;
      if (r.comment) c.comments += 1;
    });
    return c;
  }, [records]);

  const windowLabel = `${from ? format(from, 'dd MMM yyyy') : 'start'} — ${to ? format(to, 'dd MMM yyyy') : 'today'}`;
  const stamp = `${from ? format(from, 'yyyyMMdd') : 'start'}-${to ? format(to, 'yyyyMMdd') : 'today'}`;
  /** Human-readable period fragment used in every export filename. */
  const fileStamp = from || to
    ? `${from ? format(from, 'yyyy-MM-dd') : 'start'}_to_${to ? format(to, 'yyyy-MM-dd') : 'today'}`
    : 'all-time';
  const scopeLabel = scope === 'everyone'
    ? `All tenants (${rows.length.toLocaleString('en-US')})`
    : `Current filter — ${filterLabel || 'All tenants'}${searchLabel ? ` · search “${searchLabel}”` : ''} (${(filteredRows ?? rows).length.toLocaleString('en-US')})`;
  /** Clearly labelled file name: brand · hub · report · period. */
  const fileName = (kind: ReportKind) =>
    `Welile_Tenant-Calling-Hub_${KIND_META.get(kind)?.file || kind}_${fileStamp}`;

  const emit = async (
    name: string,
    headers: string[],
    body: (string | number | null | undefined)[][],
    sheet: string,
  ) => {
    if (fmt === 'xlsx') await downloadXlsx(`${name}.xlsx`, headers, body, sheet);
    else downloadCsv(`${name}.csv`, headers, body);
  };

  const tenantFields = (t: CallingListRow | undefined) => [
    t?.tenant_name || '', t?.phone || '', t?.national_id || '',
    t?.village || '', t?.district || '', t?.city || '', t?.region || '',
    t?.agent_name || '', t?.agent_phone || '', t?.landlord_name || '', t?.landlord_phone || '',
    t?.rent_amount ?? '', t?.daily_repayment ?? '', t?.total_repayment ?? '',
    t?.amount_repaid ?? '', t?.outstanding_balance ?? '', t?.expected_repaid ?? '',
    t?.missed_days ?? '', t?.repayment_pct ?? '',
    t?.start_at ? csvTimestamp(t.start_at) : '', t?.days_since_start ?? '', t?.status || '',
  ];

  const ugx = (n: any) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
  const nfmt = (n: any) => Math.round(Number(n) || 0).toLocaleString('en-US');

  /** Daily stacked series (pending/closed/missed) for the PDF chart. */
  const buildSeries = (list: TenantCallRecord[]) => {
    const m = new Map<string, { day: string; pending: number; closed: number; missed: number }>();
    list.forEach(r => {
      const day = format(new Date(r.called_at), 'yyyy-MM-dd');
      const cur = m.get(day) || { day, pending: 0, closed: 0, missed: 0 };
      cur[statusOf(r)] += 1;
      m.set(day, cur);
    });
    return [...m.values()].sort((a, b) => a.day.localeCompare(b.day));
  };

  const buildShare = (list: TenantCallRecord[]) => {
    const c = { pending: 0, closed: 0, missed: 0 };
    list.forEach(r => { c[statusOf(r)] += 1; });
    return [
      { label: 'Closed', n: c.closed, color: [16, 145, 105] as [number, number, number] },
      { label: 'Pending', n: c.pending, color: [217, 150, 20] as [number, number, number] },
      { label: 'Missed', n: c.missed, color: [200, 45, 55] as [number, number, number] },
    ];
  };

  /** Top districts table — same shape for both call-level and tenant-level PDFs. */
  const districtTable = (tenants: CallingListRow[]): CallingPdfTable => {
    const m = new Map<string, { n: number; owed: number; missed: number }>();
    tenants.forEach(t => {
      const key = t.district || 'Unmapped';
      const cur = m.get(key) || { n: 0, owed: 0, missed: 0 };
      cur.n += 1;
      cur.owed += Number(t.outstanding_balance) || 0;
      cur.missed += Number(t.missed_days) || 0;
      m.set(key, cur);
    });
    return {
      title: 'TENANTS BY DISTRICT',
      head: ['District', 'Tenants', 'Outstanding', 'Avg missed days'],
      widths: [40, 16, 24, 20],
      aligns: ['left', 'right', 'right', 'right'],
      body: [...m.entries()]
        .sort((a, b) => b[1].n - a[1].n)
        .slice(0, 25)
        .map(([d, v]) => [d, nfmt(v.n), ugx(v.owed), (v.missed / Math.max(1, v.n)).toFixed(1)]),
    };
  };

  const staffTable = (list: TenantCallRecord[]): CallingPdfTable => {
    const agg = new Map<string, { total: number; pending: number; closed: number; missed: number; comments: number; last: string }>();
    list.forEach(r => {
      const key = r.called_by || 'unknown';
      const cur = agg.get(key) || { total: 0, pending: 0, closed: 0, missed: 0, comments: 0, last: '' };
      cur.total += 1;
      cur[statusOf(r)] += 1;
      if (r.comment) cur.comments += 1;
      if (!cur.last || r.called_at > cur.last) cur.last = r.called_at;
      agg.set(key, cur);
    });
    return {
      title: 'CALLS MADE PER STAFF MEMBER',
      head: ['Staff', 'Calls', 'Pending', 'Closed', 'Missed', 'With comment', 'Last call'],
      widths: [40, 14, 14, 14, 14, 18, 26],
      aligns: ['left', 'right', 'right', 'right', 'right', 'right', 'left'],
      body: [...agg.entries()]
        .sort((a, b) => b[1].total - a[1].total)
        .map(([id, v]) => [
          staffName(id), nfmt(v.total), nfmt(v.pending), nfmt(v.closed), nfmt(v.missed), nfmt(v.comments),
          v.last ? format(new Date(v.last), 'dd MMM yyyy HH:mm') : '—',
        ]),
    };
  };

  const run = async (kind: ReportKind) => {
    setBusy(kind);
    try {
      const meta = KIND_META.get(kind);
      const all = records || [];
      const inScope = new Set(scoped.map(r => r.tenant_id));
      const scopedCalls = scope === 'everyone' ? all : all.filter(r => inScope.has(r.tenant_id));

      if (kind === 'comprehensive') {
        if (!scoped.length) { toast.error('No tenants match the current filters'); return; }
        const body = scoped.map(t => {
          const calls = callsByTenant.get(t.tenant_id) || [];
          const comments = calls
            .filter(c => c.comment)
            .map(c => `[${format(new Date(c.called_at), 'dd MMM yyyy HH:mm')} · ${TENANT_CALL_STATUS_LABEL[statusOf(c)]} · ${staffName(c.called_by)}] ${c.comment}`)
            .join(' | ');
          const last = t.call;
          return [
            ...tenantFields(t),
            last?.last_status ? TENANT_CALL_STATUS_LABEL[last.last_status] : (last ? 'Pending' : 'Never called'),
            last?.call_count ?? 0,
            last?.pending_count ?? 0,
            last?.closed_count ?? 0,
            last?.missed_count ?? 0,
            calls.length ? csvTimestamp(calls[0].called_at) : '',
            csvTimestamp(last?.last_call_at),
            csvTimestamp(last?.last_follow_up_at),
            last?.latest_comment || '',
            comments,
            calls.length,
            t.rent_request_id,
            t.tenant_id,
          ];
        });

        if (fmt === 'pdf') {
          const called = scoped.filter(t => (t.call?.call_count ?? 0) > 0).length;
          const owed = scoped.reduce((a, t) => a + (Number(t.outstanding_balance) || 0), 0);
          const repaid = scoped.reduce((a, t) => a + (Number(t.amount_repaid) || 0), 0);
          const pendingTenants = scoped.filter(t => t.call?.last_status === 'pending').length;
          const blob = generateTenantCallingHubPdf({
            reportTitle: meta?.label || 'Comprehensive tenant report',
            subtitle: `${nfmt(scoped.length)} tenant(s) · ${nfmt(scopedCalls.length)} call(s) in window`,
            periodLabel: windowLabel,
            scopeLabel,
            filterLabel: filterLabel || undefined,
            actor: actorName || 'Tenant Ops user',
            kpis: [
              { label: 'Tenants in report', value: nfmt(scoped.length) },
              { label: 'Tenants ever called', value: nfmt(called), hint: `${((called / Math.max(1, scoped.length)) * 100).toFixed(1)}% call coverage` },
              { label: 'Never called', value: nfmt(scoped.length - called) },
              { label: 'Pending follow-up', value: nfmt(pendingTenants) },
              { label: 'Calls in window', value: nfmt(scopedCalls.length) },
              { label: 'Calls with a comment', value: nfmt(scopedCalls.filter(c => c.comment).length) },
              { label: 'Total repaid', value: ugx(repaid) },
              { label: 'Total outstanding', value: ugx(owed) },
            ],
            series: buildSeries(scopedCalls),
            statusShare: buildShare(scopedCalls),
            tables: [
              {
                title: `TENANT CALLING DETAIL (${nfmt(scoped.length)})`,
                head: ['Tenant', 'Phone', 'District', 'Agent', 'Landlord', 'Daily', 'Repaid', 'Outstanding', 'Missed d', 'Repaid %', 'Calls', 'Call status', 'Last call'],
                widths: [30, 20, 18, 24, 24, 18, 20, 22, 12, 13, 10, 16, 20],
                aligns: ['left', 'left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'left', 'left'],
                body: scoped.map(t => [
                  t.tenant_name || '—', t.phone || '—', t.district || '—', t.agent_name || '—', t.landlord_name || '—',
                  ugx(t.daily_repayment), ugx(t.amount_repaid), ugx(t.outstanding_balance),
                  nfmt(t.missed_days), `${(Number(t.repayment_pct) || 0).toFixed(0)}%`,
                  nfmt(t.call?.call_count ?? 0),
                  t.call?.last_status ? TENANT_CALL_STATUS_LABEL[t.call.last_status] : (t.call ? 'Pending' : 'Never called'),
                  t.call?.last_call_at ? format(new Date(t.call.last_call_at), 'dd MMM yy HH:mm') : '—',
                ]),
              },
              districtTable(scoped),
              staffTable(scopedCalls),
            ],
            comments: scopedCalls
              .filter(c => c.comment)
              .slice(-300)
              .map(c => ({
                when: format(new Date(c.called_at), 'dd MMM yyyy HH:mm'),
                who: staffName(c.called_by),
                status: TENANT_CALL_STATUS_LABEL[statusOf(c)],
                tenant: byTenant.get(c.tenant_id)?.tenant_name || c.tenant_id,
                comment: c.comment || '',
              })),
          });
          downloadPdfBlob(blob, `${fileName(kind)}.pdf`);
          toast.success(`PDF ready — ${nfmt(scoped.length)} tenants`);
          return;
        }

        await emit(fileName(kind), TENANT_HEADERS, body, 'Tenants');
        toast.success(`Exported ${body.length.toLocaleString('en-US')} tenants`);
        return;
      }

      if (!all.length) { toast.error('No calls recorded in this date range'); return; }

      if (kind === 'staff') {
        const agg = new Map<string, { total: number; pending: number; closed: number; missed: number; comments: number; last: string }>();
        all.forEach(r => {
          const key = r.called_by || 'unknown';
          const cur = agg.get(key) || { total: 0, pending: 0, closed: 0, missed: 0, comments: 0, last: '' };
          cur.total += 1;
          cur[statusOf(r)] += 1;
          if (r.comment) cur.comments += 1;
          if (!cur.last || r.called_at > cur.last) cur.last = r.called_at;
          agg.set(key, cur);
        });

        if (fmt === 'pdf') {
          const blob = generateTenantCallingHubPdf({
            reportTitle: meta?.label || 'Calls made per staff',
            subtitle: `${nfmt(agg.size)} staff member(s) · ${nfmt(all.length)} call(s)`,
            periodLabel: windowLabel,
            scopeLabel: `All calls logged in window (${nfmt(all.length)})`,
            actor: actorName || 'Tenant Ops user',
            kpis: [
              { label: 'Calls logged', value: nfmt(all.length) },
              { label: 'Staff calling', value: nfmt(agg.size) },
              { label: 'Avg calls per staff', value: (all.length / Math.max(1, agg.size)).toFixed(1) },
              { label: 'Calls with a comment', value: nfmt(all.filter(c => c.comment).length) },
              { label: 'Pending', value: nfmt(counts.pending) },
              { label: 'Closed', value: nfmt(counts.closed) },
              { label: 'Missed', value: nfmt(counts.missed) },
              { label: 'Tenants touched', value: nfmt(new Set(all.map(r => r.tenant_id)).size) },
            ],
            series: buildSeries(all),
            statusShare: buildShare(all),
            tables: [staffTable(all)],
          });
          downloadPdfBlob(blob, `${fileName(kind)}.pdf`);
          toast.success(`PDF ready — ${nfmt(agg.size)} staff`);
          return;
        }

        await emit(
          fileName(kind),
          ['Staff', 'Staff user ID', 'Calls made', 'Pending', 'Closed', 'Missed', 'With comment', 'Last call', 'Window'],
          [...agg.entries()].map(([id, v]) => [staffName(id), id, v.total, v.pending, v.closed, v.missed, v.comments, csvTimestamp(v.last), windowLabel]),
          'Staff',
        );
        toast.success(`Exported ${agg.size} staff rows`);
        return;
      }

      const filtered = all.filter(r => {
        if (scope === 'filtered' && !inScope.has(r.tenant_id)) return false;
        if (kind === 'all' || kind === 'call_log' || kind === 'calls_comprehensive') return true;
        if (kind === 'comments') return !!r.comment;
        return statusOf(r) === kind;
      });
      if (!filtered.length) { toast.error('Nothing to export for that selection'); return; }

      if (fmt === 'pdf') {
        const tenantsTouched = [...new Set(filtered.map(r => r.tenant_id))]
          .map(id => byTenant.get(id))
          .filter(Boolean) as CallingListRow[];
        const blob = generateTenantCallingHubPdf({
          reportTitle: meta?.label || 'Call log',
          subtitle: `${nfmt(filtered.length)} call record(s) · ${nfmt(tenantsTouched.length)} tenant(s)`,
          periodLabel: windowLabel,
          scopeLabel,
          filterLabel: filterLabel || undefined,
          actor: actorName || 'Tenant Ops user',
          kpis: [
            { label: 'Calls in this report', value: nfmt(filtered.length) },
            { label: 'Tenants touched', value: nfmt(tenantsTouched.length) },
            { label: 'Pending', value: nfmt(filtered.filter(r => statusOf(r) === 'pending').length) },
            { label: 'Closed', value: nfmt(filtered.filter(r => statusOf(r) === 'closed').length) },
            { label: 'Missed', value: nfmt(filtered.filter(r => statusOf(r) === 'missed').length) },
            { label: 'With a comment', value: nfmt(filtered.filter(r => r.comment).length) },
            { label: 'Follow-ups scheduled', value: nfmt(filtered.filter(r => r.follow_up_at).length) },
            { label: 'Outstanding on these tenants', value: ugx(tenantsTouched.reduce((a, t) => a + (Number(t.outstanding_balance) || 0), 0)) },
          ],
          series: buildSeries(filtered),
          statusShare: buildShare(filtered),
          tables: [
            {
              title: `CALL LOG (${nfmt(filtered.length)})`,
              head: ['Called at', 'Status', 'Tenant', 'Phone', 'District', 'Agent', 'Landlord', 'Logged by', 'Follow-up', 'Daily', 'Repaid', 'Owed', 'Missed d', 'Comment'],
              widths: [22, 12, 26, 19, 15, 21, 21, 21, 16, 16, 19, 19, 11, 44],
              aligns: ['left', 'left', 'left', 'left', 'left', 'left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'left'],
              body: filtered.map(r => {
                const t = byTenant.get(r.tenant_id);
                return [
                  format(new Date(r.called_at), 'dd MMM yy HH:mm'),
                  TENANT_CALL_STATUS_LABEL[statusOf(r)],
                  t?.tenant_name || r.tenant_id,
                  t?.phone || '—',
                  t?.district || '—',
                  t?.agent_name || '—',
                  t?.landlord_name || '—',
                  staffName(r.called_by),
                  r.follow_up_at ? format(new Date(r.follow_up_at), 'dd MMM yy') : '—',
                  ugx(t?.daily_repayment),
                  ugx(t?.amount_repaid),
                  ugx(t?.outstanding_balance),
                  nfmt(t?.missed_days),
                  r.comment || '—',
                ];
              }),
            },
            districtTable(tenantsTouched),
            staffTable(filtered),
          ],
          comments: filtered
            .filter(c => c.comment)
            .slice(-300)
            .map(c => ({
              when: format(new Date(c.called_at), 'dd MMM yyyy HH:mm'),
              who: staffName(c.called_by),
              status: TENANT_CALL_STATUS_LABEL[statusOf(c)],
              tenant: byTenant.get(c.tenant_id)?.tenant_name || c.tenant_id,
              comment: c.comment || '',
            })),
        });
        downloadPdfBlob(blob, `${fileName(kind)}.pdf`);
        toast.success(`PDF ready — ${nfmt(filtered.length)} call records`);
        return;
      }

      await emit(
        fileName(kind),
        CALL_HEADERS,
        filtered.map(r => {
          const t = byTenant.get(r.tenant_id);
          return [
            csvTimestamp(r.called_at),
            TENANT_CALL_STATUS_LABEL[statusOf(r)],
            r.comment || '',
            staffName(r.called_by),
            r.called_by,
            csvTimestamp(r.follow_up_at),
            ...tenantFields(t),
            r.rent_request_id || '',
            r.tenant_id,
          ];
        }),
        'Calls',
      );
      toast.success(`Exported ${filtered.length.toLocaleString('en-US')} call records`);
    } catch (e: any) {
      toast.error(e?.message || 'Could not build the report');
    } finally {
      setBusy(null);
    }
  };


  const datePicker = (value: Date | undefined, onChange: (d?: Date) => void, placeholder: string) => (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 justify-start text-xs">
          <CalendarIcon className="mr-1.5 h-3 w-3 text-muted-foreground" />
          {value ? format(value, 'dd MMM yyyy') : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar mode="single" selected={value} onSelect={d => { onChange(d); }} initialFocus />
      </PopoverContent>
    </Popover>
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <FileSpreadsheet className="h-4 w-4 text-primary" /> Calling reports &amp; exports
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className={`flex flex-wrap items-center gap-1.5 ${dayMode ? 'hidden' : ''}`}>
          <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Period</span>
          {PRESETS.map(p => (
            <Button
              key={p.key}
              size="sm"
              variant={preset === p.key ? 'default' : 'outline'}
              className="h-7 px-2 text-[11px]"
              onClick={() => { setDayMode(false); applyPreset(p.key); }}
            >
              {p.label}
            </Button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Button size="sm" variant={dayMode ? 'default' : 'outline'} className="h-7 px-2 text-[11px]" onClick={() => { setDayMode(true); const d = to || new Date(); setFrom(d); setTo(d); }}>
              Single day
            </Button>
            <Button size="sm" variant={!dayMode ? 'default' : 'outline'} className="h-7 px-2 text-[11px]" onClick={() => setDayMode(false)}>
              Date range
            </Button>
          </div>
          {dayMode ? (
            datePicker(from, d => { if (!d) return; setFrom(d); setTo(d); }, 'Pick a day')
          ) : (
            <>
              {datePicker(from, d => { setFrom(d); setPreset('30d'); }, 'From')}
              <span className="text-xs text-muted-foreground">to</span>
              {datePicker(to, d => { setTo(d); setPreset('30d'); }, 'To')}
            </>
          )}
          {isLoading ? (
            <Badge variant="secondary" className="text-[10px]">Loading…</Badge>
          ) : (
            <>
              <Badge variant="secondary" className="text-[10px]">{counts.all.toLocaleString('en-US')} calls</Badge>
              <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-600">{counts.pending} pending</Badge>
              <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600">{counts.closed} closed</Badge>
              <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-[10px] text-destructive">{counts.missed} missed</Badge>
              <Badge variant="outline" className="text-[10px]">{counts.comments} with comment</Badge>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 p-2">
          <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Rows</span>
          <Button size="sm" variant={scope === 'filtered' ? 'default' : 'outline'} className="h-7 px-2 text-[11px]" onClick={() => setScope('filtered')}>
            Current filter ({(filteredRows ?? rows).length.toLocaleString('en-US')})
          </Button>
          <Button size="sm" variant={scope === 'everyone' ? 'default' : 'outline'} className="h-7 px-2 text-[11px]" onClick={() => setScope('everyone')}>
            All tenants ({rows.length.toLocaleString('en-US')})
          </Button>
          <span className="ml-auto text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Format</span>
          {(['csv', 'xlsx', 'pdf'] as const).map(f => (
            <Button key={f} size="sm" variant={fmt === f ? 'default' : 'outline'} className="h-7 px-2 text-[11px]" onClick={() => setFmt(f)}>
              {f === 'csv' ? 'CSV' : f === 'xlsx' ? 'Excel' : 'PDF'}
            </Button>
          ))}
        </div>

        {(filterLabel || searchLabel) && (
          <p className="text-[11px] text-muted-foreground break-words">
            Current filter: <span className="font-semibold text-foreground">{filterLabel || 'All tenants'}</span>
            {searchLabel ? <> · search “{searchLabel}”</> : null} · window {windowLabel}
          </p>
        )}

        <p className="text-[10px] text-muted-foreground break-words">
          {fmt === 'pdf'
            ? 'Branded landscape PDF — Welile header, calling KPIs, calls-per-day chart, status mix donut, district & staff tables and the full comment narrative.'
            : 'Every file is named ' }
          {fmt !== 'pdf' && (
            <span className="font-mono text-foreground">Welile_Tenant-Calling-Hub_&lt;Report&gt;_{fileStamp}.{fmt === 'csv' ? 'csv' : 'xlsx'}</span>
          )}
        </p>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {KINDS.map(k => (
            <button
              key={k.key}
              onClick={() => run(k.key)}
              disabled={busy !== null || isLoading}
              className="flex items-center gap-2.5 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40 disabled:opacity-60"
            >
              {busy === k.key ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
              ) : (
                <Download className="h-4 w-4 shrink-0 text-primary" />
              )}
              <span className="min-w-0">
                <span className="block text-xs font-semibold break-words">{k.label}</span>
                <span className="block text-[11px] leading-snug text-muted-foreground break-words">
                  {k.detail} · {fmt === 'csv' ? 'CSV' : fmt === 'xlsx' ? 'Excel' : 'PDF'}
                </span>
                <span className="mt-0.5 block font-mono text-[9.5px] leading-snug text-muted-foreground/80 break-words">
                  {KIND_META.get(k.key)?.file}_{fileStamp}.{fmt === 'xlsx' ? 'xlsx' : fmt}
                </span>
              </span>
            </button>
          ))}
        </div>

      </CardContent>
    </Card>
  );
}
