import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import { AlertTriangle, ArrowUpDown, Home, Wand2 } from 'lucide-react';
import type { HouseOpportunity } from '@/components/agent/EmptyHouseDetailSheet';
import { houseAddressLine, houseTitleLine } from '@/components/partner/SelfSupportHousesSection';

/**
 * Optional plan matcher for a promissory note.
 *
 * Lists BOTH ready-to-fund tenant rent plans and verified empty houses. Empty
 * houses are shown first by default; the agent can flip the ordering to rent
 * plans first. A note attaches one kind only (the server keeps them in
 * separate earmark tables), so picking a house clears rent-plan selections
 * and vice versa.
 *
 * All data comes from two server calls (`agent_list_promissory_fundable_plans`
 * and `agent_list_empty_house_opportunities`): plans already earmarked by
 * another note and houses already reserved are excluded server-side.
 */

export interface FundablePlanRow {
  rent_request_id: string;
  funding_amount: number;
  daily_repayment: number | null;
  duration_days: number | null;
  house_category: string | null;
  request_city: string | null;
  tenant_full_name: string | null;
  tenant_location: string | null;
  landlord_name: string | null;
}

interface PlansPayload {
  plans: FundablePlanRow[];
  total: number;
  available_pool: number;
}

interface HousesPayload {
  houses: HouseOpportunity[];
  total: number;
}

export function PromissoryPlanMatcher({
  targetAmount,
  selectedIds,
  onChange,
  selectedHouseIds,
  onHousesChange,
  preselectedHouse,
  disabled,
  onSelectedTotalChange,
}: {
  targetAmount: number;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  selectedHouseIds: string[];
  onHousesChange: (ids: string[]) => void;
  /** A house the agent came from (e.g. Create & Share) — pinned and pre-selected. */
  preselectedHouse?: HouseOpportunity | null;
  disabled?: boolean;
  onSelectedTotalChange?: (total: number) => void;
}) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sortMode, setSortMode] = useState<'houses' | 'plans'>('houses');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['promissory-fundable-plans', debounced],
    queryFn: async (): Promise<PlansPayload> => {
      const { data, error } = await supabase.rpc('agent_list_promissory_fundable_plans', {
        p_limit: 60,
        p_offset: 0,
        p_search: debounced || null,
        p_max_amount: null,
      });
      if (error) throw error;
      const payload = (data ?? {}) as unknown as PlansPayload;
      return {
        plans: Array.isArray(payload.plans) ? payload.plans : [],
        total: Number(payload.total || 0),
        available_pool: Number(payload.available_pool || 0),
      };
    },
  });

  const { data: housesData, isLoading: housesLoading } = useQuery({
    queryKey: ['promissory-fundable-houses', debounced],
    queryFn: async (): Promise<HousesPayload> => {
      const { data, error } = await supabase.rpc('agent_list_empty_house_opportunities', {
        p_search: debounced || null,
        p_limit: 60,
        p_offset: 0,
        p_district: null,
        p_verified_only: true,
        p_gps_only: true,
        p_min_rent: null,
        p_max_rent: null,
        p_near_lat: null,
        p_near_lng: null,
        p_radius_km: null,
        p_sort: 'newest',
      });
      if (error) throw error;
      const payload = (data ?? {}) as unknown as HousesPayload;
      return {
        houses: (Array.isArray(payload.houses) ? payload.houses : []).filter(
          (h) => h.verified === true && Number(h.monthly_rent) > 0,
        ),
        total: Number(payload.total || 0),
      };
    },
  });

  const plans = data?.plans ?? [];
  const pool = data?.available_pool ?? 0;

  const houses = useMemo(() => {
    const list = housesData?.houses ?? [];
    // Keep the house the agent tapped on visible even when it falls outside
    // the current page/search — it stays pinned at the top.
    if (
      preselectedHouse &&
      selectedHouseIds.includes(preselectedHouse.house_id) &&
      !list.some((h) => h.house_id === preselectedHouse.house_id)
    ) {
      return [preselectedHouse, ...list];
    }
    return list;
  }, [housesData, preselectedHouse, selectedHouseIds]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedHouseSet = useMemo(() => new Set(selectedHouseIds), [selectedHouseIds]);

  const plansTotal = useMemo(
    () =>
      plans
        .filter((p) => selectedSet.has(p.rent_request_id))
        .reduce((s, p) => s + Number(p.funding_amount || 0), 0),
    [plans, selectedSet],
  );
  const housesTotal = useMemo(
    () =>
      houses
        .filter((h) => selectedHouseSet.has(h.house_id))
        .reduce((s, h) => s + Number(h.monthly_rent || 0), 0),
    [houses, selectedHouseSet],
  );
  const selectedTotal = plansTotal + housesTotal;
  const remaining = Math.max(0, targetAmount - selectedTotal);
  const shortfall = targetAmount > 0 && pool < targetAmount && houses.length === 0;

  // Lets the parent mirror the earmarked total into the promised amount while
  // the agent has not typed one manually.
  useEffect(() => {
    onSelectedTotalChange?.(selectedTotal);
  }, [selectedTotal, onSelectedTotalChange]);

  /** A note attaches one kind only — selecting across kinds replaces. */
  const togglePlan = useCallback(
    (plan: FundablePlanRow) => {
      if (disabled) return;
      const id = plan.rent_request_id;
      if (selectedSet.has(id)) {
        onChange(selectedIds.filter((x) => x !== id));
        return;
      }
      if (targetAmount > 0 && plansTotal + Number(plan.funding_amount || 0) > targetAmount) return;
      if (selectedHouseIds.length > 0) onHousesChange([]);
      onChange([...selectedIds, id]);
    },
    [disabled, onChange, onHousesChange, selectedIds, selectedSet, selectedHouseIds, plansTotal, targetAmount],
  );

  const toggleHouse = useCallback(
    (house: HouseOpportunity) => {
      if (disabled) return;
      const id = house.house_id;
      if (selectedHouseSet.has(id)) {
        onHousesChange(selectedHouseIds.filter((x) => x !== id));
        return;
      }
      if (targetAmount > 0 && housesTotal + Number(house.monthly_rent || 0) > targetAmount) return;
      if (selectedIds.length > 0) onChange([]);
      onHousesChange([...selectedHouseIds, id]);
    },
    [disabled, onChange, onHousesChange, selectedHouseIds, selectedHouseSet, selectedIds, housesTotal, targetAmount],
  );

  /** Greedy fill: largest entries first, never crossing the promised amount.
   *  Fills from whichever kind (houses or rent plans) gets closest. */
  const autoFill = useCallback(() => {
    if (disabled || targetAmount <= 0) return;
    const greedy = (amounts: { id: string; amt: number }[]) => {
      let budget = targetAmount;
      const picked: string[] = [];
      [...amounts]
        .sort((a, b) => b.amt - a.amt)
        .forEach((p) => {
          if (p.amt > 0 && p.amt <= budget) {
            picked.push(p.id);
            budget -= p.amt;
          }
        });
      return { picked, total: targetAmount - budget };
    };
    const fromPlans = greedy(plans.map((p) => ({ id: p.rent_request_id, amt: Number(p.funding_amount || 0) })));
    const fromHouses = greedy(houses.map((h) => ({ id: h.house_id, amt: Number(h.monthly_rent || 0) })));
    if (fromHouses.total >= fromPlans.total) {
      onChange([]);
      onHousesChange(fromHouses.picked);
    } else {
      onHousesChange([]);
      onChange(fromPlans.picked);
    }
  }, [disabled, onChange, onHousesChange, plans, houses, targetAmount]);

  const anythingLoading = isLoading || housesLoading;
  const nothingFound = !anythingLoading && plans.length === 0 && houses.length === 0;

  const renderPlan = (p: FundablePlanRow) => {
    const checked = selectedSet.has(p.rent_request_id);
    const amt = Number(p.funding_amount || 0);
    const blocked = !checked && targetAmount > 0 && selectedTotal + amt > targetAmount;
    return (
      <button
        type="button"
        key={`plan-${p.rent_request_id}`}
        onClick={() => togglePlan(p)}
        disabled={disabled || blocked}
        aria-pressed={checked}
        className={`w-full text-left rounded-lg border p-2 transition-colors ${
          checked ? 'border-primary bg-primary/5' : 'border-border'
        } ${blocked ? 'opacity-45' : ''}`}
      >
        <div className="flex items-start gap-2">
          <Checkbox checked={checked} className="mt-0.5 pointer-events-none" tabIndex={-1} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold truncate">{p.tenant_full_name || 'Tenant'}</p>
              <span className="text-xs font-bold text-primary shrink-0">{formatUGX(amt)}</span>
            </div>
            <p className="text-[10px] text-muted-foreground truncate flex items-center gap-1">
              <Home className="h-3 w-3 shrink-0" />
              {p.tenant_location || p.request_city || 'Location not recorded'}
            </p>
            <div className="flex items-center gap-1 mt-0.5">
              <Badge variant="outline" className="text-[9px] px-1 py-0">Rent plan</Badge>
              {p.house_category && (
                <Badge variant="secondary" className="text-[9px] px-1 py-0">
                  {p.house_category}
                </Badge>
              )}
              {p.duration_days ? (
                <Badge variant="outline" className="text-[9px] px-1 py-0">
                  {p.duration_days} days
                </Badge>
              ) : null}
            </div>
          </div>
        </div>
      </button>
    );
  };

  const renderHouse = (h: HouseOpportunity) => {
    const checked = selectedHouseSet.has(h.house_id);
    const amt = Number(h.monthly_rent || 0);
    const blocked = !checked && targetAmount > 0 && selectedTotal + amt > targetAmount;
    return (
      <button
        type="button"
        key={`house-${h.house_id}`}
        onClick={() => toggleHouse(h)}
        disabled={disabled || blocked}
        aria-pressed={checked}
        className={`w-full text-left rounded-lg border p-2 transition-colors ${
          checked ? 'border-primary bg-primary/5' : 'border-border'
        } ${blocked ? 'opacity-45' : ''}`}
      >
        <div className="flex items-start gap-2">
          <Checkbox checked={checked} className="mt-0.5 pointer-events-none" tabIndex={-1} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold truncate">{houseTitleLine(h)}</p>
              <span className="text-xs font-bold text-primary shrink-0">{formatUGX(amt)}</span>
            </div>
            <p className="text-[10px] text-muted-foreground truncate flex items-center gap-1">
              <Home className="h-3 w-3 shrink-0" />
              {houseAddressLine(h)}
            </p>
            <div className="flex items-center gap-1 mt-0.5">
              <Badge className="text-[9px] px-1 py-0">Empty house</Badge>
              {h.house_category && (
                <Badge variant="secondary" className="text-[9px] px-1 py-0">
                  {h.house_category}
                </Badge>
              )}
              {h.number_of_rooms ? (
                <Badge variant="outline" className="text-[9px] px-1 py-0">
                  {h.number_of_rooms} room{h.number_of_rooms === 1 ? '' : 's'}
                </Badge>
              ) : null}
            </div>
          </div>
        </div>
      </button>
    );
  };

  const ordered =
    sortMode === 'houses'
      ? [...houses.map(renderHouse), ...plans.map(renderPlan)]
      : [...plans.map(renderPlan), ...houses.map(renderHouse)];

  return (
    <div className="rounded-xl border border-border p-3 space-y-2.5">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold">
            Empty houses &amp; rent plans{' '}
            {data || housesData ? `(${(housesData?.houses.length ?? 0) + (data?.total ?? 0)})` : ''}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Pick what this partner will fund — the promised amount fills in from your selection. A
            note attaches either houses or rent plans; picking one replaces the other.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-[11px] shrink-0 self-start"
          onClick={autoFill}
          disabled={disabled || anythingLoading || targetAmount <= 0 || (plans.length === 0 && houses.length === 0)}
        >
          <Wand2 className="h-3 w-3" /> Match amount
        </Button>
      </div>

      {isError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
          {(error as Error)?.message || 'Could not load ready-to-fund plans.'}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: 'Pool available', value: formatUGX(pool) },
              { label: 'Earmarked', value: formatUGX(selectedTotal) },
              { label: targetAmount > 0 ? 'Unallocated' : 'Promised', value: targetAmount > 0 ? formatUGX(remaining) : formatUGX(selectedTotal) },
            ].map((f) => (
              <div key={f.label} className="rounded-lg bg-muted/40 px-2 py-1.5 min-w-0">
                <p className="text-[9px] uppercase tracking-wide font-semibold text-muted-foreground truncate">
                  {f.label}
                </p>
                <p className="text-[11px] font-bold mt-0.5 truncate">{f.value}</p>
              </div>
            ))}
          </div>

          {shortfall && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-2 py-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-[10px] text-amber-700">
                Ready-to-fund plans total {formatUGX(pool)} — less than the promised amount. Attach what
                fits, or create the note on its own.
              </p>
            </div>
          )}

          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search house, tenant, city or landlord"
              className="h-8 text-xs flex-1 w-full"
              disabled={disabled}
            />
            <div className="flex items-center rounded-lg border border-border overflow-hidden shrink-0 w-full sm:w-auto">
              {(
                [
                  { key: 'houses', label: 'Houses first' },
                  { key: 'plans', label: 'Plans first' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setSortMode(opt.key)}
                  className={`px-2 h-8 text-[10px] font-semibold flex items-center justify-center gap-1 flex-1 sm:flex-none transition-colors ${
                    sortMode === opt.key
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <ArrowUpDown className="h-3 w-3" />
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="max-h-56 overflow-y-auto space-y-1.5 pr-0.5">
            {anythingLoading ? (
              <>
                <Skeleton className="h-12 w-full rounded-lg" />
                <Skeleton className="h-12 w-full rounded-lg" />
              </>
            ) : nothingFound ? (
              <p className="text-[11px] text-muted-foreground py-2">
                No empty houses or ready-to-fund plans available right now. Create the note on its own.
              </p>
            ) : (
              ordered
            )}
          </div>
        </>
      )}
    </div>
  );
}
