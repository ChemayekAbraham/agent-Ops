import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Building2, CheckCircle, Loader2, MapPin, ExternalLink } from 'lucide-react';
import { format } from 'date-fns';

export function ServiceCentrePayoutApproval() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [processingId, setProcessingId] = useState<string | null>(null);

  const { data: setups, isLoading } = useQuery({
    queryKey: ['service-centre-verified-setups'],
    queryFn: async () => {
      const { data } = await supabase
        .from('service_centre_setups' as any)
        .select('*')
        .eq('status', 'verified')
        .order('verified_at', { ascending: true });
      return (data || []) as any[];
    },
    staleTime: 30000,
  });

  const handleApproveAndPay = async (setup: any) => {
    if (!user?.id) return;
    setProcessingId(setup.id);
    try {
      // Call credit_agent_event_bonus RPC for UGX 25,000
      const { data: result, error: rpcError } = await supabase.rpc('credit_agent_event_bonus', {
        p_agent_id: setup.agent_id,
        p_event_type: 'service_centre_setup',
        p_tenant_id: setup.agent_id, // self-referencing for non-tenant events
        p_source_id: setup.id,
      });
      if (rpcError) throw rpcError;

      const parsed = typeof result === 'string' ? JSON.parse(result) : result;
      if (parsed?.status === 'error') throw new Error(parsed.message);
      if (parsed?.status === 'already_credited') {
        toast.info('This setup was already paid.');
        return;
      }

      // Update the setup status to 'paid'
      const { error: updateErr } = await supabase
        .from('service_centre_setups' as any)
        .update({
          status: 'paid',
          approved_by: user.id,
          approved_at: new Date().toISOString(),
        } as any)
        .eq('id', setup.id);
      if (updateErr) throw updateErr;

      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'cfo_service_centre_payout',
        table_name: 'service_centre_setups',
        record_id: setup.id,
        metadata: {
          agent_id: setup.agent_id,
          agent_name: setup.agent_name,
          amount: 25000,
        },
      });

      toast.success(`UGX 25,000 paid to ${setup.agent_name}!`);
      queryClient.invalidateQueries({ queryKey: ['service-centre-verified-setups'] });
      queryClient.invalidateQueries({ queryKey: ['cfo-actions-log'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to approve');
    } finally {
      setProcessingId(null);
    }
  };

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Building2 className="h-4 w-4 text-primary" />
          Service Centre Payout Approval
          {setups?.length ? (
            <span className="ml-auto bg-primary/10 text-primary text-xs font-bold px-2 py-0.5 rounded-full">{setups.length}</span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : !setups?.length ? (
          <p className="text-sm text-muted-foreground text-center py-4">No verified service centre setups awaiting payout.</p>
        ) : (
          <div className="space-y-4">
            {setups.map((s: any) => (
              <div key={s.id} className="rounded-xl border border-border p-3 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-0.5">
                    <p className="text-sm font-semibold text-foreground">{s.agent_name}</p>
                    <p className="text-xs text-muted-foreground">📱 {s.agent_phone}</p>
                    <p className="text-xs text-muted-foreground">Verified: {s.verified_at ? format(new Date(s.verified_at), 'dd MMM yyyy') : '—'}</p>
                  </div>
                  <a
                    href={`https://www.google.com/maps?q=${s.latitude},${s.longitude}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-primary hover:underline shrink-0"
                  >
                    <MapPin className="h-3 w-3" />
                    Map
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>

                <img src={s.photo_url} alt="Service Centre" className="rounded-lg max-h-32 w-full object-cover border" />
                <p className="text-xs text-muted-foreground">📍 {s.location_name || 'No description'}</p>

                <Button
                  onClick={() => handleApproveAndPay(s)}
                  disabled={processingId === s.id}
                  className="w-full gap-2"
                  size="sm"
                >
                  {processingId === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
                  Approve & Pay UGX 25,000
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
