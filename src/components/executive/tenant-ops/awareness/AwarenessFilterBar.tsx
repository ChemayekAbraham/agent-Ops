import { useMemo } from 'react';
import type { DateRange } from 'react-day-picker';
import { FilterX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { OpsDateRangeFilter, type PresetKey } from '@/components/executive/shared/OpsDateRangeFilter';
import { TEAM_LABEL, TEAM_ORDER, type AwarenessTeam } from '@/lib/awarenessCallLabels';
import {
  ANSWER_FILTER_OPTIONS, RESULT_FILTER_OPTIONS, SUBJECT_FILTER_OPTIONS, statusLabel,
} from '@/lib/awarenessMonitoringLabels';
import type { AwarenessFilters, AwarenessOptions } from '@/hooks/useAwarenessMonitoring';

const ALL = '__all__';

type FilterKey = 'team' | 'caller' | 'subjectType' | 'result' | 'answer' | 'region' | 'district' | 'status';

interface Props {
  preset: PresetKey;
  custom: DateRange | undefined;
  onPresetChange: (p: PresetKey) => void;
  onCustomChange: (r: DateRange | undefined) => void;
  filters: AwarenessFilters;
  options: AwarenessOptions | undefined;
  onChange: (patch: Partial<AwarenessFilters>) => void;
  onClear: () => void;
}

/**
 * The filter bar every tab of the Awareness Calls page shares: the dates (the same picker as Tenant Ops Home), team, caller,
 * person type, call result, answer choice, region, district and the Rent Plan's status now. The "Requests without a call" tab
 * uses the dates, team, region, district and status; the other filters are about a call and have no meaning there.
 */
export function AwarenessFilterBar({ preset, custom, onPresetChange, onCustomChange, filters, options, onChange, onClear }: Props) {
  const districts = useMemo(
    () => (options?.districts ?? []).filter((d) => !filters.region || d.region === filters.region),
    [options, filters.region],
  );
  const active = (['team', 'caller', 'subjectType', 'result', 'answer', 'region', 'district', 'status'] as FilterKey[])
    .filter((k) => filters[k]).length;

  const sel = <K extends FilterKey>(key: K, value: string) =>
    onChange({ [key]: value === ALL ? null : value, ...(key === 'region' ? { district: null } : {}) } as Partial<AwarenessFilters>);

  return (
    <div className="space-y-2" role="group" aria-label="Filters">
      <div className="flex flex-wrap items-center gap-2">
        <OpsDateRangeFilter preset={preset} custom={custom} onPresetChange={onPresetChange} onCustomChange={onCustomChange} />
        <Button type="button" variant="outline" className="h-10 gap-2 text-xs" disabled={active === 0} onClick={onClear}>
          <FilterX className="h-4 w-4" />
          Clear filters{active > 0 ? ` (${active})` : ''}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <Select value={filters.team ?? ALL} onValueChange={(v) => sel('team', v)}>
          <SelectTrigger className="h-10 text-xs" aria-label="Team"><SelectValue placeholder="All teams" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-xs">All teams</SelectItem>
            {TEAM_ORDER.map((t: AwarenessTeam) => <SelectItem key={t} value={t} className="text-xs">{TEAM_LABEL[t]}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={filters.caller ?? ALL} onValueChange={(v) => sel('caller', v)}>
          <SelectTrigger className="h-10 text-xs" aria-label="Caller"><SelectValue placeholder="All callers" /></SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value={ALL} className="text-xs">All callers</SelectItem>
            {(options?.callers ?? []).map((c) => <SelectItem key={c.id} value={c.id} className="text-xs">{c.name}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={filters.subjectType ?? ALL} onValueChange={(v) => sel('subjectType', v)}>
          <SelectTrigger className="h-10 text-xs" aria-label="Person type"><SelectValue placeholder="Any person" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-xs">Any person</SelectItem>
            {SUBJECT_FILTER_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={filters.result ?? ALL} onValueChange={(v) => sel('result', v)}>
          <SelectTrigger className="h-10 text-xs" aria-label="Call result"><SelectValue placeholder="Any result" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-xs">Any result</SelectItem>
            {RESULT_FILTER_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={filters.answer ?? ALL} onValueChange={(v) => sel('answer', v)}>
          <SelectTrigger className="h-10 text-xs" aria-label="Answer choice"><SelectValue placeholder="Any answer" /></SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value={ALL} className="text-xs">Any answer</SelectItem>
            {ANSWER_FILTER_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={filters.region ?? ALL} onValueChange={(v) => sel('region', v)}>
          <SelectTrigger className="h-10 text-xs" aria-label="Region"><SelectValue placeholder="All regions" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-xs">All regions</SelectItem>
            {(options?.regions ?? []).map((r) => <SelectItem key={r} value={r} className="text-xs">{r}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={filters.district ?? ALL} onValueChange={(v) => sel('district', v)}>
          <SelectTrigger className="h-10 text-xs" aria-label="District"><SelectValue placeholder="All districts" /></SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value={ALL} className="text-xs">All districts</SelectItem>
            {districts.map((d) => <SelectItem key={`${d.region}-${d.district}`} value={d.district} className="text-xs">{d.district}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={filters.status ?? ALL} onValueChange={(v) => sel('status', v)}>
          <SelectTrigger className="h-10 text-xs" aria-label="Request status"><SelectValue placeholder="Any request status" /></SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value={ALL} className="text-xs">Any request status</SelectItem>
            {(options?.statuses ?? []).map((s) => <SelectItem key={s} value={s} className="text-xs">{statusLabel(s)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
