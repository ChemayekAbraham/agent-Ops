import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ExecutiveDataTable, type Column } from '@/components/executive/ExecutiveDataTable';
import { KPICard } from '@/components/executive/KPICard';
import TenantCommunicationsTab from '@/components/executive/tenant-ops/workspace/TenantCommunicationsTab';
import AgentRegistrationControlTab from '@/components/executive/tenant-ops/workspace/AgentRegistrationControlTab';
import ManagementOverviewTab from '@/components/executive/tenant-ops/workspace/ManagementOverviewTab';
import { toast } from 'sonner';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import {
  ChevronLeft,
  ChevronRight,
  Settings2,
  TrendingUp,
  Users,
  CheckCircle2,
  Award,
  Gauge,
  Wallet,
  PieChart as PieChartIcon,
  FileText,
  Sheet as SheetIcon,
  Loader2,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import {
  TOPUP_TIER_LABELS,
  useSaveTopupEligibilityRules,
  useTenantTopupEligibility,
  useTopupEligibilityRules,
  type TopupEligibilityRow,
  type TopupEligibilityResult,
} from '@/hooks/useTenantTopupEligibility';
import {
  generateTopupEligibilityPdf,
  exportTopupEligibilityXlsx,
} from '@/lib/tenantOpsTopupEligibilityReport';

const PAGE_SIZE = 50;

const fmt = (n: number | null | undefined) =>
  `UGX ${Math.round(Number(n || 0)).toLocaleString()}`;

const tierTone = (tier: string) => {
  switch (tier) {
    case 'within_cycle': return 'bg-emerald-100 text-emerald-800 border-emerald-200';
    case 'within_one_month': return 'bg-sky-100 text-sky-800 border-sky-200';
    case 'within_two_months': return 'bg-amber-100 text-amber-800 border-amber-200';
    case 'beyond_two_months': return 'bg-slate-100 text-slate-700 border-slate-200';
    case 'same_amount_only': return 'bg-orange-100 text-orange-800 border-orange-200';
    default: return 'bg-rose-100 text-rose-800 border-rose-200';
  }
};

const tierChartColor = (tier: string) => {
  switch (tier) {
    case 'within_cycle': return 'hsl(var(--success))';
    case 'within_one_month': return 'hsl(var(--primary))';
    case 'within_two_months': return 'hsl(var(--warning))';
    case 'same_amount_only': return 'hsl(var(--warning))';
    case 'beyond_two_months': return 'hsl(var(--muted-foreground))';
    default: return 'hsl(var(--destructive))';
  }
};

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-base font-bold text-foreground">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function RulesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: rules } = useTopupEligibilityRules();
  const save = useSaveTopupEligibilityRules();
  const [qual, setQual] = useState('');
  const [same, setSame] = useState('');
  const [tierPcts, setTierPcts] = useState<Record<string, string>>({});

  const current = rules;
  const q = qual || String(current?.qualifying_pct ?? 90);
  const s = same || String(current?.same_amount_pct ?? 70);

  const submit = async () => {
    if (!current) return;
    try {
      await save.mutateAsync({
        ...current,
        qualifying_pct: Number(q),
        same_amount_pct: Number(s),
        tiers: current.tiers.map((t) => ({
          ...t,
          increase_pct: tierPcts[t.key] !== undefined ? Number(tierPcts[t.key]) : t.increase_pct,
        })),
      });
      toast.success('Eligibility rules saved');
      onClose();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not save the rules');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem)] max-w-lg flex-col overflow-hidden p-4 sm:max-h-[calc(100dvh-2rem)] sm:p-6">
        <DialogHeader>
          <DialogTitle>Approved eligibility thresholds</DialogTitle>
          <DialogDescription>
            These thresholds drive the whole tab. Changing them re-grades every tenant; it does not
            change any payment, plan or approval.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Qualifying coverage %</Label>
              <Input value={q} onChange={(e) => setQual(e.target.value)} inputMode="numeric" />
            </div>
            <div>
              <Label className="text-xs">Same-amount coverage %</Label>
              <Input value={s} onChange={(e) => setSame(e.target.value)} inputMode="numeric" />
            </div>
          </div>
          <div className="space-y-2">
            {(current?.tiers || []).map((t) => (
              <div key={t.key} className="flex flex-col gap-2 rounded-lg border p-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <span className="break-words text-xs font-medium">{TOPUP_TIER_LABELS[t.key] || t.key}</span>
                <div className="flex items-center gap-2 self-start sm:self-auto">
                  <Input
                    className="h-8 w-20"
                    inputMode="numeric"
                    value={tierPcts[t.key] ?? String(t.increase_pct)}
                    onChange={(e) => setTierPcts((p) => ({ ...p, [t.key]: e.target.value }))}
                  />
                  <span className="text-xs text-muted-foreground">% increase</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="grid shrink-0 grid-cols-1 gap-2 pt-2 sm:grid-cols-2">
          <Button variant="outline" className="w-full" onClick={onClose}>Cancel</Button>
          <Button className="w-full" onClick={submit} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save thresholds'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TenantDetail({ row, onClose }: { row: TopupEligibilityRow | null; onClose: () => void }) {
  if (!row) return null;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{row.tenant_name || 'Tenant'}</DialogTitle>
          <DialogDescription>
            {row.tenant_phone || 'No phone'} · {row.district || 'No district'} · Agent {row.agent_name || 'unassigned'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2 sm:grid-cols-4">
            <StatTile label="Current rent" value={fmt(row.rent_amount)} />
            <StatTile label="Expected (cycle)" value={fmt(row.total_amount)} />
            <StatTile label="Paid" value={fmt(row.amount_repaid)} />
            <StatTile label="Outstanding" value={fmt(row.outstanding)} />
          </div>
          <div className="rounded-lg border p-3">
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
              <Badge variant="outline" className={tierTone(row.tier_key)}>
                {TOPUP_TIER_LABELS[row.tier_key] || row.tier_key}
              </Badge>
              <span className="text-sm font-bold">{Number(row.pct_covered).toFixed(1)}% covered</span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Cycle {row.term_start} → {row.term_end} ({row.term_days} days, {row.repayment_frequency}).{' '}
              {row.reached_on
                ? `Reached the qualifying level on ${row.reached_on}, ${row.days_after_cycle} day(s) after the cycle end.`
                : 'Has not yet reached the qualifying level.'}
            </p>
            <p className="mt-1 text-xs font-medium">
              {row.tier_key === 'not_eligible'
                ? 'Below the qualifying coverage — no top-up available.'
                : row.increase_pct > 0
                  ? `Can access up to ${fmt(row.max_accessible_rent)} (an increase of ${fmt(row.max_topup_amount)}, ${row.increase_pct}%).`
                  : `Can access the same rate as before: up to ${fmt(row.max_accessible_rent)}.`}
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Higher levels
            </p>
            {row.levels.map((l) => (
              <div key={l.key} className="grid grid-cols-1 gap-2 rounded-lg border p-2 text-xs sm:grid-cols-2 lg:grid-cols-5 lg:items-center">
                <span className="font-medium">{l.label}</span>
                <span>{fmt(l.max_accessible_rent)}</span>
                <span className="text-muted-foreground">
                  {l.amount_required > 0 ? `${fmt(l.amount_required)} still required` : 'Coverage met'}
                </span>
                <span className="text-muted-foreground">
                  {l.deadline ? `by ${l.deadline}` : 'no deadline'}
                </span>
                <Badge variant="outline" className={l.reached ? tierTone('within_cycle') : ''}>
                  {l.reached ? 'Current level' : l.window_open ? 'Window open' : 'Window closed'}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TopUpEligibilityTab() {
  const [search, setSearch] = useState('');
  const [tier, setTier] = useState<string>('all');
  const [page, setPage] = useState(0);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [selected, setSelected] = useState<TopupEligibilityRow | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportingXlsx, setExportingXlsx] = useState(false);

  const { data, isLoading, isFetching } = useTenantTopupEligibility({
    search,
    tier: tier === 'all' ? null : tier,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  const rows = data?.rows || [];
  const summary = data?.summary;
  const rules = data?.rules;

  const tierData = useMemo(() => {
    const counts = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.tier_key] = (acc[r.tier_key] || 0) + 1;
      return acc;
    }, {});
    return Object.entries(counts).map(([key, value]) => ({
      name: TOPUP_TIER_LABELS[key] || key,
      value,
      color: tierChartColor(key),
    }));
  }, [rows]);

  /** Same RPC the table already uses, just fetched unpaginated for a report —
   * no new endpoint, no re-derivation of eligibility, nothing invented. */
  const fetchAllRowsForExport = async (): Promise<TopupEligibilityRow[]> => {
    const total = data?.total ?? rows.length;
    const { data: resp, error } = await supabase.rpc('get_tenant_topup_eligibility', {
      p_search: search || null,
      p_agent_id: null,
      p_tier: tier === 'all' ? null : tier,
      p_limit: Math.max(total, rows.length, 1),
      p_offset: 0,
    });
    if (error) throw error;
    return ((resp as unknown as TopupEligibilityResult)?.rows) || [];
  };

  const handleExportPdf = async () => {
    setExportingPdf(true);
    const toastId = toast.loading('Generating professional PDF report…');
    try {
      const allRows = await fetchAllRowsForExport();
      const { data: auth } = await supabase.auth.getUser();
      await generateTopupEligibilityPdf(allRows, { generatedByUserId: auth?.user?.id });
      toast.success('PDF report ready', { id: toastId });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not generate the PDF report', { id: toastId });
    } finally {
      setExportingPdf(false);
    }
  };

  const handleExportXlsx = async () => {
    setExportingXlsx(true);
    const toastId = toast.loading('Preparing Excel export…');
    try {
      const allRows = await fetchAllRowsForExport();
      await exportTopupEligibilityXlsx(allRows);
      toast.success('Excel export ready', { id: toastId });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not prepare the Excel export', { id: toastId });
    } finally {
      setExportingXlsx(false);
    }
  };

  const columns = useMemo<Column<TopupEligibilityRow>[]>(() => [
    { key: 'tenant_name', label: 'Tenant', render: (_v, r) => (
      <div>
        <p className="font-medium">{r.tenant_name || '—'}</p>
        <p className="text-[11px] text-muted-foreground">{r.tenant_phone || r.tenant_id.slice(0, 8)}</p>
      </div>
    ) },
    { key: 'agent_name', label: 'Agent', className: 'hidden lg:table-cell', render: (_v, r) => r.agent_name || '—' },
    { key: 'rent_amount', label: 'Current rent', sortable: true, render: (_v, r) => fmt(r.rent_amount) },
    { key: 'term_end', label: 'Cycle', className: 'hidden xl:table-cell', render: (_v, r) => (
      <span className="text-xs">{r.term_start} → {r.term_end}</span>
    ) },
    { key: 'total_amount', label: 'Expected', className: 'hidden md:table-cell', sortable: true, render: (_v, r) => fmt(r.total_amount) },
    { key: 'amount_repaid', label: 'Paid', className: 'hidden md:table-cell', sortable: true, render: (_v, r) => fmt(r.amount_repaid) },
    { key: 'outstanding', label: 'Outstanding', className: 'hidden lg:table-cell', sortable: true, render: (_v, r) => fmt(r.outstanding) },
    { key: 'pct_covered', label: '% covered', sortable: true, render: (_v, r) => (
      <span className="font-semibold">{Number(r.pct_covered).toFixed(1)}%</span>
    ) },
    { key: 'tier_key', label: 'Eligibility', render: (_v, r) => (
      <Badge variant="outline" className={tierTone(r.tier_key)}>
        {TOPUP_TIER_LABELS[r.tier_key] || r.tier_key}
      </Badge>
    ) },
    { key: 'max_accessible_rent', label: 'Max accessible', className: 'hidden xl:table-cell', sortable: true, render: (_v, r) => (
      <div>
        <p className="font-medium">{fmt(r.max_accessible_rent)}</p>
        <p className="text-[11px] text-muted-foreground">
          {r.max_topup_amount > 0 ? `+${fmt(r.max_topup_amount)}` : 'no increase'}
        </p>
      </div>
    ) },
    { key: 'amount_to_qualifying', label: 'To next level', className: 'hidden xl:table-cell', render: (_v, r) => (
      r.amount_to_qualifying > 0 ? fmt(r.amount_to_qualifying)
        : r.amount_to_same_amount > 0 ? fmt(r.amount_to_same_amount) : 'Met'
    ) },
  ], []);

  const totalPages = Math.max(1, Math.ceil((data?.total || 0) / PAGE_SIZE));

  return (
    <div className="space-y-3">
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-start sm:justify-between">
        <p className="min-w-0 break-words text-xs text-muted-foreground">
          {rules
            ? `Qualifying at ${rules.qualifying_pct}% of the tenant's own cycle dues; ${rules.same_amount_pct}%+ may re-apply for the same amount.`
            : 'Loading thresholds…'}
          {data?.as_of ? ` As of ${data.as_of}.` : ''}
        </p>
        <div className="grid grid-cols-1 gap-1.5 min-[380px]:grid-cols-2 sm:flex sm:shrink-0 sm:flex-wrap sm:items-center sm:justify-end">
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-1.5 sm:w-auto"
            disabled={exportingPdf}
            onClick={handleExportPdf}
          >
            {exportingPdf ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
            Professional PDF
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-1.5 sm:w-auto"
            disabled={exportingXlsx}
            onClick={handleExportXlsx}
          >
            {exportingXlsx ? <Loader2 className="h-4 w-4 animate-spin" /> : <SheetIcon className="h-4 w-4" />}
            Export Excel
          </Button>
          <Button variant="outline" size="sm" className="w-full gap-1.5 min-[380px]:col-span-2 sm:w-auto" onClick={() => setRulesOpen(true)}>
            <Settings2 className="h-4 w-4" /> Thresholds
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : summary ? (
        <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
          <KPICard title="Tenants" value={summary.tenants.toLocaleString()} icon={Users} color="bg-primary/10 text-primary" />
          <KPICard title="Eligible" value={summary.eligible.toLocaleString()} icon={CheckCircle2} color="bg-success/10 text-success" subtitle="any level" />
          <KPICard title="100% level" value={summary.within_cycle.toLocaleString()} icon={Award} color="bg-success/10 text-success" subtitle="within cycle" />
          <KPICard title="50% level" value={summary.within_one_month.toLocaleString()} icon={Gauge} color="bg-warning/10 text-warning" subtitle="within 1 month" />
          <KPICard title="25% level" value={summary.within_two_months.toLocaleString()} icon={Gauge} color="bg-warning/10 text-warning" subtitle="within 2 months" />
          <Card className="border-primary/30 bg-gradient-to-br from-primary/10 via-card to-card shadow-sm">
            <CardContent className="p-3 sm:p-4">
              <div className="flex items-center gap-2 sm:gap-2.5">
                <div className="rounded-xl bg-primary/15 p-1.5 sm:p-2 shrink-0">
                  <Wallet className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
                </div>
                <p className="text-xs font-medium text-muted-foreground leading-tight">Top-up accessible</p>
              </div>
              <p className="mt-2 text-xl sm:text-2xl font-bold tracking-tight tabular-nums">{fmt(summary.total_topup_accessible)}</p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {!isLoading && tierData.length > 0 && (
        <Card className="border shadow-sm">
          <CardHeader className="pb-2 px-3 sm:px-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <PieChartIcon className="h-4 w-4 text-primary" />
              Eligibility Tier Distribution
            </CardTitle>
          </CardHeader>
          <CardContent className="px-2 sm:px-4 pb-3">
            <div className="h-[260px] sm:h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={tierData} dataKey="value" nameKey="name" innerRadius={48} outerRadius={78} paddingAngle={2}>
                    {tierData.map((d) => <Cell key={d.name} fill={d.color} />)}
                  </Pie>
                  <Tooltip
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px', fontSize: '12px' }}
                    formatter={(value: number, name: string) => [`${value} tenants`, name]}
                  />
                  <Legend wrapperStyle={{ fontSize: '11px' }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Select value={tier} onValueChange={(v) => { setTier(v); setPage(0); }}>
          <SelectTrigger className="h-9 w-full sm:w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All eligibility levels</SelectItem>
            {Object.entries(TOPUP_TIER_LABELS).map(([k, l]) => (
              <SelectItem key={k} value={k}>{l}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex w-full items-center justify-between gap-1.5 sm:ml-auto sm:w-auto sm:justify-start">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground">Page {page + 1} of {totalPages}</span>
          <Button variant="outline" size="sm" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <ExecutiveDataTable
        data={rows}
        columns={columns}
        title="Tenant Top-Up Eligibility"
        loading={isLoading}
        limit={PAGE_SIZE}
        searchValue={search}
        onSearchChange={(v) => { setSearch(v); setPage(0); }}
        searchPlaceholder="Search tenant, phone or agent…"
        searching={isFetching}
        onRowClick={(r) => setSelected(r)}
      />

      <RulesDialog open={rulesOpen} onClose={() => setRulesOpen(false)} />
      <TenantDetail row={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

export default function TenantOperationsWorkspace() {
  return (
    <Card className="min-w-0 border-border/60">
      <CardHeader className="px-3 pb-3 sm:px-6">
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="h-4 w-4 text-primary" />
          Tenant Operations Workspace
        </CardTitle>
      </CardHeader>
      <CardContent className="min-w-0 px-3 sm:px-6">
        <Tabs defaultValue="topup">
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1.5 rounded-xl border border-border bg-muted/30 p-1.5">
            <TabsTrigger value="topup" className="h-9 shrink-0 whitespace-nowrap rounded-lg px-2.5 text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm">Tenant Top-Up Eligibility</TabsTrigger>
            <TabsTrigger value="comms" className="h-9 shrink-0 whitespace-nowrap rounded-lg px-2.5 text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm">Tenant Communications</TabsTrigger>
            <TabsTrigger value="registration" className="h-9 shrink-0 whitespace-nowrap rounded-lg px-2.5 text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm">Agent Registration Control</TabsTrigger>
            <TabsTrigger value="overview" className="h-9 shrink-0 whitespace-nowrap rounded-lg px-2.5 text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm">Management Overview</TabsTrigger>
          </TabsList>
          <TabsContent value="topup" className="mt-3">
            <TopUpEligibilityTab />
          </TabsContent>
          <TabsContent value="comms" className="mt-3">
            <TenantCommunicationsTab />
          </TabsContent>
          <TabsContent value="registration" className="mt-3">
            <AgentRegistrationControlTab />
          </TabsContent>
          <TabsContent value="overview" className="mt-3">
            <ManagementOverviewTab />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
