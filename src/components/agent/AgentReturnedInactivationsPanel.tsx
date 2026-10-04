import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticTap } from '@/lib/haptics';
import { Undo2, Phone, Loader2, Check, AlertTriangle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface ReturnedRow {
  rent_request_id: string;
  tenant_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  ops_notes: string | null;
  rejected_at: string;
  reviewer_name: string | null;
  outstanding: number | null;
  daily_repayment: number | null;
  agent_seen_at: string | null;
}

/**
 * Tenant Ops rejected this agent's "not paying" flag: the tenant is back on the
 * agent's book and must be worked again. The agent reads the Ops comment and
 * confirms they've seen it, which closes the follow-up task.
 */
export function AgentReturnedInactivationsPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data = [] } = useQuery({
    queryKey: ['agent-returned-inactivations'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_returned_inactivations');
      if (error) throw error;
      return (data ?? []) as ReturnedRow[];
    },
    staleTime: 60_000,
  });

  const ack = useMutation({
    mutationFn: async (rentRequestId: string) => {
      const { error } = await supabase.rpc('agent_ack_returned_inactivation', {
        p_rent_request_id: rentRequestId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-returned-inactivations'] });
      toast({ title: 'Got it', description: 'Tenant is back on your collection list.' });
    },
    onError: (e: any) =>
      toast({ title: 'Could not update', description: e?.message, variant: 'destructive' }),
  });

  if (data.length === 0) return null;

  return (
    <div className="rounded-2xl border-2 border-warning/40 bg-warning/5 p-4 space-y-3 animate-fade-in">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-xl bg-warning/15 shrink-0">
          <Undo2 className="h-5 w-5 text-warning" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold flex items-center flex-wrap gap-2">
            {data.length} tenant{data.length > 1 ? 's' : ''} sent back by Tenant Ops
            <Badge variant="secondary" className="h-5 gap-1">
              <AlertTriangle className="h-3 w-3" /> Action needed
            </Badge>
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Your “not paying” flag was rejected. These tenants are active again on your book —
            resume collection and update their status.
          </p>
        </div>
      </div>

      <ul className="space-y-2">
        {data.map((row) => (
          <li
            key={row.rent_request_id}
            className="rounded-xl border border-warning/25 bg-card/60 p-3 space-y-2"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">{row.tenant_name ?? 'Tenant'}</p>
                <p className="text-[11px] text-muted-foreground">
                  Owing {formatUGX(row.outstanding ?? 0)} · Daily {formatUGX(row.daily_repayment ?? 0)}
                </p>
              </div>
              <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                {formatDistanceToNow(new Date(row.rejected_at), { addSuffix: true })}
              </span>
            </div>

            <p className="text-xs rounded-lg bg-warning/10 border border-warning/20 p-2">
              <span className="text-muted-foreground">
                {row.reviewer_name ? `${row.reviewer_name} (Tenant Ops)` : 'Tenant Ops'}:
              </span>{' '}
              {row.ops_notes ?? 'No comment provided'}
            </p>

            <div className="flex items-center gap-1.5">
              {row.tenant_phone && (
                <a href={`tel:${row.tenant_phone}`} className="flex-1">
                  <Button size="sm" variant="outline" className="w-full h-9 text-xs gap-1">
                    <Phone className="h-3 w-3" /> Call tenant
                  </Button>
                </a>
              )}
              <Button
                size="sm"
                className={row.tenant_phone ? 'flex-1 h-9 text-xs gap-1' : 'w-full h-9 text-xs gap-1'}
                onClick={() => { hapticTap(); ack.mutate(row.rent_request_id); }}
                disabled={ack.isPending}
              >
                {ack.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Got it
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default AgentReturnedInactivationsPanel;