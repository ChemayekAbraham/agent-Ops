/**
 * Weekly Champion Team — Monday celebration dialog.
 *
 * Opens on Monday and Tuesday (Africa/Kampala) only, once per week per device,
 * announcing last week's #1 collection team and its three best collectors.
 * All figures come from the SECURITY DEFINER RPC `get_agent_weekly_champion_team`.
 */
import { useEffect, useMemo, useState } from 'react';
import { Trophy, Crown, Medal, Award, Users, Flame } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { useWeeklyChampionTeam } from '@/hooks/useAgentCollectionLeague';

const STORAGE_PREFIX = 'welile.weeklyChampionTeam.seen.';

/** Kampala calendar parts, so the window does not shift with device time zones. */
function kampalaParts() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kampala',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: get('weekday'),
  };
}

const POSITION_STYLE = [
  { icon: Crown, label: 'Best collector', ring: 'ring-amber-400/60', tint: 'bg-amber-500/10' },
  { icon: Medal, label: 'Second best', ring: 'ring-slate-400/50', tint: 'bg-slate-500/10' },
  { icon: Award, label: 'Third best', ring: 'ring-orange-400/50', tint: 'bg-orange-500/10' },
];

export function WeeklyChampionTeamDialog() {
  const { weekday } = useMemo(kampalaParts, []);
  const inWindow = weekday === 'Mon' || weekday === 'Tue';

  const { data } = useWeeklyChampionTeam(inWindow);
  const [open, setOpen] = useState(false);

  const seenKey = data?.week_start ? `${STORAGE_PREFIX}${data.week_start}` : null;

  useEffect(() => {
    if (!inWindow || !data?.has_champion || !seenKey) return;
    try {
      if (localStorage.getItem(seenKey)) return;
    } catch {
      /* private mode — show it anyway */
    }
    setOpen(true);
  }, [inWindow, data?.has_champion, seenKey]);

  const dismiss = () => {
    if (seenKey) {
      try {
        localStorage.setItem(seenKey, '1');
      } catch {
        /* ignore */
      }
    }
    setOpen(false);
  };

  if (!inWindow || !data?.has_champion || !data.team) return null;

  const team = data.team;
  const collectors = data.top_collectors ?? [];

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : dismiss())}>
      <DialogContent className="max-w-sm rounded-3xl">
        <DialogHeader className="items-center text-center">
          <div className="mx-auto mb-2 flex items-center gap-1.5 rounded-full bg-amber-500/15 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
            <Trophy className="h-3.5 w-3.5" aria-hidden="true" />
            Team of the week
          </div>
          <DialogTitle className="text-xl">{team.team_name}</DialogTitle>
          <DialogDescription>
            {team.is_my_team ? 'Your team topped the league last week.' : 'They topped the league last week.'}{' '}
            Week of {team.performance_percentage != null ? '' : ''}
            {data.week_start} to {data.week_end}.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-2xl border border-border/60 bg-muted/40 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Collected</p>
            <p className="mt-1 text-lg font-bold tabular-nums">{formatUGX(team.collected_amount)}</p>
          </div>
          <div className="rounded-2xl border border-border/60 bg-muted/40 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Of target</p>
            <p className="mt-1 flex items-center gap-1 text-lg font-bold tabular-nums">
              <Flame className="h-4 w-4 text-orange-500" aria-hidden="true" />
              {team.performance_percentage != null ? `${team.performance_percentage}%` : '—'}
            </p>
          </div>
        </div>

        <p className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <Users className="h-3.5 w-3.5" aria-hidden="true" />
          {team.active_collectors} of {team.total_members} collected money
        </p>

        <div className="mt-2 space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Best three collectors
          </p>
          {collectors.length === 0 && (
            <p className="text-sm text-muted-foreground">No individual collections recorded that week.</p>
          )}
          {collectors.slice(0, 3).map((c, i) => {
            const style = POSITION_STYLE[i] ?? POSITION_STYLE[2];
            const Icon = style.icon;
            return (
              <div
                key={c.agent_id}
                className={cn(
                  'flex items-center gap-3 rounded-2xl border border-border/60 p-3 ring-1',
                  style.tint,
                  style.ring,
                )}
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-background/70">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {c.name}
                    {c.is_me && (
                      <Badge variant="secondary" className="ml-2 align-middle text-[10px]">
                        You
                      </Badge>
                    )}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {style.label} · {c.payments} payment{c.payments === 1 ? '' : 's'}
                  </p>
                </div>
                <p className="shrink-0 text-sm font-bold tabular-nums">{formatUGX(c.collected_amount)}</p>
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button className="w-full rounded-2xl" onClick={dismiss}>
            {team.is_my_team ? 'Keep it up' : 'Chase them this week'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default WeeklyChampionTeamDialog;
