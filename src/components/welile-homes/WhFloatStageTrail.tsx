import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, Clock, RotateCcw, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWhFloatHistory, whStageForStatus, whStatusLabel, WH_FLOAT_STAGES, type WhFloatEvent } from '@/lib/welileHomesFloat';

const fmt = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Shared history read for a set of requests (one call per screen). */
export function useWhFloatHistory(requestIds: string[]) {
  const key = [...requestIds].sort().join(',');
  return useQuery({
    queryKey: ['wh-float-history', key],
    queryFn: () => fetchWhFloatHistory(requestIds),
    enabled: requestIds.length > 0,
    staleTime: 15_000,
  });
}

/**
 * Agent → Agent Ops → Tenant Ops → Landlord Ops → COO → CFO, with who acted at each stage and when.
 * Reads only the server's append-only history; the current stage comes from the request status.
 */
export function WhFloatStageTrail({ status, events, compact }: { status: string; events?: WhFloatEvent[]; compact?: boolean }) {
  const current = whStageForStatus(status);
  const ended = status === 'rejected' || status === 'returned_to_agent';
  const disbursed = ['approved', 'funded', 'disbursed'].includes(status);
  const byStage = new Map<string, WhFloatEvent>();
  for (const e of events ?? []) {
    const k = e.action === 'submitted' ? 'agent' : e.stage;
    if (k) byStage.set(k, e); // latest event per stage wins
  }
  const last = (events ?? [])[(events ?? []).length - 1];
  const currentIdx = WH_FLOAT_STAGES.findIndex((s) => s.key === current);

  return (
    <div className="space-y-1.5">
      <ol className={cn('grid gap-1', compact ? 'grid-cols-3 sm:grid-cols-6' : 'grid-cols-2 sm:grid-cols-6')}>
        {WH_FLOAT_STAGES.map((s, i) => {
          const ev = byStage.get(s.key);
          const done = disbursed || (ev && ev.action !== 'returned' && ev.action !== 'rejected') || (currentIdx > -1 && i < currentIdx);
          const isCurrent = s.key === current;
          const stoppedHere = ended && ev && (ev.action === 'returned' || ev.action === 'rejected');
          return (
            <li key={s.key} className={cn('rounded-lg border px-2 py-1.5 text-[10px] leading-tight',
              stoppedHere ? 'border-destructive/40 bg-destructive/5' : isCurrent ? 'border-amber-500/50 bg-amber-500/10' : done ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-border bg-muted/30')}>
              <div className="flex items-center gap-1 font-semibold text-foreground">
                {stoppedHere ? (ev!.action === 'returned' ? <RotateCcw className="h-3 w-3 text-destructive" /> : <XCircle className="h-3 w-3 text-destructive" />)
                  : isCurrent ? <Clock className="h-3 w-3 text-amber-600" />
                  : done ? <CheckCircle2 className="h-3 w-3 text-emerald-600" /> : <Circle className="h-3 w-3 text-muted-foreground" />}
                {s.label}
              </div>
              <div className="text-muted-foreground truncate">
                {ev ? <>{ev.action === 'submitted' ? 'Sent' : ev.action === 'disbursed' ? 'Disbursed' : ev.action === 'returned' ? 'Returned' : ev.action === 'rejected' ? 'Rejected' : 'Approved'}{ev.actor_name ? ` · ${ev.actor_name}` : ''}<br />{fmt(ev.created_at)}</>
                  : isCurrent ? 'Waiting' : done ? 'Done' : '—'}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="text-[11px] text-muted-foreground">
        <span className="font-semibold text-foreground">{whStatusLabel(status)}</span>
        {ended && last?.note ? ` — ${last.note}` : ''}
      </p>
    </div>
  );
}
