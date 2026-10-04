import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Scale } from 'lucide-react';
import { formatUGX } from '@/lib/agentAdvanceCalculations';

interface DriftRow {
  agent_id: string;
  agent_name: string | null;
  agent_phone: string | null;
  cached_balance: number;
  correct_balance: number;
  difference: number;
  open_allocations: number;
  total_funded: number;
  total_paid_out: number;
  updated_at: string;
}

interface CorrectionRow {
  id: string;
  agent_id: string;
  previous_balance: number;
  corrected_balance: number;
  difference: number;
  open_allocation_total: number;
  reason: string;
  performed_by_process: string;
  applied: boolean;
  created_at: string;
}

/**
 * Landlord float reconciliation — compares the cached
 * `agent_landlord_float.balance` against the authoritative open landlord
 * allocations and exposes the full correction audit trail.
 */
export function LandlordFloatReconciliationPanel() {
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);

  const { data: drift, isLoading } = useQuery({
    queryKey: ['landlord-float-drift'],
    queryFn: async (): Promise<DriftRow[]> => {
      const { data, error } = await supabase
        .from('v_agent_landlord_float_reconciliation' as any)
        .select('*');
      if (error) throw error;
      return ((data || []) as any[])
        .map((r) => ({ ...r, difference: Number(r.difference) }))
        .filter((r) => Number(r.difference) !== 0)
        .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
    },
    staleTime: 30_000,
  });

  const { data: corrections } = useQuery({
    queryKey: ['landlord-float-corrections'],
    queryFn: async (): Promise<(CorrectionRow & { agent_name?: string })[]> => {
      const { data, error } = await supabase
        .from('agent_landlord_float_corrections' as any)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      const rows = (data || []) as any[];
      const ids = [...new Set(rows.map((r) => r.agent_id))];
      const names: Record<string, string> = {};
      if (ids.length) {
        const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', ids);
        (profs || []).forEach((p: any) => { names[p.id] = p.full_name; });
      }
      return rows.map((r) => ({ ...r, agent_name: names[r.agent_id] }));
    },
    staleTime: 30_000,
  });

  const totals = useMemo(() => {
    const rows = drift || [];
    return {
      inflated: rows.filter((r) => r.difference > 0),
      understated: rows.filter((r) => r.difference < 0),
      phantom: rows.filter((r) => r.difference > 0).reduce((s, r) => s + r.difference, 0),
    };
  }, [drift]);

  const runReconcile = async (apply: boolean) => {
    setRunning(true);
    try {
      const { error } = await supabase.rpc('reconcile_agent_landlord_float_all' as any, {
        p_apply: apply,
        p_allow_increase: false,
        p_reason: apply ? 'manual_cfo_reseed' : 'manual_cfo_scan',
        p_process: 'cfo_dashboard',
      });
      if (error) throw error;
      toast.success(apply ? 'Inflated balances corrected.' : 'Scan complete.');
      queryClient.invalidateQueries({ queryKey: ['landlord-float-drift'] });
      queryClient.invalidateQueries({ queryKey: ['landlord-float-corrections'] });
    } catch (e: any) {
      toast.error(e.message || 'Reconciliation failed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Scale className="h-4 w-4" />
          Landlord float reconciliation
          <span className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={running} onClick={() => runReconcile(false)}>
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              <span className="ml-1.5">Scan</span>
            </Button>
            <Button size="sm" disabled={running || totals.inflated.length === 0} onClick={() => runReconcile(true)}>
              Correct inflated
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-xl border border-border p-3">
            <p className="text-xs text-muted-foreground">Phantom float</p>
            <p className="text-lg font-semibold text-destructive">{formatUGX(totals.phantom)}</p>
          </div>
          <div className="rounded-xl border border-border p-3">
            <p className="text-xs text-muted-foreground">Inflated agents</p>
            <p className="text-lg font-semibold">{totals.inflated.length}</p>
          </div>
          <div className="rounded-xl border border-border p-3">
            <p className="text-xs text-muted-foreground">Understated (review)</p>
            <p className="text-lg font-semibold">{totals.understated.length}</p>
          </div>
        </div>

        <Tabs defaultValue="drift">
          <TabsList>
            <TabsTrigger value="drift">Discrepancies</TabsTrigger>
            <TabsTrigger value="log">Correction log</TabsTrigger>
          </TabsList>

          <TabsContent value="drift" className="mt-3">
            {isLoading ? (
              <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
            ) : (drift || []).length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center flex items-center justify-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                Every cached landlord float matches its open allocations.
              </p>
            ) : (
              <div className="divide-y divide-border">
                {(drift || []).map((r) => (
                  <div key={r.agent_id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{r.agent_name || r.agent_id.slice(0, 8)}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        Cached {formatUGX(r.cached_balance)} · Correct {formatUGX(r.correct_balance)} · {r.open_allocations} open
                      </p>
                    </div>
                    <Badge variant={r.difference > 0 ? 'destructive' : 'secondary'} className="shrink-0 text-xs">
                      {r.difference > 0 ? '+' : ''}{formatUGX(r.difference)}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="log" className="mt-3">
            {(corrections || []).length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No corrections recorded yet.</p>
            ) : (
              <div className="divide-y divide-border max-h-[420px] overflow-y-auto">
                {(corrections || []).map((c) => (
                  <div key={c.id} className="py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium truncate">{c.agent_name || c.agent_id.slice(0, 8)}</p>
                      <Badge variant={c.applied ? 'secondary' : 'outline'} className="shrink-0 text-xs">
                        {c.applied ? 'Applied' : 'Reported only'}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatUGX(c.previous_balance)} → {formatUGX(c.corrected_balance)} ({Number(c.difference) > 0 ? '+' : ''}
                      {formatUGX(Number(c.difference))}) · {c.reason} · {c.performed_by_process} ·{' '}
                      {format(new Date(c.created_at), 'dd MMM yyyy HH:mm')}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>

        {totals.understated.length > 0 && (
          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
            Understated balances are never auto-increased — they are reported for manual review so no agent can be over-credited.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
