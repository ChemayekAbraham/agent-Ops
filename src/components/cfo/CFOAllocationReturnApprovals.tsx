import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Loader2, Check, X, RefreshCw, RotateCcw } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { formatDistanceToNowStrict } from 'date-fns';
import { CfoApprovalGate } from '@/components/cfo/CfoApprovalGate';

interface ReturnRequest {
  id: string;
  agent_id: string;
  allocation_id: string;
  rent_request_id: string | null;
  landlord_id: string | null;
  landlord_name: string | null;
  amount: number;
  reason: string;
  status: string;
  cfo_id: string | null;
  cfo_decision_at: string | null;
  cfo_note: string | null;
  created_at: string;
}

interface AgentInfo { id: string; full_name: string | null; phone: string | null }

/**
 * CFO-side panel: agent requests to send an allocated (not-yet-paid) landlord
 * float back to the CFO. Approval posts a balanced ledger reversal returning the
 * money to the CFO, cancels the allocation, and sends the landlord back to
 * Landlord Ops. Rejection puts the landlord back on the agent's pay list.
 */
export function CFOAllocationReturnApprovals() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [tab, setTab] = useState<'pending' | 'decided'>('pending');
  const [items, setItems] = useState<ReturnRequest[]>([]);
  const [agents, setAgents] = useState<Record<string, AgentInfo>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('agent_allocation_return_requests' as any)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      toast({ title: 'Could not load requests', description: error.message, variant: 'destructive' });
      setItems([]);
    } else {
      const rows = (data || []) as unknown as ReturnRequest[];
      setItems(rows);
      const ids = Array.from(new Set(rows.map((r) => r.agent_id)));
      if (ids.length) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', ids);
        const map: Record<string, AgentInfo> = {};
        (profs || []).forEach((p: any) => { map[p.id] = p; });
        setAgents(map);
      }
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(
    () => items.filter((i) => (tab === 'pending' ? i.status === 'pending' : i.status !== 'pending')),
    [items, tab],
  );

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    setSubmittingId(id);
    const { data, error } = await supabase.rpc('cfo_decide_allocation_return' as any, {
      p_request_id: id,
      p_decision: decision,
      p_cfo_note: notes[id]?.trim() || null,
    });
    setSubmittingId(null);
    if (error || (data as any)?.success === false) {
      toast({
        title: 'Could not save decision',
        description: error?.message || (data as any)?.error || 'Try again.',
        variant: 'destructive',
      });
      return;
    }
    toast({
      title: decision === 'approve' ? 'Approved' : 'Rejected',
      description: decision === 'approve'
        ? `${formatUGX((data as any)?.amount_returned || 0)} returned to the CFO. Landlord sent back to Landlord Ops.`
        : 'Request rejected — landlord returned to the agent\'s pay list.',
    });
    setNotes((n) => { const c = { ...n }; delete c[id]; return c; });
    await load();
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <RotateCcw className="h-5 w-5 text-primary" />
            Allocated-Float Return Approvals
          </CardTitle>
          <CardDescription>
            Agent requests to send a not-yet-paid landlord float allocation back to the CFO.
            Approval reverses the allocation back to the CFO and returns the landlord to Landlord Ops.
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading} className="gap-1.5">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Button size="sm" variant={tab === 'pending' ? 'default' : 'outline'} onClick={() => setTab('pending')}>
            Pending ({items.filter((i) => i.status === 'pending').length})
          </Button>
          <Button size="sm" variant={tab === 'decided' ? 'default' : 'outline'} onClick={() => setTab('decided')}>
            Decided ({items.filter((i) => i.status !== 'pending').length})
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            {tab === 'pending' ? 'No requests waiting for CFO approval.' : 'No decided requests yet.'}
          </p>
        ) : (
          <div className="space-y-3">
            {filtered.map((r) => {
              const a = agents[r.agent_id];
              const isPending = r.status === 'pending';
              return (
                <div key={r.id} className="rounded-lg border border-border p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">
                        {a?.full_name || 'Agent'} {a?.phone ? <span className="text-muted-foreground font-normal">· {a.phone}</span> : null}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        Landlord: {r.landlord_name || '—'} · {formatDistanceToNowStrict(new Date(r.created_at), { addSuffix: true })}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono font-bold">{formatUGX(Number(r.amount))}</span>
                      <Badge variant={isPending ? 'secondary' : r.status === 'approved' ? 'default' : 'destructive'}>
                        {r.status}
                      </Badge>
                    </div>
                  </div>

                  <p className="text-xs bg-muted/40 rounded p-2 text-foreground/90">
                    <span className="font-semibold">Agent reason: </span>{r.reason}
                  </p>

                  {!isPending && r.cfo_note && (
                    <p className="text-xs text-muted-foreground">
                      <span className="font-semibold">CFO note: </span>{r.cfo_note}
                    </p>
                  )}

                  {isPending && (
                    <CfoApprovalGate>
                      <div className="space-y-2">
                        <Textarea
                          rows={2}
                          placeholder="Optional note for the audit log"
                          value={notes[r.id] || ''}
                          onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                          maxLength={500}
                        />
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => decide(r.id, 'reject')}
                            disabled={submittingId === r.id}
                            className="gap-1.5"
                          >
                            <X className="h-4 w-4" /> Reject
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => decide(r.id, 'approve')}
                            disabled={submittingId === r.id}
                            className="gap-1.5"
                          >
                            {submittingId === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                            Approve & return to CFO
                          </Button>
                        </div>
                      </div>
                    </CfoApprovalGate>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}