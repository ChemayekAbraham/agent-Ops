import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, MapPin, Clock, DollarSign } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';

interface FloatRow {
  agent_id: string;
  agent_name: string;
  total_assigned: number;
  total_settled: number;
  outstanding: number;
  oldest_unsettled_at: string;
  age_hours: number;
}

function getAgingBadge(hours: number) {
  if (hours < 24) return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 border-emerald-500/30 text-[10px]">Fresh</Badge>;
  if (hours < 72) return <Badge variant="outline" className="bg-amber-500/10 text-amber-700 border-amber-500/30 text-[10px]">⚠ {Math.floor(hours)}h</Badge>;
  return <Badge variant="destructive" className="text-[10px]">🔴 {Math.floor(hours)}h overdue</Badge>;
}

export function FieldCashExposureCard() {
  const { data: rows, isLoading } = useQuery({
    queryKey: ['outstanding-agent-float'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_outstanding_agent_float');
      if (error) throw error;
      return (data || []) as FloatRow[];
    },
    refetchInterval: 60_000,
  });

  const totalOutstanding = (rows || []).reduce((s, r) => s + Number(r.outstanding), 0);
  const flaggedCount = (rows || []).filter(r => r.age_hours > 72).length;

  return (
    <Card className="glass-card border-amber-500/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-amber-500" />
            Field Cash Exposure
          </span>
          {flaggedCount > 0 && (
            <Badge variant="destructive" className="text-[10px]">
              <AlertTriangle className="h-3 w-3 mr-1" />
              {flaggedCount} overdue
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Total Outstanding */}
        <div className="flex items-center justify-between mb-4 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Total Cash in Field</p>
            <p className="text-xl font-black">{formatUGX(totalOutstanding)}</p>
          </div>
          <DollarSign className="h-8 w-8 text-amber-500/30" />
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : !rows || rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No outstanding float — all clear ✅</p>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {rows.map((row) => (
              <div key={row.agent_id} className="flex items-center justify-between p-2.5 rounded-lg bg-secondary/50 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium truncate">{row.agent_name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-muted-foreground">
                      Assigned: {formatUGX(Number(row.total_assigned))}
                    </span>
                    <span className="text-[10px] text-emerald-600">
                      Settled: {formatUGX(Number(row.total_settled))}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-mono font-bold text-sm">{formatUGX(Number(row.outstanding))}</span>
                  {getAgingBadge(Number(row.age_hours))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
