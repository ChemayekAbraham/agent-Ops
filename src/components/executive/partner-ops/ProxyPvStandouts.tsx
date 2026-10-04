import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatDynamic } from '@/lib/currencyFormat';
import { Crown, TrendingDown, Users } from 'lucide-react';
import { PROXY_PV_BAND_META, proxyPvBand, type ProxyPvTeamRow } from '@/hooks/useProxyAgentPerformance';
import { explainProxyPv } from './proxyPvExplain';

const money = (v: unknown) => formatDynamic(v);

interface Props {
  rows: ProxyPvTeamRow[];
  isLoading: boolean;
  teamAveragePv: number;
  workingDaysRemaining?: number;
  onSelect: (row: ProxyPvTeamRow) => void;
}

function StandoutRow({
  row,
  rank,
  tone,
  teamAveragePv,
  workingDaysRemaining,
  onSelect,
}: {
  row: ProxyPvTeamRow;
  rank: number;
  tone: 'top' | 'bottom';
  teamAveragePv: number;
  workingDaysRemaining?: number;
  onSelect: (row: ProxyPvTeamRow) => void;
}) {
  const meta = PROXY_PV_BAND_META[proxyPvBand(row.performance_pct)];
  const why = explainProxyPv(row, { teamAveragePv, workingDaysRemaining });
  const reason = tone === 'top' ? why.drivers[0] : (why.gaps[0] ?? why.headline);

  return (
    <button
      type="button"
      onClick={() => onSelect(row)}
      className="w-full rounded-xl border border-border/60 p-2.5 text-left transition-colors hover:bg-muted/40"
    >
      <div className="flex items-start gap-2">
        <span
          className={cn(
            'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-black',
            tone === 'top' ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive',
          )}
        >
          {rank}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-bold">{row.name}</p>
            <span className="shrink-0 text-xs font-black tabular-nums">{money(row.total_pv)}</span>
          </div>
          <Progress
            value={Math.min(row.monthly_performance_pct, 100)}
            variant={row.monthly_performance_pct >= 100 ? 'success' : 'default'}
            className="h-1.5"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className={cn('gap-1 text-[10px] font-bold', meta.className)}>
              <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} />
              {meta.label} · {row.performance_pct}%
            </Badge>
            <span className="text-[10px] text-muted-foreground">of expected {money(row.expected_pv)}</span>
          </div>
          {reason && <p className="text-[10px] leading-snug text-muted-foreground break-words">{reason}</p>}
        </div>
      </div>
    </button>
  );
}

/** Side-by-side comparison of the strongest and falling-behind proxy agents. */
export function ProxyPvStandouts({ rows, isLoading, teamAveragePv, workingDaysRemaining, onSelect }: Props) {
  if (isLoading) {
    return (
      <div className="grid gap-2 lg:grid-cols-2">
        <Skeleton className="h-48 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    );
  }

  if (rows.length === 0) return null;

  const ranked = [...rows].sort((a, b) => b.total_pv - a.total_pv || b.performance_pct - a.performance_pct);
  const top = ranked.slice(0, 3);
  const behind = [...rows]
    .sort((a, b) => a.performance_pct - b.performance_pct || a.total_pv - b.total_pv)
    .filter((r) => !top.some((t) => t.agent_user_id === r.agent_user_id) || rows.length <= 3)
    .slice(0, 3);

  return (
    <div className="grid gap-2 lg:grid-cols-2">
      <Card className="border-success/30">
        <CardContent className="space-y-2 p-3">
          <div className="flex items-center gap-1.5">
            <Crown className="h-4 w-4 text-success" />
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Strongest performers
            </p>
          </div>
          {top.map((r, i) => (
            <StandoutRow
              key={r.agent_user_id}
              row={r}
              rank={i + 1}
              tone="top"
              teamAveragePv={teamAveragePv}
              workingDaysRemaining={workingDaysRemaining}
              onSelect={onSelect}
            />
          ))}
        </CardContent>
      </Card>

      <Card className="border-destructive/30">
        <CardContent className="space-y-2 p-3">
          <div className="flex items-center gap-1.5">
            <TrendingDown className="h-4 w-4 text-destructive" />
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Falling behind
            </p>
          </div>
          {behind.map((r, i) => (
            <StandoutRow
              key={r.agent_user_id}
              row={r}
              rank={i + 1}
              tone="bottom"
              teamAveragePv={teamAveragePv}
              workingDaysRemaining={workingDaysRemaining}
              onSelect={onSelect}
            />
          ))}
          <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Users className="h-3 w-3" /> Ranked across all {rows.length} proxy agents this month
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
