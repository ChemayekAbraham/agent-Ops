/**
 * Per-section exportable reports for TENANT OPS → Classic → Daily Repayments.
 *
 * Each section of the Daily Repayments page mounts one <SectionReportExport />.
 * The control opens its own period picker + section-scoped filters, fetches the
 * real `agent_collections` data for that period through `useDailyRepaymentsRange`
 * (same source table, same derivations as the on-screen view) and exports exactly
 * what the section shows — as CSV or as a branded PDF via the shared
 * `downloadAuditPdf` pattern used across the platform.
 *
 * The on-screen Daily Repayments logic, calculations and data sources are untouched.
 */
import { useMemo, useState } from 'react';
import { format, startOfMonth, subDays } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { FileDown, FileSpreadsheet, Loader2, Download } from 'lucide-react';
import { toast } from 'sonner';
import { downloadAuditPdf, type PdfKpi, type PdfSection } from '@/lib/pdfAuditReport';
import { useDailyRepaymentsRange, type EnrichedRangeRow, type RangeTotals } from '@/hooks/useDailyRepaymentsRange';

const formatUGX = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-UG')}`;

export type DailyRepaymentsSection =
  | 'summary'
  | 'hourly'
  | 'method'
  | 'property'
  | 'transactions'
  | 'agents'
  | 'comprehensive';

type Mode = 'tenant' | 'agent';

interface RangeData {
  rows: EnrichedRangeRow[];
  totals: RangeTotals;
  byHour: { hour: string; amount: number; count: number }[];
  byMethod: { method: string; amount: number; count: number }[];
  byProperty: { property: string; amount: number; count: number; landlord: string }[];
  byDay: { day: string; amount: number; count: number }[];
  agentRanking: {
    agent_id: string; agent_name: string; count: number; total: number;
    commission: number; successful: number; failed: number; pending: number;
  }[];
}

interface BuiltReport {
  headers: string[];
  rows: (string | number)[][];
  kpis: PdfKpi[];
  sections?: PdfSection[];
}

const GREEN: [number, number, number] = [16, 122, 87];
const RED: [number, number, number] = [190, 44, 44];
const PURPLE: [number, number, number] = [88, 28, 135];
const AMBER: [number, number, number] = [202, 138, 4];
const BLUE: [number, number, number] = [30, 64, 175];

function coreKpis(d: RangeData, mode: Mode): PdfKpi[] {
  const t = d.totals;
  return mode === 'tenant'
    ? [
        { label: 'Total Rent Repaid', value: formatUGX(t.sum), hint: `${t.count} repayments`, accent: GREEN },
        { label: 'Total Outstanding', value: formatUGX(t.outstanding), hint: 'still owed by tenants', accent: RED },
        { label: 'Average Payment', value: formatUGX(Math.round(t.avg)), hint: 'per transaction', accent: PURPLE },
        { label: 'Successful', value: String(t.successful), hint: `${t.count ? Math.round((t.successful / t.count) * 100) : 0}% success rate`, accent: GREEN },
        { label: 'Pending', value: String(t.pending), hint: 'awaiting confirmation', accent: AMBER },
        { label: 'Failed', value: String(t.failed), hint: 'requires review', accent: RED },
        { label: 'Unique Tenants', value: String(t.uniqueTenants), hint: 'paid in period', accent: BLUE },
        { label: 'Active Agents', value: String(t.uniqueAgents), hint: 'collected in period', accent: PURPLE },
      ]
    : [
        { label: 'Total Collected', value: formatUGX(t.sum), hint: `${t.count} collections`, accent: GREEN },
        { label: 'Total Commission', value: formatUGX(t.commission), hint: 'earned by agents', accent: PURPLE },
        { label: 'Active Agents', value: String(t.uniqueAgents), hint: `avg ${formatUGX(t.uniqueAgents ? Math.round(t.sum / t.uniqueAgents) : 0)} each`, accent: BLUE },
        { label: 'Top Agent', value: formatUGX(d.agentRanking[0]?.total ?? 0), hint: d.agentRanking[0]?.agent_name ?? '—', accent: GREEN },
        { label: 'Successful', value: String(t.successful), hint: `${t.count ? Math.round((t.successful / t.count) * 100) : 0}% success rate`, accent: GREEN },
        { label: 'Pending / Failed', value: `${t.pending} / ${t.failed}`, hint: 'need attention', accent: AMBER },
      ];
}

const summaryTable = (d: RangeData, mode: Mode) => ({
  headers: ['Metric', 'Value'],
  rows: [
    [mode === 'tenant' ? 'Total Rent Repaid (UGX)' : 'Total Collected (UGX)', d.totals.sum],
    ['Transactions', d.totals.count],
    ['Successful', d.totals.successful],
    ['Pending', d.totals.pending],
    ['Failed', d.totals.failed],
    ['Success Rate (%)', d.totals.count ? Number(((d.totals.successful / d.totals.count) * 100).toFixed(1)) : 0],
    ['Average Payment (UGX)', Math.round(d.totals.avg)],
    ['Total Outstanding (UGX)', d.totals.outstanding],
    ['Agent Commission (UGX)', d.totals.commission],
    ['Unique Tenants', d.totals.uniqueTenants],
    ['Active Agents', d.totals.uniqueAgents],
  ] as (string | number)[][],
});

const dailyTable = (d: RangeData) => ({
  headers: ['Day', 'Transactions', 'Amount (UGX)', 'Average (UGX)'],
  rows: d.byDay.map(r => [r.day, r.count, r.amount, r.count ? Math.round(r.amount / r.count) : 0]) as (string | number)[][],
});

const hourlyTable = (d: RangeData) => ({
  headers: ['Hour', 'Transactions', 'Amount (UGX)', 'Share of Total (%)'],
  rows: d.byHour.map(r => [
    `${r.hour}:00`, r.count, r.amount,
    d.totals.sum ? Number(((r.amount / d.totals.sum) * 100).toFixed(1)) : 0,
  ]) as (string | number)[][],
});

const methodTable = (d: RangeData) => ({
  headers: ['Payment Method', 'Transactions', 'Amount (UGX)', 'Average (UGX)', 'Share of Total (%)'],
  rows: d.byMethod.map(r => [
    r.method, r.count, r.amount,
    r.count ? Math.round(r.amount / r.count) : 0,
    d.totals.sum ? Number(((r.amount / d.totals.sum) * 100).toFixed(1)) : 0,
  ]) as (string | number)[][],
});

const propertyTable = (d: RangeData) => ({
  headers: ['Property', 'Landlord', 'Transactions', 'Amount (UGX)', 'Average (UGX)', 'Share of Total (%)'],
  rows: d.byProperty.map(r => [
    r.property, r.landlord, r.count, r.amount,
    r.count ? Math.round(r.amount / r.count) : 0,
    d.totals.sum ? Number(((r.amount / d.totals.sum) * 100).toFixed(1)) : 0,
  ]) as (string | number)[][],
});

const agentTable = (d: RangeData) => ({
  headers: ['Agent', 'Agent ID', 'Collections', 'Total (UGX)', 'Commission (UGX)', 'Avg Size (UGX)', 'Successful', 'Failed', 'Pending', 'Success Rate (%)'],
  rows: d.agentRanking.map(a => [
    a.agent_name, a.agent_id.slice(0, 8), a.count, a.total, a.commission,
    a.count ? Math.round(a.total / a.count) : 0,
    a.successful, a.failed, a.pending,
    a.count ? Number(((a.successful / a.count) * 100).toFixed(1)) : 0,
  ]) as (string | number)[][],
});

const transactionsTable = (d: RangeData, mode: Mode) => (mode === 'tenant'
  ? {
      headers: ['Tx ID', 'Date', 'Time', 'Tenant', 'Phone', 'Property', 'Landlord', 'Agent', 'Amount (UGX)', 'Outstanding (UGX)', 'Balance Before', 'Balance After', 'Method', 'Status', 'Receipt'],
      rows: d.rows.map(r => [
        r.id.slice(0, 8),
        format(new Date(r.created_at), 'yyyy-MM-dd'),
        format(new Date(r.created_at), 'HH:mm:ss'),
        r.tenant_name, r.tenant_phone, r.property, r.landlord_name, r.agent_name,
        Number(r.amount) || 0, r.outstanding,
        Number(r.float_before) || 0, Number(r.float_after) || 0,
        r.payment_method ?? '—', r.status,
        r.tracking_id ?? r.momo_transaction_id ?? '—',
      ]) as (string | number)[][],
    }
  : {
      headers: ['Date', 'Time', 'Agent', 'Agent ID', 'Tenant', 'Property', 'Landlord', 'Amount (UGX)', 'Commission (UGX)', 'Method', 'Status', 'Receipt'],
      rows: d.rows.map(r => [
        format(new Date(r.created_at), 'yyyy-MM-dd'),
        format(new Date(r.created_at), 'HH:mm:ss'),
        r.agent_name, (r.agent_id ?? '').slice(0, 8), r.tenant_name, r.property, r.landlord_name,
        Number(r.amount) || 0, r.commission,
        r.payment_method ?? '—', r.status,
        r.tracking_id ?? r.momo_transaction_id ?? '—',
      ]) as (string | number)[][],
    });

interface SectionDef {
  label: string;
  subtitle: string;
  slug: string;
  build: (d: RangeData, mode: Mode) => BuiltReport;
}

const SECTIONS: Record<DailyRepaymentsSection, SectionDef> = {
  summary: {
    label: 'Summary Cards',
    subtitle: 'Headline repayment metrics for the selected period',
    slug: 'summary',
    build: (d, mode) => ({
      ...summaryTable(d, mode),
      kpis: coreKpis(d, mode),
      sections: [{ title: 'Day-by-Day Breakdown', headers: dailyTable(d).headers, rows: dailyTable(d).rows }],
    }),
  },
  hourly: {
    label: 'By Hour',
    subtitle: 'Collection volume and value by hour of day',
    slug: 'by-hour',
    build: (d, mode) => ({
      ...hourlyTable(d),
      kpis: coreKpis(d, mode).slice(0, 4),
      sections: [{ title: 'Day-by-Day Totals', headers: dailyTable(d).headers, rows: dailyTable(d).rows }],
    }),
  },
  method: {
    label: 'By Payment Method',
    subtitle: 'Mix of mobile money, cash and in-app wallet payments',
    slug: 'by-method',
    build: (d, mode) => ({ ...methodTable(d), kpis: coreKpis(d, mode).slice(0, 4) }),
  },
  property: {
    label: 'Properties',
    subtitle: 'Repayment value per property and landlord',
    slug: 'by-property',
    build: (d, mode) => ({ ...propertyTable(d), kpis: coreKpis(d, mode).slice(0, 4) }),
  },
  transactions: {
    label: 'Transactions',
    subtitle: 'Ledger-confirmed transaction register',
    slug: 'transactions',
    build: (d, mode) => ({ ...transactionsTable(d, mode), kpis: coreKpis(d, mode) }),
  },
  agents: {
    label: 'Agent Performance',
    subtitle: 'Per-agent collection performance, sorted by amount',
    slug: 'agent-performance',
    build: (d, mode) => ({ ...agentTable(d), kpis: coreKpis(d, mode) }),
  },
  comprehensive: {
    label: 'Comprehensive Report',
    subtitle: 'Every section of the Daily Repayments page in one report',
    slug: 'comprehensive',
    build: (d, mode) => ({
      ...summaryTable(d, mode),
      kpis: coreKpis(d, mode),
      sections: [
        { title: 'Day-by-Day Breakdown', headers: dailyTable(d).headers, rows: dailyTable(d).rows },
        { title: 'By Hour of Day', headers: hourlyTable(d).headers, rows: hourlyTable(d).rows },
        { title: 'By Payment Method', headers: methodTable(d).headers, rows: methodTable(d).rows },
        { title: 'Properties', headers: propertyTable(d).headers, rows: propertyTable(d).rows },
        { title: 'Agent Performance', headers: agentTable(d).headers, rows: agentTable(d).rows },
        {
          title: 'Transaction Register',
          headers: transactionsTable(d, mode).headers,
          rows: transactionsTable(d, mode).rows,
          note: 'Ledger-confirmed rows from agent_collections for the selected period and filters.',
        },
      ],
    }),
  },
};

function csvBlob(headers: string[], rows: (string | number)[][]) {
  const esc = (v: any) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map(r => r.map(esc).join(',')).join('\n');
}

function downloadCsv(filename: string, blocks: { title?: string; headers: string[]; rows: (string | number)[][] }[]) {
  const content = blocks
    .map(b => `${b.title ? `${b.title}\n` : ''}${csvBlob(b.headers, b.rows)}`)
    .join('\n\n');
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface Props {
  section: DailyRepaymentsSection;
  mode: Mode;
  /** The date currently selected on the page — used as the default period. */
  pageDate: string;
  /** Compact trigger for inline placement inside section headers. */
  variant?: 'inline' | 'prominent';
}

export function SectionReportExport({ section, mode, pageDate, variant = 'inline' }: Props) {
  const def = SECTIONS[section];
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(pageDate);
  const [to, setTo] = useState(pageDate);
  const [status, setStatus] = useState('all');
  const [method, setMethod] = useState('all');
  const [agent, setAgent] = useState('all');
  const [busy, setBusy] = useState(false);

  const data = useDailyRepaymentsRange(from, to, open);

  const methodOptions = useMemo(
    () => [...new Set(data.rows.map(r => r.payment_method).filter(Boolean) as string[])],
    [data.rows],
  );
  const agentOptions = useMemo(() => {
    const m = new Map<string, string>();
    data.rows.forEach(r => { if (r.agent_id) m.set(r.agent_id, r.agent_name); });
    return [...m.entries()];
  }, [data.rows]);

  /** Apply section-scoped filters, then recompute the derived views from the filtered rows. */
  const scoped: RangeData = useMemo(() => {
    const rows = data.rows.filter(r => {
      if (status !== 'all' && r.status !== status) return false;
      if (method !== 'all' && r.payment_method !== method) return false;
      if (agent !== 'all' && r.agent_id !== agent) return false;
      return true;
    });
    if (rows.length === data.rows.length) {
      return {
        rows: data.rows, totals: data.totals, byHour: data.byHour, byMethod: data.byMethod,
        byProperty: data.byProperty, byDay: data.byDay, agentRanking: data.agentRanking,
      };
    }
    // Recompute aggregates over the filtered subset so exports always reconcile.
    let sum = 0, commission = 0, successful = 0, pending = 0, failed = 0, outstanding = 0;
    const seen = new Set<string>();
    const hour: Record<string, { amount: number; count: number }> = {};
    for (let h = 0; h < 24; h++) hour[String(h).padStart(2, '0')] = { amount: 0, count: 0 };
    const meth: Record<string, { amount: number; count: number }> = {};
    const prop: Record<string, { amount: number; count: number; landlord: string }> = {};
    const day: Record<string, { amount: number; count: number }> = {};
    const agents = new Map<string, RangeData['agentRanking'][number]>();

    rows.forEach(r => {
      const amt = Number(r.amount) || 0;
      sum += amt; commission += r.commission;
      if (r.status === 'successful') successful += 1;
      else if (r.status === 'pending') pending += 1;
      else failed += 1;
      const key = r.rent_request_id ?? `t:${r.tenant_id}`;
      if (key && !seen.has(key)) { seen.add(key); outstanding += r.outstanding || 0; }

      const h = format(new Date(r.created_at), 'HH');
      hour[h] = { amount: (hour[h]?.amount ?? 0) + amt, count: (hour[h]?.count ?? 0) + 1 };
      const mk = r.payment_method ?? 'unknown';
      meth[mk] = { amount: (meth[mk]?.amount ?? 0) + amt, count: (meth[mk]?.count ?? 0) + 1 };
      prop[r.property] = {
        amount: (prop[r.property]?.amount ?? 0) + amt,
        count: (prop[r.property]?.count ?? 0) + 1,
        landlord: prop[r.property]?.landlord ?? r.landlord_name,
      };
      const dk = format(new Date(r.created_at), 'yyyy-MM-dd');
      day[dk] = { amount: (day[dk]?.amount ?? 0) + amt, count: (day[dk]?.count ?? 0) + 1 };

      const aid = r.agent_id ?? 'unknown';
      const cur = agents.get(aid) ?? { agent_id: aid, agent_name: r.agent_name, count: 0, total: 0, commission: 0, successful: 0, failed: 0, pending: 0 };
      cur.count += 1; cur.total += amt; cur.commission += r.commission;
      if (r.status === 'successful') cur.successful += 1;
      else if (r.status === 'pending') cur.pending += 1;
      else cur.failed += 1;
      agents.set(aid, cur);
    });

    return {
      rows,
      totals: {
        sum, count: rows.length, successful, pending, failed, commission, outstanding,
        avg: rows.length ? sum / rows.length : 0,
        uniqueTenants: new Set(rows.map(r => r.tenant_id).filter(Boolean)).size,
        uniqueAgents: new Set(rows.map(r => r.agent_id).filter(Boolean)).size,
      },
      byHour: Object.entries(hour).map(([k, v]) => ({ hour: k, amount: v.amount, count: v.count })),
      byMethod: Object.entries(meth).map(([k, v]) => ({ method: k, amount: v.amount, count: v.count })).sort((a, b) => b.amount - a.amount),
      byProperty: Object.entries(prop).map(([k, v]) => ({ property: k, amount: v.amount, count: v.count, landlord: v.landlord })).sort((a, b) => b.amount - a.amount),
      byDay: Object.entries(day).map(([k, v]) => ({ day: k, amount: v.amount, count: v.count })).sort((a, b) => a.day.localeCompare(b.day)),
      agentRanking: [...agents.values()].sort((a, b) => b.total - a.total),
    };
  }, [data.rows, data.totals, data.byHour, data.byMethod, data.byProperty, data.byDay, data.agentRanking, status, method, agent]);

  const report = useMemo(() => def.build(scoped, mode), [def, scoped, mode]);

  const filterLines = () => [
    `Period: ${from} → ${to}`,
    ...(status !== 'all' ? [`Status: ${status}`] : []),
    ...(method !== 'all' ? [`Method: ${method}`] : []),
    ...(agent !== 'all' ? [`Agent: ${agentOptions.find(([id]) => id === agent)?.[1] ?? agent}`] : []),
    `Rows: ${scoped.rows.length}`,
  ];

  const baseName = `daily-${mode === 'tenant' ? 'repayments' : 'collections'}-${def.slug}-${from}_${to}`;

  const onCsv = () => {
    if (!scoped.rows.length) { toast.error('No data in the selected period'); return; }
    downloadCsv(`${baseName}.csv`, [
      { title: `${def.label} — ${filterLines().join(' | ')}`, headers: report.headers, rows: report.rows },
      ...(report.sections ?? []).map(s => ({ title: s.title, headers: s.headers, rows: s.rows as (string | number)[][] })),
    ]);
    toast.success(`${def.label} exported to CSV`);
  };

  const onPdf = async () => {
    if (!scoped.rows.length) { toast.error('No data in the selected period'); return; }
    setBusy(true);
    try {
      await downloadAuditPdf(`${baseName}.pdf`, report.headers, report.rows, {
        title: `${mode === 'tenant' ? 'Daily Repayments' : 'Daily Collections'} — ${def.label}`,
        subtitle: def.subtitle,
        filters: filterLines(),
        footerLabel: mode === 'tenant' ? 'Welile · Tenant Ops' : 'Welile · Agent Ops',
        kpis: report.kpis,
        sections: report.sections,
      });
      toast.success(`${def.label} exported to PDF`);
    } catch (e: any) {
      toast.error(e?.message ?? 'PDF export failed');
    } finally {
      setBusy(false);
    }
  };

  const setPreset = (preset: 'today' | '7d' | '30d' | 'month') => {
    const today = new Date();
    if (preset === 'today') { setFrom(format(today, 'yyyy-MM-dd')); setTo(format(today, 'yyyy-MM-dd')); }
    if (preset === '7d') { setFrom(format(subDays(today, 6), 'yyyy-MM-dd')); setTo(format(today, 'yyyy-MM-dd')); }
    if (preset === '30d') { setFrom(format(subDays(today, 29), 'yyyy-MM-dd')); setTo(format(today, 'yyyy-MM-dd')); }
    if (preset === 'month') { setFrom(format(startOfMonth(today), 'yyyy-MM-dd')); setTo(format(today, 'yyyy-MM-dd')); }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {variant === 'prominent' ? (
          <Button size="sm" className="h-9 gap-1.5">
            <Download className="h-3.5 w-3.5" />
            {def.label}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[11px]">
            <Download className="h-3 w-3" />
            Report
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 p-3">
        <div>
          <div className="text-sm font-semibold">{def.label}</div>
          <div className="text-[11px] text-muted-foreground">{def.subtitle}</div>
        </div>
        <Separator />
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">From</label>
            <Input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">To</label>
            <Input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} className="h-8 text-xs" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {([['today', 'Today'], ['7d', 'Last 7d'], ['30d', 'Last 30d'], ['month', 'This month']] as const).map(([k, l]) => (
            <Button key={k} size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => setPreset(k)}>{l}</Button>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-2">
          <div className="space-y-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Status</label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="successful">Successful</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Method</label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All methods</SelectItem>
                {methodOptions.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Agent</label>
            <Select value={agent} onValueChange={setAgent}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                {agentOptions.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Separator />
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-muted-foreground">
            {data.isLoading ? 'Loading period…' : `${scoped.rows.length} rows · ${formatUGX(scoped.totals.sum)}`}
          </span>
          {data.isFetching && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        {!!report.sections?.length && (
          <Badge variant="secondary" className="text-[10px]">
            Includes {report.sections.length} extra table{report.sections.length > 1 ? 's' : ''}
          </Badge>
        )}
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="h-8 flex-1 gap-1.5 text-xs" onClick={onCsv} disabled={data.isLoading || !scoped.rows.length}>
            <FileSpreadsheet className="h-3.5 w-3.5" />CSV
          </Button>
          <Button size="sm" className="h-8 flex-1 gap-1.5 text-xs" onClick={onPdf} disabled={busy || data.isLoading || !scoped.rows.length}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}PDF
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
