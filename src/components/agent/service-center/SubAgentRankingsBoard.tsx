import { useMemo, useState } from 'react';
import { AlertTriangle, Award, ChevronDown, Crown, Medal, Trophy } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import type { ServiceCenterSubAgent } from '@/hooks/useAgentServiceCenter';
import {
  rankSubAgents,
  summariseSubAgentRankings,
  type SubAgentRankMetric,
  type SubAgentRankRow,
} from '@/lib/subAgentRankings';
import { initialsOf, tintFor } from './subAgentVisuals';

const COLLAPSED_ROWS = 5;

const METRICS: {
  value: SubAgentRankMetric;
  label: string;
  /** Sits under the toggle so the number on each row is never ambiguous. */
  caption: string;
  /** Podium styling only makes sense when rank 1 is a good thing. */
  podium: boolean;
}[] = [
  {
    value: 'repaid',
    label: 'Repaid',
    caption:
      'All-time rent repaid on their own tenants’ Rent Plans — every payment route, not only what the sub-agent collected in person.',
    podium: true,
  },
  {
    value: 'rate',
    label: 'Rate',
    caption: 'Share of each Rent Plan’s total repayment that has come in, all time.',
    podium: true,
  },
  {
    value: 'outstanding',
    label: 'Outstanding',
    caption: 'Biggest unpaid balances first — start your follow-up at the top.',
    podium: false,
  },
];

const ratePercent = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate)}%`);

/** Rate drives the row's progress bar colour: green on track, red badly behind. */
const rateTone = (rate: number | null) => {
  if (rate === null) return 'muted' as const;
  if (rate >= 80) return 'success' as const;
  if (rate >= 50) return 'warning' as const;
  return 'destructive' as const;
};

function RankBadge({ rank, podium }: { rank: number; podium: boolean }) {
  const icon = podium && rank <= 3
    ? [
        <Crown key="1" className="h-4 w-4 text-warning" aria-hidden />,
        <Medal key="2" className="h-4 w-4 text-muted-foreground" aria-hidden />,
        <Award key="3" className="h-4 w-4 text-primary" aria-hidden />,
      ][rank - 1]
    : null;

  return (
    <span className="flex w-6 shrink-0 items-center justify-center">
      {icon ?? (
        <span className="text-xs font-bold tabular-nums text-muted-foreground" aria-hidden>
          {rank}
        </span>
      )}
      <span className="sr-only">Rank {rank}</span>
    </span>
  );
}

/** The headline figure on the right of a row, per active metric. */
function rowHeadline(row: SubAgentRankRow, metric: SubAgentRankMetric) {
  switch (metric) {
    case 'rate':
      return { value: ratePercent(row.collectionRate), sub: `${formatUGX(row.collected)} in` };
    case 'outstanding':
      return { value: formatUGX(row.outstanding), sub: `${ratePercent(row.collectionRate)} repaid` };
    case 'repaid':
    default:
      return { value: formatUGX(row.collected), sub: `${ratePercent(row.collectionRate)} of plan total` };
  }
}

function RankingRow({
  row,
  metric,
  podium,
  onOpen,
}: {
  row: SubAgentRankRow;
  metric: SubAgentRankMetric;
  podium: boolean;
  onOpen?: (subAgentId: string) => void;
}) {
  const tint = tintFor(row.subAgentId);
  const headline = rowHeadline(row, metric);
  const leading = podium && row.rank === 1 && row.score > 0;

  const body = (
    <div className="flex items-center gap-2.5 p-2.5">
      <RankBadge rank={row.rank} podium={podium} />
      <Avatar className="h-9 w-9 shrink-0">
        <AvatarImage src={row.avatarUrl ?? undefined} alt="" />
        <AvatarFallback className={cn('text-[11px]', tint.fallback)}>{initialsOf(row.name)}</AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-foreground">{row.name}</span>
          {row.suspended && <Badge variant="destructive" className="text-[10px]">Suspended</Badge>}
          {leading && (
            <Badge variant="outline" className="border-warning/40 text-[10px] text-warning">
              Top
            </Badge>
          )}
        </div>
        <Progress
          className="mt-1.5"
          size="sm"
          variant={rateTone(row.collectionRate)}
          value={Math.min(100, row.collectionRate ?? 0)}
          aria-label={`${row.name} collection rate`}
        />
        <p className="mt-1 truncate text-[11px] text-muted-foreground">
          {row.plans === 0
            ? 'No funded rent plans yet'
            : [
                `${row.activePlans} active of ${row.plans} plan${row.plans === 1 ? '' : 's'}`,
                row.clearedPlans > 0 ? `${row.clearedPlans} cleared` : null,
                row.dailyTarget > 0 ? `${formatUGX(row.dailyTarget)}/day due` : null,
              ].filter(Boolean).join(' · ')}
        </p>
      </div>

      <div className="shrink-0 text-right">
        <div
          className={cn(
            'text-sm font-bold tabular-nums',
            metric === 'outstanding' && row.outstanding > 0 ? 'text-destructive' : 'text-foreground',
          )}
        >
          {headline.value}
        </div>
        <div className="text-[10px] text-muted-foreground">{headline.sub}</div>
      </div>
    </div>
  );

  const className = cn(
    'rounded-lg border transition-colors',
    leading ? 'border-warning/40 bg-warning/5' : 'border-border/60 bg-background',
  );

  if (!onOpen) return <li className={className}>{body}</li>;

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(row.subAgentId)}
        aria-label={`Open ${row.name} details`}
        className={cn(
          className,
          'w-full text-left hover:border-primary/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        {body}
      </button>
    </li>
  );
}

/**
 * Ranks the manager's sub-agents on rent collections. Driven entirely by the
 * roster the Service Center page already holds, so it adds no query of its own
 * and stays in sync with the rest of the page.
 */
export function SubAgentRankingsBoard({
  subAgents,
  isLoading = false,
  error,
  onOpenSubAgent,
}: {
  subAgents: ServiceCenterSubAgent[];
  isLoading?: boolean;
  error?: unknown;
  /** Opens the existing sub-agent detail sheet on the parent page. */
  onOpenSubAgent?: (subAgentId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [metric, setMetric] = useState<SubAgentRankMetric>('repaid');
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(() => rankSubAgents(subAgents, metric), [subAgents, metric]);
  const summary = useMemo(() => summariseSubAgentRankings(rows), [rows]);

  const active = METRICS.find((m) => m.value === metric) ?? METRICS[0];
  const visible = showAll ? rows : rows.slice(0, COLLAPSED_ROWS);
  const hidden = rows.length - visible.length;

  return (
    <Card className="overflow-hidden">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 p-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`${open ? 'Hide' : 'Show'} sub-agent rankings`}
          >
            <Trophy className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold text-foreground">Collection rankings</div>
              <div className="truncate text-[11px] text-muted-foreground">
                {isLoading
                  ? 'Loading your team…'
                  : summary.collected > 0
                    ? `${formatUGX(summary.collected)} repaid, all time, across ${summary.ranked} of ${summary.subAgents} sub-agents`
                    : 'How your sub-agents compare on rent repaid'}
              </div>
            </div>
            <ChevronDown
              className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
              aria-hidden
            />
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="space-y-3 border-t border-border/60 p-3 pt-3">
            <ToggleGroup
              type="single"
              value={metric}
              onValueChange={(v) => v && setMetric(v as SubAgentRankMetric)}
              className="grid w-full grid-cols-3 gap-1"
              aria-label="Rank sub-agents by"
            >
              {METRICS.map((m) => (
                <ToggleGroupItem key={m.value} value={m.value} size="sm" className="text-[11px] sm:text-xs">
                  {m.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p className="text-[11px] text-muted-foreground">{active.caption}</p>

            {isLoading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
              </div>
            ) : error ? (
              <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                Could not load rankings because your team did not load.
              </p>
            ) : rows.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                Invite sub-agents to see how they rank on rent collections.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {[
                    { label: 'Repaid, all time', value: formatUGX(summary.collected) },
                    { label: 'Still owed', value: formatUGX(summary.outstanding) },
                    { label: 'Repaid share', value: ratePercent(summary.collectionRate) },
                    { label: 'Due per day', value: formatUGX(summary.dailyTarget) },
                  ].map((s) => (
                    <div key={s.label} className="rounded-lg border border-border/60 bg-muted/30 p-2">
                      <div className="text-[10px] text-muted-foreground">{s.label}</div>
                      <div className="break-words text-xs font-bold text-foreground">{s.value}</div>
                    </div>
                  ))}
                </div>

                {summary.collected === 0 && (
                  <p className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/5 p-2.5 text-[11px] text-warning">
                    <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                    No repayments recorded yet, so every sub-agent is tied. Rankings fill in as
                    collections come through.
                  </p>
                )}

                <ul className="space-y-2">
                  {visible.map((row) => (
                    <RankingRow
                      key={row.subAgentId}
                      row={row}
                      metric={metric}
                      podium={active.podium}
                      onOpen={onOpenSubAgent}
                    />
                  ))}
                </ul>

                {hidden > 0 && (
                  <Button variant="outline" size="sm" className="w-full" onClick={() => setShowAll(true)}>
                    Show all {rows.length} sub-agents
                  </Button>
                )}
                {showAll && rows.length > COLLAPSED_ROWS && (
                  <Button variant="ghost" size="sm" className="w-full" onClick={() => setShowAll(false)}>
                    Show top {COLLAPSED_ROWS} only
                  </Button>
                )}
              </>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
