import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { Loader2, CheckCircle, XCircle, MapPin, Users } from 'lucide-react';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/businessAdvanceCalculations';

const STATUS_LABEL: Record<string, string> = {
  pending_coo: 'Pending COO Approval',
  pending_ceo: 'Pending CEO Approval',
  verified: 'Verified',
  rejected: 'Rejected',
};

const DURATION_LABEL: Record<string, string> = { days: 'Days', months: 'Months', years: 'Yearly' };

export function ServiceCentreEntriesList() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const { data: entries, isLoading } = useQuery({
    queryKey: ['service-centre-entries'],
    staleTime: 30_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('service_centre_entries')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      return (data || []) as any[];
    },
  });

  const advance = async (entry: any) => {
    setProcessingId(entry.id);
    try {
      const now = new Date().toISOString();
      const patch: Record<string, any> =
        entry.status === 'pending_coo'
          ? { status: 'pending_ceo', coo_approved_by: user?.id ?? null, coo_approved_at: now }
          : {
              status: 'verified',
              ceo_approved_by: user?.id ?? null,
              ceo_approved_at: now,
              verified_by: user?.id ?? null,
              verified_at: now,
            };
      const { error } = await supabase
        .from('service_centre_entries')
        .update(patch as any)
        .eq('id', entry.id);
      if (error) throw error;
      toast.success(entry.status === 'pending_coo' ? 'COO approved — sent to CEO.' : 'Service centre verified.');
      queryClient.invalidateQueries({ queryKey: ['service-centre-entries'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to update entry');
    } finally {
      setProcessingId(null);
    }
  };

  const reject = async (id: string) => {
    if (reason.trim().length < 10) {
      toast.error('Please give a reason (at least 10 characters).');
      return;
    }
    setProcessingId(id);
    try {
      const { error } = await supabase
        .from('service_centre_entries')
        .update({ status: 'rejected', rejection_reason: reason.trim() } as any)
        .eq('id', id);
      if (error) throw error;
      toast.success('Entry rejected.');
      setRejectingId(null);
      setReason('');
      queryClient.invalidateQueries({ queryKey: ['service-centre-entries'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to reject entry');
    } finally {
      setProcessingId(null);
    }
  };

  if (isLoading) {
    return <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  if (!entries?.length) {
    return <p className="text-sm text-muted-foreground text-center py-4">No service centre entries yet. Use “New Entry” to add one.</p>;
  }

  return (
    <div className="space-y-3">
      {entries.map((e) => (
        <div key={e.id} className="rounded-xl border border-border p-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground flex items-center gap-1 truncate">
                <MapPin className="h-3.5 w-3.5 text-primary" />{e.stationed_location}
              </p>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Users className="h-3 w-3" />
                {(e.assigned_agent_ids || []).length} agent{(e.assigned_agent_ids || []).length !== 1 ? 's' : ''} ·{' '}
                {format(new Date(e.created_at), 'dd MMM yyyy')}
              </p>
            </div>
            <span className="shrink-0 text-xs px-2 py-1 rounded-full bg-accent text-accent-foreground font-semibold">
              {STATUS_LABEL[e.status] || e.status}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs">
            <div><span className="text-muted-foreground">Unit price</span><p className="font-semibold text-foreground">{formatUGX(Number(e.unit_price) || 0)}</p></div>
            <div><span className="text-muted-foreground">30% forecast</span><p className="font-semibold text-foreground">{formatUGX(Number(e.forecast_amount) || 0)}</p></div>
            <div><span className="text-muted-foreground">Payment</span><p className="font-semibold text-foreground">{e.payment_mode === 'full_payment' ? 'Full Payment' : 'Installments'}</p></div>
            <div><span className="text-muted-foreground">Paid upfront</span><p className="font-semibold text-foreground">{formatUGX(Number(e.paid_upfront) || 0)}</p></div>
            <div><span className="text-muted-foreground">Duration</span><p className="font-semibold text-foreground">{e.duration_value} {DURATION_LABEL[e.duration_unit] || e.duration_unit}</p></div>
          </div>

          {e.notes && <p className="text-xs text-muted-foreground">{e.notes}</p>}
          {e.status === 'rejected' && e.rejection_reason && (
            <p className="text-xs text-destructive">Rejected: {e.rejection_reason}</p>
          )}

          {(e.status === 'pending_coo' || e.status === 'pending_ceo') && (
            rejectingId === e.id ? (
              <div className="space-y-2">
                <Input
                  placeholder="Reason for rejection (min 10 chars)"
                  value={reason}
                  onChange={(ev) => setReason(ev.target.value)}
                  maxLength={500}
                />
                <div className="flex gap-2">
                  <Button size="sm" variant="destructive" className="flex-1 gap-1" disabled={processingId === e.id} onClick={() => reject(e.id)}>
                    {processingId === e.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
                    Confirm Reject
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setRejectingId(null); setReason(''); }}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" className="flex-1 gap-1" disabled={processingId === e.id} onClick={() => advance(e)}>
                  {processingId === e.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
                  {e.status === 'pending_coo' ? 'COO Approve' : 'CEO Approve & Verify'}
                </Button>
                <Button size="sm" variant="outline" className="flex-1 gap-1" onClick={() => setRejectingId(e.id)}>
                  <XCircle className="h-3 w-3" /> Reject
                </Button>
              </div>
            )
          )}
        </div>
      ))}
    </div>
  );
}