import { useState } from 'react';
import { AlarmClockOff, ChevronDown, ChevronUp } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { useAgentExpiredCycles } from '@/hooks/useAgentArrears';

/**
 * Rent Plans whose cycle has ended while a balance remains.
 *
 * These are invisible everywhere else on the agent's screen: once the term has
 * passed there are no more days to pin, so today's expected amount reads 0 even
 * though the tenant may still owe the whole balance. The arrears queue does not
 * carry them either — it is floored at the go-live date and an expired cycle's
 * unpaid days sit almost entirely before it.
 *
 * One RPC round trip (`agent_expired_cycles`), aggregated server-side. Renders
 * nothing when the agent has no expired plans still owing.
 *
 * The amounts are existing balances, not new charges.
 */
interface Props {
  agentId: string;
}

export function AgentExpiredCyclesCard({ agentId }: Props) {
  const [expanded, setExpanded] = useState(false);
  const { data } = useAgentExpiredCycles(agentId);

  const plans = data?.plans ?? [];
  const outstanding = Number(data?.totals?.outstanding_ugx ?? 0);
  if (!(outstanding > 0) || plans.length === 0) return null;

  const planCount = Number(data?.totals?.plans ?? plans.length);

  return (
    <div className="rounded-xl border border-destructive/40 bg-destructive/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 p-3.5 text-left active:scale-[0.99] transition-transform touch-manipulation"
      >
        <div className="p-2.5 rounded-xl bg-destructive/10 shrink-0">
          <AlarmClockOff className="h-5 w-5 text-destructive" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Ended Plans Still Owing
          </p>
          <p className="font-bold text-lg tabular-nums truncate">{formatUGX(outstanding)}</p>
          <p className="text-[10px] text-muted-foreground">
            {planCount} {planCount === 1 ? 'Rent Plan' : 'Rent Plans'} past the end date · nothing
            shows under today&apos;s target
          </p>
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-destructive/30 divide-y divide-destructive/20">
          {plans.map((p) => {
            const daysOverdue = Number(p.days_overdue ?? 0);
            return (
              <div key={p.rent_request_id} className="flex items-center gap-3 px-3.5 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold truncate">{p.tenant_name ?? 'Tenant'}</p>
                  <p className="text-[10px] text-muted-foreground">
                    Ended {p.term_ends_on ?? 'unknown'} · {daysOverdue}{' '}
                    {daysOverdue === 1 ? 'day' : 'days'} ago
                    {p.last_payment_on ? ` · last paid ${p.last_payment_on}` : ' · never paid'}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs font-mono font-bold text-destructive">
                    {formatUGX(Number(p.outstanding_ugx ?? 0))}
                  </p>
                  <p className="text-[10px] text-muted-foreground font-mono">
                    of {formatUGX(Number(p.total_repayment ?? 0))}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
