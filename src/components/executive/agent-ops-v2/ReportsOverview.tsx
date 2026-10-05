import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarRange, Download, FileBarChart, Info, Loader2, Search } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
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
  printReportFrame,
  printReportHtml,
} from '@/lib/agentOpsOverviewReportHtml';

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

/**
 * The wizard selection (range → report type → agent/team) is kept in
 * sessionStorage, not only in component state.
 *
 * Why: this panel is mounted inside `switch (activeView)` in
 * `AgentOpsDashboard`, and `activeView` is duplicated between React state and
 * the `?section=` query param. Anything that drops `section` from the URL — a
 * sidebar `navigate(route)` from `ExecutiveDashboardLayout`, a role switch, a
 * deep link, or a genuine reload — flips `activeView` to null, which unmounts
 * this component and silently discarded the user's picks. They then had to
 * choose the range and report type again.
 *
 * Persisting here fixes the symptom for every one of those causes, including a
 * real page refresh, without touching the query string (which already has
 * several competing writers). sessionStorage, not localStorage: a report
 * selection should not outlive the browser tab.
 */
const WIZARD_KEY = 'welile.agent-ops.reports-overview.v1';

interface WizardState {
  from: string;
  to: string;
  reportType: ReportType | '';
  agentId: string | null;
  teamId: string | null;
}

const EMPTY_WIZARD: WizardState = { from: '', to: '', reportType: '', agentId: null, teamId: null };

/** Storage can throw (private mode, blocked site data) — never let it break the panel. */
function readWizard(): WizardState {
  try {
    const raw = sessionStorage.getItem(WIZARD_KEY);
    if (!raw) return EMPTY_WIZARD;
    const p = JSON.parse(raw) as Partial<WizardState>;
    const type = REPORT_TYPES.some((r) => r.value === p.reportType) ? (p.reportType as ReportType) : '';
    return {
      from: typeof p.from === 'string' ? p.from : '',
      to: typeof p.to === 'string' ? p.to : '',
      reportType: type,
      agentId: typeof p.agentId === 'string' ? p.agentId : null,
      teamId: typeof p.teamId === 'string' ? p.teamId : null,
    };
  } catch {
    return EMPTY_WIZARD;
  }
}

function writeWizard(s: WizardState): void {
  try {
    sessionStorage.setItem(WIZARD_KEY, JSON.stringify(s));
  } catch {
    /* nothing to do — the panel still works, it just will not survive a remount */
  }
}

export function ReportsOverview() {
  // Lazy initialiser: reads storage once on mount, not on every render.
  const [restored] = useState<WizardState>(readWizard);

  const [from, setFrom] = useState(restored.from);
  const [to, setTo] = useState(restored.to);
  const [reportType, setReportType] = useState<ReportType | ''>(restored.reportType);
  const [agentSearch, setAgentSearch] = useState('');
  const [agentId, setAgentId] = useState<string | null>(restored.agentId);
  const [teamSearch, setTeamSearch] = useState('');
  const [teamId, setTeamId] = useState<string | null>(restored.teamId);

  // Mirror the selection so an unmount (or reload) cannot lose it.
  useEffect(() => {
    writeWizard({ from, to, reportType, agentId, teamId });
  }, [from, to, reportType, agentId, teamId]);

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

  const frameRef = useRef<HTMLIFrameElement>(null);

  /**
   * The report document. This one string is BOTH the on-screen preview
   * (iframe srcDoc) and the print target, so the exported PDF is the same DOM
   * and stylesheet the user just looked at - it cannot drift.
   */
  const reportHtml = useMemo(() => {
    if (reportType === "agent" && agentReport.data) return buildAgentReportHtml(agentReport.data);
    if (reportType === "rent-collections" && rentReport.data) return buildRentCollectionsReportHtml(rentReport.data);
    if (reportType === "products-services" && productsReport.data) return buildProductsReportHtml(productsReport.data);
    if (reportType === "advances" && advancesReport.data) return buildAdvancesReportHtml(advancesReport.data);
    if (reportType === "team-collections" && teamReport.data) return buildTeamCollectionsReportHtml(teamReport.data);
    return "";
  }, [reportType, agentReport.data, rentReport.data, productsReport.data, advancesReport.data, teamReport.data]);

  const pdfReady = Boolean(reportHtml);

  /** Print the preview frame itself; only fall back if the frame is gone. */
  const downloadPdf = () => {
    if (!reportHtml) return;
    const filename = `Welile-${reportType || "report"}-${from}_${to}`;
    if (!printReportFrame(frameRef.current)) {
      printReportHtml(reportHtml, filename);
    }

    // Bulk report print/export (agent/rent-collections/products-services/
    // advances/team-collections) -- many rows of financial data at once,
    // not logged before this. Plain client-side insert so the audit_logs
    // IP-capture trigger sees the real browser IP directly. Never blocks
    // the actual export.
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        await supabase.from('audit_logs').insert({
          user_id: user?.id ?? null,
          action_type: 'pdf_report_exported',
          table_name: 'export',
          record_id: null,
          metadata: { filename, report_type: reportType },
        });
      } catch (e) {
        console.warn('[ReportsOverview] audit log insert failed:', e);
      }
    })();
  };

  const activeQuery =
    reportType === "agent" ? agentReport
    : reportType === "rent-collections" ? rentReport
    : reportType === "products-services" ? productsReport
    : reportType === "advances" ? advancesReport
    : reportType === "team-collections" ? teamReport
    : null;

  const err = activeQuery?.error as Error | null | undefined;

  const needsAgent = reportType === "agent" && !agentId;
  const needsTeam = reportType === "team-collections" && !teamId;

  const body = () => (
    <div className="space-y-4">
      {reportType === "agent" && (
        <EntityPicker
          label="Agent"
          placeholder="Search agent by name or phone..."
          query={agentSearch}
          onQuery={setAgentSearch}
          loading={agents.isLoading}
          options={(agents.data ?? []).map((a) => ({
            id: a.agent_id, name: a.full_name || "Unnamed agent", phone: a.phone, meta: `${a.tenants} tenants`,
          }))}
          selectedId={agentId}
          onSelect={setAgentId}
        />
      )}

      {reportType === "team-collections" && (
        <EntityPicker
          label="Team leader"
          placeholder="Search team leader by name or phone..."
          query={teamSearch}
          onQuery={setTeamSearch}
          loading={teams.isLoading}
          options={(teams.data ?? []).map((t) => ({
            id: t.parent_agent_id, name: t.full_name || "Unnamed leader", phone: t.phone, meta: `${t.members} members`,
          }))}
          selectedId={teamId}
          onSelect={setTeamId}
        />
      )}

      {needsAgent || needsTeam ? (
        <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          {needsAgent
            ? "Select an agent to load their rent repayment history."
            : "Select a team leader to load the team collections report."}
        </p>
      ) : activeQuery?.isLoading ? (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-border py-20 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Aggregating report...
        </div>
      ) : reportHtml ? (
        <div className="overflow-hidden rounded-lg border border-border bg-muted/40">
          <iframe
            ref={frameRef}
            srcDoc={reportHtml}
            title={`${active?.label ?? "Welile"} report preview`}
            className="h-[78vh] w-full border-0"
          />
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          No records for this window.
        </p>
      )}
    </div>
  );

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
            <Button size="sm" variant="outline" disabled={!pdfReady} onClick={downloadPdf} className={cn('shrink-0 gap-1.5')}>
              <Download className="h-3.5 w-3.5" /> PDF
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {err && (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                Could not load this report: {err.message}
              </p>
            )}
            {body()}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default ReportsOverview;
