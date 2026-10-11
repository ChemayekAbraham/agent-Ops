import { useQuery } from '@tanstack/react-query';
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { Progress } from '@/components/ui/progress';
import { formatUGX } from '@/lib/rentCalculations';
import { kampalaLabel, kampalaTodayYmd } from '@/lib/kampalaDays';

interface Props {
  agentId: string;
  repaid: number;
  outstanding: number;
}

export function AgentProductProgress({ agentId, repaid, outstanding }: Props) {
  const day = kampalaTodayYmd();
  const { data: collection, isLoading, isError } = useQuery({
    queryKey: ['agent-product-daily-collection', agentId, day],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_daily_eligibility', { p_agent_ids: [agentId] });
      if (error) throw error;
      return data?.find((row) => row.agent_id === agentId) ?? null;
    },
    staleTime: 30_000,
  });
  const paid = Math.max(0, repaid);
  const owed = Math.max(0, outstanding);
  const total = paid + owed;
  const percent = total > 0 ? (paid / total) * 100 : 0;
  const expected = Math.max(0, Number(collection?.expected_daily) || 0);
  const collected = Math.max(0, Number(collection?.paid_today) || 0);
  const coverage = expected > 0 ? (collected / expected) * 100 : 0;
  const short = Math.max(0, expected - collected);

  return (
    <div className="space-y-5 border-y border-border py-4">
      <section aria-label="Repayment progress" className="space-y-3">
        <h3 className="text-sm font-semibold">Repayment progress</h3>
        <div className="flex items-center gap-3 sm:gap-5">
          <div className="relative h-28 w-28 shrink-0" role="img" aria-label={`${percent.toFixed(1)}% repaid; ${formatUGX(paid)} paid; ${formatUGX(owed)} still owed`}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={total > 0 ? [{ value: paid }, { value: owed }] : [{ value: 0 }, { value: 1 }]} dataKey="value" innerRadius={35} outerRadius={50} startAngle={90} endAngle={-270} stroke="none" isAnimationActive={false}>
                  <Cell fill="hsl(var(--primary))" />
                  <Cell fill="hsl(var(--muted))" />
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <span className="absolute inset-0 flex items-center justify-center text-base font-bold tabular-nums">{percent.toFixed(1)}%</span>
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-xs text-muted-foreground">Total to repay</p>
            <p className="text-lg font-bold tabular-nums break-words">{formatUGX(total)}</p>
            <Progress value={percent} aria-label="Amount repaid" />
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span className="text-primary">Paid <strong className="tabular-nums">{formatUGX(paid)}</strong></span>
              <span className="text-muted-foreground">Still owed <strong className="text-foreground tabular-nums">{formatUGX(owed)}</strong></span>
            </div>
          </div>
        </div>
      </section>
      <section aria-label="Daily rent collection" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-1">
          <h3 className="text-sm font-semibold">Daily rent collection</h3>
          <p className="text-xs text-muted-foreground">Today · {kampalaLabel(day)} · Kampala</p>
        </div>
        {isLoading ? (
          <p className="text-xs text-muted-foreground" role="status">Loading today's rent collection…</p>
        ) : isError ? (
          <p className="text-xs text-destructive" role="alert">Today's rent collection could not be loaded.</p>
        ) : !collection ? (
          <p className="text-xs text-muted-foreground">No agent rent collection record for this user.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Expected today</p>
                <p className="text-lg font-bold tabular-nums break-words">{formatUGX(expected)}</p>
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Collected today</p>
                <p className="text-lg font-bold text-success tabular-nums break-words">{formatUGX(collected)}</p>
              </div>
            </div>
            <Progress value={Math.min(100, coverage)} variant="success" aria-label="Daily rent collection target covered" />
            <p className="text-xs text-muted-foreground">
              {expected > 0
                ? `${coverage.toFixed(1)}% of today's target collected · ${short > 0 ? `${formatUGX(short)} short` : collected > expected ? `${formatUGX(collected - expected)} above target` : 'Target reached'}`
                : 'No rent collection expected today.'}
            </p>
          </>
        )}
      </section>
    </div>
  );
}