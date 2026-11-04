import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { advanceControlMessage } from '@/lib/advanceControls';
import { CheckCircle2, Loader2, ShieldCheck, XCircle } from 'lucide-react';

// agent_advance_write_off_requests and decide_agent_advance_write_off are newer than the generated types.
const db = supabase as any;

export interface WriteOffQueueRow {
  id: string;
  advance_id: string;
  amount: number;
  reason: string;
  status: string;
  requested_by: string;
  requested_at: string;
  agent_name: string | null;
  requester_name: string | null;
  outstanding_now: number | null;
}

const MIN_NOTE = 10;

/**
 * Write-off requests waiting for a decision. The person who asked for a write-off cannot approve it: another CFO or the
 * CEO must. Approving does not post anything; the advance is closed (and the loss booked) from the Close advance dialog.
 */
export function AdvanceWriteOffApprovals({ hideWhenEmpty = false }: { hideWhenEmpty?: boolean } = {}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const { data: rows = [], isLoading, error } = useQuery<WriteOffQueueRow[]>({
    queryKey: ['agent-advance-write-off-queue'],
    queryFn: async () => {
      const { data, error: e } = await db.from('agent_advance_write_off_requests')
        .select('id, advance_id, amount, reason, status, requested_by, requested_at')
        .eq('status', 'requested').order('requested_at', { ascending: true });
      if (e) throw e;
      const reqs = (data ?? []) as Omit<WriteOffQueueRow, 'agent_name' | 'requester_name' | 'outstanding_now'>[];
      if (reqs.length === 0) return [];
      const { data: advs } = await db.from('agent_advances')
        .select('id, agent_id, outstanding_balance').in('id', reqs.map((r) => r.advance_id));
      const advMap = new Map<string, { agent_id: string; outstanding_balance: number }>((advs ?? []).map((a: any) => [a.id, a]));
      const people = [...new Set([...reqs.map((r) => r.requested_by), ...(advs ?? []).map((a: any) => a.agent_id)])];
      const { data: profs } = await db.from('profiles').select('id, full_name').in('id', people);
      const names = new Map<string, string>((profs ?? []).map((p: any) => [p.id, p.full_name]));
      return reqs.map((r) => {
        const adv = advMap.get(r.advance_id);
        return {
          ...r,
          agent_name: adv ? names.get(adv.agent_id) ?? null : null,
          requester_name: names.get(r.requested_by) ?? null,
          outstanding_now: adv ? Number(adv.outstanding_balance) : null,
        };
      });
    },
  });

  const decide = async (row: WriteOffQueueRow, approve: boolean) => {
    const note = (notes[row.id] ?? '').trim();
    if (note.length < MIN_NOTE) return;
    setBusy(row.id);
    try {
      const { error: e } = await db.rpc('decide_agent_advance_write_off', { p_request_id: row.id, p_approve: approve, p_note: note });
      if (e) throw e;
      toast.success(approve
        ? 'Write-off approved. Close the advance from its Close advance dialog to post it.'
        : 'Write-off rejected. The balance stays owed.');
      setNotes((n) => ({ ...n, [row.id]: '' }));
      for (const key of ['agent-advance-write-off-queue', 'advance-write-off-request', 'cfo-advances']) {
        queryClient.invalidateQueries({ queryKey: [key], exact: false });
      }
    } catch (e: any) {
      toast.error(advanceControlMessage(e?.message) || 'Decision failed');
    } finally {
      setBusy(null);
    }
  };

  if (hideWhenEmpty && !isLoading && !error && rows.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" /> Write-off approvals
          {rows.length > 0 && <Badge variant="secondary">{rows.length}</Badge>}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          A write-off needs a second person: another CFO or the CEO, never the requester.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading...</p>
        ) : error ? (
          <p className="text-xs text-destructive">Could not load write-off requests: {advanceControlMessage((error as any)?.message)}</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No write-off requests waiting.</p>
        ) : rows.map((row) => {
          const own = row.requested_by === user?.id;
          const note = notes[row.id] ?? '';
          const changed = row.outstanding_now !== null && Math.abs(row.outstanding_now - Number(row.amount)) >= 1;
          return (
            <div key={row.id} className="rounded-lg border border-border p-3 space-y-2" data-testid="write-off-request">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-semibold">{row.agent_name ?? 'Unknown agent'}</p>
                <p className="text-sm font-bold">{formatUGX(Number(row.amount))}</p>
              </div>
              <p className="text-xs text-muted-foreground">
                Requested by {own ? 'you' : row.requester_name ?? 'unknown'} on {new Date(row.requested_at).toLocaleDateString()}
              </p>
              <p className="text-xs">{row.reason}</p>
              {changed && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  The balance is now {formatUGX(row.outstanding_now ?? 0)}. At most the requested {formatUGX(Number(row.amount))} can ever be written off; if the balance is higher, a new request is needed.
                </p>
              )}
              {own ? (
                <p className="text-xs text-muted-foreground italic">You requested this write-off, so someone else must decide it.</p>
              ) : (
                <>
                  <Textarea value={note} onChange={(e) => setNotes((n) => ({ ...n, [row.id]: e.target.value }))}
                    placeholder={`Decision note (min ${MIN_NOTE} characters)`} className="min-h-[52px] text-xs" aria-label="Decision note" />
                  <div className="flex flex-wrap gap-2 justify-end">
                    <Button size="sm" variant="outline" disabled={busy === row.id || note.trim().length < MIN_NOTE} onClick={() => decide(row, false)}>
                      <XCircle className="h-3.5 w-3.5 mr-1" /> Reject
                    </Button>
                    <Button size="sm" disabled={busy === row.id || note.trim().length < MIN_NOTE} onClick={() => decide(row, true)}>
                      {busy === row.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Approve</>}
                    </Button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
