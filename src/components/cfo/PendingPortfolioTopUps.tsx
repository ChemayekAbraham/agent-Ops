import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Clock, TrendingUp } from 'lucide-react';

export function PendingPortfolioTopUps() {
  const { data, isLoading } = useQuery({
    queryKey: ['pending-portfolio-topups-cfo'],
    queryFn: async () => {
      const { data: ops, error } = await supabase
        .from('pending_wallet_operations')
        .select('id, amount, created_at, source_id, description, metadata')
        .eq('operation_type', 'portfolio_topup')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;
      return ops || [];
    },
    refetchInterval: false, // Manual refresh only — cost optimization
  });

  const totalPending = (data || []).reduce((s, op) => s + Number(op.amount), 0);
  const count = (data || []).length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          Pending Portfolio Top-Ups
        </CardTitle>
        {count > 0 && (
          <Badge variant="secondary" className="text-xs">
            {count} pending
          </Badge>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : count === 0 ? (
          <p className="text-sm text-muted-foreground">No pending portfolio top-ups.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-primary" />
              <span className="text-lg font-bold">UGX {totalPending.toLocaleString()}</span>
              <span className="text-xs text-muted-foreground">across {count} top-up(s)</span>
            </div>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {data!.map((op) => (
                <div key={op.id} className="flex flex-col gap-0.5 text-sm border-b border-border/40 pb-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground truncate max-w-[60%]">
                      {op.description || 'Portfolio top-up'}
                    </span>
                    <span className="font-medium">UGX {Number(op.amount).toLocaleString()}</span>
                  </div>
                  {op.metadata && typeof op.metadata === 'object' && (op.metadata as any).reason && (
                    <p className="text-[10px] text-muted-foreground/70 italic truncate">
                      Reason: {(op.metadata as any).reason}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
