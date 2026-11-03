import { useQueries, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type Row = Record<string, unknown>;
export type FeedState = { rows: Row[]; loading: boolean; error: string | null; updatedAt: number };

type RpcFn = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
// desk_feed is not in the generated Supabase types until they are regenerated after the migration.
const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;

async function loadFeed(feed: string): Promise<Row[]> {
  const { data, error } = await rpc('desk_feed', { p_feed: feed });
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? (data as Row[]) : [];
}

/** One row per pipeline stage, with the throughput figures the flow is drawn from. */
export type StageRow = Row & {
  ord: string;
  stage: string;
  desk: string;
  waiting: number;
  waiting_ugx: number;
  done_24h: number;
  done_7d: number;
  per_day_7d: number;
  days_to_clear: number | null;
  rejected_7d: number;
};

/**
 * The stage flow behind the command centre. The key starts with 'desk-feed' so
 * "Refresh now" — which invalidates that prefix — reloads this too.
 */
export function useStageFlow(): FeedState {
  const r = useQuery({
    queryKey: ['desk-feed', 'stage_flow'],
    queryFn: async (): Promise<Row[]> => {
      const { data, error } = await rpc('desk_stage_flow', {});
      if (error) throw new Error(error.message);
      return Array.isArray(data) ? (data as Row[]) : [];
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    retry: 1,
  });
  return {
    rows: (r.data as Row[] | undefined) ?? [],
    loading: r.isLoading,
    error: r.error ? (r.error as Error).message : null,
    updatedAt: r.dataUpdatedAt,
  };
}

/** Loads every feed a desk needs and refreshes each one every minute while the desk is open. */
export function useDeskFeeds(feeds: string[]): Record<string, FeedState> {
  const results = useQueries({
    queries: feeds.map((feed) => ({
      queryKey: ['desk-feed', feed],
      queryFn: () => loadFeed(feed),
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
      staleTime: 30_000,
      retry: 1,
    })),
  });
  const out: Record<string, FeedState> = {};
  feeds.forEach((feed, i) => {
    const r = results[i];
    out[feed] = {
      rows: (r.data as Row[] | undefined) ?? [],
      loading: r.isLoading,
      error: r.error ? (r.error as Error).message : null,
      updatedAt: r.dataUpdatedAt,
    };
  });
  return out;
}
