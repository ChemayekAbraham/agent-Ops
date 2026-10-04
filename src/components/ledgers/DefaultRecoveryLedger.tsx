import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { AlertTriangle, TrendingUp, XCircle, CheckCircle2 } from 'lucide-react';

const STATUS_MAP: Record<string, { label: string; color: string; icon: any }> = {
  defaulted: { label: 'Defaulted', color: 'bg-destructive/10 text-destructive border-destructive/30', icon: XCircle },
  partial_recovery: { label: 'Partial Recovery', color: 'bg-amber-500/10 text-amber-700 border-amber-500/30', icon: TrendingUp },
  full_recovery: { label: 'Recovered', color: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30', icon: CheckCircle2 },
  written_off: { label: 'Written Off', color: 'bg-muted text-muted-foreground', icon: AlertTriangle },
};

export function DefaultRecoveryLedger() {
  const [statusFilter, setStatusFilter] = useState('all');

  const { data, isLoading } = useQuery({
    queryKey: ['default-recovery-ledger', statusFilter],
    queryFn: async () => {
      let q = supabase.from('default_recovery_ledger')
        .select('*, tenant:tenant_id(full_name, phone), agent:agent_id(full_name)')
        .order('created_at', { ascending: false }).limit(100);
      if (statusFilter !== 'all') q = q.eq('status', statusFilter);
      const { data } = await q;
      return data || [];
    },
  });

  const totals = (data || []).reduce((acc, e) => ({
    defaulted: acc.defaulted + e.default_amount,
    recovered: acc.recovered + e.recovered_amount,
    writtenOff: acc.writtenOff + e.written_off_amount,
    platformLoss: acc.platformLoss + e.platform_loss,
  }), { defaulted: 0, recovered: 0, writtenOff: 0, platformLoss: 0 });

  const recoveryRate = totals.defaulted > 0 ? ((totals.recovered / totals.defaulted) * 100).toFixed(1) : '0';

  return (
    <div className="space-y-3">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-2">
        <Card className="border-destructive/20">
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">Total Defaults</p>
            <p className="text-lg font-black text-destructive">{formatUGX(totals.defaulted)}</p>
          </CardContent>
        </Card>
        <Card className="border-emerald-500/20">
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">Total Recovered</p>
            <p className="text-lg font-black text-emerald-600">{formatUGX(totals.recovered)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">Written Off</p>
            <p className="text-lg font-black">{formatUGX(totals.writtenOff)}</p>
          </CardContent>
        </Card>
        <Card className={Number(recoveryRate) > 50 ? 'border-emerald-500/20' : 'border-amber-500/20'}>
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">Recovery Rate</p>
            <p className="text-lg font-black">{recoveryRate}%</p>
          </CardContent>
        </Card>
      </div>

      {/* Filter */}
      <Select value={statusFilter} onValueChange={setStatusFilter}>
        <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Status</SelectItem>
          <SelectItem value="defaulted">Defaulted</SelectItem>
          <SelectItem value="partial_recovery">Partial Recovery</SelectItem>
          <SelectItem value="full_recovery">Full Recovery</SelectItem>
          <SelectItem value="written_off">Written Off</SelectItem>
        </SelectContent>
      </Select>

      {/* Entries */}
      <div className="space-y-2">
        {isLoading ? (
          <p className="text-xs text-muted-foreground text-center py-6">Loading...</p>
        ) : (data || []).length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">No defaults recorded</p>
        ) : (data || []).map(entry => {
          const st = STATUS_MAP[entry.status] || STATUS_MAP.defaulted;
          const Icon = st.icon;
          const outstanding = entry.default_amount - entry.recovered_amount - entry.written_off_amount;
          return (
            <Card key={entry.id}>
              <CardContent className="p-3">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="text-xs font-semibold">{(entry as any).tenant?.full_name || 'Unknown tenant'}</p>
                    <p className="text-[10px] text-muted-foreground">Agent: {(entry as any).agent?.full_name || '—'}</p>
                    <div className="flex gap-3 mt-1.5">
                      <div>
                        <p className="text-[9px] text-muted-foreground">Default</p>
                        <p className="text-xs font-bold text-destructive">{formatUGX(entry.default_amount)}</p>
                      </div>
                      <div>
                        <p className="text-[9px] text-muted-foreground">Recovered</p>
                        <p className="text-xs font-bold text-emerald-600">{formatUGX(entry.recovered_amount)}</p>
                      </div>
                      <div>
                        <p className="text-[9px] text-muted-foreground">Outstanding</p>
                        <p className="text-xs font-bold">{formatUGX(Math.max(outstanding, 0))}</p>
                      </div>
                    </div>
                    <p className="text-[9px] text-muted-foreground mt-1">{format(new Date(entry.default_date), 'MMM d, yyyy')}</p>
                  </div>
                  <Badge variant="outline" className={`text-[9px] ${st.color}`}>
                    <Icon className="h-2.5 w-2.5 mr-0.5" /> {st.label}
                  </Badge>
                </div>
                {entry.notes && <p className="text-[10px] text-muted-foreground mt-1.5 italic">{entry.notes}</p>}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
