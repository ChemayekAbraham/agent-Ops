import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { ChevronDown, RefreshCw, Search } from 'lucide-react';
import { format } from 'date-fns';

interface TraceLeg {
  user_id?: string;
  amount: number;
  direction: 'cash_in' | 'cash_out';
  category: string;
  ledger_scope: string;
  description?: string;
}

interface Trace {
  id: string;
  created_at: string;
  agent_id: string;
  tenant_id: string;
  rent_request_id: string;
  landlord_id: string | null;
  amount: number;
  commission_earned: number;
  outstanding_before: number;
  outstanding_after: number;
  float_before: number;
  float_after: number;
  transaction_group: string | null;
  tracking_id: string | null;
  legs: TraceLeg[];
  notes: string | null;
}

const fmtUGX = (n: number) =>
  `UGX ${Number(n || 0).toLocaleString('en-UG', { maximumFractionDigits: 0 })}`;

export function AgentAllocationTracesPanel() {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);

  const [from, setFrom] = useState(weekAgo);
  const [to, setTo] = useState(today);
  const [agentId, setAgentId] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [txnGroup, setTxnGroup] = useState('');
  const [trackingId, setTrackingId] = useState('');
  const [rows, setRows] = useState<Trace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    let q = supabase
      .from('agent_allocation_traces')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);

    if (from) q = q.gte('created_at', `${from}T00:00:00Z`);
    if (to) q = q.lte('created_at', `${to}T23:59:59Z`);
    if (agentId.trim()) q = q.eq('agent_id', agentId.trim());
    if (tenantId.trim()) q = q.eq('tenant_id', tenantId.trim());
    if (txnGroup.trim()) q = q.eq('transaction_group', txnGroup.trim());
    if (trackingId.trim()) q = q.ilike('tracking_id', `%${trackingId.trim()}%`);

    const { data, error } = await q;
    if (error) setError(error.message);
    setRows((data as any) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => ({
        count: acc.count + 1,
        amount: acc.amount + Number(r.amount || 0),
        commission: acc.commission + Number(r.commission_earned || 0),
      }),
      { count: 0, amount: 0, commission: 0 },
    );
  }, [rows]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agent Allocation Traces</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">From</Label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">To</Label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Tracking ID</Label>
              <Input placeholder="AGT-xxxxxxxx" value={trackingId} onChange={(e) => setTrackingId(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Agent ID (UUID)</Label>
              <Input placeholder="agent uuid" value={agentId} onChange={(e) => setAgentId(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Tenant ID (UUID)</Label>
              <Input placeholder="tenant uuid" value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Transaction Group (UUID)</Label>
              <Input placeholder="txn group uuid" value={txnGroup} onChange={(e) => setTxnGroup(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Button onClick={load} disabled={loading} size="sm">
              {loading ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
              {loading ? 'Loading…' : 'Search'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setAgentId('');
                setTenantId('');
                setTxnGroup('');
                setTrackingId('');
              }}
            >
              Clear filters
            </Button>
            <div className="ml-auto text-xs text-muted-foreground">
              {totals.count} traces · Total allocated <span className="font-semibold">{fmtUGX(totals.amount)}</span> · Commission <span className="font-semibold">{fmtUGX(totals.commission)}</span>
            </div>
          </div>
          {error && <div className="text-sm text-destructive">Error: {error}</div>}
        </CardContent>
      </Card>

      <div className="space-y-2">
        {rows.length === 0 && !loading && (
          <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No traces match these filters.</CardContent></Card>
        )}
        {rows.map((r) => (
          <Collapsible key={r.id}>
            <Card>
              <CollapsibleTrigger asChild>
                <button className="w-full text-left">
                  <CardContent className="py-3">
                    <div className="flex flex-wrap items-center gap-2 justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <Badge variant="outline" className="font-mono text-xs">{r.tracking_id ?? '—'}</Badge>
                        <span className="text-xs text-muted-foreground">{format(new Date(r.created_at), 'MMM d, HH:mm')}</span>
                        <span className="text-sm font-semibold">{fmtUGX(r.amount)}</span>
                        <span className="text-xs text-muted-foreground">commission {fmtUGX(r.commission_earned)}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          outstanding {fmtUGX(r.outstanding_before)} → {fmtUGX(r.outstanding_after)}
                        </span>
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </div>
                    <div className="mt-1 grid grid-cols-1 sm:grid-cols-3 gap-1 text-[11px] text-muted-foreground font-mono">
                      <div>agent {r.agent_id.slice(0, 8)}…</div>
                      <div>tenant {r.tenant_id.slice(0, 8)}…</div>
                      <div>rr {r.rent_request_id.slice(0, 8)}…</div>
                    </div>
                  </CardContent>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="pt-0 pb-3">
                  <div className="rounded-md border bg-muted/30 p-2">
                    <div className="text-xs font-semibold mb-2">Ledger legs ({r.legs?.length ?? 0})</div>
                    <div className="space-y-1">
                      {(r.legs ?? []).map((leg, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs font-mono">
                          <Badge variant={leg.direction === 'cash_in' ? 'default' : 'secondary'} className="w-16 justify-center">
                            {leg.direction}
                          </Badge>
                          <span className="w-20 text-muted-foreground">{leg.ledger_scope}</span>
                          <span className="flex-1 truncate">{leg.category}</span>
                          <span className="font-semibold">{fmtUGX(leg.amount)}</span>
                        </div>
                      ))}
                    </div>
                    {r.notes && <div className="mt-2 text-xs text-muted-foreground">Notes: {r.notes}</div>}
                    {r.transaction_group && (
                      <div className="mt-2 text-[11px] text-muted-foreground font-mono">txn group: {r.transaction_group}</div>
                    )}
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        ))}
      </div>
    </div>
  );
}
