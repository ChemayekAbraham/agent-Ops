import { useMemo, useState } from 'react';
import { ArrowRight, Search, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  usePaymentBehaviorBy, type DimensionRow, type PaymentBehaviorDimension, type PaymentBehaviorFilters,
} from '@/hooks/tenantOpsWorkspace/usePaymentBehavior';
import { WorkspaceEmptyState } from '@/components/executive/tenant-ops/workspace/WorkspaceEmptyState';
import { WorkspaceMobileRow } from '@/components/executive/tenant-ops/workspace/WorkspaceMobileRow';
import { DIMENSION_LABEL, SELF_COLOR, num, pct, ugx } from './labels';
import { ChartSkeleton, ObservedBadge, PctBar, SectionCard } from './shared';
import { cn } from '@/lib/utils';

type SortKey = 'paying_tenants' | 'self_payers' | 'self_payers_pct' | 'self_share_pct' | 'coverage_pct' | 'short_ugx';

const SORTS: { value: SortKey; label: string }[] = [
  { value: 'paying_tenants', label: 'Paying tenants' },
  { value: 'self_payers', label: 'Self-paying tenants' },
  { value: 'self_payers_pct', label: '% self-paying' },
  { value: 'self_share_pct', label: 'Self share of money' },
  { value: 'coverage_pct', label: 'Bill covered' },
  { value: 'short_ugx', label: 'Shortfall' },
];

const DIMENSIONS: PaymentBehaviorDimension[] = ['agent', 'region', 'district', 'rent_band', 'cadence', 'cohort'];
const ORDERED_BY_KEY: PaymentBehaviorDimension[] = ['rent_band', 'cadence', 'cohort'];
const DRILLABLE: PaymentBehaviorDimension[] = ['agent', 'region', 'district', 'cadence'];

export function BreakdownSection({
  filters, onDrill,
}: { filters: PaymentBehaviorFilters; onDrill: (dimension: PaymentBehaviorDimension, key: string) => void }) {
  const [dimension, setDimension] = useState<PaymentBehaviorDimension>('agent');
  const [sort, setSort] = useState<SortKey>('paying_tenants');
  const [search, setSearch] = useState('');
  const { data, isLoading, isError } = usePaymentBehaviorBy(filters, dimension);

  const rows = useMemo(() => {
    let r = data ?? [];
    if (search.trim()) r = r.filter((x) => x.label.toLowerCase().includes(search.trim().toLowerCase()));
    if (ORDERED_BY_KEY.includes(dimension) && sort === 'paying_tenants') return r;
    return [...r].sort((a, b) => Number(b[sort] ?? -1) - Number(a[sort] ?? -1));
  }, [data, search, sort, dimension]);

  const drillable = DRILLABLE.includes(dimension);

  return (
    <SectionCard
      title="Self-pay versus agent-pay breakdown"
      description="Choose a cut. Tap a row's arrow to narrow the whole tab to that agent, place or frequency."
      badge={<ObservedBadge />}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Breakdown by">
          {DIMENSIONS.map((d) => (
            <Button
              key={d} type="button" size="sm" role="tab" aria-selected={dimension === d}
              variant={dimension === d ? 'default' : 'outline'} className="h-9 text-xs"
              onClick={() => { setDimension(d); setSearch(''); }}
            >
              {DIMENSION_LABEL[d]}
            </Button>
          ))}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${DIMENSION_LABEL[dimension].toLowerCase()}`} aria-label="Search the breakdown" className="pl-9" />
          </div>
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="h-10 w-full text-xs sm:w-52" aria-label="Sort breakdown by"><SelectValue /></SelectTrigger>
            <SelectContent>{SORTS.map((o) => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <ChartSkeleton h={220} />
        ) : isError ? (
          <WorkspaceEmptyState icon={Users} tone="destructive" title="Could not load the breakdown" hint="Check your connection and try again." />
        ) : rows.length === 0 ? (
          <WorkspaceEmptyState icon={Users} title="Nothing to show" hint="No Rent Plans were billed or paid in this selection." />
        ) : (
          <>
            {/* Phones and narrow screens: stacked rows */}
            <div className="space-y-2 xl:hidden">
              {rows.slice(0, 100).map((r) => (
                <WorkspaceMobileRow
                  key={r.key}
                  title={r.label}
                  badge={<span className="text-sm font-bold tabular-nums text-primary">{pct(r.self_payers_pct)}</span>}
                  fields={[
                    { label: 'Paying tenants', value: num(r.paying_tenants) },
                    { label: 'Self-paying', value: num(r.self_payers) },
                    { label: 'Self share of money', value: pct(r.self_share_pct) },
                    { label: 'Bill covered', value: pct(r.coverage_pct) },
                    { label: 'Self-payers covered', value: pct(r.self_payers_coverage_pct) },
                    { label: 'Agent-only covered', value: pct(r.agent_only_coverage_pct) },
                    { label: 'Short', value: ugx(r.short_ugx), full: true },
                  ]}
                  actions={drillable ? (
                    <Button type="button" variant="outline" size="sm" className="h-10 w-full gap-2 text-xs font-semibold" onClick={() => onDrill(dimension, r.key)}>
                      Focus on {r.label} <ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                  ) : undefined}
                />
              ))}
            </div>

            <div className="hidden overflow-hidden rounded-lg border xl:block">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">{DIMENSION_LABEL[dimension]}</th>
                    <th className="px-3 py-2 text-right">Paying tenants</th>
                    <th className="px-3 py-2 text-right">Self-paying</th>
                    <th className="px-3 py-2 text-right">% self-paying</th>
                    <th className="px-3 py-2 w-40">Self share of money</th>
                    <th className="px-3 py-2 text-right">Bill covered</th>
                    <th className="px-3 py-2 text-right">Self vs agent-only covered</th>
                    <th className="px-3 py-2 text-right">Short</th>
                    {drillable && <th className="px-3 py-2"><span className="sr-only">Focus</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 200).map((r: DimensionRow) => (
                    <tr key={r.key} className="border-t hover:bg-muted/30">
                      <td className="px-3 py-2 font-medium">{r.label}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(r.paying_tenants)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(r.self_payers)}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{pct(r.self_payers_pct)}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <PctBar value={r.self_share_pct} color={SELF_COLOR} label={`${r.label} self share ${pct(r.self_share_pct)}`} />
                          <span className="w-12 shrink-0 text-right tabular-nums">{pct(r.self_share_pct)}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{pct(r.coverage_pct)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{pct(r.self_payers_coverage_pct)} / {pct(r.agent_only_coverage_pct)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{ugx(r.short_ugx)}</td>
                      {drillable && (
                        <td className="px-2 py-2 text-right">
                          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={`Focus on ${r.label}`} onClick={() => onDrill(dimension, r.key)}>
                            <ArrowRight className={cn('h-4 w-4')} />
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > 100 && <p className="text-center text-[11px] text-muted-foreground">Showing the first 100 of {num(rows.length)}. Narrow the filters or search to see the rest.</p>}
            <p className="text-[11px] text-muted-foreground">
              Self vs agent-only covered compares the bill coverage of tenants who paid themselves with tenants paid for only by agents within the same row. Small groups swing widely.
            </p>
          </>
        )}
      </div>
    </SectionCard>
  );
}
