import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';
import { Home, Loader2, Search, Users, Banknote, TrendingUp, Clock, PlayCircle } from 'lucide-react';

interface Row {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  monthly_rent: number;
  receivable_total: number;
  outstanding_balance: number;
  payout_day: number;
  landlord_uses_wallet: boolean;
  landlord_name: string | null;
  next_due_date: string | null;
  tenant_name?: string;
  tenant_phone?: string;
  agent_name?: string;
}

export function WelileHomesAdminPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [q, setQ] = useState('');
  const [stats, setStats] = useState({ collectedThisMonth: 0, welileNet: 0, pendingPayouts: 0 });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('welile_homes_subscriptions')
        .select('id, tenant_id, agent_id, monthly_rent, receivable_total, outstanding_balance, payout_day, landlord_uses_wallet, landlord_name, next_due_date')
        .eq('mode', 'agent_collection')
        .order('created_at', { ascending: false });
      if (error) throw error;
      const list = (data ?? []) as Row[];
      const ids = Array.from(new Set([...list.map((r) => r.tenant_id), ...list.map((r) => r.agent_id).filter(Boolean) as string[]]));
      if (ids.length) {
        const { data: profs } = await supabase.from('profiles').select('id, full_name, phone').in('id', ids);
        const map = new Map((profs ?? []).map((p: any) => [p.id, p]));
        list.forEach((r) => {
          r.tenant_name = map.get(r.tenant_id)?.full_name ?? 'Tenant';
          r.tenant_phone = map.get(r.tenant_id)?.phone ?? '';
          r.agent_name = r.agent_id ? (map.get(r.agent_id)?.full_name ?? 'Agent') : '—';
        });
      }
      setRows(list);

      const monthStart = new Date();
      monthStart.setDate(1);
      const { data: dues } = await supabase
        .from('welile_homes_monthly_dues')
        .select('amount_collected, welile_net, landlord_net, collection_status, payout_status, period_month');
      let collectedThisMonth = 0, welileNet = 0, pendingPayouts = 0;
      const mKey = monthStart.toISOString().slice(0, 7);
      (dues ?? []).forEach((d: any) => {
        if (String(d.period_month).slice(0, 7) === mKey) collectedThisMonth += Number(d.amount_collected) || 0;
        if (d.collection_status === 'collected') welileNet += Number(d.welile_net) || 0;
        if (d.collection_status === 'collected' && d.payout_status === 'unpaid') pendingPayouts += Number(d.landlord_net) || 0;
      });
      setStats({ collectedThisMonth, welileNet, pendingPayouts });
    } catch (err: any) {
      toast.error('Failed to load Welile Homes: ' + err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runPayouts = async () => {
    setRunning(true);
    try {
      const { data, error } = await supabase.rpc('welile_home_run_landlord_payouts', { p_as_of: new Date().toISOString().slice(0, 10) });
      if (error) throw error;
      const res = data as any;
      toast.success(`Paid ${res?.payouts ?? 0} landlord(s) · ${formatUGX(res?.total_paid ?? 0)}`);
      // Fire-and-forget: send landlords their payout SMS receipts.
      supabase.functions.invoke('welile-homes-sms-dispatch', { body: { since_minutes: 10 } }).catch(() => {});
      load();
    } catch (err: any) {
      toast.error('Payout run failed: ' + err.message);
    } finally { setRunning(false); }
  };

  const filtered = rows.filter((r) => {
    if (!q) return true;
    const s = q.toLowerCase();
    return r.tenant_name?.toLowerCase().includes(s) || r.tenant_phone?.toLowerCase().includes(s) || r.agent_name?.toLowerCase().includes(s);
  });

  const totalReceivable = rows.reduce((a, r) => a + (Number(r.receivable_total) || 0), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="p-3"><div className="flex items-center gap-2"><Users className="h-4 w-4 text-purple-600" /><div><p className="text-xs text-muted-foreground">Enrolled tenants</p><p className="text-lg font-bold">{rows.length}</p></div></div></CardContent></Card>
        <Card><CardContent className="p-3"><div className="flex items-center gap-2"><Banknote className="h-4 w-4 text-blue-600" /><div><p className="text-xs text-muted-foreground">Total receivable</p><p className="text-lg font-bold">{formatUGX(totalReceivable)}</p></div></div></CardContent></Card>
        <Card><CardContent className="p-3"><div className="flex items-center gap-2"><TrendingUp className="h-4 w-4 text-emerald-600" /><div><p className="text-xs text-muted-foreground">Welile net (8%)</p><p className="text-lg font-bold">{formatUGX(stats.welileNet)}</p></div></div></CardContent></Card>
        <Card><CardContent className="p-3"><div className="flex items-center gap-2"><Clock className="h-4 w-4 text-orange-600" /><div><p className="text-xs text-muted-foreground">Pending landlord payouts</p><p className="text-lg font-bold">{formatUGX(stats.pendingPayouts)}</p></div></div></CardContent></Card>
      </div>

      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search tenant or agent..." value={q} onChange={(e) => setQ(e.target.value)} className="pl-10" />
        </div>
        <Button onClick={runPayouts} disabled={running} className="h-10 gap-2">
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
          Run landlord payouts now
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Monthly rent</TableHead>
                  <TableHead>Receivable (×12)</TableHead>
                  <TableHead>Outstanding</TableHead>
                  <TableHead>Payout day</TableHead>
                  <TableHead>Landlord</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-8"><Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" /></TableCell></TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No Welile Homes tenants</TableCell></TableRow>
                ) : filtered.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell><div><p className="font-medium">{r.tenant_name}</p><p className="text-xs text-muted-foreground">{r.tenant_phone}</p></div></TableCell>
                    <TableCell className="text-sm">{r.agent_name}</TableCell>
                    <TableCell>{formatUGX(r.monthly_rent)}</TableCell>
                    <TableCell>{formatUGX(r.receivable_total)}</TableCell>
                    <TableCell className="font-medium text-orange-600">{formatUGX(r.outstanding_balance)}</TableCell>
                    <TableCell>{r.payout_day}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="font-normal">
                        {r.landlord_uses_wallet ? 'Welile wallet' : `Agent float${r.landlord_name ? ` · ${r.landlord_name}` : ''}`}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}