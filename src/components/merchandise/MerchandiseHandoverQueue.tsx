import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, PackageCheck } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';

interface Row {
  sale_id: string; item_name: string; quantity: number; selected_size: string | null;
  total_revenue: number; agent_name: string | null; agent_phone: string | null; created_at: string;
}

/** Company-issued orders that are fully approved and waiting for a handler to hand them over. */
export function MerchandiseHandoverQueue() {
  const qc = useQueryClient();
  const [row, setRow] = useState<Row | null>(null);
  const [note, setNote] = useState('');

  const { data: rows = [], isLoading, error } = useQuery({
    queryKey: ['merchandise-handover-queue'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('list_merchandise_handover_queue' as any);
      if (error) throw error;
      return (data || []) as Row[];
    },
  });

  const confirm = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('confirm_merchandise_handover' as any, { p_sale_id: row!.sale_id, p_note: note.trim() });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Marked as issued. Repayment plan started.');
      setRow(null); setNote('');
      qc.invalidateQueries({ queryKey: ['merchandise-handover-queue'] });
      qc.invalidateQueries({ queryKey: ['merchandise'], exact: false });
    },
    onError: (e: any) => toast.error(e?.message || 'Could not confirm handover'),
  });

  if (error) return null; // not a company handler
  if (isLoading) return <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin" /></div>;

  return (
    <div className="rounded-xl border bg-card p-4 space-y-3">
      <h3 className="flex items-center gap-2 font-semibold">
        <PackageCheck className="h-4 w-4" /> Awaiting handover (company issued)
      </h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No approved company items waiting to be handed over.</p>
      ) : rows.map((r) => (
        <div key={r.sale_id} className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <div className="font-medium">{r.agent_name || 'Unknown agent'}</div>
            <p className="text-sm text-muted-foreground">
              {r.item_name}{r.quantity > 1 ? ` × ${r.quantity}` : ''}{r.selected_size ? ` · ${r.selected_size}` : ''} · {formatUGX(Number(r.total_revenue || 0))}
              {r.agent_phone ? ` · ${r.agent_phone}` : ''}
            </p>
          </div>
          <Button size="sm" onClick={() => setRow(r)}>Confirm issued</Button>
        </div>
      ))}

      <Dialog open={!!row} onOpenChange={(o) => !o && setRow(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Confirm item handed over</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            {row?.item_name} to {row?.agent_name}. Their repayment plan starts as soon as you confirm.
          </p>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Handover note, e.g. where and who received it (at least 10 characters)" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRow(null)}>Cancel</Button>
            <Button disabled={note.trim().length < 10 || confirm.isPending} onClick={() => confirm.mutate()}>
              {confirm.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}Confirm issued
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
