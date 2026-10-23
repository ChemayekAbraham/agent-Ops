import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { parseWeeklyPerformance, type WeeklyPerformance } from '@/lib/weeklyPerformance';

/**
 * The signed-in agent's weekly performance (get_my_weekly_performance):
 * the judged week, the week in progress with a full-week projection, the
 * last few weeks, and this week's plans. Read-only.
 */
export function useMyWeeklyPerformance(weeks = 6) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-weekly-performance', user?.id, weeks],
    enabled: !!user?.id,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<WeeklyPerformance> => {
      const { data, error } = await (supabase.rpc as any)('get_my_weekly_performance', { p_weeks: weeks });
      if (error) throw error;
      return parseWeeklyPerformance(data);
    },
  });
}
