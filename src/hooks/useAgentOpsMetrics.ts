import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  METRICS_PAGE_SIZE,
  normalizeAgents,
  normalizeLocations,
  normalizeMainAgents,
  normalizePins,
  normalizeTotals,
  type MetricsScope,
} from '@/lib/agentMetrics';

// Read-only hooks over the five agent_ops_metrics_* functions. The server decides every figure; these only fetch and type them.
// supabase.rpc is always called on the client itself (a detached reference loses `this`).

const STALE = 60_000;

const shape = (q: { error: unknown; isLoading: boolean; isFetching: boolean; isPlaceholderData?: boolean; dataUpdatedAt: number; refetch: () => unknown }) => ({
  error: q.error ?? null,
  isLoading: q.isLoading,
  isFetching: q.isFetching,
  isStale: q.isPlaceholderData === true,
  updatedAt: q.dataUpdatedAt,
  refetch: () => { void q.refetch(); },
});

export function useMetricsTotals(from: string, to: string) {
  const q = useQuery({
    queryKey: ['agent-ops-metrics', 'totals', from, to],
    enabled: !!from && !!to,
    staleTime: STALE,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_ops_metrics_totals', { p_start: from, p_end: to });
      if (error) throw error;
      return normalizeTotals(data);
    },
  });
  return { data: q.data ?? null, ...shape(q) };
}

/** Search text that only settles after `ms` without typing. */
export function useDebouncedValue<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useMetricsAgents(args: { from: string; to: string; search: string; sort: string; scope: MetricsScope; page: number }, enabled = true) {
  const search = useDebouncedValue(args.search.trim(), 300);
  const q = useQuery({
    queryKey: ['agent-ops-metrics', 'agents', args.from, args.to, search, args.sort, args.scope, args.page],
    enabled: enabled && !!args.from && !!args.to,
    staleTime: STALE,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_ops_metrics_agents', {
        p_start: args.from, p_end: args.to, p_search: search || undefined, p_sort: args.sort, p_scope: args.scope,
        p_limit: METRICS_PAGE_SIZE, p_offset: args.page * METRICS_PAGE_SIZE,
      });
      if (error) throw error;
      return normalizeAgents(data);
    },
  });
  const rows = q.data ?? [];
  return { rows, total: rows[0]?.total_matched ?? 0, debouncing: search !== args.search.trim(), ...shape(q) };
}

export type LocationLevel = 'region' | 'district' | 'sub_county';

export function useMetricsLocations(from: string, to: string, level: LocationLevel, enabled = true) {
  const q = useQuery({
    queryKey: ['agent-ops-metrics', 'locations', from, to, level],
    enabled: enabled && !!from && !!to,
    staleTime: STALE,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_ops_metrics_locations', { p_start: from, p_end: to, p_level: level });
      if (error) throw error;
      return normalizeLocations(data);
    },
  });
  return { rows: q.data ?? [], ...shape(q) };
}

export interface MapBox { minLat: number; minLng: number; maxLat: number; maxLng: number }

export function useMetricsPins(box: MapBox, enabled: boolean, limit = 500) {
  const r = (n: number) => Math.round(n * 100) / 100;
  const key = [r(box.minLat), r(box.minLng), r(box.maxLat), r(box.maxLng)];
  const q = useQuery({
    queryKey: ['agent-ops-metrics', 'pins', ...key, limit],
    enabled,
    staleTime: STALE,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_ops_metrics_pins', {
        p_min_lat: box.minLat, p_min_lng: box.minLng, p_max_lat: box.maxLat, p_max_lng: box.maxLng, p_limit: limit,
      });
      if (error) throw error;
      return normalizePins(data);
    },
  });
  return { rows: q.data ?? [], ...shape(q) };
}

export function useMetricsMainAgents(from: string, to: string, page: number, enabled = true) {
  const q = useQuery({
    queryKey: ['agent-ops-metrics', 'main-agents', from, to, page],
    enabled: enabled && !!from && !!to,
    staleTime: STALE,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_ops_metrics_main_agents', {
        p_start: from, p_end: to, p_limit: METRICS_PAGE_SIZE, p_offset: page * METRICS_PAGE_SIZE,
      });
      if (error) throw error;
      return normalizeMainAgents(data);
    },
  });
  const rows = q.data ?? [];
  return { rows, total: rows[0]?.total_matched ?? 0, ...shape(q) };
}
