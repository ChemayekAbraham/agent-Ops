/**
 * Tenant Ops -> Classic -> Awareness Calls.
 *
 * Monitors the awareness calls staff record at each stage of the rent pipeline (what tenants, landlords and agents knew about the
 * 30M access and merchant-code self-payment, and whether it was explained). Every figure comes from the awareness_calls_* reports,
 * worked out in SQL on Kampala days; this page only filters, lays out and exports. The date picker is the one Tenant Ops Home uses.
 */
import { useCallback, useMemo, useState } from 'react';
import type { DateRange } from 'react-day-picker';
import { subDays } from 'date-fns';
import { ShieldAlert } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { resolveRange, type PresetKey } from '@/components/executive/shared/OpsDateRangeFilter';
import { WorkspaceEmptyState } from '@/components/executive/tenant-ops/workspace/WorkspaceEmptyState';
import {
  EMPTY_AWARENESS_FILTERS, useAwarenessByCaller, useAwarenessByTeam, useAwarenessGaps, useAwarenessOptions, useAwarenessSummary,
  type AwarenessFilters,
} from '@/hooks/useAwarenessMonitoring';
import { AwarenessFilterBar } from './AwarenessFilterBar';
import { OverviewTab } from './OverviewTab';
import { StageTeamTab } from './StageTeamTab';
import { CallerTab } from './CallerTab';
import { GapsTab } from './GapsTab';
import { LogTab } from './LogTab';

const TAB_TRIGGER =
  'h-9 shrink-0 whitespace-nowrap rounded-lg px-2.5 text-xs font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm';

/** The page opens on the last 7 days (today and the six days before). */
const lastSevenDays = (): DateRange => ({ from: subDays(new Date(), 6), to: new Date() });

export default function AwarenessCallsPage() {
  const [preset, setPreset] = useState<PresetKey>('custom');
  const [custom, setCustom] = useState<DateRange | undefined>(lastSevenDays);
  const [tab, setTab] = useState('overview');
  const [rest, setRest] = useState<Omit<AwarenessFilters, 'startIso' | 'endIso'>>({ ...EMPTY_AWARENESS_FILTERS });

  const { start, end } = useMemo(() => resolveRange(preset, custom), [preset, custom]);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const filters: AwarenessFilters = useMemo(() => ({ startIso, endIso, ...rest }), [startIso, endIso, rest]);

  const onChange = useCallback((patch: Partial<AwarenessFilters>) => {
    const { startIso: _s, endIso: _e, ...others } = patch;
    setRest((prev) => ({ ...prev, ...others }));
  }, []);
  const onClear = useCallback(() => setRest({ ...EMPTY_AWARENESS_FILTERS }), []);

  const options = useAwarenessOptions();
  const summary = useAwarenessSummary(filters);
  const byTeam = useAwarenessByTeam(filters);
  const byCaller = useAwarenessByCaller(filters, tab === 'caller');
  // The by-stage table and the "stages without a call" card only need the totals, not a page of rows.
  const stages = useAwarenessGaps(filters, { limit: 1, offset: 0 });

  const denied = [summary.error, options.error].some((e) => /not authori[sz]ed/i.test((e as { message?: string } | null)?.message ?? ''));

  if (denied) {
    return (
      <Card>
        <CardContent className="py-10">
          <WorkspaceEmptyState
            icon={ShieldAlert}
            title="Not available"
            hint="Awareness call monitoring is only available to Tenant Ops, COO, CEO and super admin users."
            tone="destructive"
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="min-w-0">
        <h3 className="text-base font-bold tracking-tight">Awareness Calls</h3>
        <p className="text-xs text-muted-foreground">
          Do tenants, landlords and agents know about 30M access and merchant-code self-payment? Calls staff record at each stage of the rent pipeline,
          and the Rent Plans that moved on without one.
        </p>
      </div>

      <AwarenessFilterBar
        preset={preset}
        custom={custom}
        onPresetChange={setPreset}
        onCustomChange={setCustom}
        filters={filters}
        options={options.data}
        onChange={onChange}
        onClear={onClear}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1.5 rounded-xl border border-border bg-muted/30 p-1.5">
          <TabsTrigger value="overview" className={TAB_TRIGGER}>Overview</TabsTrigger>
          <TabsTrigger value="stage-team" className={TAB_TRIGGER}>By stage / team</TabsTrigger>
          <TabsTrigger value="caller" className={TAB_TRIGGER}>By caller</TabsTrigger>
          <TabsTrigger value="gaps" className={TAB_TRIGGER}>Requests without a call</TabsTrigger>
          <TabsTrigger value="log" className={TAB_TRIGGER}>Call log</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-3">
          <OverviewTab summary={summary.data} gaps={stages.data} loading={summary.isLoading} />
        </TabsContent>
        <TabsContent value="stage-team" className="mt-3">
          <StageTeamTab byTeam={byTeam.data} gaps={stages.data} loadingTeam={byTeam.isLoading} loadingStage={stages.isLoading} />
        </TabsContent>
        <TabsContent value="caller" className="mt-3">
          <CallerTab data={byCaller.data} loading={byCaller.isLoading} />
        </TabsContent>
        <TabsContent value="gaps" className="mt-3">
          <GapsTab filters={filters} enabled={tab === 'gaps'} />
        </TabsContent>
        <TabsContent value="log" className="mt-3">
          <LogTab filters={filters} options={options.data} enabled={tab === 'log'} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
