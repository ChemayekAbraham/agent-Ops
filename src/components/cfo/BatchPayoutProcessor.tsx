import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Layers, Loader2, CheckCircle2, Banknote } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { excludePartnerReservedPlans } from '@/lib/partnerReservedPlans';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { CfoApprovalGate } from '@/components/cfo/CfoApprovalGate';

export function BatchPayoutProcessor() {
  const { user } = useAuth();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchRef, setBatchRef] = useState('');
  const qc = useQueryClient();

  const { data: pending, isLoading } = useQuery({
    queryKey: ['batch-payout-pending'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('rent_requests')
        .select('id, rent_amount, tenant_id, status, created_at')
        .eq('status', 'coo_approved')
        .order('created_at', { ascending: true });
      if (error) throw error;

      // Plans a partner is self-funding are disbursed by Partner Ops approval,
      // not by the company float — keep them out of this queue.
      const rows = await excludePartnerReservedPlans(data || []);

      const userIds = [...new Set(rows.map(r => r.tenant_id))];
      const profileMap = new Map<string, string>();
      if (userIds.length > 0) {
        const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', userIds);
        for (const p of profiles || []) profileMap.set(p.id, p.full_name);
      }

      return rows.map(r => ({ ...r, amount: r.rent_amount, tenant_name: profileMap.get(r.tenant_id) || 'Unknown' }));
    },
    staleTime: 30_000,
  });

  const items = pending || [];
  const selectedItems = items.filter(i => selected.has(i.id));
  const totalSelected = selectedItems.reduce((s, i) => s + i.amount, 0);
  const allSelected = items.length > 0 && selected.size === items.length;

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(items.map(i => i.id)));
  };

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const batchApprove = useMutation({
    mutationFn: async () => {
      if (!batchRef.trim()) throw new Error('Enter a batch reference');
      for (const id of selected) {
        const { error } = await supabase.functions.invoke('fund-agent-landlord-float', {
          body: { rent_request_id: id, notes: `Batch: ${batchRef}` },
        });
        if (error) throw error;
      }

      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: 'cfo_batch_payout_processed',
        table_name: 'rent_requests',
        record_id: batchRef,
        metadata: {
          batch_reference: batchRef,
          count: selected.size,
          rent_request_ids: Array.from(selected),
        },
      });
    },
    onSuccess: () => {
      toast.success(`${selected.size} payouts processed`);
      setSelected(new Set());
      setBatchRef('');
      qc.invalidateQueries({ queryKey: ['batch-payout-pending'] });
      qc.invalidateQueries({ queryKey: ['cfo-actions-log'] });
    },
    onError: (e: any) => toast.error(e.message || 'Batch failed'),
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Layers className="h-4 w-4 text-primary" />
          Batch Payout Processor
          {items.length > 0 && <Badge variant="outline" className="text-[10px] ml-1">{items.length} awaiting</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : items.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-success" />
            <p className="font-medium">No Pending Payouts</p>
            <p className="text-xs">All disbursements have been processed</p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Select all */}
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
                Select all ({items.length})
              </label>
              {selected.size > 0 && (
                <Badge className="bg-primary/10 text-primary border-primary/30">
                  {selected.size} selected · {formatUGX(totalSelected)}
                </Badge>
              )}
            </div>

            {/* List */}
            <div className="space-y-1 max-h-[300px] overflow-y-auto">
              {items.map(item => (
                <div key={item.id} className={cn('flex items-center gap-3 p-2 rounded-lg border text-sm', selected.has(item.id) && 'bg-primary/5 border-primary/20')}>
                  <Checkbox checked={selected.has(item.id)} onCheckedChange={() => toggle(item.id)} />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{item.tenant_name}</p>
                    <p className="text-xs text-muted-foreground">{format(new Date(item.created_at), 'dd MMM yyyy')}</p>
                  </div>
                  <p className="font-mono font-bold text-xs">{formatUGX(item.amount)}</p>
                </div>
              ))}
            </div>

            {/* Batch actions */}
            {selected.size > 0 && (
              <CfoApprovalGate>
              <div className="flex items-center gap-2 pt-2 border-t">
                <Input placeholder="Batch reference (e.g. MoMo-2024-01)" value={batchRef} onChange={e => setBatchRef(e.target.value)} className="h-8 text-sm flex-1" />
                <Button size="sm" onClick={() => batchApprove.mutate()} disabled={batchApprove.isPending || !batchRef.trim()}>
                  {batchApprove.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Banknote className="h-3 w-3 mr-1" />}
                  Disburse ({selected.size})
                </Button>
              </div>
              </CfoApprovalGate>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
