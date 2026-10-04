import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Bell, BellOff, CheckCircle2, Loader2, Shield } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

export function ThresholdAlerts() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: alerts, isLoading } = useQuery({
    queryKey: ['cfo-threshold-alerts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('cfo_threshold_alerts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data || [];
    },
    staleTime: 30_000,
  });

  const acknowledge = useMutation({
    mutationFn: async (alertId: string) => {
      const { error } = await supabase
        .from('cfo_threshold_alerts')
        .update({ acknowledged: true, acknowledged_by: user?.id, acknowledged_at: new Date().toISOString() })
        .eq('id', alertId);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['cfo-threshold-alerts'] }); toast.success('Alert acknowledged'); },
  });

  const unackedCount = (alerts || []).filter(a => !a.acknowledged).length;

  const severityIcon = (s: string) => {
    if (s === 'critical') return <AlertTriangle className="h-4 w-4 text-destructive" />;
    if (s === 'warning') return <Shield className="h-4 w-4 text-warning" />;
    return <Bell className="h-4 w-4 text-muted-foreground" />;
  };

  const severityBadge = (s: string) => {
    if (s === 'critical') return <Badge variant="destructive" className="text-[10px]">Critical</Badge>;
    if (s === 'warning') return <Badge className="bg-warning/10 text-warning border-warning/30 text-[10px]">Warning</Badge>;
    return <Badge variant="outline" className="text-[10px]">Info</Badge>;
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Bell className="h-4 w-4 text-primary" />
            Threshold Alerts
            {unackedCount > 0 && <Badge variant="destructive" className="text-[10px] ml-1">{unackedCount} new</Badge>}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (alerts || []).length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-success" />
            <p className="font-medium">All Clear</p>
            <p className="text-xs">No threshold alerts at this time</p>
          </div>
        ) : (
          <div className="space-y-2">
            {(alerts || []).map(alert => (
              <div key={alert.id} className={cn('border rounded-lg p-3 flex items-start gap-3', !alert.acknowledged && 'bg-destructive/5 border-destructive/20')}>
                {severityIcon(alert.severity)}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium text-sm">{alert.title}</p>
                    {severityBadge(alert.severity)}
                    {alert.acknowledged && <Badge variant="outline" className="text-[10px] text-muted-foreground"><BellOff className="h-3 w-3 mr-1" />Acked</Badge>}
                  </div>
                  {alert.description && <p className="text-xs text-muted-foreground mt-1">{alert.description}</p>}
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    <span>{format(new Date(alert.created_at), 'dd MMM HH:mm')}</span>
                    {alert.threshold_value != null && <span>Threshold: {Number(alert.threshold_value).toFixed(1)}</span>}
                    {alert.current_value != null && <span>Current: {Number(alert.current_value).toFixed(1)}</span>}
                  </div>
                </div>
                {!alert.acknowledged && (
                  <Button variant="outline" size="sm" className="shrink-0 text-xs" onClick={() => acknowledge.mutate(alert.id)} disabled={acknowledge.isPending}>
                    Ack
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
