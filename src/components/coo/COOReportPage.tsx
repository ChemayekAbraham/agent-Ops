import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import {
  Calendar as CalendarIcon, Download, FileSpreadsheet, FileText, RefreshCw, Search,
  AlertTriangle, TrendingUp, Clock, Sparkles, ChevronRight, ChevronLeft, ArrowLeft, Loader2, type LucideIcon
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, Legend, LineChart, Line,
} from 'recharts';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { toast } from 'sonner';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type Severity = 'neutral' | 'success' | 'warning' | 'destructive' | 'info';

export interface ReportKPI {
  label: string;
  value: string | number;
  sub?: string;
  icon?: LucideIcon;
  severity?: Severity;
  /** When true, renders a pulsing dot to flag urgent/pending work. */
  urgent?: boolean;
}

export interface ReportActivity {
  id: string;
  type: string;
  person: string;
  amount?: number | null;       // UGX
  status: string;
  /** Status colour bucket. */
  statusKind?: Severity;
  date: string;                 // ISO
  staff?: string;
  reference?: string;
  /** Free-form fields shown in the drill-down drawer. */
  details?: Record<string, string | number | null | undefined>;
  timeline?: { at: string; label: string; by?: string }[];
  notes?: string;
}

export interface ReportInsight {
  kind: 'trend' | 'bottleneck' | 'pending' | 'priority' | 'action';
  title: string;
  body: string;
}

export interface ReportChartSpec {
  kind: 'bar' | 'line' | 'pie';
  title: string;
  /** Bar/line: array of { label, value } (or { label, a, b }). Pie: { label, value }. */
  data: any[];
  /** Optional second series key for bar/line. */
  seriesKeys?: string[];
  height?: number;
}

export interface COOReportPageProps {
  title: string;
  description: string;
  icon: LucideIcon;
  /** Filter dropdown values; "All" is implicit. */
  statusOptions?: string[];
  activityTypeOptions?: string[];
  departmentOptions?: string[];
  staffOptions?: string[];

  kpis: ReportKPI[];
  charts: ReportChartSpec[];
  activities: ReportActivity[];
  insights: ReportInsight[];

  /**
   * Optional async hook to wire up real data. Returning a promise keeps the
   * "Generate Report" button busy until it resolves.
   */
  onGenerate?: (range: { from?: Date; to?: Date }) => Promise<void> | void;

  /** Show a loading state over the page while parent is fetching. */
  loading?: boolean;

  /**
   * Optional section rendered directly below the KPI grid. Receives the active
   * date range so the section can scope its own live queries to the selection.
   */
  belowKpis?: (range: { from?: Date; to?: Date }) => React.ReactNode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ugx = (n?: number | null) =>
  n == null ? '—' : `UGX ${new Intl.NumberFormat('en-UG').format(Math.round(n))}`;

/** Rows rendered per page in the activity table. */
const PAGE_SIZE = 15;

/** Coerce any incoming amount to a finite number (or null) so totals never NaN. */
const safeAmount = (n?: number | null): number | null => {
  if (n == null) return null;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
};

/** Parse a date defensively — invalid dates must not crash the table. */
const safeDate = (iso?: string): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

const fmtDate = (iso: string, pattern: string) => {
  const d = safeDate(iso);
  return d ? format(d, pattern) : '—';
};

const SEVERITY_BG: Record<Severity, string> = {
  neutral:     'bg-muted/40 border-border',
  success:     'bg-success/8 border-success/30',
  warning:     'bg-warning/8 border-warning/30',
  destructive: 'bg-destructive/8 border-destructive/30',
  info:        'bg-primary/8 border-primary/30',
};

const SEVERITY_TEXT: Record<Severity, string> = {
  neutral: 'text-foreground', success: 'text-success', warning: 'text-warning',
  destructive: 'text-destructive', info: 'text-primary',
};

const STATUS_BADGE: Record<Severity, string> = {
  neutral:     'bg-muted text-muted-foreground border-border',
  success:     'bg-success/10 text-success border-success/20',
  warning:     'bg-warning/10 text-warning border-warning/20',
  destructive: 'bg-destructive/10 text-destructive border-destructive/20',
  info:        'bg-primary/10 text-primary border-primary/20',
};

const CHART_COLORS = [
  'hsl(var(--primary))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
];

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function COOReportPage(props: COOReportPageProps) {
  const {
    title, description, icon: Icon,
    statusOptions = [], activityTypeOptions = [], departmentOptions = [], staffOptions = [],
    kpis, charts, activities, insights, onGenerate, loading = false,
    belowKpis,
  } = props;

  const navigate = useNavigate();
  const isMobile = useIsMobile();

  // ── Filters ───────────────────────────────────────────────────────────────
  const [from, setFrom] = useState<Date | undefined>(() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return d;
  });
  const [to, setTo] = useState<Date | undefined>(new Date());
  const [status, setStatus] = useState<string>('all');
  const [type, setType] = useState<string>('all');
  const [dept, setDept] = useState<string>('all');
  const [staff, setStaff] = useState<string>('all');
  const [q, setQ] = useState('');

  const [generating, setGenerating] = useState(false);
  const [drawer, setDrawer] = useState<ReportActivity | null>(null);
  const [page, setPage] = useState(0);

  // ── Derived rows ──────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const fromTs = from ? from.getTime() : -Infinity;
    const toTs = to ? to.getTime() + 24 * 3600 * 1000 - 1 : Infinity;
    const seen = new Set<string>();
    return activities
      .filter((a) => {
        // Data integrity: drop duplicate ids so a row is never counted twice.
        if (seen.has(a.id)) return false;
        seen.add(a.id);
        const d = safeDate(a.date);
        if (!d) return false;
        const ts = d.getTime();
        if (ts < fromTs || ts > toTs) return false;
      if (status !== 'all' && a.status !== status) return false;
      if (type   !== 'all' && a.type   !== type)   return false;
      if (dept   !== 'all' && (a.details?.department ?? '') !== dept) return false;
      if (staff  !== 'all' && (a.staff ?? '') !== staff) return false;
      if (qq) {
        const hay = [a.person, a.reference, a.staff, a.type, a.id].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(qq)) return false;
      }
      return true;
      })
      .sort((a, b) => {
        const diff = (safeDate(b.date)?.getTime() ?? 0) - (safeDate(a.date)?.getTime() ?? 0);
        return diff !== 0 ? diff : a.id.localeCompare(b.id);
      });
  }, [activities, q, status, type, dept, staff, from, to]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = useMemo(
    () => filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [filtered, safePage],
  );
  // Keep the page index valid whenever the filtered set shrinks.
  useEffect(() => { setPage(0); }, [q, status, type, dept, staff, from, to, activities]);

  const filteredTotal = useMemo(
    () => filtered.reduce((s, a) => s + (safeAmount(a.amount) ?? 0), 0),
    [filtered],
  );

  // ── Actions ───────────────────────────────────────────────────────────────
  async function handleGenerate() {
    setGenerating(true);
    try {
      await onGenerate?.({ from, to });
      setPage(0);
      toast.success('Report regenerated from live data', {
        description: `Range ${from ? format(from, 'PP') : '—'} → ${to ? format(to, 'PP') : '—'}. Figures re-fetched from the server.`,
      });
    } catch (e: any) {
      toast.error('Could not generate report', { description: e?.message ?? 'Unknown error' });
    } finally {
      setGenerating(false);
    }
  }

  function exportCsv() {
    if (filtered.length === 0) {
      toast.error('Nothing to export', { description: 'No activities match the current filters.' });
      return;
    }
    const head = ['ID', 'Type', 'Person', 'Amount UGX', 'Status', 'Date', 'Staff', 'Reference'];
    const lines = [head.join(',')].concat(
      filtered.map((a) =>
        [a.id, a.type, a.person, safeAmount(a.amount) ?? '', a.status, a.date, a.staff ?? '', a.reference ?? '']
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(','),
      ),
    ).concat([`"TOTAL","","","${Math.round(filteredTotal)}","","","",""`]);
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/\s+/g, '_').toLowerCase()}_${format(new Date(), 'yyyyMMdd_HHmm')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('CSV exported');
  }

  function exportPdf() {
    try {
      if (filtered.length === 0) {
        toast.error('Nothing to export', { description: 'No activities match the current filters.' });
        return;
      }
      const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
      const pageWidth = doc.internal.pageSize.getWidth();
      const generatedAt = format(new Date(), 'PPpp');
      const range = `${from ? format(from, 'PP') : '—'}  →  ${to ? format(to, 'PP') : '—'}`;

      // Header
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.text(title, 40, 40);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(110);
      doc.text(description, 40, 58, { maxWidth: pageWidth - 80 });
      doc.text(`Generated: ${generatedAt}    |    Range: ${range}    |    Rows: ${filtered.length} of ${activities.length}`, 40, 78);
      doc.setTextColor(0);

      // KPI summary table
      autoTable(doc, {
        startY: 96,
        head: [['KPI', 'Value', 'Detail']],
        body: kpis.map((k) => [k.label, String(k.value), k.sub ?? '']),
        theme: 'grid',
        headStyles: { fillColor: [139, 61, 217], textColor: 255, fontStyle: 'bold', fontSize: 9 },
        styles: { fontSize: 8.5, cellPadding: 4 },
        columnStyles: { 0: { cellWidth: 180, fontStyle: 'bold' }, 1: { cellWidth: 140 } },
        margin: { left: 40, right: 40 },
      });

      // Activity table
      const afterKpi = (doc as any).lastAutoTable?.finalY ?? 200;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text('Activities', 40, afterKpi + 22);

      autoTable(doc, {
        startY: afterKpi + 30,
        head: [['Date', 'Type', 'Person', 'Amount (UGX)', 'Status', 'Staff', 'Reference']],
        body: filtered.map((a) => [
          fmtDate(a.date, 'dd MMM yy HH:mm'),
          a.type,
          a.person,
          safeAmount(a.amount) == null ? '—' : new Intl.NumberFormat('en-UG').format(Math.round(safeAmount(a.amount)!)),
          a.status,
          a.staff ?? '—',
          a.reference ?? '—',
        ]),
        foot: [['TOTAL', '', '', new Intl.NumberFormat('en-UG').format(Math.round(filteredTotal)), '', '', '']],
        footStyles: { fillColor: [240, 240, 245], textColor: 20, fontStyle: 'bold', fontSize: 8.5 },
        theme: 'striped',
        headStyles: { fillColor: [30, 30, 35], textColor: 255, fontStyle: 'bold', fontSize: 9 },
        styles: { fontSize: 8, cellPadding: 3.5 },
        columnStyles: { 3: { halign: 'right' } },
        margin: { left: 40, right: 40 },
        didDrawPage: (data) => {
          const str = `Page ${doc.getNumberOfPages()}`;
          doc.setFontSize(8);
          doc.setTextColor(140);
          doc.text(str, pageWidth - 60, doc.internal.pageSize.getHeight() - 18);
          doc.setTextColor(0);
        },
      });

      // Insights
      if (insights.length > 0) {
        const afterAct = (doc as any).lastAutoTable?.finalY ?? 400;
        const remaining = doc.internal.pageSize.getHeight() - afterAct;
        if (remaining < 120) doc.addPage();
        const startY = remaining < 120 ? 40 : afterAct + 22;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.text('Insights & recommended actions', 40, startY);
        autoTable(doc, {
          startY: startY + 8,
          head: [['Kind', 'Title', 'Detail']],
          body: insights.map((i) => [i.kind, i.title, i.body]),
          theme: 'grid',
          headStyles: { fillColor: [139, 61, 217], textColor: 255, fontStyle: 'bold', fontSize: 9 },
          styles: { fontSize: 8.5, cellPadding: 4 },
          columnStyles: { 0: { cellWidth: 90, fontStyle: 'bold' }, 1: { cellWidth: 200, fontStyle: 'bold' } },
          margin: { left: 40, right: 40 },
        });
      }

      const filename = `${title.replace(/\s+/g, '_').toLowerCase()}_${format(new Date(), 'yyyyMMdd_HHmm')}.pdf`;
      doc.save(filename);
      toast.success('PDF exported');
    } catch (e: any) {
      toast.error('Could not export PDF', { description: e?.message ?? 'Unknown error' });
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          {isMobile && (
            <button
              onClick={() => navigate('/coo/dashboard')}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Dashboard
            </button>
          )}
        </div>

        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="h-11 w-11 rounded-2xl bg-primary/10 flex items-center justify-center shrink-0">
              <Icon className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-black tracking-tight leading-tight">{title}</h1>
              <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2">
            <DateRangeButton label="From" value={from} onChange={setFrom} />
            <DateRangeButton label="To"   value={to}   onChange={setTo}   />
            <Button size="sm" variant="outline" onClick={exportCsv} className="gap-1.5">
              <FileSpreadsheet className="h-4 w-4" /> CSV
            </Button>
            <Button size="sm" variant="outline" onClick={exportPdf} className="gap-1.5">
              <FileText className="h-4 w-4" /> PDF
            </Button>
            <Button size="sm" onClick={handleGenerate} disabled={generating} className="gap-1.5">
              <RefreshCw className={cn('h-4 w-4', generating && 'animate-spin')} />
              Generate Report
            </Button>
          </div>
        </div>
      </div>

      {loading && (
        <div className="rounded-2xl border border-border bg-card p-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          Loading live data…
        </div>
      )}

      {/* KPI Summary */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5">
        {kpis.map((k) => {
          const sev = k.severity ?? 'neutral';
          const KpiIcon = k.icon;
          return (
            <div
              key={k.label}
              className={cn('rounded-2xl border p-3.5 transition-colors', SEVERITY_BG[sev])}
            >
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{k.label}</p>
                {k.urgent && <span className="h-2 w-2 rounded-full bg-destructive animate-pulse" />}
                {!k.urgent && KpiIcon && <KpiIcon className={cn('h-3.5 w-3.5', SEVERITY_TEXT[sev])} />}
              </div>
              <p className={cn('text-xl sm:text-2xl font-black tracking-tight tabular-nums', SEVERITY_TEXT[sev])}>
                {k.value}
              </p>
              {k.sub && <p className="text-[11px] text-muted-foreground mt-1">{k.sub}</p>}
            </div>
          );
        })}
      </div>

      {/* Breakdown section (below KPIs) */}
      {belowKpis && belowKpis({ from, to })}

      {/* Charts */}
      {charts.length > 0 && (
        <div className={cn('grid gap-3', charts.length === 1 ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-2')}>
          {charts.map((c, i) => (
            <div key={i} className="rounded-2xl border border-border bg-card p-4">
              <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">{c.title}</p>
              <div style={{ width: '100%', height: c.height ?? 220 }}>
                <ResponsiveContainer>
                  {c.kind === 'pie' ? (
                    <PieChart>
                      <Pie data={c.data} dataKey="value" nameKey="label" innerRadius={50} outerRadius={80} paddingAngle={2}>
                        {c.data.map((_, idx) => <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />)}
                      </Pie>
                      <Tooltip />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                    </PieChart>
                  ) : c.kind === 'line' ? (
                    <LineChart data={c.data} margin={{ left: -10, right: 8, top: 6, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="label" fontSize={11} stroke="hsl(var(--muted-foreground))" />
                      <YAxis fontSize={11} stroke="hsl(var(--muted-foreground))" />
                      <Tooltip />
                      {(c.seriesKeys ?? ['value']).map((k, idx) => (
                        <Line key={k} type="monotone" dataKey={k} stroke={CHART_COLORS[idx % CHART_COLORS.length]} strokeWidth={2} dot={false} />
                      ))}
                    </LineChart>
                  ) : (
                    <BarChart data={c.data} margin={{ left: -10, right: 8, top: 6, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="label" fontSize={11} stroke="hsl(var(--muted-foreground))" />
                      <YAxis fontSize={11} stroke="hsl(var(--muted-foreground))" />
                      <Tooltip />
                      {(c.seriesKeys ?? ['value']).map((k, idx) => (
                        <Bar key={k} dataKey={k} fill={CHART_COLORS[idx % CHART_COLORS.length]} radius={[6, 6, 0, 0]} />
                      ))}
                    </BarChart>
                  )}
                </ResponsiveContainer>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
          <div className="lg:col-span-2 relative">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search name, email, ID, or reference"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          {statusOptions.length > 0 && (
            <FilterSelect label="Status" value={status} onChange={setStatus} options={statusOptions} />
          )}
          {activityTypeOptions.length > 0 && (
            <FilterSelect label="Activity" value={type} onChange={setType} options={activityTypeOptions} />
          )}
          {departmentOptions.length > 0 && (
            <FilterSelect label="Department" value={dept} onChange={setDept} options={departmentOptions} />
          )}
          {staffOptions.length > 0 && (
            <FilterSelect label="Staff" value={staff} onChange={setStaff} options={staffOptions} />
          )}
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">
          Showing <span className="font-bold tabular-nums">{filtered.length}</span> of {activities.length} activities
          {(from || to) && <> · {from && format(from, 'PP')} → {to && format(to, 'PP')}</>}
          {' · Total '}<span className="font-bold tabular-nums">{ugx(filteredTotal)}</span>
        </p>
      </div>

      {/* Activity table */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <p className="text-sm font-bold">Recent activity</p>
          <Badge variant="outline" className="text-[10px]">{filtered.length} rows</Badge>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                <th className="px-3 py-2.5">Type</th>
                <th className="px-3 py-2.5">Person</th>
                <th className="px-3 py-2.5 text-right">Amount</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5 hidden md:table-cell">Date</th>
                <th className="px-3 py-2.5 hidden lg:table-cell">Staff</th>
                <th className="px-3 py-2.5 text-right" />
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 && (
                <tr><td colSpan={7} className="text-center py-12 text-sm text-muted-foreground">No activities match the current filters.</td></tr>
              )}
              {pageRows.map((a) => {
                const sev = a.statusKind ?? 'neutral';
                return (
                  <tr
                    key={a.id}
                    onClick={() => setDrawer(a)}
                    className="border-t border-border hover:bg-muted/40 cursor-pointer active:bg-muted transition-colors"
                  >
                    <td className="px-3 py-3 font-medium">{a.type}</td>
                    <td className="px-3 py-3 text-muted-foreground">{a.person}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{ugx(safeAmount(a.amount))}</td>
                    <td className="px-3 py-3">
                      <span className={cn('text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md border', STATUS_BADGE[sev])}>
                        {a.status}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground hidden md:table-cell whitespace-nowrap">
                      {fmtDate(a.date, 'PP p')}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground hidden lg:table-cell">{a.staff ?? '—'}</td>
                    <td className="px-3 py-3 text-right">
                      <ChevronRight className="h-4 w-4 text-muted-foreground inline" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination — 15 rows per page */}
        {filtered.length > 0 && (
          <div className="px-4 py-3 border-t border-border flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              Rows <span className="font-bold tabular-nums">{safePage * PAGE_SIZE + 1}</span>–
              <span className="font-bold tabular-nums">{Math.min((safePage + 1) * PAGE_SIZE, filtered.length)}</span>
              {' of '}<span className="font-bold tabular-nums">{filtered.length}</span>
              {' · Page '}{safePage + 1}/{totalPages}
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="gap-1"
                disabled={safePage === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-4 w-4" /> Prev
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1"
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              >
                Next <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Insights */}
      {insights.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="h-4 w-4 text-primary" />
            <p className="text-sm font-bold">Report insights</p>
            <Badge variant="outline" className="text-[10px] ml-1">COO actions</Badge>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {insights.map((it, i) => <InsightCard key={i} insight={it} />)}
          </div>
        </div>
      )}

      {/* Drill-down drawer */}
      <Sheet open={!!drawer} onOpenChange={(open) => !open && setDrawer(null)}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
          {drawer && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  {drawer.type}
                  <span className={cn('text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md border',
                    STATUS_BADGE[drawer.statusKind ?? 'neutral'])}>
                    {drawer.status}
                  </span>
                </SheetTitle>
                <SheetDescription>
                  {drawer.person} · {format(new Date(drawer.date), 'PPpp')}
                </SheetDescription>
              </SheetHeader>

              <div className="mt-5 space-y-4">
                <div className="rounded-xl bg-muted/40 p-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Amount</p>
                  <p className="text-2xl font-black tabular-nums mt-0.5">{ugx(drawer.amount)}</p>
                </div>

                <div className="space-y-1">
                  <DetailRow label="Reference" value={drawer.reference ?? '—'} mono />
                  <DetailRow label="Assigned staff" value={drawer.staff ?? '—'} />
                  {Object.entries(drawer.details ?? {}).map(([k, v]) => (
                    <DetailRow key={k} label={prettifyKey(k)} value={String(v ?? '—')} />
                  ))}
                </div>

                {drawer.timeline && drawer.timeline.length > 0 && (
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Timeline</p>
                    <ol className="relative border-l border-border pl-4 space-y-3">
                      {drawer.timeline.map((t, i) => (
                        <li key={i} className="relative">
                          <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full bg-primary" />
                          <p className="text-sm font-medium">{t.label}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {format(new Date(t.at), 'PPpp')}{t.by ? ` · ${t.by}` : ''}
                          </p>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {drawer.notes && (
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1">Notes</p>
                    <p className="text-sm bg-muted/40 rounded-xl p-3 leading-relaxed">{drawer.notes}</p>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function DateRangeButton({
  label, value, onChange,
}: { label: string; value?: Date; onChange: (d?: Date) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className={cn('gap-1.5', !value && 'text-muted-foreground')}>
          <CalendarIcon className="h-4 w-4" />
          <span className="hidden sm:inline">{label}:</span>
          {value ? format(value, 'PP') : 'Pick'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end">
        <Calendar
          mode="single"
          selected={value}
          onSelect={onChange}
          initialFocus
          className={cn('p-3 pointer-events-auto')}
        />
      </PopoverContent>
    </Popover>
  );
}

function FilterSelect({
  label, value, onChange, options,
}: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-9">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All {label.toLowerCase()}</SelectItem>
        {options.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function InsightCard({ insight }: { insight: ReportInsight }) {
  const map: Record<ReportInsight['kind'], { icon: LucideIcon; sev: Severity; label: string }> = {
    trend:      { icon: TrendingUp,    sev: 'info',        label: 'Trend' },
    bottleneck: { icon: AlertTriangle, sev: 'warning',     label: 'Bottleneck' },
    pending:    { icon: Clock,         sev: 'warning',     label: 'Pending workload' },
    priority:   { icon: AlertTriangle, sev: 'destructive', label: 'High priority' },
    action:     { icon: Sparkles,      sev: 'info',        label: 'Recommended action' },
  };
  const { icon: I, sev, label } = map[insight.kind];
  return (
    <div className={cn('rounded-xl border p-3', SEVERITY_BG[sev])}>
      <div className="flex items-center gap-2 mb-1">
        <I className={cn('h-4 w-4', SEVERITY_TEXT[sev])} />
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{label}</span>
      </div>
      <p className="text-sm font-bold leading-tight">{insight.title}</p>
      <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed">{insight.body}</p>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-sm font-medium text-right break-all', mono && 'font-mono tabular-nums')}>{value}</span>
    </div>
  );
}

function prettifyKey(k: string) {
  return k.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}