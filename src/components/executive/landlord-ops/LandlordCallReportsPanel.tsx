import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
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
import { useAuth } from '@/hooks/useAuth';
import {
  generateTenantCallingHubPdf,
  downloadPdfBlob,
  type CallingPdfTable,
} from '@/lib/tenantCallingHubPdf';
import {
  LANDLORD_CALL_STATUS_LABEL,
  useLandlordCallRecords,
  type LandlordCallRecord,
} from '@/hooks/useLandlordCallReports';
import type { LandlordCallingRow } from '@/hooks/useLandlordCallingList';

type ReportKind =
  | 'calls_comprehensive'
  | 'comprehensive' | 'call_log' | 'all' | 'pending' | 'closed' | 'missed' | 'staff' | 'comments';

const KINDS: { key: ReportKind; label: string; detail: string }[] = [
  { key: 'calls_comprehensive', label: 'Comprehensive calls report', detail: 'Every call made in the selected day/range — landlord, agent, call date & time, status, money paid/owed on their plans and the comment recorded' },
  { key: 'comprehensive', label: 'Comprehensive landlord report', detail: 'Every landlord on this page — contact, location, houses, rent plans, payouts, payment details, call counts and all comments' },
  { key: 'call_log', label: 'Full call log (with landlord detail)', detail: 'One row per call, every landlord + call field, comments included' },
  { key: 'all', label: 'All calls', detail: 'Every call logged in the window' },
  { key: 'pending', label: 'Pending calls', detail: 'Follow-up still expected' },
  { key: 'closed', label: 'Closed calls', detail: 'Matter resolved' },
  { key: 'missed', label: 'Missed calls', detail: 'Landlord not reached' },
  { key: 'staff', label: 'Calls made per staff', detail: 'Volume by staff member' },
  { key: 'comments', label: 'Comments log', detail: 'Only calls carrying a comment' },
];

const LANDLORD_FIELD_HEADERS = [
  'Landlord', 'Landlord phone', 'Verified', 'Has smartphone',
  'Village', 'District', 'Region', 'Property address', 'House category',
  'Agent', 'Agent phone', 'Caretaker', 'Caretaker phone',
  'Mobile money name', 'Mobile money number', 'Bank', 'Account number',
  'Houses listed', 'Occupied houses', 'Empty houses', 'Verified houses',
  'Rent on houses (UGX)', 'Declared houses', 'Declared monthly rent (UGX)',
  'Rent plans', 'Funded plans', 'Plan rent value (UGX)', 'Last rent plan',
  'Payouts', 'Total paid (UGX)', 'Last payout', 'Registered on',
];

const CALL_HEADERS = [
  'Called at', 'Call status', 'Comment', 'Logged by', 'Logged by ID', 'Follow-up due',
  ...LANDLORD_FIELD_HEADERS, 'Landlord ID',
];

const LANDLORD_HEADERS = [
  ...LANDLORD_FIELD_HEADERS,
  'Current call status', 'Total calls', 'Pending', 'Closed', 'Missed',
  'First call (window)', 'Last call', 'Last follow-up due', 'Latest comment',
  'All comments (window)', 'Calls in window', 'Landlord ID',
];

type Preset = 'today' | '7d' | '30d' | 'month' | 'all';
const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
  { key: 'all', label: 'All time' },
];

/**
 * Date-ranged reports and exports for the Landlord Calling Hub. Presentation
 * only — reuses the shared calendar/popover date pattern, `downloadCsv` and
 * `downloadXlsx`. The comprehensive reports honour whatever list/search filter
 * is currently applied on the page.
 */
export function LandlordCallReportsPanel({
  rows,
  filteredRows,
  filterLabel,
  searchLabel,
}: {
  rows: LandlordCallingRow[];
  filteredRows?: LandlordCallingRow[];
  filterLabel?: string;
  searchLabel?: string;
}) {
  const { user } = useAuth();
  const [actorName, setActorName] = useState('');
  const [dayMode, setDayMode] = useState(false);
  const [preset, setPreset] = useState<Preset>('today');
  const [from, setFrom] = useState<Date | undefined>(startOfDay(new Date()));
  const [to, setTo] = useState<Date | undefined>(new Date());
  const [scope, setScope] = useState<'filtered' | 'everyone'>('filtered');
  const [fmt, setFmt] = useState<'csv' | 'xlsx' | 'pdf'>('csv');
  const [busy, setBusy] = useState<ReportKind | null>(null);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
      if (!cancelled) setActorName(data?.full_name || user.email || 'Landlord Ops user');
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
  const { data: records, isLoading } = useLandlordCallRecords(fromISO, toISO);

  const scoped = scope === 'everyone' ? rows : (filteredRows ?? rows);

  const byLandlord = useMemo(() => {
    const m = new Map<string, LandlordCallingRow>();
    rows.forEach(r => m.set(r.landlord_id, r));
    return m;
  }, [rows]);

  /** Staff names for `called_by` so reports read like a person, not a UUID. */
  const staffIds = useMemo(
    () => [...new Set((records || []).map(r => r.called_by).filter(Boolean))],
    [records],
  );
  const { data: staff } = useQuery({
    queryKey: ['landlord-call-staff-names', staffIds.length, staffIds[0] ?? ''],
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

  const callsByLandlord = useMemo(() => {
    const m = new Map<string, LandlordCallRecord[]>();
    (records || []).forEach(r => {
      const list = m.get(r.landlord_id) || [];
      list.push(r);
      m.set(r.landlord_id, list);
    });
    m.forEach(list => list.sort((a, b) => a.called_at.localeCompare(b.called_at)));
    return m;
  }, [records]);

  const counts = useMemo(() => {
    const c = { all: 0, pending: 0, closed: 0, missed: 0, comments: 0 };
    (records || []).forEach(r => {
      c.all += 1;
      c[r.status] += 1;
      if (r.comment) c.comments += 1;
    });
    return c;
  }, [records]);

  const windowLabel = `${from ? format(from, 'dd MMM yyyy') : 'start'} — ${to ? format(to, 'dd MMM yyyy') : 'today'}`;
  const stamp = `${from ? format(from, 'yyyyMMdd') : 'start'}-${to ? format(to, 'yyyyMMdd') : 'today'}`;

  const emit = async (
    name: string,
    headers: string[],
    body: (string | number | null | undefined)[][],
    sheet: string,
  ) => {
    if (fmt === 'xlsx') await downloadXlsx(`${name}.xlsx`, headers, body, sheet);
    else downloadCsv(`${name}.csv`, headers, body);
  };

  const landlordFields = (l: LandlordCallingRow | undefined) => [
    l?.landlord_name || '', l?.phone || '', l?.verified ? 'Yes' : 'No',
    l?.has_smartphone === null || l?.has_smartphone === undefined ? '' : (l.has_smartphone ? 'Yes' : 'No'),
    l?.village || '', l?.district || '', l?.region || '', l?.property_address || '', l?.house_category || '',
    l?.agent_name || '', l?.agent_phone || '', l?.caretaker_name || '', l?.caretaker_phone || '',
    l?.mobile_money_name || '', l?.mobile_money_number || '', l?.bank_name || '', l?.account_number || '',
    l?.houses ?? '', l?.occupied_houses ?? '', l?.empty_houses ?? '', l?.verified_houses ?? '',
    l?.houses_monthly_rent ?? '', l?.declared_houses ?? '', l?.declared_monthly_rent ?? '',
    l?.plans ?? '', l?.funded_plans ?? '', l?.plan_rent_total ?? '',
    l?.last_plan_at ? csvTimestamp(l.last_plan_at) : '',
    l?.payout_count ?? '', l?.paid_total ?? '',
    l?.last_paid_at ? csvTimestamp(l.last_paid_at) : '',
    l?.created_at ? csvTimestamp(l.created_at) : '',
  ];

  const ugx = (n: any) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
  const nfmt = (n: any) => Math.round(Number(n) || 0).toLocaleString('en-US');

  const scopeLabel = scope === 'everyone'
    ? `All landlords (${rows.length.toLocaleString('en-US')})`
    : `Current filter — ${filterLabel || 'All landlords'}${searchLabel ? ` · search “${searchLabel}”` : ''} (${(filteredRows ?? rows).length.toLocaleString('en-US')})`;

  /** Daily stacked series (pending/closed/missed) for the PDF chart. */
  const buildSeries = (list: LandlordCallRecord[]) => {
    const m = new Map<string, { day: string; pending: number; closed: number; missed: number }>();
    list.forEach(r => {
      const day = format(new Date(r.called_at), 'yyyy-MM-dd');
      const cur = m.get(day) || { day, pending: 0, closed: 0, missed: 0 };
      cur[r.status] += 1;
      m.set(day, cur);
    });
    return [...m.values()].sort((a, b) => a.day.localeCompare(b.day));
  };

  const buildShare = (list: LandlordCallRecord[]) => {
    const c = { pending: 0, closed: 0, missed: 0 };
    list.forEach(r => { c[r.status] += 1; });
    return [
      { label: 'Closed', n: c.closed, color: [16, 145, 105] as [number, number, number] },
      { label: 'Pending', n: c.pending, color: [217, 150, 20] as [number, number, number] },
      { label: 'Missed', n: c.missed, color: [200, 45, 55] as [number, number, number] },
    ];
  };

  const districtTable = (landlords: LandlordCallingRow[]): CallingPdfTable => {
    const m = new Map<string, { n: number; paid: number; houses: number }>();
    landlords.forEach(l => {
      const key = l.district || 'Unmapped';
      const cur = m.get(key) || { n: 0, paid: 0, houses: 0 };
      cur.n += 1;
      cur.paid += Number(l.paid_total) || 0;
      cur.houses += Number(l.houses) || 0;
      m.set(key, cur);
    });
    return {
      title: 'LANDLORDS BY DISTRICT',
      head: ['District', 'Landlords', 'Houses', 'Total paid'],
      widths: [40, 18, 16, 26],
      aligns: ['left', 'right', 'right', 'right'],
      body: [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 25)
        .map(([d, v]) => [d, nfmt(v.n), nfmt(v.houses), ugx(v.paid)]),
    };
  };

  const staffTable = (list: LandlordCallRecord[]): CallingPdfTable => {
    const agg = new Map<string, { total: number; pending: number; closed: number; missed: number; comments: number; last: string }>();
    list.forEach(r => {
      const key = r.called_by || 'unknown';
      const cur = agg.get(key) || { total: 0, pending: 0, closed: 0, missed: 0, comments: 0, last: '' };
      cur.total += 1;
      cur[r.status] += 1;
      if (r.comment) cur.comments += 1;
      if (!cur.last || r.called_at > cur.last) cur.last = r.called_at;
      agg.set(key, cur);
    });
    return {
      title: 'CALLS MADE PER STAFF MEMBER',
      head: ['Staff', 'Calls', 'Pending', 'Closed', 'Missed', 'With comment', 'Last call'],
      widths: [40, 14, 14, 14, 14, 18, 26],
      aligns: ['left', 'right', 'right', 'right', 'right', 'right', 'left'],
      body: [...agg.entries()].sort((a, b) => b[1].total - a[1].total)
        .map(([id, v]) => [
          staffName(id), nfmt(v.total), nfmt(v.pending), nfmt(v.closed), nfmt(v.missed), nfmt(v.comments),
          v.last ? format(new Date(v.last), 'dd MMM yyyy HH:mm') : '—',
        ]),
    };
  };

  const run = async (kind: ReportKind) => {
    setBusy(kind);
    try {
      if (kind === 'comprehensive') {
        if (!scoped.length) { toast.error('No landlords match the current filters'); return; }
        if (fmt === 'pdf') { toast.error('Pick CSV or Excel for the landlord-level report, or use the Comprehensive calls report for a PDF'); return; }
        const body = scoped.map(l => {
          const calls = callsByLandlord.get(l.landlord_id) || [];
          const comments = calls
            .filter(c => c.comment)
            .map(c => `[${format(new Date(c.called_at), 'dd MMM yyyy HH:mm')} · ${LANDLORD_CALL_STATUS_LABEL[c.status]} · ${staffName(c.called_by)}] ${c.comment}`)
            .join(' | ');
          const last = l.call;
          return [
            ...landlordFields(l),
            last?.last_status ? LANDLORD_CALL_STATUS_LABEL[last.last_status] : (last ? 'Pending' : 'Never called'),
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
            l.landlord_id,
          ];
        });
        await emit(`landlord-calling-comprehensive_${stamp}`, LANDLORD_HEADERS, body, 'Landlords');
        toast.success(`Exported ${body.length.toLocaleString('en-US')} landlords`);
        return;
      }

      const all = records || [];
      if (!all.length) { toast.error('No calls recorded in this date range'); return; }

      if (kind === 'staff' && fmt === 'pdf') {
        const blob = generateTenantCallingHubPdf({
          hubName: 'Landlord Calling Hub',
          sourceNote: 'Welile landlord call reports, house listings & landlord payouts',
          reportTitle: 'Calls made per staff',
          subtitle: `${nfmt(all.length)} call(s)`,
          periodLabel: windowLabel,
          scopeLabel: `All calls logged in window (${nfmt(all.length)})`,
          actor: actorName || 'Landlord Ops user',
          kpis: [
            { label: 'Calls logged', value: nfmt(all.length) },
            { label: 'Pending', value: nfmt(counts.pending) },
            { label: 'Closed', value: nfmt(counts.closed) },
            { label: 'Missed', value: nfmt(counts.missed) },
          ],
          series: buildSeries(all),
          statusShare: buildShare(all),
          tables: [staffTable(all)],
        });
        downloadPdfBlob(blob, `Welile_Landlord-Calling-Hub_calls-per-staff_${stamp}.pdf`);
        toast.success('PDF ready');
        return;
      }

      if (kind === 'staff') {
        const agg = new Map<string, { total: number; pending: number; closed: number; missed: number; comments: number; last: string }>();
        all.forEach(r => {
          const key = r.called_by || 'unknown';
          const cur = agg.get(key) || { total: 0, pending: 0, closed: 0, missed: 0, comments: 0, last: '' };
          cur.total += 1;
          cur[r.status] += 1;
          if (r.comment) cur.comments += 1;
          if (!cur.last || r.called_at > cur.last) cur.last = r.called_at;
          agg.set(key, cur);
        });
        await emit(
          `landlord-calls-per-staff_${stamp}`,
          ['Staff', 'Staff user ID', 'Calls made', 'Pending', 'Closed', 'Missed', 'With comment', 'Last call', 'Window'],
          [...agg.entries()].map(([id, v]) => [staffName(id), id, v.total, v.pending, v.closed, v.missed, v.comments, csvTimestamp(v.last), windowLabel]),
          'Staff',
        );
        toast.success(`Exported ${agg.size} staff rows`);
        return;
      }

      const inScope = new Set(scoped.map(r => r.landlord_id));
      const filtered = all.filter(r => {
        if (scope === 'filtered' && !inScope.has(r.landlord_id)) return false;
        if (kind === 'all' || kind === 'call_log' || kind === 'calls_comprehensive') return true;
        if (kind === 'comments') return !!r.comment;
        return r.status === kind;
      });
      if (!filtered.length) { toast.error('Nothing to export for that selection'); return; }

      if (fmt === 'pdf') {
        const touched = [...new Set(filtered.map(r => r.landlord_id))]
          .map(id => byLandlord.get(id))
          .filter(Boolean) as LandlordCallingRow[];
        const blob = generateTenantCallingHubPdf({
          hubName: 'Landlord Calling Hub',
          sourceNote: 'Welile landlord call reports, house listings & landlord payouts',
          reportTitle: KINDS.find(k => k.key === kind)?.label || 'Call log',
          subtitle: `${nfmt(filtered.length)} call record(s) · ${nfmt(touched.length)} landlord(s)`,
          periodLabel: windowLabel,
          scopeLabel,
          filterLabel: filterLabel || undefined,
          actor: actorName || 'Landlord Ops user',
          kpis: [
            { label: 'Calls in this report', value: nfmt(filtered.length) },
            { label: 'Landlords touched', value: nfmt(touched.length) },
            { label: 'Pending', value: nfmt(filtered.filter(r => r.status === 'pending').length) },
            { label: 'Closed', value: nfmt(filtered.filter(r => r.status === 'closed').length) },
            { label: 'Missed', value: nfmt(filtered.filter(r => r.status === 'missed').length) },
            { label: 'With a comment', value: nfmt(filtered.filter(r => r.comment).length) },
            { label: 'Follow-ups scheduled', value: nfmt(filtered.filter(r => r.follow_up_at).length) },
            { label: 'Paid to these landlords', value: ugx(touched.reduce((a, l) => a + (Number(l.paid_total) || 0), 0)) },
          ],
          series: buildSeries(filtered),
          statusShare: buildShare(filtered),
          tables: [
            {
              title: `CALL LOG (${nfmt(filtered.length)})`,
              head: ['Called at', 'Status', 'Landlord', 'Phone', 'District', 'Agent', 'Logged by', 'Follow-up', 'Houses', 'Plans', 'Plan rent', 'Total paid', 'Comment'],
              widths: [22, 12, 26, 19, 15, 22, 22, 16, 12, 11, 20, 20, 46],
              aligns: ['left', 'left', 'left', 'left', 'left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'left'],
              body: filtered.map(r => {
                const l = byLandlord.get(r.landlord_id);
                return [
                  format(new Date(r.called_at), 'dd MMM yy HH:mm'),
                  LANDLORD_CALL_STATUS_LABEL[r.status],
                  l?.landlord_name || r.landlord_id,
                  l?.phone || '—',
                  l?.district || '—',
                  l?.agent_name || '—',
                  staffName(r.called_by),
                  r.follow_up_at ? format(new Date(r.follow_up_at), 'dd MMM yy') : '—',
                  nfmt(l?.houses),
                  nfmt(l?.plans),
                  ugx(l?.plan_rent_total),
                  ugx(l?.paid_total),
                  r.comment || '—',
                ];
              }),
            },
            districtTable(touched),
            staffTable(filtered),
          ],
          comments: filtered.filter(c => c.comment).slice(-300).map(c => ({
            when: format(new Date(c.called_at), 'dd MMM yyyy HH:mm'),
            who: staffName(c.called_by),
            status: LANDLORD_CALL_STATUS_LABEL[c.status],
            tenant: byLandlord.get(c.landlord_id)?.landlord_name || c.landlord_id,
            comment: c.comment || '',
          })),
        });
        downloadPdfBlob(blob, `Welile_Landlord-Calling-Hub_${kind}_${stamp}.pdf`);
        toast.success(`PDF ready — ${nfmt(filtered.length)} call records`);
        return;
      }

      await emit(
        `landlord-calls-${kind}_${stamp}`,
        CALL_HEADERS,
        filtered.map(r => {
          const l = byLandlord.get(r.landlord_id);
          return [
            csvTimestamp(r.called_at),
            LANDLORD_CALL_STATUS_LABEL[r.status],
            r.comment || '',
            staffName(r.called_by),
            r.called_by,
            csvTimestamp(r.follow_up_at),
            ...landlordFields(l),
            r.landlord_id,
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
            All landlords ({rows.length.toLocaleString('en-US')})
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
            Current filter: <span className="font-semibold text-foreground">{filterLabel || 'All landlords'}</span>
            {searchLabel ? <> · search “{searchLabel}”</> : null} · window {windowLabel}
          </p>
        )}

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
              </span>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
