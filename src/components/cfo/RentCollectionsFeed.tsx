import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CompactAmount } from '@/components/ui/CompactAmount';
import { Loader2, Receipt, Banknote, TrendingUp, Users } from 'lucide-react';
import { format, subDays, startOfDay, startOfMonth } from 'date-fns';

interface CollectionRecord {
  id: string;
  amount: number;
  date: string;
  tenantName: string;
  agentName: string;
  method: 'auto' | 'manual';
  status: string;
  landlordInfo?: string;
}

export function RentCollectionsFeed() {
  const [period, setPeriod] = useState<'7d' | '30d' | 'month'>('30d');

  const dateFrom = useMemo(() => {
    if (period === '7d') return subDays(new Date(), 7).toISOString();
    if (period === 'month') return startOfMonth(new Date()).toISOString();
    return subDays(new Date(), 30).toISOString();
  }, [period]);

  // Auto-charges from subscription_charge_logs
  const { data: autoCharges, isLoading: loadingAuto } = useQuery({
    queryKey: ['cfo-auto-collections', dateFrom],
    queryFn: async () => {
      const { data: logs } = await supabase
        .from('subscription_charge_logs')
        .select('id, amount_deducted, charge_amount, charge_date, status, tenant_id, subscription_id, debt_added')
        .gte('charge_date', dateFrom)
        .order('charge_date', { ascending: false })
        .limit(500);

      if (!logs?.length) return [];

      // Get subscription details for agent info
      const subIds = [...new Set(logs.map(l => l.subscription_id))];
      const { data: subs } = await supabase
        .from('subscription_charges')
        .select('id, agent_id, tenant_id, rent_request_id')
        .in('id', subIds);

      const subMap = new Map((subs || []).map(s => [s.id, s]));

      // Resolve profile names
      const userIds = new Set<string>();
      logs.forEach(l => userIds.add(l.tenant_id));
      (subs || []).forEach(s => { if (s.agent_id) userIds.add(s.agent_id); });

      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', [...userIds]);

      const nameMap = new Map((profiles || []).map(p => [p.id, p.full_name || 'Unknown']));

      return logs.map(l => {
        const sub = subMap.get(l.subscription_id);
        return {
          id: l.id,
          amount: l.amount_deducted,
          date: l.charge_date,
          tenantName: nameMap.get(l.tenant_id) || 'Unknown',
          agentName: sub?.agent_id ? (nameMap.get(sub.agent_id) || 'Unknown') : '—',
          method: 'auto' as const,
          status: l.status,
        };
      });
    },
  });

  // Manual collections from general_ledger
  const { data: manualCharges, isLoading: loadingManual } = useQuery({
    queryKey: ['cfo-manual-collections', dateFrom],
    queryFn: async () => {
      const { data: entries } = await supabase
        .from('general_ledger')
        .select('id, user_id, amount, direction, category, created_at, source_id, description, ledger_scope')
        .eq('category', 'rent_repayment')
        .eq('direction', 'cash_out')
        .gte('created_at', dateFrom)
        .order('created_at', { ascending: false })
        .limit(300);

      if (!entries?.length) return [];

      const userIds = [...new Set(entries.filter(e => e.user_id).map(e => e.user_id!))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', userIds);

      const nameMap = new Map((profiles || []).map(p => [p.id, p.full_name || 'Unknown']));

      return entries.map(e => ({
        id: e.id,
        amount: e.amount,
        date: e.created_at,
        tenantName: e.user_id ? (nameMap.get(e.user_id) || 'Unknown') : 'Unknown',
        agentName: '—',
        method: 'manual' as const,
        status: 'completed',
        landlordInfo: e.description || undefined,
      }));
    },
  });

  const allCollections = useMemo(() => {
    const combined = [...(autoCharges || []), ...(manualCharges || [])];
    return combined.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [autoCharges, manualCharges]);

  const todayStr = startOfDay(new Date()).toISOString();
  const totalToday = useMemo(
    () => allCollections.filter(c => c.date >= todayStr).reduce((s, c) => s + c.amount, 0),
    [allCollections, todayStr]
  );
  const totalPeriod = useMemo(
    () => allCollections.reduce((s, c) => s + c.amount, 0),
    [allCollections]
  );
  const autoCount = useMemo(() => allCollections.filter(c => c.method === 'auto').length, [allCollections]);
  const manualCount = useMemo(() => allCollections.filter(c => c.method === 'manual').length, [allCollections]);

  const isLoading = loadingAuto || loadingManual;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Receipt className="h-5 w-5 text-primary" />
          Rent Collections
        </h1>
        <Select value={period} onValueChange={(v: '7d' | '30d' | 'month') => setPeriod(v)}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
            <SelectItem value="month">This month</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Collected Today</p>
            <p className="text-lg font-bold text-primary"><CompactAmount value={totalToday} /></p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Period Total</p>
            <p className="text-lg font-bold"><CompactAmount value={totalPeriod} /></p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground flex items-center gap-1"><TrendingUp className="h-3 w-3" /> Auto</p>
            <p className="text-lg font-bold">{autoCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground flex items-center gap-1"><Banknote className="h-3 w-3" /> Manual</p>
            <p className="text-lg font-bold">{manualCount}</p>
          </CardContent>
        </Card>
      </div>

      {/* Collections Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Users className="h-4 w-4" />
            All Collections ({allCollections.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : allCollections.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No collections found for this period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allCollections.slice(0, 100).map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {format(new Date(c.date), 'dd MMM yyyy HH:mm')}
                    </TableCell>
                    <TableCell className="text-sm font-medium">{c.tenantName}</TableCell>
                    <TableCell className="text-sm">{c.agentName}</TableCell>
                    <TableCell>
                      <CompactAmount value={c.amount} className="font-semibold" />
                    </TableCell>
                    <TableCell>
                      <Badge variant={c.method === 'auto' ? 'secondary' : 'outline'} className="text-xs">
                        {c.method === 'auto' ? '⚡ Auto' : '✋ Manual'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={c.status === 'success' || c.status === 'completed' ? 'default' : c.status === 'partial' ? 'secondary' : 'destructive'}
                        className="text-xs"
                      >
                        {c.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
