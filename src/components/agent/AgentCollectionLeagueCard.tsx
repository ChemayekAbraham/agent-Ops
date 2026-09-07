/**
 * Compact Collection League card for the agent home screen.
 * Shows this week's team rank, performance and 7-day heat strip.
 */
import { useNavigate } from 'react-router-dom';
import { Trophy, TrendingUp, TrendingDown, Minus, ChevronRight, Users } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticTap } from '@/lib/haptics';
import {
  useAgentCollectionLeagueHome,
  HEAT_CLASS,
  HEAT_LABEL,
  type LeagueDay,
} from '@/hooks/useAgentCollectionLeague';

const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function DayCell({ day, index }: { day: LeagueDay; index: number }) {
  const tone = day.is_future ? 'bg-muted/50 text-muted-foreground' : HEAT_CLASS[day.heat_level];
  return (
    <div className="flex flex-col items-center gap-1 min-w-0 flex-1">
      <div
        className={`w-full aspect-square max-w-[38px] rounded-lg flex items-center justify-center text-[10px] font-semibold ${tone}`}
        title={`${day.date} — ${day.is_future ? 'Upcoming' : HEAT_LABEL[day.heat_level]}`}
      >
        {day.is_future ? '' : day.performance_percentage != null ? Math.round(day.performance_percentage) : '–'}
      </div>
      <span className="text-[10px] text-muted-foreground">{DAY_LETTERS[index] ?? ''}</span>
    </div>
  );
}

export function AgentCollectionLeagueCard() {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useAgentCollectionLeagueHome();

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-border bg-card p-4 animate-pulse">
        <div className="h-4 w-32 bg-muted rounded mb-3" />
        <div className="h-8 w-40 bg-muted rounded mb-3" />
        <div className="h-10 w-full bg-muted rounded" />
      </div>
    );
  }

  if (isError || !data || data.error) {
    return (
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="text-sm font-semibold text-foreground mb-1">Collection League</div>
        <p className="text-xs text-muted-foreground">
          League standings could not be loaded right now. Pull down to refresh.
        </p>
      </div>
    );
  }

  const t = data.my_team;
  const change = t.rank_change;
  const ChangeIcon = change == null || change === 0 ? Minus : change > 0 ? TrendingUp : TrendingDown;
  const changeTone =
    change == null || change === 0
      ? 'text-muted-foreground'
      : change > 0
        ? 'text-emerald-600'
        : 'text-destructive';

  return (
    <button
      type="button"
      onClick={() => { hapticTap(); navigate('/agent/collection-league'); }}
      className="w-full text-left rounded-2xl border border-primary/25 bg-primary/5 hover:bg-primary/10 transition-colors p-4 touch-manipulation"
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <Trophy className="h-4 w-4 text-primary shrink-0" />
          <span className="text-sm font-semibold text-foreground truncate">Collection League</span>
        </div>
        <ChevronRight className="h-4 w-4 text-primary shrink-0" />
      </div>

      {!data.has_team && !t.is_parent ? (
        <p className="text-xs text-muted-foreground">
          You are not in a team yet. Once you join a team, your weekly standings appear here.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-1 mb-3">
            <div>
              <div className="text-[11px] text-muted-foreground">This week</div>
              <div className="text-2xl font-bold text-foreground leading-none">
                {t.rank != null ? `#${t.rank}` : '—'}
                {t.rank != null && (
                  <span className="text-xs font-medium text-muted-foreground"> of {t.total_teams}</span>
                )}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground">Performance</div>
              <div className="text-lg font-semibold text-foreground leading-none">
                {t.performance_percentage != null ? `${t.performance_percentage}%` : '—'}
              </div>
            </div>
            <div className={`flex items-center gap-1 text-xs font-medium ${changeTone}`}>
              <ChangeIcon className="h-3.5 w-3.5" />
              {change == null ? 'No last week' : change === 0 ? 'Same as last week' : `${Math.abs(change)} ${change > 0 ? 'up' : 'down'}`}
            </div>
          </div>

          <div className="flex items-center gap-1.5 mb-3">
            {data.current_week_days.map((d, i) => (
              <DayCell key={d.date} day={d} index={i} />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className="text-emerald-600 font-medium">{formatUGX(t.collected_amount)} collected</span>
            <span>of {formatUGX(t.expected_amount)} expected</span>
            <span className="flex items-center gap-1">
              <Users className="h-3 w-3" />
              {t.active_collectors}/{t.total_members} collecting
            </span>
          </div>
        </>
      )}
    </button>
  );
}

export default AgentCollectionLeagueCard;
