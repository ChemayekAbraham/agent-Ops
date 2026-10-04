import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { CalendarClock } from 'lucide-react';

interface Props {
  userId: string;
}

export function DailyRentExpectedCard({ userId }: Props) {
  const { data: totalDaily = 0, isLoading } = useQuery({
    queryKey: ['agent-daily-rent-expected', userId],
    queryFn: async () => {
      const { data } = await supabase
        .from('rent_requests')
        .select('daily_repayment')
        .eq('agent_id', userId)
        .in('status', ['approved', 'disbursed', 'active']);

      return (data || []).reduce((sum, r) => sum + Number(r.daily_repayment || 0), 0);
    },
    staleTime: 300000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card p-3.5">
      <div className="p-2.5 rounded-xl bg-warning/10 shrink-0">
        <CalendarClock className="h-5 w-5 text-warning" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Daily Rent Expected</p>
        <p className="font-bold text-lg tabular-nums truncate h-7 leading-7">
          {isLoading ? <span className="inline-block w-20 h-4 rounded bg-muted animate-pulse" /> : formatUGX(totalDaily)}
        </p>
      </div>
      <p className="text-[10px] text-muted-foreground shrink-0">/day</p>
    </div>
  );
}
