import { useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import { Building2, ChevronLeft, ChevronRight, Download, FileText, Loader2, MapPinOff, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  emptyTpspFilters, fetchTpspProjectionRows, useTpspProjection, useTpspProjectionFilters,
  useTpspProjectionRows, type TpspFilterOptions, type TpspFilters, type TpspGrain, type TpspOption,
} from '@/hooks/useTpspProjection';
import { downloadTpspProjectionPdf } from '@/lib/tpspProjectionPdf';

const PAGE_SIZE = 25;
const ugx = (n: unknown) => `UGX ${Math.round(Number(n) || 0).toLocaleString()}`;
const compact = (n: unknown) => {
  const v = Math.round(Number(n) || 0);
  if (Math.abs(v) >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return String(v);
};

const ALL = '__all__';
const PDF_ROW_CAP = 2000;

/** Resolve the filters in force into readable label lines for the PDF header/footer. */
function describeFilters(f: TpspFilters, options?: TpspFilterOptions): string[] {
  const label = (list: TpspOption[] | undefined, value: string | number | null) =>
    value == null ? null : (list || []).find((o) => String(o.value) === String(value))?.label ?? String(value);
  const parts: Array<[string, string | null]> = [
    ['Region', label(options?.regions, f.region)],
    ['District', label(options?.districts, f.districtId)],
    ['County', label(options?.counties, f.countyId)],
    ['Sub-county', label(options?.subcounties, f.subcountyId)],
    ['Parish', label(options?.parishes, f.parishId)],
    ['Village', label(options?.villages, f.villageId)],
    ['Agent', label(options?.agents, f.agentId)],
    ['Landlord', label(options?.landlords, f.landlordId)],
    ['House', label(options?.houses, f.houseId)],
  ];
  const lines = parts.filter(([, v]) => !!v).map(([k, v]) => `${k}: ${v}`);
  if (f.unmapped) lines.push('Unmapped locations only');
  if (f.search.trim()) lines.push(`Search: "${f.search.trim()}"`);
  return lines;
}

function OptionSelect({
  label, value, options, onChange, disabled,
}: {
  label: string;
  value: string;
  options: TpspOption[];
  onChange: (v: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value || ALL}
      onValueChange={(v) => onChange(v === ALL ? null : v)}
      disabled={disabled || options.length === 0}
    >
      <SelectTrigger className="h-8 w-[150px] text-[11px]">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent className="z-[200] max-h-[320px]">
        <SelectItem value={ALL} className="text-[11px]">{label}: All</SelectItem>
        {options.map((o) => (
          <SelectItem key={String(o.value)} value={String(o.value)} className="text-[11px]">
            {o.label} ({o.plans.toLocaleString()})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function KpiTile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={cn('mt-1 text-base font-bold tabular-nums', tone)}>{value}</p>
        {hint && <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function TenantProductsProjections() {
  const [filters, setFilters] = useState<TpspFilters>(emptyTpspFilters);
  const [searchInput, setSearchInput] = useState('');
  const [grain, setGrain] = useState<TpspGrain>('month');
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);

  const months = 12;
  const projectionQuery = useTpspProjection(filters, grain, months);
  const optionsQuery = useTpspProjectionFilters(filters);
  const rowsQuery = useTpspProjectionRows(filters, months, page, PAGE_SIZE);

  const projection = projectionQuery.data;
  const options = optionsQuery.data;
  const summary = projection?.summary;

  const patch = (next: Partial<TpspFilters>) => {
    setPage(0);
    setFilters((prev) => ({ ...prev, ...next }));
  };

  // Selecting a higher level clears the levels beneath it so the drill-down stays coherent.
  const setRegion = (v: string | null) => patch({ region: v, districtId: null, countyId: null, subcountyId: null, parishId: null, villageId: null, houseId: null });
  const setDistrict = (v: string | null) => patch({ districtId: v ? Number(v) : null, countyId: null, subcountyId: null, parishId: null, villageId: null, houseId: null });
  const setCounty = (v: string | null) => patch({ countyId: v ? Number(v) : null, subcountyId: null, parishId: null, villageId: null, houseId: null });
  const setSubcounty = (v: string | null) => patch({ subcountyId: v ? Number(v) : null, parishId: null, villageId: null, houseId: null });
  const setParish = (v: string | null) => patch({ parishId: v ? Number(v) : null, villageId: null, houseId: null });
  const setVillage = (v: string | null) => patch({ villageId: v ? Number(v) : null, houseId: null });

  const chartData = useMemo(
    () => (projection?.series || []).map((s) => ({
      label: s.label,
      tenant: Number(s.tenant_rent) || 0,
      landlord: Number(s.landlord_cost) || 0,
      margin: Number(s.margin) || 0,
    })),
    [projection?.series],
  );

  const totalRows = rowsQuery.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  const handleExport = async () => {
    setExporting(true);
    try {
      const header = [
        'Tenant', 'Phone', 'House', 'Location', 'Agent', 'Landlord', 'Plan status',
        'Current cycle ends', 'Monthly tenant rent', 'Monthly landlord cost', 'Monthly margin',
        '12-month tenant rent', '12-month margin',
      ];
      const lines = (rowsQuery.data?.rows || []).map((r) => [
        r.tenant_name, r.tenant_phone ?? '', r.house_label ?? '', r.location_label ?? '',
        r.agent_name ?? '', r.landlord_name ?? '', r.plan_status, r.cycle_end_date ?? '',
        r.monthly_tenant_rent, r.monthly_landlord_cost, r.monthly_margin,
        r.horizon_tenant_rent, r.horizon_margin,
      ]);
      const csv = [header, ...lines]
        .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
        .join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rent-projections-page-${page + 1}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success('Projection rows exported');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const handleExportPdf = async () => {
    if (!projection) return;
    setExportingPdf(true);
    try {
      const detail = await fetchTpspProjectionRows(filters, months, PDF_ROW_CAP);
      await downloadTpspProjectionPdf({
        projection,
        rows: detail.rows,
        totalRows: detail.total,
        rowCap: PDF_ROW_CAP,
        filterLines: describeFilters(filters, options),
        grain,
      });
      toast.success('Projection report exported');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'PDF export failed');
    } finally {
      setExportingPdf(false);
    }
  };

  return (
    <div className="space-y-3">
      <Card className="border-purple-200">
        <CardHeader className="p-3 pb-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-sm font-bold">Rent Projections — next 12 months</CardTitle>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Houses Welile leases from landlords and sub-leases to active tenants ·{' '}
                {projection?.timezone || 'Africa/Kampala'} · read-only
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {(['month', 'quarter', 'year'] as TpspGrain[]).map((g) => (
                <Button
                  key={g}
                  size="sm"
                  variant={grain === g ? 'default' : 'outline'}
                  className="h-8 text-[11px] capitalize"
                  onClick={() => setGrain(g)}
                >
                  {g === 'month' ? 'Monthly' : g === 'quarter' ? 'Quarterly' : 'Yearly'}
                </Button>
              ))}
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-[11px]"
                onClick={() => { void projectionQuery.refetch(); void rowsQuery.refetch(); void optionsQuery.refetch(); }}
              >
                <RefreshCw className={cn('mr-1 h-3.5 w-3.5', (projectionQuery.isFetching || rowsQuery.isFetching) && 'animate-spin')} />
                Refresh
              </Button>
              <Button size="sm" variant="outline" className="h-8 text-[11px]" disabled={exporting || !rowsQuery.data?.rows.length} onClick={() => void handleExport()}>
                {exporting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1 h-3.5 w-3.5" />}
                CSV
              </Button>
              <Button
                size="sm"
                className="h-8 text-[11px]"
                disabled={exportingPdf || !projection}
                onClick={() => void handleExportPdf()}
              >
                {exportingPdf ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <FileText className="mr-1 h-3.5 w-3.5" />}
                Export PDF
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 p-3 pt-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') patch({ search: searchInput }); }}
                onBlur={() => patch({ search: searchInput })}
                placeholder="Tenant, phone, agent, landlord, house, location…"
                className="h-8 w-[260px] pl-7 text-[11px]"
              />
            </div>
            <OptionSelect label="Region" value={filters.region ?? ''} options={options?.regions ?? []} onChange={setRegion} />
            <OptionSelect label="District" value={filters.districtId ? String(filters.districtId) : ''} options={options?.districts ?? []} onChange={setDistrict} />
            <OptionSelect label="County" value={filters.countyId ? String(filters.countyId) : ''} options={options?.counties ?? []} onChange={setCounty} />
            <OptionSelect label="Sub-county" value={filters.subcountyId ? String(filters.subcountyId) : ''} options={options?.subcounties ?? []} onChange={setSubcounty} />
            <OptionSelect label="Parish" value={filters.parishId ? String(filters.parishId) : ''} options={options?.parishes ?? []} onChange={setParish} />
            <OptionSelect label="Village" value={filters.villageId ? String(filters.villageId) : ''} options={options?.villages ?? []} onChange={setVillage} />
            <OptionSelect label="Agent" value={filters.agentId ?? ''} options={options?.agents ?? []} onChange={(v) => patch({ agentId: v })} />
            <OptionSelect label="Landlord" value={filters.landlordId ?? ''} options={options?.landlords ?? []} onChange={(v) => patch({ landlordId: v })} />
            <OptionSelect label="House" value={filters.houseId ?? ''} options={options?.houses ?? []} onChange={(v) => patch({ houseId: v })} />
            <Button
              size="sm"
              variant={filters.unmapped ? 'default' : 'outline'}
              className="h-8 text-[11px]"
              onClick={() => patch({ unmapped: filters.unmapped ? null : true })}
            >
              <MapPinOff className="mr-1 h-3.5 w-3.5" />
              Unmapped {options ? `(${Number(options.unmapped_plans || 0).toLocaleString()})` : ''}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-[11px]"
              onClick={() => { setSearchInput(''); setPage(0); setFilters(emptyTpspFilters); }}
            >
              Clear filters
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            {projection?.basis || 'Active tenant plans normalised to a 30-day month and assumed to continue across the horizon.'}{' '}
            Landlord cost is the agreed rent; tenant rent is the full plan obligation. Legacy locations that cannot be matched to the approved dataset stay under Unmapped.
          </p>
        </CardContent>
      </Card>

      {projectionQuery.isLoading ? (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-[78px] rounded-xl" />)}
        </div>
      ) : projectionQuery.error ? (
        <Card className="border-destructive/30">
          <CardContent className="p-4 text-sm text-destructive">
            {(projectionQuery.error as Error)?.message || 'Could not load projections.'}
          </CardContent>
        </Card>
      ) : summary ? (
        <>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
            <KpiTile label="Tenant rent / month" value={ugx(summary.monthly_tenant_rent)} hint="Expected from active tenants" tone="text-emerald-600" />
            <KpiTile label="Landlord rent / month" value={ugx(summary.monthly_landlord_cost)} hint="Payable to landlords" tone="text-amber-600" />
            <KpiTile label="Margin / month" value={ugx(summary.monthly_margin)} hint="Tenant rent less landlord rent" />
            <KpiTile label="Occupied houses" value={Number(summary.plans).toLocaleString()} hint={`${Number(summary.tenants).toLocaleString()} active tenants`} />
            <KpiTile label="12-month tenant rent" value={ugx(summary.horizon_tenant_rent)} tone="text-emerald-600" />
            <KpiTile label="12-month landlord rent" value={ugx(summary.horizon_landlord_cost)} tone="text-amber-600" />
            <KpiTile label="12-month margin" value={ugx(summary.horizon_margin)} />
            <KpiTile label="Landlords / agents" value={`${Number(summary.landlords).toLocaleString()} / ${Number(summary.agents).toLocaleString()}`} hint={`${Number(summary.unmapped_plans).toLocaleString()} unmapped`} />
          </div>

          <Card>
            <CardHeader className="p-3 pb-1">
              <CardTitle className="text-xs font-bold">
                Projection by {grain === 'month' ? 'month' : grain === 'quarter' ? 'quarter' : 'year'}
              </CardTitle>
            </CardHeader>
            <CardContent className="h-[280px] p-3 pt-0">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis tickFormatter={compact} tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v: number | string) => ugx(v)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar name="Tenant rent" dataKey="tenant" fill="#10b981" radius={[3, 3, 0, 0]} />
                  <Bar name="Landlord rent" dataKey="landlord" fill="#f59e0b" radius={[3, 3, 0, 0]} />
                  <Line name="Margin" type="monotone" dataKey="margin" stroke="#7c3aed" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-3 pb-1">
              <CardTitle className="text-xs font-bold">
                Monthly projection by {projection?.breakdown[0]?.level ?? 'region'}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="max-h-[320px] overflow-auto">
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-muted/60">
                    <tr className="text-left">
                      <th className="px-3 py-2 font-semibold capitalize">{projection?.breakdown[0]?.level ?? 'Region'}</th>
                      <th className="px-3 py-2 text-right font-semibold">Houses</th>
                      <th className="px-3 py-2 text-right font-semibold">Tenant rent</th>
                      <th className="px-3 py-2 text-right font-semibold">Landlord rent</th>
                      <th className="px-3 py-2 text-right font-semibold">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(projection?.breakdown || []).map((b) => (
                      <tr key={`${b.level}-${b.label}`} className="border-t">
                        <td className="px-3 py-1.5">{b.label}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{Number(b.plans).toLocaleString()}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-emerald-600">{ugx(b.monthly_tenant_rent)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-amber-600">{ugx(b.monthly_landlord_cost)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{ugx(b.monthly_margin)}</td>
                      </tr>
                    ))}
                    {!projection?.breakdown.length && (
                      <tr><td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">No active plans match these filters.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}

      <Card>
        <CardHeader className="p-3 pb-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-1.5 text-xs font-bold">
              <Building2 className="h-3.5 w-3.5" />
              House-level projection
              <Badge variant="secondary" className="text-[10px]">{totalRows.toLocaleString()}</Badge>
            </CardTitle>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="outline" className="h-7 px-2" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="text-[11px] text-muted-foreground">Page {page + 1} of {pageCount}</span>
              <Button size="sm" variant="outline" className="h-7 px-2" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {rowsQuery.isLoading ? (
            <div className="space-y-1.5 p-3">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8 rounded" />)}
            </div>
          ) : (
            <div className="overflow-auto">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-muted/60">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-semibold">Tenant</th>
                    <th className="px-3 py-2 font-semibold">House</th>
                    <th className="px-3 py-2 font-semibold">Location</th>
                    <th className="px-3 py-2 font-semibold">Agent</th>
                    <th className="px-3 py-2 font-semibold">Landlord</th>
                    <th className="px-3 py-2 text-right font-semibold">Tenant / month</th>
                    <th className="px-3 py-2 text-right font-semibold">Landlord / month</th>
                    <th className="px-3 py-2 text-right font-semibold">12-month rent</th>
                  </tr>
                </thead>
                <tbody>
                  {(rowsQuery.data?.rows || []).map((r) => (
                    <tr key={r.plan_id} className="border-t">
                      <td className="px-3 py-1.5">
                        <div className="font-medium">{r.tenant_name}</div>
                        <div className="text-[10px] text-muted-foreground">{r.tenant_phone || '—'}</div>
                      </td>
                      <td className="px-3 py-1.5">{r.house_label || '—'}</td>
                      <td className="px-3 py-1.5">
                        <span className={cn(r.unmapped && 'text-muted-foreground italic')}>{r.location_label || '—'}</span>
                        {r.unmapped && <Badge variant="outline" className="ml-1 text-[9px]">Unmapped</Badge>}
                      </td>
                      <td className="px-3 py-1.5">{r.agent_name || '—'}</td>
                      <td className="px-3 py-1.5">{r.landlord_name || '—'}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-emerald-600">{ugx(r.monthly_tenant_rent)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-amber-600">{ugx(r.monthly_landlord_cost)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{ugx(r.horizon_tenant_rent)}</td>
                    </tr>
                  ))}
                  {!rowsQuery.data?.rows.length && (
                    <tr><td colSpan={8} className="px-3 py-4 text-center text-muted-foreground">No active tenant plans match these filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default TenantProductsProjections;
