/**
 * Compact Collection League card for the agent home screen.
 * Shows this week's team rank, performance and 7-day heat strip.
 */
import { useNavigate } from 'react-router-dom';
import { Trophy, TrendingUp, TrendingDown, Minus, ChevronRight, Users, RefreshCw } from 'lucide-react';
import { hapticTap } from '@/lib/haptics';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  useAgentCollectionLeagueHome,
  HEAT_CLASS,
  HEAT_LABEL,
  type LeagueDay,
} from '@/hooks/useAgentCollectionLeague';

const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function formatCompactUGX(amount: number): string {
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  const absoluteAmount = Math.abs(safeAmount);
  const sign = safeAmount < 0 ? '-' : '';

  if (absoluteAmount >= 1_000_000_000) {
    return `${sign}UGX ${(absoluteAmount / 1_000_000_000).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}B`;
  }
  if (absoluteAmount >= 1_000_000) {
    return `${sign}UGX ${(absoluteAmount / 1_000_000).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}M`;
  }
  if (absoluteAmount >= 1_000) {
    return `${sign}UGX ${(absoluteAmount / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return `${sign}UGX ${Math.round(absoluteAmount).toLocaleString('en-UG')}`;
}

function formatDayDate(date: string): string {
  if (!date || typeof date !== 'string') return 'Date unavailable';

  const dateOnly = date.match(/^\d{4}-\d{2}-\d{2}$/);
  const parsed = new Date(dateOnly ? `${date}T12:00:00+03:00` : date);
  if (Number.isNaN(parsed.getTime())) return date;

  return new Intl.DateTimeFormat('en-UG', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(parsed);
}

function DayCell({ day, index }: { day: LeagueDay; index: number }) {
  const performance = day.performance_percentage == null ? 'No performance percentage' : `${Math.round(day.performance_percentage)}% performance`;
  const state = day.is_future ? 'Future day' : HEAT_LABEL[day.heat_level];
  const detail = `${formatDayDate(day.date)}. ${state}. ${performance}. ${formatCompactUGX(day.collected_amount)} collected. ${formatCompactUGX(day.expected_amount)} expected.`;
  const tone = day.is_future ? 'bg-muted/60 ring-muted-foreground/15' : `${HEAT_CLASS[day.heat_level]} ring-current/15`;

  return (
    <div className="group relative flex min-w-0 flex-1 flex-col items-center gap-1.5">
      <span className="text-[10px] font-medium text-muted-foreground" aria-hidden="true">
        {DAY_LETTERS[index] ?? ''}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(event) => event.stopPropagation()}
            aria-label={detail}
            className={`h-5 w-full max-w-8 rounded-[4px] ring-1 ring-inset transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-6 ${tone}`}
          />
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-56 p-3 text-xs">
          <div className="font-semibold">{formatDayDate(day.date)}</div>
          <div className="mt-1">{day.is_future ? 'Future day' : performance}</div>
          <div className="mt-1 text-muted-foreground">{formatCompactUGX(day.collected_amount)} collected</div>
          <div className="text-muted-foreground">{formatCompactUGX(day.expected_amount)} expected</div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export function AgentCollectionLeagueCard() {
  const navigate = useNavigate();
  const { data, isLoading, isError, refetch, isFetching } = useAgentCollectionLeagueHome();

  if (isLoading) {
    return (
      <div className="animate-pulse rounded-2xl border border-primary/25 bg-primary/20 p-4" aria-label="Loading Collection League">
        <div className="mb-5 flex items-center justify-between">
          <div className="h-4 w-32 rounded bg-muted" />
          <div className="h-4 w-4 rounded bg-muted" />
        </div>
        <div className="mb-2 h-3 w-16 rounded bg-muted" />
        <div className="mb-4 flex items-end justify-between">
          <div className="h-11 w-24 rounded bg-muted" />
          <div className="h-8 w-20 rounded bg-muted" />
        </div>
        <div className="mb-3 h-2 w-full rounded-full bg-muted" />
        <div className="mb-4 h-3 w-full rounded bg-muted" />
        <div className="grid grid-cols-7 gap-2">
          {DAY_LETTERS.map((letter, index) => <div key={`${letter}-${index}`} className="h-8 rounded bg-muted" />)}
        </div>
      </div>
    );
  }

  if (isError || !data || data.error) {
    return (
      <div className="rounded-2xl border border-primary/25 bg-primary/20 p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
          <Trophy className="h-4 w-4 text-primary" />
          Collection League
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">League standings could not be loaded.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="min-h-8 shrink-0 gap-1.5 px-2.5 text-xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            Retry
          </Button>
        </div>
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
  const progress = Math.min(100, Math.max(0, t.performance_percentage ?? 0));
  const performanceText = t.performance_percentage == null ? '—' : `${t.performance_percentage}%`;

  return (
    <div
      className="w-full rounded-2xl border border-primary/25 bg-primary/20 p-4 text-left transition-colors hover:bg-primary/30"
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      <Button
        type="button"
        variant="ghost"
        onClick={() => { hapticTap(); navigate('/agent/collection-league'); }}
        className="mb-4 h-auto w-full justify-between gap-2 p-0 text-left hover:bg-transparent"
        aria-label="Open Collection League"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Trophy className="h-4 w-4 text-primary shrink-0" />
          <span className="text-sm font-semibold text-foreground truncate">Collection League</span>
        </div>
        <ChevronRight className="h-4 w-4 text-primary shrink-0" />
      </Button>

      {!data.has_team && !t.is_parent ? (
        <p className="text-xs text-muted-foreground">
          You are not in a team yet. Once you join a team, your weekly standings appear here.
        </p>
      ) : (
        <>
          <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">This week</div>
          <div className="mb-4 flex items-end justify-between gap-4">
            <div className="min-w-0">
              <div className="text-4xl font-bold leading-none text-foreground sm:text-[2.75rem]">{performanceText}</div>
              <div className="mt-1 text-xs font-medium text-muted-foreground">collected</div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-xl font-bold leading-none text-foreground">
                {t.rank != null ? `#${t.rank}` : '—'}
                {t.rank != null && <span className="text-sm font-semibold text-muted-foreground"> of {t.total_teams}</span>}
              </div>
              <div className={`mt-1.5 flex items-center justify-end gap-1 text-xs font-semibold ${changeTone}`}>
                <ChangeIcon className="h-3.5 w-3.5" />
                {change == null ? 'No previous rank' : change === 0 ? 'No change this week' : `${Math.abs(change)} ${Math.abs(change) === 1 ? 'place' : 'places'} ${change > 0 ? 'up' : 'down'}`}
              </div>
            </div>
          </div>

          <div
            className="mb-2 h-2.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Weekly collection progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress)}
          >
            <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${progress}%` }} />
          </div>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px]">
            <span className="font-semibold text-foreground">{formatCompactUGX(t.collected_amount)} collected</span>
            <span className="text-muted-foreground">{formatCompactUGX(t.expected_amount)} expected</span>
          </div>

          <div className="mb-2 text-[11px] font-semibold text-foreground">Daily performance</div>
          <TooltipProvider delayDuration={150}>
            <div className="mb-4 flex items-center gap-1.5">
              {data.current_week_days.map((d, i) => (
                <DayCell key={d.date} day={d} index={i} />
              ))}
            </div>
          </TooltipProvider>

          <div className="flex items-center gap-2 border-t border-primary/15 pt-3 text-xs font-medium text-foreground">
            <Users className="h-4 w-4 shrink-0 text-primary" />
            <span>{t.active_collectors} / {t.total_members} collectors active</span>
          </div>
        </>
      )}
    </div>
  );
}

export default AgentCollectionLeagueCard;
