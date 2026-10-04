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
import { AlertTriangle, CheckCircle2, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';

const STATUS_COLORS: Record<string, string> = {
  unmatched: 'bg-amber-500/10 text-amber-700 border-amber-500/30',
  matched: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
  refunded: 'bg-blue-500/10 text-blue-700 border-blue-500/30',
  written_off: 'bg-destructive/10 text-destructive border-destructive/30',
};

export function SuspenseLedger() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showAdd, setShowAdd] = useState(false);
  const [newEntry, setNewEntry] = useState({ amount: '', source_channel: 'mtn', reference_id: '', depositor_phone: '', depositor_name: '', notes: '' });
  const queryClient = useQueryClient();

  const { data: entries, isLoading } = useQuery({
    queryKey: ['suspense-ledger', statusFilter],
    queryFn: async () => {
      let q = supabase.from('suspense_ledger').select('*, matched_user:matched_to_user_id(full_name)').order('created_at', { ascending: false }).limit(100);
      if (statusFilter !== 'all') q = q.eq('status', statusFilter);
      const { data } = await q;
      return data || [];
    },
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      const amt = parseFloat(newEntry.amount);
      if (!amt || amt <= 0) throw new Error('Invalid amount');
      const { error } = await supabase.from('suspense_ledger').insert({
        amount: amt,
        source_channel: newEntry.source_channel,
        reference_id: newEntry.reference_id || null,
        depositor_phone: newEntry.depositor_phone || null,
        depositor_name: newEntry.depositor_name || null,
        notes: newEntry.notes || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Suspense entry added');
      setShowAdd(false);
      setNewEntry({ amount: '', source_channel: 'mtn', reference_id: '', depositor_phone: '', depositor_name: '', notes: '' });
      queryClient.invalidateQueries({ queryKey: ['suspense-ledger'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const resolveMutation = useMutation({
    mutationFn: async ({ id, status, notes }: { id: string; status: string; notes?: string }) => {
      const updates: any = { status, updated_at: new Date().toISOString() };
      if (status === 'matched') updates.matched_at = new Date().toISOString();
      if (status === 'refunded') updates.refunded_at = new Date().toISOString();
      if (status === 'written_off') updates.written_off_at = new Date().toISOString();
      if (notes) updates.notes = notes;
      const { error } = await supabase.from('suspense_ledger').update(updates).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Entry resolved');
      queryClient.invalidateQueries({ queryKey: ['suspense-ledger'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const filtered = (entries || []).filter(e =>
    !search || e.depositor_name?.toLowerCase().includes(search.toLowerCase()) ||
    e.depositor_phone?.includes(search) || e.reference_id?.includes(search)
  );

  const unmatchedTotal = (entries || []).filter(e => e.status === 'unmatched').reduce((s, e) => s + e.amount, 0);

  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-2">
        <Card className="border-amber-500/20">
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">Unmatched Funds</p>
            <p className="text-lg font-black text-amber-600">{formatUGX(unmatchedTotal)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">Total Entries</p>
            <p className="text-lg font-black">{entries?.length || 0}</p>
          </CardContent>
        </Card>
      </div>

      {/* Controls */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} className="pl-8 h-9 text-xs" />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-28 h-9 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="unmatched">Unmatched</SelectItem>
            <SelectItem value="matched">Matched</SelectItem>
            <SelectItem value="refunded">Refunded</SelectItem>
            <SelectItem value="written_off">Written Off</SelectItem>
          </SelectContent>
        </Select>
        <Dialog open={showAdd} onOpenChange={setShowAdd}>
          <DialogTrigger asChild>
            <Button size="sm" className="h-9 gap-1 text-xs"><Plus className="h-3.5 w-3.5" /> Add</Button>
          </DialogTrigger>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle className="text-sm">Log Suspense Entry</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <Input placeholder="Amount (UGX)" value={newEntry.amount} onChange={e => setNewEntry(p => ({ ...p, amount: e.target.value }))} type="number" className="text-sm" />
              <Select value={newEntry.source_channel} onValueChange={v => setNewEntry(p => ({ ...p, source_channel: v }))}>
                <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="mtn">MTN MoMo</SelectItem>
                  <SelectItem value="airtel">Airtel Money</SelectItem>
                  <SelectItem value="bank">Bank</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
              <Input placeholder="Reference / TID" value={newEntry.reference_id} onChange={e => setNewEntry(p => ({ ...p, reference_id: e.target.value }))} className="text-sm" />
              <Input placeholder="Depositor phone" value={newEntry.depositor_phone} onChange={e => setNewEntry(p => ({ ...p, depositor_phone: e.target.value }))} className="text-sm" />
              <Input placeholder="Depositor name" value={newEntry.depositor_name} onChange={e => setNewEntry(p => ({ ...p, depositor_name: e.target.value }))} className="text-sm" />
              <Textarea placeholder="Notes" value={newEntry.notes} onChange={e => setNewEntry(p => ({ ...p, notes: e.target.value }))} className="text-sm" rows={2} />
              <Button onClick={() => addMutation.mutate()} disabled={addMutation.isPending} className="w-full">
                {addMutation.isPending ? 'Saving...' : 'Log Entry'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Entries List */}
      <div className="space-y-2">
        {isLoading ? (
          <p className="text-xs text-muted-foreground text-center py-6">Loading...</p>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">No suspense entries</p>
        ) : filtered.map(entry => (
          <Card key={entry.id} className="border-l-4" style={{ borderLeftColor: entry.status === 'unmatched' ? 'hsl(var(--chart-4))' : 'hsl(var(--chart-2))' }}>
            <CardContent className="p-3">
              <div className="flex justify-between items-start">
                <div>
                  <p className="text-sm font-bold">{formatUGX(entry.amount)}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {entry.source_channel?.toUpperCase()} · {entry.reference_id || 'No ref'}
                  </p>
                  {entry.depositor_name && <p className="text-[10px] mt-0.5">{entry.depositor_name} · {entry.depositor_phone}</p>}
                  <p className="text-[9px] text-muted-foreground mt-1">{format(new Date(entry.created_at), 'MMM d, HH:mm')}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge variant="outline" className={`text-[9px] ${STATUS_COLORS[entry.status] || ''}`}>
                    {entry.status === 'unmatched' && <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />}
                    {entry.status === 'matched' && <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />}
                    {entry.status}
                  </Badge>
                  {entry.status === 'unmatched' && (
                    <div className="flex gap-1 mt-1">
                      <Button size="sm" variant="outline" className="h-6 text-[9px] px-2" onClick={() => resolveMutation.mutate({ id: entry.id, status: 'matched' })}>
                        Match
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 text-[9px] px-2 text-destructive" onClick={() => resolveMutation.mutate({ id: entry.id, status: 'written_off' })}>
                        Write Off
                      </Button>
                    </div>
                  )}
                </div>
              </div>
              {entry.notes && <p className="text-[10px] text-muted-foreground mt-1 italic">{entry.notes}</p>}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
