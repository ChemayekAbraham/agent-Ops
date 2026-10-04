import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, Loader2, ShieldAlert, MapPin, Repeat } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format, subDays } from 'date-fns';
import { cn } from '@/lib/utils';

interface Alert {
  id: string;
  type: 'large_payment' | 'failed_repeat' | 'location_anomaly' | 'suspicious';
  severity: 'warning' | 'critical';
  title: string;
  detail: string;
  timestamp: string;
}

export default function FinancialAlertsPanel() {
  const { data: alerts, isLoading } = useQuery({
    queryKey: ['coo-financial-alerts'],
    queryFn: async () => {
      const results: Alert[] = [];
      const sevenDaysAgo = subDays(new Date(), 7).toISOString();

      // Large payments (> 2,000,000 UGX)
      const { data: largeTx } = await supabase.from('general_ledger')
        .select('id, amount, category, linked_party, transaction_date')
        .gt('amount', 2000000)
        .gte('transaction_date', sevenDaysAgo)
        .order('transaction_date', { ascending: false })
        .limit(10);

      for (const tx of largeTx || []) {
        results.push({
          id: `large-${tx.id}`,
          type: 'large_payment',
          severity: tx.amount > 5000000 ? 'critical' : 'warning',
          title: `Large payment: ${formatUGX(tx.amount)}`,
          detail: `${tx.category.replace(/_/g, ' ')} — ${tx.linked_party || 'Unknown'}`,
          timestamp: tx.transaction_date,
        });
      }

      // Failed withdrawals
      const { data: failedTx } = await supabase.from('withdrawal_requests')
        .select('id, amount, created_at, status')
        .eq('status', 'failed')
        .gte('created_at', sevenDaysAgo)
        .limit(10);

      for (const tx of failedTx || []) {
        results.push({
          id: `failed-${tx.id}`,
          type: 'failed_repeat',
          severity: 'warning',
          title: `Failed withdrawal: ${formatUGX(tx.amount)}`,
          detail: 'Transaction failed — review required',
          timestamp: tx.created_at,
        });
      }

      return results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    },
    staleTime: 5 * 60 * 1000,
  });

  const icons = {
    large_payment: AlertTriangle,
    failed_repeat: Repeat,
    location_anomaly: MapPin,
    suspicious: ShieldAlert,
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-destructive" /> Financial Alerts
          {alerts && alerts.length > 0 && (
            <Badge variant="destructive" className="text-xs animate-pulse">{alerts.length}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
        ) : !alerts || alerts.length === 0 ? (
          <div className="text-center py-6">
            <p className="text-sm text-muted-foreground">✅ No financial anomalies detected</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-[350px] overflow-y-auto">
            {alerts.map(alert => {
              const Icon = icons[alert.type];
              return (
                <div
                  key={alert.id}
                  className={cn(
                    'flex items-start gap-3 p-3 rounded-xl border',
                    alert.severity === 'critical' ? 'border-destructive/40 bg-destructive/5' : 'border-amber-500/40 bg-amber-500/5'
                  )}
                >
                  <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', alert.severity === 'critical' ? 'text-destructive' : 'text-amber-600')} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{alert.title}</p>
                    <p className="text-xs text-muted-foreground">{alert.detail}</p>
                  </div>
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                    {format(new Date(alert.timestamp), 'MMM d')}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
