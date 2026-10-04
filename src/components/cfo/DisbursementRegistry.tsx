import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

import { Receipt, Search, Download, RefreshCw, Loader2, CheckCircle2, Clock, AlertTriangle, MapPin, Camera, ExternalLink } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';


type ReconciliationFilter = 'all' | 'pending' | 'confirmed' | 'disputed';

export function DisbursementRegistry() {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ReconciliationFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: records, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['disbursement-registry'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('disbursement_records')
        .select('*')
        .order('disbursed_at', { ascending: false })
        .limit(500);
      if (error) throw error;

      // Get profiles for tenant/agent
      const userIds = new Set<string>();
      for (const r of data || []) {
        if (r.tenant_id) userIds.add(r.tenant_id);
        if (r.agent_id) userIds.add(r.agent_id);
        if (r.disbursed_by) userIds.add(r.disbursed_by);
      }
      const ids = Array.from(userIds);
      const profileMap = new Map<string, string>();
      if (ids.length > 0) {
        const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', ids);
        for (const p of profiles || []) profileMap.set(p.id, p.full_name);
      }

      // Get delivery confirmations
      const disbIds = (data || []).map(d => d.id);
      const confirmMap = new Map<string, any>();
      if (disbIds.length > 0) {
        const { data: confs } = await supabase
          .from('agent_delivery_confirmations')
          .select('*')
          .in('disbursement_id', disbIds);
        for (const c of confs || []) confirmMap.set(c.disbursement_id, c);
      }

      return (data || []).map(r => ({
        ...r,
        tenant_name: profileMap.get(r.tenant_id) || 'Unknown',
        agent_name: r.agent_id ? profileMap.get(r.agent_id) || 'Unknown' : '-',
        disbursed_by_name: r.disbursed_by ? profileMap.get(r.disbursed_by) || 'System' : 'System',
        delivery_confirmation: confirmMap.get(r.id) || null,
      }));
    },
    staleTime: 30_000,
  });

  const allRows = records || [];

  const filtered = useMemo(() => {
    let result = allRows;
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(r => r.tenant_name.toLowerCase().includes(q) || r.agent_name.toLowerCase().includes(q) || (r.transaction_reference || '').toLowerCase().includes(q));
    }
    if (filter === 'pending') result = result.filter(r => r.reconciliation_status === 'pending');
    if (filter === 'confirmed') result = result.filter(r => r.reconciliation_status === 'confirmed');
    if (filter === 'disputed') result = result.filter(r => r.reconciliation_status === 'disputed');
    return result;
  }, [allRows, search, filter]);

  const stats = useMemo(() => {
    const total = allRows.length;
    const confirmed = allRows.filter(r => r.reconciliation_status === 'confirmed').length;
    const pending = allRows.filter(r => r.reconciliation_status === 'pending').length;
    const totalAmount = allRows.reduce((s, r) => s + Number(r.amount), 0);
    return { total, confirmed, pending, totalAmount };
  }, [allRows]);

  const selected = selectedId ? allRows.find(r => r.id === selectedId) : null;

  const statusBadge = (status: string) => {
    if (status === 'confirmed') return <Badge className="bg-success/10 text-success border-success/30 text-[10px]"><CheckCircle2 className="h-3 w-3 mr-1" />Confirmed</Badge>;
    if (status === 'disputed') return <Badge variant="destructive" className="text-[10px]"><AlertTriangle className="h-3 w-3 mr-1" />Disputed</Badge>;
    return <Badge variant="outline" className="text-[10px]"><Clock className="h-3 w-3 mr-1" />Pending</Badge>;
  };

  function exportCSV() {
    const header = 'Date,Tenant,Agent,Amount,Method,Reference,Status,Agent Confirmed\n';
    const body = filtered.map(r =>
      `"${format(new Date(r.disbursed_at), 'yyyy-MM-dd')}","${r.tenant_name}","${r.agent_name}",${r.amount},"${r.payout_method}","${r.transaction_reference || ''}","${r.reconciliation_status}","${r.agent_confirmed ? 'Yes' : 'No'}"`
    ).join('\n');
    const blob = new Blob([header + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `disbursements_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="border-2"><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground uppercase tracking-wider">Total Payouts</p><p className="text-2xl font-bold">{stats.total}</p></CardContent></Card>
        <Card className="border-2"><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground uppercase tracking-wider">Confirmed</p><p className="text-2xl font-bold text-success">{stats.confirmed}</p></CardContent></Card>
        <Card className="border-2"><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground uppercase tracking-wider">Pending</p><p className="text-2xl font-bold text-warning">{stats.pending}</p></CardContent></Card>
        <Card className="border-2"><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground uppercase tracking-wider">Total Disbursed</p><p className="text-lg font-bold font-mono">{formatUGX(stats.totalAmount)}</p></CardContent></Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base flex items-center gap-2"><Receipt className="h-4 w-4 text-primary" />Disbursement Registry</CardTitle>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={exportCSV} disabled={filtered.length === 0}><Download className="h-3 w-3 mr-1" />CSV</Button>
              <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>{isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}</Button>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 pt-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input placeholder="Search tenant, agent, reference..." value={search} onChange={e => setSearch(e.target.value)} className="pl-8 h-8 text-sm" />
            </div>
            <Select value={filter} onValueChange={v => setFilter(v as ReconciliationFilter)}>
              <SelectTrigger className="w-full sm:w-[140px] h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All ({allRows.length})</SelectItem>
                <SelectItem value="pending">Pending ({allRows.filter(r => r.reconciliation_status === 'pending').length})</SelectItem>
                <SelectItem value="confirmed">Confirmed ({allRows.filter(r => r.reconciliation_status === 'confirmed').length})</SelectItem>
                <SelectItem value="disputed">Disputed ({allRows.filter(r => r.reconciliation_status === 'disputed').length})</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground"><Receipt className="h-12 w-12 mx-auto mb-3 opacity-30" /><p className="font-semibold">No disbursements found</p></div>
          ) : (
            <div className="overflow-x-auto -mx-4 sm:mx-0">
              <table className="w-full min-w-[600px] text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground uppercase tracking-wider">
                    <th className="text-left py-2 px-3">Date</th>
                    <th className="text-left py-2 px-3">Tenant</th>
                    <th className="text-left py-2 px-3">Agent</th>
                    <th className="text-right py-2 px-3">Amount</th>
                    <th className="text-center py-2 px-3">Method</th>
                    <th className="text-center py-2 px-3">Receipt</th>
                    <th className="text-center py-2 px-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 200).map(row => (
                    <tr key={row.id} className="border-b last:border-0 hover:bg-muted/30 cursor-pointer" onClick={() => setSelectedId(row.id)}>
                      <td className="py-2.5 px-3 text-xs">{format(new Date(row.disbursed_at), 'dd MMM yyyy')}</td>
                      <td className="py-2.5 px-3 font-medium truncate max-w-[120px]">{row.tenant_name}</td>
                      <td className="py-2.5 px-3 truncate max-w-[100px]">{row.agent_name}</td>
                      <td className="py-2.5 px-3 text-right font-mono text-xs font-bold">{formatUGX(Number(row.amount))}</td>
                      <td className="py-2.5 px-3 text-center"><Badge variant="outline" className="text-[10px]">{row.payout_method}</Badge></td>
                      <td className="py-2.5 px-3 text-center">
                        {row.delivery_confirmation ? <Camera className="h-4 w-4 text-success mx-auto" /> : <span className="text-muted-foreground text-xs">-</span>}
                      </td>
                      <td className="py-2.5 px-3 text-center">{statusBadge(row.reconciliation_status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Detail Dialog */}
      <Dialog open={!!selected} onOpenChange={() => setSelectedId(null)}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Receipt className="h-5 w-5 text-primary" />Disbursement Detail</DialogTitle></DialogHeader>
          {selected && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><p className="text-xs text-muted-foreground">Tenant</p><p className="font-medium">{selected.tenant_name}</p></div>
                <div><p className="text-xs text-muted-foreground">Agent</p><p className="font-medium">{selected.agent_name}</p></div>
                <div><p className="text-xs text-muted-foreground">Amount</p><p className="font-bold font-mono">{formatUGX(Number(selected.amount))}</p></div>
                <div><p className="text-xs text-muted-foreground">Method</p><p>{selected.payout_method}</p></div>
                <div><p className="text-xs text-muted-foreground">Reference</p><p className="font-mono text-xs">{selected.transaction_reference || '-'}</p></div>
                <div><p className="text-xs text-muted-foreground">Disbursed By</p><p>{selected.disbursed_by_name}</p></div>
                <div><p className="text-xs text-muted-foreground">Date</p><p>{format(new Date(selected.disbursed_at), 'dd MMM yyyy HH:mm')}</p></div>
                <div><p className="text-xs text-muted-foreground">Status</p>{statusBadge(selected.reconciliation_status)}</div>
              </div>

              {selected.delivery_confirmation && (
                <Card className="bg-success/5 border-success/20">
                  <CardContent className="p-3 space-y-2">
                    <p className="text-xs font-bold uppercase tracking-wider text-success flex items-center gap-1"><CheckCircle2 className="h-3 w-3" />Agent Delivery Confirmed</p>
                    <p className="text-xs">Confirmed at: {format(new Date(selected.delivery_confirmation.confirmed_at), 'dd MMM yyyy HH:mm')}</p>
                    {selected.delivery_confirmation.latitude && (
                      <a href={`https://www.google.com/maps?q=${selected.delivery_confirmation.latitude},${selected.delivery_confirmation.longitude}`} target="_blank" rel="noopener noreferrer" className="text-xs text-primary flex items-center gap-1">
                        <MapPin className="h-3 w-3" />View GPS Location <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    {selected.delivery_confirmation.photo_urls?.length > 0 && (
                      <div className="flex gap-2 flex-wrap">
                        {selected.delivery_confirmation.photo_urls.map((url: string, i: number) => (
                          <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                            <img src={url} alt={`Receipt ${i + 1}`} className="h-16 w-16 object-cover rounded border" />
                          </a>
                        ))}
                      </div>
                    )}
                    {selected.delivery_confirmation.notes && <p className="text-xs text-muted-foreground">{selected.delivery_confirmation.notes}</p>}
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
