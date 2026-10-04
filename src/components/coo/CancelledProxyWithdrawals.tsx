import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { XCircle, RefreshCw, User, Wallet, AlertTriangle } from 'lucide-react';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';

export function CancelledProxyWithdrawals() {
  const { data: cancellations = [], isLoading, refetch } = useQuery({
    queryKey: ['cancelled-proxy-withdrawals'],
    queryFn: async () => {
      // Get cancelled proxy withdrawal audit logs
      const { data, error } = await supabase
        .from('audit_logs')
        .select('*')
        .eq('action_type', 'proxy_withdrawal_cancelled')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data || [];
    },
  });

  // Get unique user IDs for profile lookups
  const userIds = [...new Set(cancellations.flatMap(c => {
    const meta = (c.metadata || {}) as Record<string, any>;
    return [c.user_id, meta.cancelled_by].filter(Boolean);
  }))];

  const { data: profiles = [] } = useQuery({
    queryKey: ['cancelled-proxy-profiles', userIds.join(',')],
    queryFn: async () => {
      if (userIds.length === 0) return [];
      const { data } = await supabase.from('profiles').select('id, full_name, phone').in('id', userIds);
      return data || [];
    },
    enabled: userIds.length > 0,
  });

  const getName = (id: string | null) => {
    if (!id) return '—';
    const p = profiles.find(pr => pr.id === id);
    return p?.full_name || id.slice(0, 8);
  };

  if (isLoading) return null;
  if (cancellations.length === 0) return null;

  return (
    <Card className="border-destructive/30">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Cancelled Proxy Withdrawals
            <Badge variant="destructive">{cancellations.length}</Badge>
          </CardTitle>
          <Button size="icon-sm" variant="ghost" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="max-h-[400px]">
          <div className="space-y-3">
            {cancellations.map((log: any) => {
              const meta = (log.metadata || {}) as Record<string, any>;
              return (
                <div
                  key={log.id}
                  className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 space-y-2"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2 flex-wrap">
                      <XCircle className="h-4 w-4 text-destructive shrink-0" />
                      <span className="font-semibold text-sm">
                        {meta.partner_name || 'Unknown Partner'}
                      </span>
                      <span className="text-muted-foreground text-xs">cancelled by</span>
                      <div className="flex items-center gap-1">
                        <User className="h-3 w-3 text-muted-foreground" />
                        <span className="text-xs font-medium">{getName(log.user_id)}</span>
                      </div>
                    </div>
                    <Badge variant="destructive" className="text-[10px] shrink-0">
                      Cancelled
                    </Badge>
                  </div>

                  <div className="flex items-center gap-4 text-sm">
                    <div className="flex items-center gap-1.5">
                      <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-bold text-destructive">
                        {formatUGX(meta.amount_restored || 0)}
                      </span>
                      <span className="text-xs text-muted-foreground">restored</span>
                    </div>
                  </div>

                  {meta.cancellation_reason && (
                    <div className="rounded-lg bg-background border p-2">
                      <p className="text-xs text-muted-foreground mb-0.5 font-medium">Reason:</p>
                      <p className="text-sm">{meta.cancellation_reason}</p>
                    </div>
                  )}

                  <p className="text-[10px] text-muted-foreground">
                    {format(new Date(log.created_at), 'dd MMM yyyy, HH:mm')}
                  </p>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
