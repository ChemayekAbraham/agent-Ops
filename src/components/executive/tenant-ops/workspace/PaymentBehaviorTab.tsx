/**
 * Tenant Payment Behavior & Data Science (Tenant Ops -> Classic -> Workspaces -> Tenant
 * Operations Workspace).
 *
 * Who pays tenants' rent, the tenant or an agent, and what that says about reliability. Every
 * figure comes from the tops_payment_behaviour_* RPCs (calculated in SQL from the receipt book
 * and the pinned bill); this component only filters, lays out and exports. The date range uses
 * the same OpsDateRangeFilter as Tenant Ops Home, and the agent, place and plan-frequency filters
 * narrow every section and the PDF at once. Observed figures and estimates are labelled apart.
 */
import { useMemo, useState } from 'react';
import type { DateRange } from 'react-day-picker';
import { useSearchParams } from 'react-router-dom';
import { format, isValid, parseISO } from 'date-fns';
import { toast } from 'sonner';
import { FileText, FilterX, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  OpsDateRangeFilter, PRESETS, rangePhrase, resolveRange, type PresetKey,
} from '@/components/executive/shared/OpsDateRangeFilter';
import {
  fetchPaymentBehaviorReportData, usePaymentBehaviorOptions, usePaymentBehaviorOverview, usePaymentBehaviorTiming,
  usePaymentBehaviorTrend, type PaymentBehaviorDimension, type PaymentBehaviorFilters,
} from '@/hooks/tenantOpsWorkspace/usePaymentBehavior';
import { WorkspaceEmptyState } from '@/components/executive/tenant-ops/workspace/WorkspaceEmptyState';
import { AlertTriangle } from 'lucide-react';
import { OverviewSection } from './payment-behavior/OverviewSection';
import { TrendsSection } from './payment-behavior/TrendsSection';
import { TimelinessSection } from './payment-behavior/TimelinessSection';
import { SegmentsSection } from './payment-behavior/SegmentsSection';
import { BreakdownSection } from './payment-behavior/BreakdownSection';
import { EarlyWarningSection } from './payment-behavior/EarlyWarningSection';
import { MethodSection } from './payment-behavior/MethodSection';
import { fmtDay } from './payment-behavior/labels';

const SECTION_TRIGGER =
  'h-9 shrink-0 whitespace-nowrap rounded-lg px-2.5 text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm';

// The date range can arrive in the URL (pb_range, plus pb_from / pb_to for a custom range) so the
// Tenant Ops Home card opens this tab on the range it was showing.
function readRange(params: URLSearchParams): { preset: PresetKey; custom?: DateRange } {
  const range = params.get('pb_range');
  if (range === 'custom') {
    const from = params.get('pb_from') ? parseISO(params.get('pb_from')!) : null;
    const to = params.get('pb_to') ? parseISO(params.get('pb_to')!) : null;
    if (from && isValid(from)) return { preset: 'custom', custom: { from, to: to && isValid(to) ? to : from } };
  }
  if (range && PRESETS.some((p) => p.key === range && p.key !== 'custom')) return { preset: range as PresetKey };
  return { preset: 'month' };
}

const ALL = '__all__';

export default function PaymentBehaviorTab() {
  const [params] = useSearchParams();
  const [initial] = useState(() => readRange(params));
  const [preset, setPreset] = useState<PresetKey>(initial.preset);
  const [custom, setCustom] = useState<DateRange | undefined>(initial.custom);
  const { start, end } = useMemo(() => resolveRange(preset, custom), [preset, custom]);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const phrase = useMemo(() => rangePhrase(preset, start, end), [preset, start, end]);

  const [agentId, setAgentId] = useState<string | null>(null);
  const [region, setRegion] = useState<string | null>(null);
  const [district, setDistrict] = useState<string | null>(null);
  const [cadence, setCadence] = useState<string | null>(null);
  const [section, setSection] = useState('overview');
  const [exporting, setExporting] = useState(false);

  const filters: PaymentBehaviorFilters = useMemo(
    () => ({ startIso, endIso, agentId, region, district, cadence }),
    [startIso, endIso, agentId, region, district, cadence],
  );
  const filtered = !!(agentId || region || district || cadence);

  const { data: options } = usePaymentBehaviorOptions();
  const overview = usePaymentBehaviorOverview(filters);
  const trend = usePaymentBehaviorTrend(filters);
  const timing = usePaymentBehaviorTiming(filters);

  const districtOptions = useMemo(
    () => (options?.districts ?? []).filter((d) => !region || d.region === region),
    [options, region],
  );

  const clearFilters = () => { setAgentId(null); setRegion(null); setDistrict(null); setCadence(null); };

  const drill = (dimension: PaymentBehaviorDimension, key: string) => {
    if (dimension === 'agent') setAgentId(key === 'none' ? null : key);
    if (dimension === 'region') { setRegion(key === 'Unmapped' ? null : key); setDistrict(null); }
    if (dimension === 'district') setDistrict(key === 'Unmapped' ? null : key);
    if (dimension === 'cadence') setCadence(key === 'unknown' ? null : key);
    setSection('overview');
    toast.success('Narrowed every section to that selection');
  };

  const selectedLabels = () => ({
    agent: agentId ? options?.agents.find((a) => a.id === agentId)?.name ?? 'Selected agent' : null,
    region,
    district,
    cadence,
  });

  const exportPdf = async () => {
    setExporting(true);
    const toastId = toast.loading('Building the Tenant Payment Behavior report…');
    try {
      const [data, { generatePaymentBehaviorPdf }] = await Promise.all([
        fetchPaymentBehaviorReportData(filters),
        import('@/lib/tenantPaymentBehaviorPdf'),
      ]);
      await generatePaymentBehaviorPdf(data, {
        periodLabel: `${format(start, 'dd MMM yyyy')} to ${format(end, 'dd MMM yyyy')}`,
        phrase,
        filters: selectedLabels(),
      });
      toast.success('Report ready', { id: toastId });
    } catch (e) {
      toast.error((e as { message?: string })?.message || 'Could not build the report', { id: toastId });
    } finally {
      setExporting(false);
    }
  };

  const failed = overview.isError && !overview.data;

  return (
    <div className="space-y-3">
      <div className="space-y-3">
        <div className="min-w-0">
          <h3 className="text-base font-bold tracking-tight">Tenant Payment Behavior</h3>
          <p className="text-xs text-muted-foreground">
            Who pays the rent, tenants themselves or agents, and what it says about reliability.
            {overview.data ? ` ${fmtDay(overview.data.summary.window.start_day)} to ${fmtDay(overview.data.summary.window.end_day)}.` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <OpsDateRangeFilter preset={preset} custom={custom} onPresetChange={setPreset} onCustomChange={setCustom} />
          <Button type="button" className="h-10 w-full shrink-0 gap-2 text-xs font-semibold min-[480px]:w-auto" onClick={() => void exportPdf()} disabled={exporting || failed}>
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
            Download PDF report
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2 xl:grid-cols-5" role="group" aria-label="Filters">
        <Select value={agentId ?? ALL} onValueChange={(v) => setAgentId(v === ALL ? null : v)}>
          <SelectTrigger className="h-10 text-xs" aria-label="Agent"><SelectValue placeholder="All agents" /></SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value={ALL} className="text-xs">All agents</SelectItem>
            {(options?.agents ?? []).map((a) => <SelectItem key={a.id} value={a.id} className="text-xs">{a.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={region ?? ALL} onValueChange={(v) => { setRegion(v === ALL ? null : v); setDistrict(null); }}>
          <SelectTrigger className="h-10 text-xs" aria-label="Region"><SelectValue placeholder="All regions" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-xs">All regions</SelectItem>
            {(options?.regions ?? []).map((r) => <SelectItem key={r} value={r} className="text-xs">{r}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={district ?? ALL} onValueChange={(v) => setDistrict(v === ALL ? null : v)}>
          <SelectTrigger className="h-10 text-xs" aria-label="District"><SelectValue placeholder="All districts" /></SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value={ALL} className="text-xs">All districts</SelectItem>
            {districtOptions.map((d) => <SelectItem key={`${d.region}-${d.district}`} value={d.district} className="text-xs">{d.district}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={cadence ?? ALL} onValueChange={(v) => setCadence(v === ALL ? null : v)}>
          <SelectTrigger className="h-10 text-xs" aria-label="Payment frequency"><SelectValue placeholder="Any frequency" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-xs">Any frequency</SelectItem>
            {(options?.cadences ?? []).map((c) => <SelectItem key={c} value={c} className="text-xs capitalize">{c}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button type="button" variant="outline" className="h-10 gap-2 text-xs" disabled={!filtered} onClick={clearFilters}>
          <FilterX className="h-4 w-4" /> Clear filters
        </Button>
      </div>

      {failed ? (
        <WorkspaceEmptyState icon={AlertTriangle} tone="destructive" title="Could not load Tenant Payment Behavior" hint="Check your connection, or that you have access to Tenant Ops." />
      ) : (
        <Tabs value={section} onValueChange={setSection}>
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1.5 rounded-xl border border-border bg-muted/30 p-1.5">
            <TabsTrigger value="overview" className={SECTION_TRIGGER}>Overview</TabsTrigger>
            <TabsTrigger value="trends" className={SECTION_TRIGGER}>Trends</TabsTrigger>
            <TabsTrigger value="timeliness" className={SECTION_TRIGGER}>Timeliness</TabsTrigger>
            <TabsTrigger value="segments" className={SECTION_TRIGGER}>Segments</TabsTrigger>
            <TabsTrigger value="breakdown" className={SECTION_TRIGGER}>Breakdowns</TabsTrigger>
            <TabsTrigger value="warning" className={SECTION_TRIGGER}>Early warning</TabsTrigger>
            <TabsTrigger value="method" className={SECTION_TRIGGER}>Method</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="mt-3"><OverviewSection data={overview.data} timing={timing.data} loading={overview.isLoading} /></TabsContent>
          <TabsContent value="trends" className="mt-3"><TrendsSection data={trend.data} loading={trend.isLoading} /></TabsContent>
          <TabsContent value="timeliness" className="mt-3"><TimelinessSection data={timing.data} loading={timing.isLoading} /></TabsContent>
          <TabsContent value="segments" className="mt-3"><SegmentsSection data={overview.data} loading={overview.isLoading} /></TabsContent>
          <TabsContent value="breakdown" className="mt-3"><BreakdownSection filters={filters} onDrill={drill} /></TabsContent>
          <TabsContent value="warning" className="mt-3"><EarlyWarningSection filters={filters} /></TabsContent>
          <TabsContent value="method" className="mt-3"><MethodSection summary={overview.data?.summary} /></TabsContent>
        </Tabs>
      )}
    </div>
  );
}
