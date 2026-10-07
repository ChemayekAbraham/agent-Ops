import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Phone, MessageSquare, Loader2, RefreshCw, MapPin, RotateCcw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/agentAdvanceCalculations';

type Row = {
  lease_id: string; agent_id: string; agent_name: string | null; agent_phone: string | null;
  bike_model: string | null; last_repayment_at: string | null; days_since_last_repayment: number;
  amount_outstanding: number; wallet_zero: boolean; service_centre: string | null;
};

const MAX_MSG = 480;

function autoMessage(r: Row): string {
  const name = (r.agent_name || 'Agent').split(' ')[0];
  const bal = formatUGX(Number(r.amount_outstanding || 0));
  return `Hello ${name}, your Welile electric bike lease has had no repayment for 7+ days. Outstanding: ${bal}. Please top up your Welile wallet today so your daily repayment can be collected. Thank you.`;
}

export function DormantBikeLeasesPanel() {
  const [sending, setSending] = useState<string | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  const [message, setMessage] = useState('');
  const { data = [], isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['dormant-bike-leases'],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('agent_ops_dormant_bike_leases');
      if (error) throw error;
      return (data || []) as Row[];
    },
  });

  const remind = async (r: Row) => {
    setSending(r.lease_id);
    try {
      const { data, error } = await supabase.functions.invoke('dormant-bike-lease-reminder', { body: { lease_id: r.lease_id } });
      if (error || (data as any)?.error) {
        let msg = (data as any)?.error || error?.message;
        try { msg = (await (error as any)?.context?.json())?.error || msg; } catch { /* ignore */ }
        throw new Error(msg);
      }
      toast.success(`Reminder sent to ${r.agent_name ?? 'agent'}`);
    } catch (e: any) {
      toast.error(e.message || 'Could not send reminder');
    } finally { setSending(null); }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          Dormant Bike Leases (7+ Days)
          <Badge variant="destructive">{data.length}</Badge>
        </CardTitle>
        <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : error ? (
          <p className="text-sm text-destructive">{(error as Error).message}</p>
        ) : data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No dormant bike leases. Every active lease has been repaid in the last 7 days.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {data.map((r) => (
              <div key={r.lease_id} className="rounded-xl border border-border p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold truncate">{r.agent_name || 'Unknown agent'}</p>
                    <p className="text-xs text-muted-foreground">{r.agent_phone || 'No phone'}</p>
                  </div>
                  <Badge variant="destructive" className="shrink-0">{r.days_since_last_repayment} days</Badge>
                </div>
                <div className="text-xs space-y-1">
                  <p>Outstanding: <span className="font-semibold">{formatUGX(Number(r.amount_outstanding))}</span></p>
                  <p className="flex items-center gap-1 text-muted-foreground"><MapPin className="h-3 w-3" />{r.service_centre || 'No service centre'}</p>
                  <p className="text-muted-foreground">
                    Last repayment: {r.last_repayment_at ? new Date(r.last_repayment_at).toLocaleDateString('en-GB') : 'Never (counted from activation)'}
                  </p>
                  {r.wallet_zero && <Badge variant="outline" className="text-[10px]">Wallet at zero</Badge>}
                </div>
                <div className="flex gap-2">
                  <Button asChild size="sm" variant="outline" className="flex-1" disabled={!r.agent_phone}>
                    <a href={r.agent_phone ? `tel:${r.agent_phone}` : undefined}><Phone className="h-4 w-4 mr-1" />Call</a>
                  </Button>
                  <Button size="sm" className="flex-1" onClick={() => remind(r)} disabled={!r.agent_phone || sending === r.lease_id}>
                    {sending === r.lease_id ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <MessageSquare className="h-4 w-4 mr-1" />}
                    Send SMS
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
