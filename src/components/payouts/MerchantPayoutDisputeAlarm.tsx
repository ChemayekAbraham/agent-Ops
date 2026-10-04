import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { AlertOctagon, Loader2, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';

interface DisputeRow {
  id: string;
  withdrawal_id: string;
  amount: number;
  message: string;
  status: string;
  created_at: string;
  acknowledged_at: string | null;
}

/**
 * Prominent, unmissable alarm shown at the top of the merchant agent payout
 * dashboard whenever a customer reports that money marked as paid never
 * arrived. The merchant must acknowledge, then resolve with a note.
 */
export function MerchantPayoutDisputeAlarm() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [notes, setNotes] = useState<Record<string, string>>({});

  const { data: disputes = [] } = useQuery({
    queryKey: ['merchant-payout-disputes', user?.id],
    enabled: !!user?.id,
    refetchInterval: 60_000,
    queryFn: async (): Promise<DisputeRow[]> => {
      const { data, error } = await (supabase as any)
        .from('payout_delivery_disputes')
        .select('id, withdrawal_id, amount, message, status, created_at, acknowledged_at')
        .eq('merchant_user_id', user!.id)
        .neq('status', 'resolved')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data as DisputeRow[]) || [];
    },
  });

  const respond = useMutation({
    mutationFn: async ({ id, status, note }: { id: string; status: 'acknowledged' | 'resolved'; note?: string }) => {
      const { error } = await (supabase as any).rpc('respond_payout_dispute', {
        p_dispute_id: id,
        p_status: status,
        p_note: note ?? null,
      });
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast.success(vars.status === 'resolved' ? 'Report closed — thank you.' : 'Marked as seen. Please settle it now.');
      qc.invalidateQueries({ queryKey: ['merchant-payout-disputes'] });
    },
    onError: (e: any) => toast.error(e?.message || 'Could not update this report'),
  });

  if (disputes.length === 0) return null;

  return (
    <div className="rounded-2xl border-2 border-destructive bg-destructive/10 p-4 space-y-4">
      <div className="flex items-start gap-3">
        <AlertOctagon className="h-6 w-6 text-destructive shrink-0 mt-0.5 animate-pulse" />
        <div>
          <p className="text-base font-extrabold text-destructive">
            MONEY NOT DELIVERED — {disputes.length} customer report{disputes.length > 1 ? 's' : ''}
          </p>
          <p className="text-xs text-destructive/80">
            A customer says a payout you marked as paid never reached them. Settle it immediately —
            Financial Ops can see these reports.
          </p>
        </div>
      </div>

      <ul className="space-y-3 list-none p-0 m-0">
        {disputes.map((d) => (
          <li key={d.id} className="rounded-xl border border-destructive/40 bg-card p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-bold">{formatUGX(Number(d.amount || 0))}</p>
              <Badge variant={d.status === 'acknowledged' ? 'secondary' : 'destructive'}>
                {d.status === 'acknowledged' ? 'Seen — unresolved' : 'New'}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Reported {format(new Date(d.created_at), 'MMM d • h:mm a')}
            </p>
            <p className="text-sm text-foreground whitespace-pre-wrap">{d.message}</p>

            {d.status === 'open' ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={respond.isPending}
                onClick={() => respond.mutate({ id: d.id, status: 'acknowledged' })}
              >
                {respond.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                I have seen this
              </Button>
            ) : (
              <div className="space-y-2">
                <Textarea
                  rows={2}
                  value={notes[d.id] ?? ''}
                  onChange={(e) => setNotes((p) => ({ ...p, [d.id]: e.target.value }))}
                  placeholder="How was it settled? (bank reference, re-sent MoMo TID, cash handed over…)"
                />
                <Button
                  size="sm"
                  className="gap-2"
                  disabled={respond.isPending || (notes[d.id] ?? '').trim().length < 10}
                  onClick={() => respond.mutate({ id: d.id, status: 'resolved', note: notes[d.id] })}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Mark delivered & close
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
