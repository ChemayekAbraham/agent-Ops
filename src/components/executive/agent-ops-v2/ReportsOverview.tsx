import { useMemo, useState } from 'react';
import { CalendarRange, Download, Eye, FileBarChart, Info, Loader2, Search, Table as TableIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  useAdvancesReport,
  useAgentReport,
  useProductsReport,
  useRentCollectionsReport,
  useReportAgentSearch,
  useReportTeamSearch,
  useTeamCollectionsReport,
  type ReportRange,
} from '@/hooks/useAgentOpsReports';
import {
  buildAdvancesReportHtml,
  buildAgentReportHtml,
  buildProductsReportHtml,
  buildRentCollectionsReportHtml,
  buildTeamCollectionsReportHtml,
} from '@/lib/agentOpsOverviewReportHtml';
import { downloadReportPdf } from '@/lib/renderReportPdf';
import ReportHtmlPreview from './ReportHtmlPreview';

/**
 * Reports → Overview.
 *
 * Flow: pick a date range → the report-type select unlocks → the matching
 * report renders below from live server-aggregated figures, and can be
 * exported as a PDF using the Welile report template.
 */

type ReportType =
  | 'agent'
  | 'rent-collections'
  | 'products-services'
  | 'advances'
  | 'team-collections';

const REPORT_TYPES: { value: ReportType; label: string; blurb: string }[] = [
  { value: 'agent', label: 'Agent', blurb: 'One agent, full rent repayment history, tenant-by-tenant breakdown.' },
  { value: 'rent-collections', label: 'Rent Collections', blurb: 'Daily active repaying tenants only — expected vs collected per agent.' },
  { value: 'products-services', label: 'Agent Products & Services', blurb: 'Smartphones, motorbikes and merchandise uptake across the window.' },
  { value: 'advances', label: 'Advances', blurb: 'Advance issuance, recovery and exposure for the window.' },
  { value: 'team-collections', label: 'Team Collections', blurb: 'Team leader (parent) and sub-agent collections for the window.' },
];

const DASH = '—';
const ugx = (n: number | null | undefined) =>
  n === null || n === undefined ? DASH : `UGX ${Math.round(Number(n)).toLocaleString('en-UG')}`;
const num = (n: number | null | undefined) =>
  n === null || n === undefined ? DASH : Math.round(Number(n)).toLocaleString('en-UG');
const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? DASH : `${Number(n).toFixed(1)}%`;
const dt = (v: string | null | undefined) => {
  if (!v) return DASH;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-base font-bold" title={value}>{value}</p>
    </div>
  );
}

function StatGrid({ items }: { items: { label: string; value: string }[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
      {items.map((i) => <Stat key={i.label} {...i} />)}
    </div>
  );
}

function TableShell({
  columns,
  children,
  footer,
  note,
  empty,
  loading,
}: {
  columns: string[];
  children: React.ReactNode;
  footer?: React.ReactNode;
  note?: string;
  empty: boolean;
  loading: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[760px] text-xs">
          <thead className="bg-muted/60">
            <tr>
              {columns.map((c) => (
                <th key={c} className="whitespace-nowrap px-3 py-2 text-left font-semibold text-muted-foreground">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={columns.length} className="px-3 py-8 text-center text-muted-foreground">
                <Loader2 className="mx-auto h-4 w-4 animate-spin" />
              </td></tr>
            ) : empty ? (
              <tr><td colSpan={columns.length} className="px-3 py-8 text-center text-muted-foreground">No records in this window.</td></tr>
            ) : children}
          </tbody>
          {!loading && !empty && footer ? <tfoot className="border-t-2 border-border bg-muted/40">{footer}</tfoot> : null}
        </table>
      </div>
      {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}

function statusTone(rate: number | null | undefined) {
  if (rate === null || rate === undefined) return 'outline';
  if (rate >= 75) return 'default';
  return 'secondary';
}

/** Searchable picker used for the agent and team reports. */
function EntityPicker({
  label,
  placeholder,
  query,
  onQuery,
  options,
  loading,
  selectedId,
  onSelect,
}: {
  label: string;
  placeholder: string;
  query: string;
  onQuery: (v: string) => void;
  options: { id: string; name: string; phone: string | null; meta: string }[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs">{label}</Label>
      <div className="relative w-full sm:max-w-md">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => onQuery(e.target.value)} placeholder={placeholder} className="pl-8" />
      </div>
      <ScrollArea className="h-40 rounded-lg border border-border">
        <div className="divide-y divide-border">
          {loading ? (
            <div className="flex items-center justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
          ) : options.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">No matches.</p>
          ) : (
            options.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => onSelect(o.id)}
                className={cn(
                  'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/60',
                  selectedId === o.id && 'bg-primary/10',
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{o.name}</span>
                  <span className="block truncate text-muted-foreground">{o.phone || 'No phone'}</span>
                </span>
                <Badge variant="outline" className="shrink-0 font-normal">{o.meta}</Badge>
              </button>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export function ReportsOverview() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reportType, setReportType] = useState<ReportType | ''>('');
  const [agentSearch, setAgentSearch] = useState('');
  const [agentId, setAgentId] = useState<string | null>(null);
  const [teamSearch, setTeamSearch] = useState('');
  const [teamId, setTeamId] = useState<string | null>(null);
  const [view, setView] = useState<'preview' | 'data'>('preview');
  const [pdfBusy, setPdfBusy] = useState(false);

  const rangeReady = Boolean(from && to && from <= to);
  const range: ReportRange | null = rangeReady ? { from, to } : null;
  const active = REPORT_TYPES.find((r) => r.value === reportType);
  const rangeLabel = useMemo(() => (rangeReady ? `${from} → ${to}` : 'No range selected'), [from, to, rangeReady]);

  const agents = useReportAgentSearch(agentSearch, reportType === 'agent');
  const teams = useReportTeamSearch(teamSearch, reportType === 'team-collections');
  const agentReport = useAgentReport(reportType === 'agent' ? agentId : null, range);
  const rentReport = useRentCollectionsReport(reportType === 'rent-collections' ? range : null);
  const productsReport = useProductsReport(reportType === 'products-services' ? range : null);
  const advancesReport = useAdvancesReport(reportType === 'advances' ? range : null);
  const teamReport = useTeamCollectionsReport(reportType === 'team-collections' ? teamId : null, range);

  /**
   * The document itself — one HTML build per report, used for both the iframe
   * preview and the PDF, so what is previewed is exactly what downloads.
   */
  const doc = useMemo<{ html: string; file: string } | null>(() => {
    if (reportType === 'agent' && agentReport.data) {
      return { html: buildAgentReportHtml(agentReport.data), file: `Welile-Agent-Report-${from}_${to}` };
    }
    if (reportType === 'rent-collections' && rentReport.data) {
      return { html: buildRentCollectionsReportHtml(rentReport.data), file: `Welile-Rent-Collections-${from}_${to}` };
    }
    if (reportType === 'products-services' && productsReport.data) {
      return { html: buildProductsReportHtml(productsReport.data), file: `Welile-Products-Services-${from}_${to}` };
    }
    if (reportType === 'advances' && advancesReport.data) {
      return { html: buildAdvancesReportHtml(advancesReport.data), file: `Welile-Agent-Advances-${from}_${to}` };
    }
    if (reportType === 'team-collections' && teamReport.data) {
      return { html: buildTeamCollectionsReportHtml(teamReport.data), file: `Welile-Team-Collections-${from}_${to}` };
    }
    return null;
  }, [reportType, agentReport.data, rentReport.data, productsReport.data, advancesReport.data, teamReport.data, from, to]);

  const pdfReady = Boolean(doc);

  const downloadPdf = async () => {
    if (!doc || pdfBusy) return;
    setPdfBusy(true);
    try {
      await downloadReportPdf(doc.html, doc.file);
    } finally {
      setPdfBusy(false);
    }
  };

  const errorOf = () => {
    const q =
      reportType === 'agent' ? agentReport
      : reportType === 'rent-collections' ? rentReport
      : reportType === 'products-services' ? productsReport
      : reportType === 'advances' ? advancesReport
      : reportType === 'team-collections' ? teamReport
      : null;
    return q?.error as Error | null | undefined;
  };

  /** The agent / team chooser, also shown above the preview so it stays usable. */
  const picker = () => {
    if (reportType === 'agent') {
      return (
        <EntityPicker
          label="Agent"
          placeholder="Search agent by name or phone…"
          query={agentSearch}
          onQuery={setAgentSearch}
          loading={agents.isLoading}
          options={(agents.data ?? []).map((a) => ({
            id: a.agent_id, name: a.full_name || 'Unnamed agent', phone: a.phone, meta: `${a.tenants} tenants`,
          }))}
          selectedId={agentId}
          onSelect={setAgentId}
        />
      );
    }
    if (reportType === 'team-collections') {
      return (
        <EntityPicker
          label="Team"
          placeholder="Search team leader by name or phone…"
          query={teamSearch}
          onQuery={setTeamSearch}
          loading={teams.isLoading}
          options={(teams.data ?? []).map((t) => ({
            id: t.parent_agent_id, name: t.full_name || 'Unnamed leader', phone: t.phone, meta: `${t.members} members`,
          }))}
          selectedId={teamId}
          onSelect={setTeamId}
        />
      );
    }
    return null;
  };

  const body = () => {
    switch (reportType) {
      case 'agent': {
        const d = agentReport.data;
        const k = d?.kpis;
        const sums = (d?.tenants ?? []).reduce(
          (a, t) => ({
            rent: a.rent + Number(t.rent_amount || 0),
            out: a.out + Number(t.outstanding || 0),
            rep: a.rep + Number(t.repayment || 0),
            col: a.col + Number(t.collected || 0),
          }),
          { rent: 0, out: 0, rep: 0, col: 0 },
        );
        return (
          <div className="space-y-4">
            <EntityPicker
              label="Agent"
              placeholder="Search agent by name or phone…"
              query={agentSearch}
              onQuery={setAgentSearch}
              loading={agents.isLoading}
              options={(agents.data ?? []).map((a) => ({
                id: a.agent_id, name: a.full_name || 'Unnamed agent', phone: a.phone, meta: `${a.tenants} tenants`,
              }))}
              selectedId={agentId}
              onSelect={setAgentId}
            />
            {!agentId ? (
              <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                Select an agent to load their rent repayment history.
              </p>
            ) : (
              <>
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Agent</p>
                  <p className="text-base font-bold">{d?.agent?.full_name || DASH}</p>
                  <p className="text-xs text-muted-foreground">{d?.agent?.phone || DASH}</p>
                </div>
                <StatGrid items={[
                  { label: 'Tenants', value: num(k?.assigned_tenants) },
                  { label: 'Active repaying', value: num(k?.active_repaying) },
                  { label: 'Rent amount', value: ugx(k?.rent_total) },
                  { label: 'Outstanding', value: ugx(k?.outstanding) },
                  { label: 'Collected to date', value: ugx(k?.collected_to_date) },
                  { label: 'Repayment rate', value: pct(k?.repayment_rate) },
                  { label: 'Expected in window', value: ugx(k?.expected_window) },
                  { label: 'Collected in window', value: ugx(k?.collected_window) },
                ]} />
                <TableShell
                  columns={['Tenant Name & Contact', 'Rent Amount', 'Outstanding', 'Repayment', 'Collected', 'Percentage', 'Date']}
                  loading={agentReport.isLoading}
                  empty={(d?.tenants?.length ?? 0) === 0}
                  note="Collected is the amount taken in the selected window; percentage is repayment progress to date."
                  footer={
                    <tr>
                      <td className="px-3 py-2 text-[11px] font-semibold">Totals · {d?.tenants?.length ?? 0} tenants</td>
                      <td className="px-3 py-2 text-[11px] font-semibold">{ugx(sums.rent)}</td>
                      <td className="px-3 py-2 text-[11px] font-semibold">{ugx(sums.out)}</td>
                      <td className="px-3 py-2 text-[11px] font-semibold">{ugx(sums.rep)}</td>
                      <td className="px-3 py-2 text-[11px] font-semibold">{ugx(sums.col)}</td>
                      <td className="px-3 py-2 text-[11px] font-semibold">{pct(k?.repayment_rate)}</td>
                      <td className="px-3 py-2 text-[11px] font-semibold">{DASH}</td>
                    </tr>
                  }
                >
                  {(d?.tenants ?? []).map((t) => (
                    <tr key={t.rent_request_id} className="border-t border-border/70">
                      <td className="px-3 py-2">
                        <span className="block font-medium">{t.tenant_name || 'Unnamed tenant'}</span>
                        <span className="block text-muted-foreground">{t.tenant_phone || DASH}</span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">{ugx(t.rent_amount)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{ugx(t.outstanding)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{ugx(t.repayment)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{ugx(t.collected)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{pct(t.percentage)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{dt(t.last_collection_at)}</td>
                    </tr>
                  ))}
                </TableShell>
              </>
            )}
          </div>
        );
      }
      case 'rent-collections': {
        const d = rentReport.data;
        const k = d?.kpis;
        const t = (d?.rows ?? []).reduce(
          (a, r) => ({
            tenants: a.tenants + Number(r.repaying_tenants || 0),
            expected: a.expected + Number(r.expected || 0),
            collected: a.collected + Number(r.collected || 0),
            paid: a.paid + Number(r.paid_tenants || 0),
          }),
          { tenants: 0, expected: 0, collected: 0, paid: 0 },
        );
        return (
          <div className="space-y-4">
            <StatGrid items={[
              { label: 'Total agents', value: num(k?.total_agents) },
              { label: 'Active agents', value: num(k?.active_agents) },
              { label: 'Repaying tenants', value: num(k?.repaying_tenants) },
              { label: 'Expected', value: ugx(k?.expected) },
              { label: 'Collected', value: ugx(k?.collected) },
              { label: 'Collection rate', value: pct(k?.collection_rate) },
            ]} />
            <TableShell
              columns={['#', 'Agent Name', 'Agent Phone', 'Total Repaying Tenants', 'Expected', 'Collected', 'Rate', 'Paid', 'Status']}
              loading={rentReport.isLoading}
              empty={(d?.rows?.length ?? 0) === 0}
              note="Daily active repaying tenants only. Expected and collected are aggregated across the selected range."
              footer={
                <tr>
                  <td colSpan={3} className="px-3 py-2 text-[11px] font-semibold">Totals · {d?.rows?.length ?? 0} agents</td>
                  <td className="px-3 py-2 text-[11px] font-semibold">{num(t.tenants)}</td>
                  <td className="px-3 py-2 text-[11px] font-semibold">{ugx(t.expected)}</td>
                  <td className="px-3 py-2 text-[11px] font-semibold">{ugx(t.collected)}</td>
                  <td className="px-3 py-2 text-[11px] font-semibold">{pct(k?.collection_rate)}</td>
                  <td className="px-3 py-2 text-[11px] font-semibold">{num(t.paid)}</td>
                  <td className="px-3 py-2 text-[11px] font-semibold">{DASH}</td>
                </tr>
              }
            >
              {(d?.rows ?? []).map((r, i) => (
                <tr key={r.agent_id} className="border-t border-border/70">
                  <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                  <td className="px-3 py-2 font-medium">{r.full_name || 'Unnamed agent'}</td>
                  <td className="whitespace-nowrap px-3 py-2">{r.phone || DASH}</td>
                  <td className="px-3 py-2">{num(r.repaying_tenants)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{ugx(r.expected)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{ugx(r.collected)}</td>
                  <td className="px-3 py-2">{pct(r.rate)}</td>
                  <td className="px-3 py-2">{num(r.paid_tenants)}</td>
                  <td className="px-3 py-2"><Badge variant={statusTone(r.rate)} className="font-normal">{r.status}</Badge></td>
                </tr>
              ))}
            </TableShell>
          </div>
        );
      }
      case 'products-services': {
        const d = productsReport.data;
        const k = d?.kpis;
        const t = (d?.rows ?? []).reduce(
          (a, r) => ({
            value: a.value + Number(r.value || 0),
            recovered: a.recovered + Number(r.recovered || 0),
            outstanding: a.outstanding + Number(r.outstanding || 0),
          }),
          { value: 0, recovered: 0, outstanding: 0 },
        );
        return (
          <div className="space-y-4">
            <StatGrid items={[
              { label: 'Records', value: num(k?.applications) },
              { label: 'Approved / issued', value: num(k?.approved) },
              { label: 'Pending', value: num(k?.pending) },
              { label: 'Value issued', value: ugx(k?.value_issued) },
              { label: 'Recovered', value: ugx(k?.recovered) },
              { label: 'Outstanding', value: ugx(k?.outstanding) },
            ]} />
            <TableShell
              columns={['#', 'Agent Name', 'Agent Phone', 'Product', 'Status', 'Value', 'Recovered', 'Outstanding', 'Date']}
              loading={productsReport.isLoading}
              empty={(d?.rows?.length ?? 0) === 0}
              footer={
                <tr>
                  <td colSpan={5} className="px-3 py-2 text-[11px] font-semibold">Totals · {d?.rows?.length ?? 0} records</td>
                  <td className="px-3 py-2 text-[11px] font-semibold">{ugx(t.value)}</td>
                  <td className="px-3 py-2 text-[11px] font-semibold">{ugx(t.recovered)}</td>
                  <td className="px-3 py-2 text-[11px] font-semibold">{ugx(t.outstanding)}</td>
                  <td className="px-3 py-2 text-[11px] font-semibold">{DASH}</td>
                </tr>
              }
            >
              {(d?.rows ?? []).map((r, i) => (
                <tr key={r.sale_id} className="border-t border-border/70">
                  <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                  <td className="px-3 py-2 font-medium">{r.full_name || 'Unnamed agent'}</td>
                  <td className="whitespace-nowrap px-3 py-2">{r.phone || DASH}</td>
                  <td className="px-3 py-2">{r.product || DASH}</td>
                  <td className="px-3 py-2"><Badge variant="outline" className="font-normal">{r.status}</Badge></td>
                  <td className="whitespace-nowrap px-3 py-2">{ugx(r.value)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{ugx(r.recovered)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{ugx(r.outstanding)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{dt(r.date)}</td>
                </tr>
              ))}
            </TableShell>
          </div>
        );
      }
      case 'advances': {
        const d = advancesReport.data;
        const k = d?.kpis;
        const t = (d?.rows ?? []).reduce(
          (a, r) => ({
            d: a.d + Number(r.disbursed || 0),
            f: a.f + Number(r.access_fee || 0),
            r: a.r + Number(r.repaid || 0),
            o: a.o + Number(r.outstanding || 0),
          }),
          { d: 0, f: 0, r: 0, o: 0 },
        );
        return (
          <div className="space-y-4">
            <StatGrid items={[
              { label: 'Advances issued', value: num(k?.issued_count) },
              { label: 'Advance volume', value: ugx(k?.volume) },
              { label: 'Agents', value: num(k?.agents) },
              { label: 'Pending apps', value: num(k?.pending_apps) },
              { label: 'Repaid in window', value: ugx(k?.repaid) },
              { label: 'Outstanding', value: ugx(k?.outstanding) },
              { label: 'Arrears', value: ugx(k?.arrears) },
              { label: 'Recovery rate', value: pct(k?.recovery_rate) },
            ]} />
            {(d?.stages?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-2">
                {(d?.stages ?? []).map((s) => (
                  <Badge key={s.stage} variant="outline" className="font-normal">
                    {s.stage}: {num(s.count)} · {ugx(s.value)}
                  </Badge>
                ))}
              </div>
            )}
            <TableShell
              columns={['#', 'Agent Name', 'Agent Phone', 'Principal', 'Fee', 'Recovered', 'Outstanding', 'Status', 'Date']}
              loading={advancesReport.isLoading}
              empty={(d?.rows?.length ?? 0) === 0}
              note="Advances issued inside the selected window; recovery is drawn from the advance ledger."
              footer={
                <tr>
                  <td colSpan={3} className="px-3 py-2 text-[11px] font-semibold">Totals · {d?.rows?.length ?? 0} advances</td>
                  <td className="px-3 py-2 text-[11px] font-semibold">{ugx(t.d)}</td>
                  <td className="px-3 py-2 text-[11px] font-semibold">{ugx(t.f)}</td>
                  <td className="px-3 py-2 text-[11px] font-semibold">{ugx(t.r)}</td>
                  <td className="px-3 py-2 text-[11px] font-semibold">{ugx(t.o)}</td>
                  <td className="px-3 py-2 text-[11px] font-semibold">{DASH}</td>
                  <td className="px-3 py-2 text-[11px] font-semibold">{DASH}</td>
                </tr>
              }
            >
              {(d?.rows ?? []).map((r, i) => (
                <tr key={r.advance_id} className="border-t border-border/70">
                  <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                  <td className="px-3 py-2 font-medium">{r.full_name || 'Unnamed agent'}</td>
                  <td className="whitespace-nowrap px-3 py-2">{r.phone || DASH}</td>
                  <td className="whitespace-nowrap px-3 py-2">{ugx(r.disbursed)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{ugx(r.access_fee)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{ugx(r.repaid)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{ugx(r.outstanding)}</td>
                  <td className="px-3 py-2"><Badge variant="outline" className="font-normal">{r.status || DASH}</Badge></td>
                  <td className="whitespace-nowrap px-3 py-2">{dt(r.issued_at)}</td>
                </tr>
              ))}
            </TableShell>
          </div>
        );
      }
      case 'team-collections': {
        const d = teamReport.data;
        const k = d?.kpis;
        return (
          <div className="space-y-4">
            <EntityPicker
              label="Team"
              placeholder="Search team leader by name or phone…"
              query={teamSearch}
              onQuery={setTeamSearch}
              loading={teams.isLoading}
              options={(teams.data ?? []).map((t) => ({
                id: t.parent_agent_id, name: t.full_name || 'Unnamed leader', phone: t.phone, meta: `${t.members} members`,
              }))}
              selectedId={teamId}
              onSelect={setTeamId}
            />
            {!teamId ? (
              <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                Select a team leader to load their sub-agent collections.
              </p>
            ) : (
              <>
                <StatGrid items={[
                  { label: 'Team leader', value: d?.leader?.full_name || DASH },
                  { label: 'Total sub-agents', value: num(k?.sub_agents) },
                  { label: 'Collected', value: ugx(k?.collected) },
                  { label: 'Expected', value: ugx(k?.expected) },
                  { label: 'Rate', value: pct(k?.rate) },
                  { label: 'Rank', value: k?.rank ? `${k.rank} / ${k.total_teams ?? DASH}` : DASH },
                ]} />
                <TableShell
                  columns={['Agent Name & Phone', 'Tenants Count', 'Amount Collected', '% of Group Expected', 'Collections in Window', 'Latest']}
                  loading={teamReport.isLoading}
                  empty={(d?.rows?.length ?? 0) === 0}
                  footer={
                    <tr>
                      <td className="px-3 py-2 text-[11px] font-semibold">Totals · {d?.rows?.length ?? 0} members</td>
                      <td className="px-3 py-2 text-[11px] font-semibold">{num(k?.tenants)}</td>
                      <td className="px-3 py-2 text-[11px] font-semibold">{ugx(k?.collected)}</td>
                      <td className="px-3 py-2 text-[11px] font-semibold">{pct(k?.rate)}</td>
                      <td className="px-3 py-2 text-[11px] font-semibold">{DASH}</td>
                      <td className="px-3 py-2 text-[11px] font-semibold">Expected {ugx(k?.expected)}</td>
                    </tr>
                  }
                >
                  {(d?.rows ?? []).map((m) => (
                    <tr key={m.agent_id} className="border-t border-border/70">
                      <td className="px-3 py-2">
                        <span className="block font-medium">
                          {m.full_name || 'Unnamed agent'}
                          {m.is_leader && <Badge className="ml-2 font-normal" variant="default">Leader</Badge>}
                        </span>
                        <span className="block text-muted-foreground">{m.phone || DASH}</span>
                      </td>
                      <td className="px-3 py-2">{num(m.tenants)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{ugx(m.collected)}</td>
                      <td className="px-3 py-2">{pct(m.share_of_group_expected)}</td>
                      <td className="px-3 py-2">{num(m.payments)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{dt(m.last_collection_at)}</td>
                    </tr>
                  ))}
                </TableShell>
              </>
            )}
          </div>
        );
      }
      default:
        return null;
    }
  };

  const err = errorOf();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FileBarChart className="h-4 w-4 text-primary" />
            Reports Overview
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Step 1 — date range */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <CalendarRange className="h-3.5 w-3.5" /> Step 1 · Date range
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ro-from" className="text-xs">From</Label>
                <Input id="ro-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ro-to" className="text-xs">To</Label>
                <Input id="ro-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
              </div>
            </div>
          </div>

          {/* Step 2 — report type */}
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Step 2 · Report type
            </div>
            <Select
              value={reportType || undefined}
              onValueChange={(v) => setReportType(v as ReportType)}
              disabled={!rangeReady}
            >
              <SelectTrigger className="w-full" aria-label="Report type">
                <SelectValue placeholder={rangeReady ? 'Select report type' : 'Select a date range first'} />
              </SelectTrigger>
              <SelectContent>
                {REPORT_TYPES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <Badge variant="outline" className="font-normal">{rangeLabel}</Badge>
              {active && <span>{active.blurb}</span>}
            </div>
          </div>
        </CardContent>
      </Card>

      {!reportType ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <Info className="h-5 w-5 text-muted-foreground" />
            <p className="text-sm font-semibold">Pick a date range, then a report type</p>
            <p className="max-w-md text-xs text-muted-foreground">
              The report renders here and can be downloaded as a PDF.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex flex-col gap-3 pb-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="text-sm">{active?.label} report</CardTitle>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{rangeLabel}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-md border border-border p-0.5">
                <Button
                  size="sm"
                  variant={view === 'preview' ? 'default' : 'ghost'}
                  className="h-7 gap-1.5 px-2.5 text-xs"
                  onClick={() => setView('preview')}
                >
                  <Eye className="h-3.5 w-3.5" /> Preview
                </Button>
                <Button
                  size="sm"
                  variant={view === 'data' ? 'default' : 'ghost'}
                  className="h-7 gap-1.5 px-2.5 text-xs"
                  onClick={() => setView('data')}
                >
                  <TableIcon className="h-3.5 w-3.5" /> Data
                </Button>
              </div>
              <Button size="sm" variant="outline" disabled={!pdfReady || pdfBusy} onClick={downloadPdf} className={cn('shrink-0 gap-1.5')}>
                {pdfBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                {pdfBusy ? 'Building PDF…' : 'PDF'}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {err && (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                Could not load this report: {err.message}
              </p>
            )}
            {view === 'preview' ? (
              doc ? (
                <>
                  <ReportHtmlPreview html={doc.html} title={`${active?.label} report preview`} />
                  <p className="text-[11px] text-muted-foreground">
                    This is the exact document the PDF is generated from.
                  </p>
                </>
              ) : (
                <div className="space-y-4">
                  {(reportType === 'agent' || reportType === 'team-collections') && body()}
                  {reportType !== 'agent' && reportType !== 'team-collections' && (
                    <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" /> Preparing the report…
                    </div>
                  )}
                </div>
              )
            ) : (
              body()
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default ReportsOverview;
