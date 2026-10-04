import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

const FEE_LABELS: Record<string, string> = {
  access_fee: 'Access Fee',
  request_fee: 'Request Fee',
  platform_fee: 'Platform Fee',
  service_fee: 'Service Fee',
};

const STATUS_COLORS: Record<string, string> = {
  deferred: 'bg-amber-500/10 text-amber-700 border-amber-500/30',
  partial: 'bg-blue-500/10 text-blue-700 border-blue-500/30',
  recognized: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
};

const PIE_COLORS = ['hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))'];

export function FeeRevenueLedger() {
  const [statusFilter, setStatusFilter] = useState('all');

  const { data, isLoading } = useQuery({
    queryKey: ['fee-revenue-ledger', statusFilter],
    queryFn: async () => {
      let q = supabase.from('fee_revenue_ledger')
        .select('*, tenant:tenant_id(full_name)')
        .order('created_at', { ascending: false }).limit(200);
      if (statusFilter !== 'all') q = q.eq('status', statusFilter);
      const { data } = await q;
      return data || [];
    },
  });

  const totals = (data || []).reduce((acc, e) => {
    acc.total += e.total_amount;
    acc.recognized += e.recognized_amount;
    acc.deferred += e.deferred_amount;
    acc.byType[e.fee_type] = (acc.byType[e.fee_type] || 0) + e.total_amount;
    return acc;
  }, { total: 0, recognized: 0, deferred: 0, byType: {} as Record<string, number> });

  const pieData = Object.entries(totals.byType).map(([key, value]) => ({
    name: FEE_LABELS[key] || key,
    value,
  }));

  const _recognitionRate = totals.total > 0 ? ((totals.recognized / totals.total) * 100).toFixed(1) : '0';

  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-2">
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">Total Fees</p>
            <p className="text-lg font-black">{formatUGX(totals.total)}</p>
          </CardContent>
        </Card>
        <Card className="border-emerald-500/20">
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">Recognized</p>
            <p className="text-lg font-black text-emerald-600">{formatUGX(totals.recognized)}</p>
          </CardContent>
        </Card>
        <Card className="border-amber-500/20">
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">Deferred</p>
            <p className="text-lg font-black text-amber-600">{formatUGX(totals.deferred)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Pie Chart */}
      {pieData.length > 0 && (
        <Card>
          <CardContent className="p-3">
            <p className="text-xs font-semibold mb-2">Revenue by Fee Type</p>
            <div className="h-[140px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={35} outerRadius={60} paddingAngle={3}>
                    {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => formatUGX(v)} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex flex-wrap gap-2 justify-center mt-1">
              {pieData.map((d, i) => (
                <div key={d.name} className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
                  <span className="text-[9px]">{d.name}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filter */}
      <Select value={statusFilter} onValueChange={setStatusFilter}>
        <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Status</SelectItem>
          <SelectItem value="deferred">Deferred</SelectItem>
          <SelectItem value="partial">Partially Recognized</SelectItem>
          <SelectItem value="recognized">Fully Recognized</SelectItem>
        </SelectContent>
      </Select>

      {/* Entries */}
      <div className="space-y-2">
        {isLoading ? (
          <p className="text-xs text-muted-foreground text-center py-6">Loading...</p>
        ) : (data || []).length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">No fee revenue entries</p>
        ) : (data || []).map(entry => (
          <Card key={entry.id}>
            <CardContent className="p-3">
              <div className="flex justify-between items-start">
                <div>
                  <p className="text-xs font-semibold">{FEE_LABELS[entry.fee_type] || entry.fee_type}</p>
                  <p className="text-[10px] text-muted-foreground">{(entry as any).tenant?.full_name || '—'}</p>
                  <div className="flex gap-3 mt-1">
                    <div>
                      <p className="text-[9px] text-muted-foreground">Total</p>
                      <p className="text-xs font-bold">{formatUGX(entry.total_amount)}</p>
                    </div>
                    <div>
                      <p className="text-[9px] text-muted-foreground">Recognized</p>
                      <p className="text-xs font-bold text-emerald-600">{formatUGX(entry.recognized_amount)}</p>
                    </div>
                    <div>
                      <p className="text-[9px] text-muted-foreground">Deferred</p>
                      <p className="text-xs font-bold text-amber-600">{formatUGX(entry.deferred_amount)}</p>
                    </div>
                  </div>
                  <p className="text-[9px] text-muted-foreground mt-1">{format(new Date(entry.created_at), 'MMM d, yyyy')}</p>
                </div>
                <Badge variant="outline" className={`text-[9px] ${STATUS_COLORS[entry.status] || ''}`}>{entry.status}</Badge>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
