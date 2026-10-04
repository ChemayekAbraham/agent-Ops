import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, PieChart as PieChartIcon } from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { formatUGX } from '@/lib/rentCalculations';

const COLORS = ['hsl(var(--primary))', '#f59e0b', '#10b981', '#6366f1', '#ec4899'];

export default function PaymentModeAnalytics() {
  const { data, isLoading } = useQuery({
    queryKey: ['coo-payment-mode-analytics'],
    queryFn: async () => {
      const { data: collections } = await supabase.from('agent_collections').select('payment_method, amount').is('reversed_at', null);

      const modeMap = new Map<string, number>();
      for (const c of collections || []) {
        const method = c.payment_method || 'unknown';
        modeMap.set(method, (modeMap.get(method) || 0) + (c.amount || 0));
      }

      const labels: Record<string, string> = {
        mobile_money_mtn: 'MTN MoMo',
        mobile_money_airtel: 'Airtel Money',
        cash: 'Cash',
        wallet: 'Wallet',
        mobile_money: 'Mobile Money',
      };

      const total = [...modeMap.values()].reduce((s, v) => s + v, 0);

      return [...modeMap.entries()].map(([key, value]) => ({
        name: labels[key] || key.replace(/_/g, ' '),
        value,
        percentage: total > 0 ? Math.round((value / total) * 100) : 0,
      })).sort((a, b) => b.value - a.value);
    },
    staleTime: 10 * 60 * 1000,
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <PieChartIcon className="h-4 w-4 text-primary" /> Payment Mode Distribution
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
        ) : !data || data.length === 0 ? (
          <p className="text-center py-8 text-muted-foreground text-sm">No payment data available</p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={90}
                innerRadius={45}
                paddingAngle={3}
                label={({ name, percentage }) => `${name} ${percentage}%`}
                labelLine={{ strokeWidth: 1 }}
              >
                {data.map((_: any, i: number) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                formatter={(value: number) => formatUGX(value)}
                contentStyle={{ borderRadius: '12px', border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }}
              />
              <Legend
                verticalAlign="bottom"
                iconType="circle"
                iconSize={10}
                formatter={(value: string) => <span className="text-xs text-foreground">{value}</span>}
              />
            </PieChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
