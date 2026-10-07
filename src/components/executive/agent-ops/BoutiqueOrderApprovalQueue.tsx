import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, ShoppingBag } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FulfilmentBadge } from '@/components/merchandise/fulfilmentType';
import { formatUGX } from '@/lib/businessAdvanceCalculations';

type Stage = 'coo' | 'cfo';
interface Row {
  sale_id: string; item_name: string; quantity: number; selected_size: string | null;
  total_revenue: number; payment_plan: string; order_status: string;
  agent_name: string | null; agent_phone: string | null; created_at: string;
}

const STATUS_LABEL: Record<string, string> = {
  pending_approval: 'Awaiting Agent Ops', submitted: 'Awaiting Agent Ops', processing: 'Awaiting Agent Ops',
  ops_approved: 'Awaiting COO', coo_approved: 'COO approved — awaiting CFO',
  awaiting_handover: 'Awaiting handover', issued: 'Issued', completed: 'Issued · fully paid',
};

export function BoutiqueOrderApprovalQueue({ stage }: { stage: Stage }) {
  const qc = useQueryClient();
  const [rejectRow, setRejectRow] = useState<Row | null>(null);
  const [reason, setReason] = useState('');
  const key = ['boutique-approval-queue', stage];

  const { data: rows = [], isLoading } = useQuery({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('list_boutique_approval_queue' as any, { p_stage: stage });
      if (error) throw error;
      return (data || []) as Row[];
    },
  });

  // Category per catalog item: company issued (handover) vs out-sourced (money to wallet).
  const { data: typeByItem = {} } = useQuery({
    queryKey: ['merchandise-fulfilment-types'],
    queryFn: async () => {
      const { data } = await (supabase as any).from('merchandise_catalog').select('item_name, fulfilment_type');
      const m: Record<string, string> = {};
      (data || []).forEach((c: any) => { if (c.fulfilment_type) m[c.item_name.trim().toLowerCase()] = c.fulfilment_type; });
      return m;
    },
  });
  const typeOf = (r: Row) => typeByItem[(r.item_name || '').trim().toLowerCase()];

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['boutique-approval-queue'] });
    qc.invalidateQueries({ queryKey: ['agent-products-overview'], exact: false });
  };

  const approve = useMutation({
    mutationFn: async (id: string) => {
      const fn = stage === 'coo' ? 'coo_approve_boutique_order' : 'cfo_issue_boutique_order';
      const { error } = await supabase.rpc(fn as any, { p_sale_id: id });
      if (error) throw error;
    },
    onSuccess: () => { toast.success(stage === 'coo' ? 'Approved — sent to CFO' : 'Approved'); refresh(); },
    onError: (e: any) => toast.error(e?.message || 'Could not approve'),
  });

  const reject = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('reject_merchandise_purchase' as any, { p_sale_id: rejectRow!.sale_id, p_reason: reason.trim() });
      if (error) throw error;
    },
    onSuccess: () => { toast.success('Order rejected'); setRejectRow(null); setReason(''); refresh(); },
    onError: (e: any) => toast.error(e?.message || 'Could not reject'),
  });

  const actionable = (r: Row) => stage === 'coo' ? r.order_status !== 'coo_approved' : r.order_status === 'coo_approved';

  if (isLoading) return <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  if (!rows.length) return (
    <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
      <ShoppingBag className="mx-auto mb-2 h-6 w-6" />No boutique orders waiting.
    </div>
  );

  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.sale_id} className="flex flex-col gap-2 rounded-xl border bg-card p-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{r.agent_name || 'Unknown agent'}</span>
              <Badge variant="secondary" className="text-[10px]">{STATUS_LABEL[r.order_status] ?? r.order_status}</Badge>
              <FulfilmentBadge type={typeOf(r)} />
            </div>
            <p className="text-sm text-muted-foreground">
              {r.item_name}{r.quantity > 1 ? ` × ${r.quantity}` : ''}{r.selected_size ? ` · ${r.selected_size}` : ''} · {formatUGX(Number(r.total_revenue || 0))}
              {r.agent_phone ? ` · ${r.agent_phone}` : ''} · {new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
            </p>
          </div>
          {actionable(r) && (
            <div className="flex gap-2">
              <Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate(r.sale_id)}>
                {stage === 'coo' ? 'Approve' : typeOf(r) === 'outsourced' ? 'Approve & send to wallet' : typeOf(r) === 'company_issued' ? 'Approve for handover' : 'Approve & issue'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setRejectRow(r)}>Reject</Button>
            </div>
          )}
        </div>
      ))}

      <Dialog open={!!rejectRow} onOpenChange={(o) => !o && setRejectRow(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Reject boutique order</DialogTitle></DialogHeader>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (at least 10 characters)" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectRow(null)}>Cancel</Button>
            <Button variant="destructive" disabled={reason.trim().length < 10 || reject.isPending} onClick={() => reject.mutate()}>Reject</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
