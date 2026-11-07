import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { useAuthenticatedAudience, requireUserSession } from '@/hooks/useAuthenticatedPoll';
import { supabase } from '@/integrations/supabase/client';

export const FUNDER_EMPTY_HOUSES_CACHE_MS = 60_000;

export async function readFunderEmptyHousesSwitch(): Promise<boolean> {
  try {
    await requireUserSession();
    const { data, error } = await supabase
      .from('pipeline_switches')
      .select('is_on')
      .eq('key', 'funders_empty_houses')
      .maybeSingle();
    return !error && data?.is_on === true;
  } catch {
    return false;
  }
}

export function useFunderEmptyHousesAllowed(): boolean {
  const { user } = useAuth();
  const signedIn = useAuthenticatedAudience();
  const query = useQuery({
    queryKey: ['funder-empty-houses-switch', user?.id],
    enabled: signedIn,
    queryFn: readFunderEmptyHousesSwitch,
    staleTime: FUNDER_EMPTY_HOUSES_CACHE_MS,
    refetchInterval: FUNDER_EMPTY_HOUSES_CACHE_MS,
    retry: false,
  });
  return signedIn && !query.isError && query.data === true;
}