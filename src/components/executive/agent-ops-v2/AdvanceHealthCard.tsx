import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend,
} from 'recharts';

/**
 * Advance Health donut — migrated out of the Agent Ops overview so every
 * advances-related visual now lives under the Advances menu group.
 */
export function AdvanceHealthCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['advance-health-donut'],
    queryFn: async () => {
      const { data } = await supabase
        .from('agent_advances')
        .select('arrears_balance, outstanding_balance, status')
        .in('status', ['active', 'disbursed', 'overdue'])
        .limit(5000);
      const rows = data || [];
      const behind = rows.filter((r: any) => Number(r.arrears_balance || 0) > 0).length;
      const outstanding = rows.reduce((s: number, r: any) => s + Number(r.outstanding_balance || 0), 0);
      return { total: rows.length, behind, onTrack: Math.max(0, rows.length - behind), outstanding };
    },
    staleTime: 60_000,
  });

  const donut = [
    { name: 'On track', value: data?.onTrack || 0, fill: 'hsl(160 84% 39%)' },
    { name: 'Behind', value: data?.behind || 0, fill: 'hsl(0 84% 60%)' },
  ];

  return (
    <Card className="rounded-2xl border-border/50 p-3 sm:p-4">
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="text-sm font-semibold">Advance Health</h3>
          <p className="text-[11px] text-muted-foreground">
            {data ? `${data.total} live advances · UGX ${Math.round(data.outstanding).toLocaleString()} outstanding` : 'Live advances'}
          </p>
        </div>
      </div>
      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="h-40">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={donut} dataKey="value" nameKey="name" innerRadius={30} outerRadius={55} paddingAngle={2}>
                {donut.map((d, i) => <Cell key={i} fill={d.fill} />)}
              </Pie>
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
