import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, AlertTriangle, CheckCircle2, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format, startOfDay, endOfDay, subDays } from 'date-fns';

interface AgentRecon {
  agent_id: string;
  agent_name: string;
  total_collected: number;
  total_deposited: number;
  discrepancy: number;
  collection_count: number;
  deposit_count: number;
}

export function AgentCashReconciliation() {
  const [data, setData] = useState<AgentRecon[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));

  const fetchReconciliation = async () => {
    setLoading(true);
    try {
      const dateObj = new Date(selectedDate);
      const dayStart = startOfDay(dateObj).toISOString();
      const dayEnd = endOfDay(dateObj).toISOString();

      // Fetch agent collections for the day
      const { data: collections } = await supabase
        .from('agent_collections')
        .select('agent_id, amount').is('reversed_at', null)
        .gte('created_at', dayStart)
        .lte('created_at', dayEnd);

      // Fetch deposits made by agents for the day
      const { data: deposits } = await supabase
        .from('deposit_requests')
        .select('agent_id, amount, user_id')
        .gte('created_at', dayStart)
        .lte('created_at', dayEnd)
        .not('agent_id', 'is', null);

      // Aggregate by agent
      const agentMap = new Map<string, { collected: number; deposited: number; collCount: number; depCount: number }>();

      (collections || []).forEach(c => {
        const entry = agentMap.get(c.agent_id) || { collected: 0, deposited: 0, collCount: 0, depCount: 0 };
        entry.collected += c.amount;
        entry.collCount += 1;
        agentMap.set(c.agent_id, entry);
      });

      (deposits || []).forEach(d => {
        if (!d.agent_id) return;
        const entry = agentMap.get(d.agent_id) || { collected: 0, deposited: 0, collCount: 0, depCount: 0 };
        entry.deposited += d.amount;
        entry.depCount += 1;
        agentMap.set(d.agent_id, entry);
      });

      // Fetch agent names
      const agentIds = [...agentMap.keys()];
      const { data: profiles } = agentIds.length > 0
        ? await supabase.from('profiles').select('id, full_name').in('id', agentIds)
        : { data: [] };

      const nameMap = new Map((profiles || []).map(p => [p.id, p.full_name]));

      const results: AgentRecon[] = agentIds.map(id => {
        const entry = agentMap.get(id)!;
        return {
          agent_id: id,
          agent_name: nameMap.get(id) || 'Unknown',
          total_collected: entry.collected,
          total_deposited: entry.deposited,
          discrepancy: entry.collected - entry.deposited,
          collection_count: entry.collCount,
          deposit_count: entry.depCount,
        };
      }).sort((a, b) => Math.abs(b.discrepancy) - Math.abs(a.discrepancy));

      setData(results);
    } catch (err) {
      console.error('Reconciliation error:', err);
    }
    setLoading(false);
  };

  useEffect(() => { fetchReconciliation(); }, [selectedDate]);

  const flagged = data.filter(d => Math.abs(d.discrepancy) > 1000);
  const clean = data.filter(d => Math.abs(d.discrepancy) <= 1000);
  const totalCollected = data.reduce((s, d) => s + d.total_collected, 0);
  const totalDeposited = data.reduce((s, d) => s + d.total_deposited, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-primary" />
            Agent Cash Reconciliation
          </h1>
          <p className="text-sm text-muted-foreground">Compare collections vs deposits by agent</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
            className="h-9 px-3 rounded-md border border-input bg-background text-sm"
          />
          <Button variant="outline" size="sm" onClick={fetchReconciliation}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-lg font-bold">{formatUGX(totalCollected)}</p>
            <p className="text-[10px] text-muted-foreground flex items-center justify-center gap-1">
              <TrendingUp className="h-3 w-3 text-emerald-500" />Total Collected
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-lg font-bold">{formatUGX(totalDeposited)}</p>
            <p className="text-[10px] text-muted-foreground flex items-center justify-center gap-1">
              <TrendingDown className="h-3 w-3 text-blue-500" />Total Deposited
            </p>
          </CardContent>
        </Card>
        <Card className={Math.abs(totalCollected - totalDeposited) > 5000 ? 'border-destructive/50' : 'border-emerald-500/50'}>
          <CardContent className="p-3 text-center">
            <p className={`text-lg font-bold ${Math.abs(totalCollected - totalDeposited) > 5000 ? 'text-destructive' : 'text-emerald-600'}`}>
              {formatUGX(Math.abs(totalCollected - totalDeposited))}
            </p>
            <p className="text-[10px] text-muted-foreground">Net Discrepancy</p>
          </CardContent>
        </Card>
      </div>

      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : data.length === 0 ? (
        <p className="text-center py-8 text-sm text-muted-foreground">No agent activity for this date</p>
      ) : (
        <div className="space-y-4">
          {flagged.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-bold text-destructive flex items-center gap-1">
                <AlertTriangle className="h-4 w-4" />
                Flagged Discrepancies ({flagged.length})
              </h3>
              {flagged.map(agent => (
                <Card key={agent.agent_id} className="border-destructive/30">
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-bold text-sm">{agent.agent_name}</p>
                        <p className="text-xs text-muted-foreground">
                          {agent.collection_count} collections · {agent.deposit_count} deposits
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">Collected: {formatUGX(agent.total_collected)}</p>
                        <p className="text-xs text-muted-foreground">Deposited: {formatUGX(agent.total_deposited)}</p>
                        <Badge variant="destructive" className="text-xs mt-1">
                          Gap: {formatUGX(Math.abs(agent.discrepancy))}
                        </Badge>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {clean.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-1">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                Reconciled ({clean.length})
              </h3>
              {clean.map(agent => (
                <Card key={agent.agent_id} className="border-border/50">
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium text-sm">{agent.agent_name}</p>
                        <p className="text-xs text-muted-foreground">
                          {agent.collection_count} collections · {agent.deposit_count} deposits
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs">{formatUGX(agent.total_collected)}</p>
                        <Badge variant="secondary" className="text-[9px]">
                          <CheckCircle2 className="h-2.5 w-2.5 mr-0.5 text-emerald-500" />Matched
                        </Badge>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
