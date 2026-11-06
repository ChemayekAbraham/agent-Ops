import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, RefreshCw, RotateCcw, XCircle, Building2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { advanceWelileHomesFloat, fetchWhReviewQueue, WH_FLOAT_STAGES, type WhReviewRow } from '@/lib/welileHomesFloat';
import { useWhFloatHistory, WhFloatStageTrail } from './WhFloatStageTrail';

type StageKey = 'agent_ops' | 'tenant_ops' | 'landlord_ops' | 'coo';

/** Approve / Return to agent / Reject with a reason. The server decides whether the caller may act. */
export function WhStageActions({ row, nextLabel, onDone }: { row: { id: string; status: string }; nextLabel: string; onDone?: () => void }) {
  const [mode, setMode] = useState<null | 'return' | 'reject'>(null);
  const [note, setNote] = useState('');
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (action: 'approve' | 'return' | 'reject') =>
      advanceWelileHomesFloat({ requestId: row.id, expectedStatus: row.status, action, note: action === 'approve' ? undefined : note }),
    onSuccess: (_r, action) => {
      toast.success(action === 'approve' ? `Approved and sent to ${nextLabel}` : action === 'return' ? 'Returned to the agent' : 'Request rejected');
      setMode(null); setNote('');
      qc.invalidateQueries({ queryKey: ['wh-float-review-queue'] });
      qc.invalidateQueries({ queryKey: ['wh-float-history'] });
      onDone?.();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  if (mode) {
    return (
      <div className="w-full space-y-2">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
          placeholder={mode === 'return' ? 'What should the agent fix? (at least 5 characters)' : 'Reason for rejecting (at least 5 characters)'} />
        <div className="flex gap-2 justify-end">
          <Button size="sm" variant="ghost" onClick={() => { setMode(null); setNote(''); }}>Cancel</Button>
          <Button size="sm" variant={mode === 'reject' ? 'destructive' : 'default'} disabled={m.isPending || note.trim().length < 5}
            onClick={() => m.mutate(mode)}>
            {m.isPending && <RefreshCw className="h-3.5 w-3.5 mr-1 animate-spin" />}
            {mode === 'return' ? 'Return to agent' : 'Reject'}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2 justify-end">
      <Button size="sm" variant="outline" className="gap-1 h-9 text-xs" onClick={() => setMode('return')}><RotateCcw className="h-3.5 w-3.5" />Return to agent</Button>
      <Button size="sm" variant="outline" className="gap-1 h-9 text-xs text-destructive" onClick={() => setMode('reject')}><XCircle className="h-3.5 w-3.5" />Reject</Button>
      <Button size="sm" className="gap-1 h-9 text-xs" disabled={m.isPending} onClick={() => m.mutate('approve')}>
        {m.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}Approve & send to {nextLabel}
      </Button>
    </div>
  );
}

/** One review desk for a single stage of the Welile Homes float chain. */
export function WhFloatStageDesk({ stage, title }: { stage: StageKey; title: string }) {
  const idx = WH_FLOAT_STAGES.findIndex((s) => s.key === stage);
  const myStatus = WH_FLOAT_STAGES[idx].status!;
  const nextLabel = WH_FLOAT_STAGES[idx + 1].label;
  const [tab, setTab] = useState<'mine' | 'all'>('mine');
  const { data = [], isLoading, refetch, error } = useQuery({
    queryKey: ['wh-float-review-queue'],
    queryFn: fetchWhReviewQueue,
    refetchInterval: 30_000,
  });
  const mine = data.filter((r) => r.status === myStatus);
  const rows: WhReviewRow[] = tab === 'mine' ? mine : data;
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const { data: history } = useWhFloatHistory(ids);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold">{title}</h2>
          <p className="text-xs text-muted-foreground">
            Order: Agent → Agent Ops → Tenant Ops → Landlord Ops → COO → CFO. You act only on requests waiting for {WH_FLOAT_STAGES[idx].label}.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => refetch()} className="gap-1"><RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />Refresh</Button>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant={tab === 'mine' ? 'default' : 'outline'} onClick={() => setTab('mine')}>Waiting for {WH_FLOAT_STAGES[idx].label} ({mine.length})</Button>
        <Button size="sm" variant={tab === 'all' ? 'default' : 'outline'} onClick={() => setTab('all')}>All requests ({data.length})</Button>
      </div>
      {error ? <p className="text-sm text-destructive">{(error as Error).message}</p> : null}
      {isLoading ? <Skeleton className="h-28 w-full rounded-2xl" /> : rows.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground border-dashed">No requests here.</Card>
      ) : rows.map((r) => (
        <Card key={r.id} className={cn('p-4 space-y-3 rounded-2xl', r.status === myStatus && 'border-amber-500/40')}>
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-xl bg-primary/10 text-primary"><Building2 className="h-4 w-4" /></div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold text-sm">{r.agent_name || 'Agent'}</span>
                {r.agent_phone && <span className="text-xs text-muted-foreground">({r.agent_phone})</span>}
                <Badge variant="outline" className="text-[10px]">{r.tenant_count} tenant{r.tenant_count === 1 ? '' : 's'}</Badge>
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2">{r.reason}</p>
              <p className="text-xs font-semibold mt-1">Float: {formatUGX(Number(r.requested_amount) || 0)}</p>
            </div>
          </div>
          <WhFloatStageTrail status={r.status} events={history?.get(r.id)} compact />
          {r.status === myStatus && <WhStageActions row={r} nextLabel={nextLabel} />}
        </Card>
      ))}
    </div>
  );
}
