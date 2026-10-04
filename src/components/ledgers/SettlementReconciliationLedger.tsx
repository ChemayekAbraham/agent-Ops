import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { Plus, CheckCircle2, AlertTriangle, Clock } from 'lucide-react';
import { toast } from 'sonner';

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  pending: { label: 'Pending', color: 'bg-amber-500/10 text-amber-700 border-amber-500/30', icon: Clock },
  matched: { label: 'Matched', color: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30', icon: CheckCircle2 },
  discrepancy: { label: 'Discrepancy', color: 'bg-destructive/10 text-destructive border-destructive/30', icon: AlertTriangle },
};

export function SettlementReconciliationLedger() {
  const [statusFilter, setStatusFilter] = useState('all');
  const [channelFilter, setChannelFilter] = useState('all');
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ channel: 'mtn', period_date: '', external_reference: '', external_amount: '', system_amount: '', notes: '' });
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['settlement-recon', statusFilter, channelFilter],
    queryFn: async () => {
      let q = supabase.from('settlement_reconciliation_ledger')
        .select('*')
        .order('period_date', { ascending: false }).limit(200);
      if (statusFilter !== 'all') q = q.eq('status', statusFilter);
      if (channelFilter !== 'all') q = q.eq('channel', channelFilter);
      const { data } = await q;
      return data || [];
    },
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      const extAmt = parseFloat(form.external_amount);
      const sysAmt = parseFloat(form.system_amount);
      if (!extAmt || !sysAmt) throw new Error('Both amounts required');
      if (!form.period_date) throw new Error('Period date required');
      const disc = extAmt - sysAmt;
      const { error } = await supabase.from('settlement_reconciliation_ledger').insert({
        channel: form.channel,
        period_date: form.period_date,
        external_reference: form.external_reference || null,
        external_amount: extAmt,
        system_amount: sysAmt,
        discrepancy_amount: disc,
        status: Math.abs(disc) < 100 ? 'matched' : 'discrepancy',
        notes: form.notes || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Reconciliation entry added');
      setShowAdd(false);
      setForm({ channel: 'mtn', period_date: '', external_reference: '', external_amount: '', system_amount: '', notes: '' });
      queryClient.invalidateQueries({ queryKey: ['settlement-recon'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const resolveMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('settlement_reconciliation_ledger')
        .update({ status: 'matched', reconciled_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Marked as reconciled');
      queryClient.invalidateQueries({ queryKey: ['settlement-recon'] });
    },
  });

  const totals = (data || []).reduce((acc, e) => {
    acc.totalExternal += e.external_amount;
    acc.totalSystem += e.system_amount;
    acc.totalDisc += Math.abs(e.discrepancy_amount);
    if (e.status === 'discrepancy') acc.discCount++;
    return acc;
  }, { totalExternal: 0, totalSystem: 0, totalDisc: 0, discCount: 0 });

  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-2">
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">Provider Total</p>
            <p className="text-lg font-black">{formatUGX(totals.totalExternal)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">System Total</p>
            <p className="text-lg font-black">{formatUGX(totals.totalSystem)}</p>
          </CardContent>
        </Card>
        <Card className={totals.discCount > 0 ? 'border-destructive/20' : 'border-emerald-500/20'}>
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">Net Discrepancy</p>
            <p className={`text-lg font-black ${totals.discCount > 0 ? 'text-destructive' : 'text-emerald-600'}`}>{formatUGX(totals.totalDisc)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">Open Issues</p>
            <p className="text-lg font-black">{totals.discCount}</p>
          </CardContent>
        </Card>
      </div>

      {/* Controls */}
      <div className="flex gap-2">
        <Select value={channelFilter} onValueChange={setChannelFilter}>
          <SelectTrigger className="h-9 text-xs flex-1"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Channels</SelectItem>
            <SelectItem value="mtn">MTN</SelectItem>
            <SelectItem value="airtel">Airtel</SelectItem>
            <SelectItem value="bank">Bank</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-9 text-xs flex-1"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="matched">Matched</SelectItem>
            <SelectItem value="discrepancy">Discrepancy</SelectItem>
          </SelectContent>
        </Select>
        <Dialog open={showAdd} onOpenChange={setShowAdd}>
          <DialogTrigger asChild>
            <Button size="sm" className="h-9 gap-1 text-xs"><Plus className="h-3.5 w-3.5" /></Button>
          </DialogTrigger>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle className="text-sm">New Reconciliation Entry</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <Select value={form.channel} onValueChange={v => setForm(p => ({ ...p, channel: v }))}>
                <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="mtn">MTN MoMo</SelectItem>
                  <SelectItem value="airtel">Airtel Money</SelectItem>
                  <SelectItem value="bank">Bank</SelectItem>
                </SelectContent>
              </Select>
              <Input type="date" value={form.period_date} onChange={e => setForm(p => ({ ...p, period_date: e.target.value }))} className="text-sm" />
              <Input placeholder="External reference" value={form.external_reference} onChange={e => setForm(p => ({ ...p, external_reference: e.target.value }))} className="text-sm" />
              <Input placeholder="Provider amount (UGX)" type="number" value={form.external_amount} onChange={e => setForm(p => ({ ...p, external_amount: e.target.value }))} className="text-sm" />
              <Input placeholder="System amount (UGX)" type="number" value={form.system_amount} onChange={e => setForm(p => ({ ...p, system_amount: e.target.value }))} className="text-sm" />
              <Textarea placeholder="Notes" value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} className="text-sm" rows={2} />
              <Button onClick={() => addMutation.mutate()} disabled={addMutation.isPending} className="w-full">
                {addMutation.isPending ? 'Saving...' : 'Add Entry'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Entries */}
      <div className="space-y-2">
        {isLoading ? (
          <p className="text-xs text-muted-foreground text-center py-6">Loading...</p>
        ) : (data || []).length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">No reconciliation entries</p>
        ) : (data || []).map(entry => {
          const cfg = STATUS_CONFIG[entry.status] || STATUS_CONFIG.pending;
          const Icon = cfg.icon;
          return (
            <Card key={entry.id}>
              <CardContent className="p-3">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className="text-[9px]">{entry.channel?.toUpperCase()}</Badge>
                      <span className="text-[10px] text-muted-foreground">{format(new Date(entry.period_date), 'MMM d, yyyy')}</span>
                    </div>
                    <div className="flex gap-3 mt-1.5">
                      <div>
                        <p className="text-[9px] text-muted-foreground">Provider</p>
                        <p className="text-xs font-bold">{formatUGX(entry.external_amount)}</p>
                      </div>
                      <div>
                        <p className="text-[9px] text-muted-foreground">System</p>
                        <p className="text-xs font-bold">{formatUGX(entry.system_amount)}</p>
                      </div>
                      <div>
                        <p className="text-[9px] text-muted-foreground">Diff</p>
                        <p className={`text-xs font-bold ${entry.discrepancy_amount !== 0 ? 'text-destructive' : 'text-emerald-600'}`}>
                          {entry.discrepancy_amount > 0 ? '+' : ''}{formatUGX(entry.discrepancy_amount)}
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Badge variant="outline" className={`text-[9px] ${cfg.color}`}>
                      <Icon className="h-2.5 w-2.5 mr-0.5" /> {cfg.label}
                    </Badge>
                    {entry.status === 'discrepancy' && (
                      <Button size="sm" variant="outline" className="h-5 text-[9px] px-1.5 mt-1"
                        onClick={() => resolveMutation.mutate(entry.id)}>
                        Resolve
                      </Button>
                    )}
                  </div>
                </div>
                {entry.notes && <p className="text-[10px] text-muted-foreground mt-1.5 italic">{entry.notes}</p>}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
