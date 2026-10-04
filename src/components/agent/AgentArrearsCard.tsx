import { useState } from 'react';
import { CalendarX2, ChevronDown, ChevronUp } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { useAgentArrears } from '@/hooks/useAgentArrears';

/**
 * The agent's own view of who is behind, and by how much.
 *
 * One RPC round trip (`agent_arrears_overview`), aggregated server-side — no
 * per-tenant fan-out. It renders nothing at all when nobody is behind, which is
 * also true for every agent before the arrears go-live floor, so mounting it is
 * safe from day zero and needs no date check.
 *
 * Amounts here are unpaid day balances, not new charges: the same money the
 * tenant already owed, now attributed to the specific days it belongs to.
 */
interface Props {
  agentId: string;
}

export function AgentArrearsCard({ agentId }: Props) {
  const [expanded, setExpanded] = useState(false);
  const { data } = useAgentArrears(agentId);

  const totals = data?.totals;
  const tenants = data?.tenants ?? [];
  const arrears = Number(totals?.arrears_ugx ?? 0);
  if (!(arrears > 0) || tenants.length === 0) return null;

  const behindCount = Number(totals?.tenants_behind ?? 0);

  return (
    <div className="rounded-xl border border-warning/40 bg-warning/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 p-3.5 text-left active:scale-[0.99] transition-transform touch-manipulation"
      >
        <div className="p-2.5 rounded-xl bg-warning/10 shrink-0">
          <CalendarX2 className="h-5 w-5 text-warning" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Unpaid Days To Recover
          </p>
          <p className="font-bold text-lg tabular-nums truncate">{formatUGX(arrears)}</p>
          <p className="text-[10px] text-muted-foreground">
            {behindCount} {behindCount === 1 ? 'tenant' : 'tenants'} behind · collected money clears
            the oldest day first
          </p>
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-warning/30 divide-y divide-warning/20">
          {tenants.map((t) => (
            <div key={t.rent_request_id} className="flex items-center gap-3 px-3.5 py-2.5">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold truncate">{t.tenant_name ?? 'Tenant'}</p>
                <p className="text-[10px] text-muted-foreground">
                  {Number(t.days_behind ?? 0)}{' '}
                  {Number(t.days_behind ?? 0) === 1 ? 'day' : 'days'} behind
                  {t.oldest_open_day ? ` · since ${t.oldest_open_day}` : ''}
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs font-mono font-bold text-warning">
                  {formatUGX(Number(t.arrears_ugx ?? 0))}
                </p>
                {Number(t.due_today_ugx ?? 0) > 0 && (
                  <p className="text-[10px] text-muted-foreground font-mono">
                    +{formatUGX(Number(t.due_today_ugx))} today
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
