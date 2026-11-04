import { agentWeekDetail, agentWeekSummary, formatWeekPct, type AgentWeekPct as AgentWeek } from '@/lib/agentWeekPct';

// The registering agent's collection percentage for this Thursday-Wednesday week, placed next to the agent's name on a rent request.
// Presentation only: the figures and the percentage come from `rent_request_agent_week_pct` (the same ones the agent sees on Weekly performance).
// Current Rent Plans are the main figure; expired Rent Plans show beside it when the agent has both. No figure shows "-" (nothing billed yet),
// and nothing at all while it loads or if it could not be loaded.

interface Props {
  week: AgentWeek | undefined;
  loading?: boolean;
  /** When the name shown next to the chip is not the registering agent (an older request with a different assigned agent), name who it is for. */
  forName?: string;
  className?: string;
}

export function AgentWeekPct({ week, loading, forName, className }: Props) {
  if (!week) {
    return loading ? <span className="inline-block h-4 w-12 animate-pulse rounded-full bg-muted align-middle" data-testid="agent-week-pct-loading" aria-hidden="true" /> : null;
  }
  const s = agentWeekSummary(week);
  const detail = `${forName ? `For ${forName}. ` : ''}${agentWeekDetail(week)}`;
  const main = s.primary;
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${className ?? ''}`} data-testid="agent-week-pct" title={detail} aria-label={detail}>
      <span
        className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-bold tabular-nums ${main ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}
        data-testid="agent-week-pct-main"
      >
        <span className="font-medium opacity-80">Wk</span>
        {main ? formatWeekPct(main.pct) : '-'}
      </span>
      {s.current && s.expired && (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-xs font-semibold tabular-nums text-muted-foreground" data-testid="agent-week-pct-expired">
          <span className="font-medium">Expired</span>
          {formatWeekPct(s.expired.pct)}
        </span>
      )}
    </span>
  );
}

export default AgentWeekPct;
