import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { ArrowDownLeft, ArrowUpRight, TrendingUp } from 'lucide-react';

const TYPE_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  inflow: { label: 'Capital In', color: 'text-emerald-600', icon: ArrowDownLeft },
  deployment: { label: 'Deployed', color: 'text-blue-600', icon: ArrowUpRight },
  return: { label: 'Return', color: 'text-chart-2', icon: TrendingUp },
  withdrawal: { label: 'Withdrawal', color: 'text-destructive', icon: ArrowUpRight },
};

export function SupporterCapitalLedger() {
  const { data, isLoading } = useQuery({
    queryKey: ['supporter-capital-ledger'],
    queryFn: async () => {
      const { data } = await supabase.from('supporter_capital_ledger')
        .select('*, supporter:supporter_id(full_name)')
        .order('created_at', { ascending: false }).limit(200);
      return data || [];
    },
  });

  const totals = (data || []).reduce((acc, e) => {
    if (e.transaction_type === 'inflow') acc.inflows += e.amount;
    else if (e.transaction_type === 'deployment') acc.deployed += e.amount;
    else if (e.transaction_type === 'return') acc.returns += e.amount;
    else if (e.transaction_type === 'withdrawal') acc.withdrawals += e.amount;
    return acc;
  }, { inflows: 0, deployed: 0, returns: 0, withdrawals: 0 });

  const netCapital = totals.inflows - totals.withdrawals;
  const utilization = netCapital > 0 ? ((totals.deployed / netCapital) * 100).toFixed(1) : '0';

  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-2">
        <Card className="border-emerald-500/20">
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">Total Inflows</p>
            <p className="text-lg font-black text-emerald-600">{formatUGX(totals.inflows)}</p>
          </CardContent>
        </Card>
        <Card className="border-blue-500/20">
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">Total Deployed</p>
            <p className="text-lg font-black text-blue-600">{formatUGX(totals.deployed)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">Returns Paid</p>
            <p className="text-lg font-black">{formatUGX(totals.returns)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">Utilization</p>
            <p className="text-lg font-black">{utilization}%</p>
          </CardContent>
        </Card>
      </div>

      {/* Entries */}
      <div className="space-y-2">
        {isLoading ? (
          <p className="text-xs text-muted-foreground text-center py-6">Loading...</p>
        ) : (data || []).length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">No capital movements recorded</p>
        ) : (data || []).map(entry => {
          const cfg = TYPE_CONFIG[entry.transaction_type] || TYPE_CONFIG.inflow;
          const Icon = cfg.icon;
          return (
            <Card key={entry.id}>
              <CardContent className="p-3">
                <div className="flex justify-between items-start">
                  <div className="flex items-start gap-2">
                    <div className={`p-1.5 rounded-full bg-muted ${cfg.color}`}>
                      <Icon className="h-3.5 w-3.5" />
                    </div>
                    <div>
                      <p className="text-xs font-semibold">{(entry as any).supporter?.full_name || 'Unknown'}</p>
                      <p className="text-[10px] text-muted-foreground">{entry.description || cfg.label}</p>
                      <p className="text-[9px] text-muted-foreground mt-0.5">{format(new Date(entry.created_at), 'MMM d, HH:mm')}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className={`text-sm font-bold ${cfg.color}`}>
                      {entry.transaction_type === 'inflow' || entry.transaction_type === 'return' ? '+' : '-'}{formatUGX(entry.amount)}
                    </p>
                    <Badge variant="outline" className="text-[9px] mt-0.5">{cfg.label}</Badge>
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
