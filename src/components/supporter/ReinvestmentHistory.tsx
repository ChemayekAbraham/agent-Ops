import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { TrendingUp, RefreshCw, Scissors, Calendar, Hash } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';

interface ReinvestmentEntry {
  id: string;
  created_at: string;
  action_type: string;
  metadata: {
    roi_amount?: number;
    new_principal?: number;
    partner_id?: string;
    reason?: string;
    reference?: string;
    cash_amount?: number;
    reinvest_amount?: number;
    portfolio_code?: string;
    [key: string]: unknown;
  };
}

function formatUGX(amount: number) {
  return `UGX ${amount.toLocaleString()}`;
}

export function ReinvestmentHistory() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<ReinvestmentEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from('audit_logs')
        .select('id, created_at, action_type, metadata')
        .in('action_type', ['roi_compounded', 'roi_split_payout'])
        .order('created_at', { ascending: true });

      // Filter client-side for partner_id match
      const filtered = (data ?? []).filter((d: any) => {
        const meta = d.metadata as any;
        return meta?.partner_id === user.id;
      }) as ReinvestmentEntry[];

      setEntries(filtered);
      setLoading(false);
    })();
  }, [user?.id]);

  const chartData = entries
    .filter(e => (e.metadata as any)?.new_principal)
    .map(e => ({
      date: format(new Date(e.created_at), 'dd MMM'),
      principal: (e.metadata as any).new_principal,
    }));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <Card className="mx-4 mt-4">
        <CardContent className="py-12 text-center">
          <TrendingUp className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No reinvestments yet</p>
          <p className="text-xs text-muted-foreground/70 mt-1">When your ROI is compounded, it will appear here.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Growth Chart */}
      {chartData.length >= 2 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              Principal Growth
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3">
            <div className="h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="principalGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                  <YAxis
                    tick={{ fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => `${(v / 1_000_000).toFixed(1)}M`}
                  />
                  <Tooltip
                    formatter={(v: number) => [formatUGX(v), 'Principal']}
                    labelStyle={{ fontSize: 11 }}
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,.1)' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="principal"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    fill="url(#principalGrad)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Timeline */}
      <div className="space-y-2">
        {[...entries].reverse().map((entry) => {
          const meta = entry.metadata as any;
          const isSplit = entry.action_type === 'roi_split_payout';
          const reinvestedAmount = isSplit ? meta.reinvest_amount : meta.roi_amount;

          return (
            <Card key={entry.id} className="overflow-hidden">
              <CardContent className="p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant={isSplit ? 'warning' : 'success'} size="sm">
                        {isSplit ? (
                          <><Scissors className="h-3 w-3 mr-0.5" />Split</>
                        ) : (
                          <><RefreshCw className="h-3 w-3 mr-0.5" />Full</>
                        )}
                      </Badge>
                      {meta.portfolio_code && (
                        <span className="text-[10px] text-muted-foreground font-mono">{meta.portfolio_code}</span>
                      )}
                    </div>
                    <p className="text-sm font-semibold text-foreground">
                      +{formatUGX(reinvestedAmount ?? 0)} reinvested
                    </p>
                    {isSplit && meta.cash_amount && (
                      <p className="text-[11px] text-muted-foreground">
                        {formatUGX(meta.cash_amount)} paid out as cash
                      </p>
                    )}
                    {meta.new_principal && (
                      <p className="text-[11px] text-muted-foreground">
                        New principal: {formatUGX(meta.new_principal)}
                      </p>
                    )}
                  </div>
                  <div className="text-right shrink-0 space-y-1">
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Calendar className="h-3 w-3" />
                      {format(new Date(entry.created_at), 'dd MMM yyyy')}
                    </div>
                    {meta.reference && (
                      <div className="flex items-center gap-1 text-[10px] text-muted-foreground font-mono">
                        <Hash className="h-3 w-3" />
                        {meta.reference}
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
