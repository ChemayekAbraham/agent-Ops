import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { ResponsiveContainer, AreaChart, Area } from 'recharts';
import { TrendingDown, TrendingUp, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DateRange } from './AgentOpsHomeView';
import { NewAgentsList } from './drill/NewAgentsList';
import { RentRequestsList } from './drill/RentRequestsList';
import { CommissionList } from './drill/CommissionList';
import { ActiveAgentsList } from './drill/ActiveAgentsList';

export type DrillMetric = 'new-agents' | 'rent-requests' | 'commission' | 'active-agents';

const METRIC_META: Record<
  DrillMetric,
  { title: string; sectionKey: string; sectionLabel: string; stroke: string }
> = {
  'new-agents': {
    title: 'New Agents Onboarded',
    sectionKey: 'directory',
    sectionLabel: 'Open agent directory',
    stroke: 'hsl(var(--primary))',
  },
  'rent-requests': {
    title: 'Rent Requests',
    sectionKey: 'pipeline',
    sectionLabel: 'Open rent pipeline',
    stroke: 'hsl(199 89% 48%)',
  },
  commission: {
    title: 'Commission Earned',
    sectionKey: 'earnings',
    sectionLabel: 'Open earnings',
    stroke: 'hsl(160 84% 39%)',
  },
  'active-agents': {
    title: 'Active Agents',
    sectionKey: 'directory',
    sectionLabel: 'Open agent directory',
    stroke: 'hsl(38 92% 50%)',
  },
};

const RANGE_LABELS: Record<DateRange, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '1m': 'Last 30 days',
};

export interface BriefDrillDownModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  metric: DrillMetric | null;
  range: DateRange;
  series: number[];
  kpiValue: number | string;
  changePct: number;
  onOpenSection: (key: string) => void;
}

function Header({
  metric,
  range,
  series,
  kpiValue,
  changePct,
}: {
  metric: DrillMetric;
  range: DateRange;
  series: number[];
  kpiValue: number | string;
  changePct: number;
}) {
  const meta = METRIC_META[metric];
  const isUp = changePct >= 0;
  const sparkData = series.map((v, i) => ({ x: i, y: v }));
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="text-[10px] gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          Live
        </Badge>
        <Badge variant="secondary" className="text-[10px]">
          {RANGE_LABELS[range]}
        </Badge>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-muted-foreground">{meta.title}</p>
          <p className="text-2xl sm:text-3xl font-bold text-foreground leading-tight tabular-nums">
            {kpiValue}
          </p>
        </div>
        <Badge
          variant="secondary"
          className={cn(
            'h-6 gap-0.5 px-2 text-[11px] font-semibold',
            isUp
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
              : 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30',
          )}
        >
          {isUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
          {Math.abs(changePct).toFixed(0)}%
        </Badge>
      </div>
      {sparkData.length > 1 && (
        <div className="h-12">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sparkData} margin={{ top: 2, right: 2, bottom: 0, left: 2 }}>
              <defs>
                <linearGradient id={`drill-spark-${metric}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={meta.stroke} stopOpacity={0.4} />
                  <stop offset="100%" stopColor={meta.stroke} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="y"
                stroke={meta.stroke}
                strokeWidth={1.5}
                fill={`url(#drill-spark-${metric})`}
                isAnimationActive={false}
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function ListBody({ metric, range }: { metric: DrillMetric; range: DateRange }) {
  switch (metric) {
    case 'new-agents':
      return <NewAgentsList range={range} />;
    case 'rent-requests':
      return <RentRequestsList range={range} />;
    case 'commission':
      return <CommissionList range={range} />;
    case 'active-agents':
      return <ActiveAgentsList range={range} />;
  }
}

export function BriefDrillDownModal({
  open,
  onOpenChange,
  metric,
  range,
  series,
  kpiValue,
  changePct,
  onOpenSection,
}: BriefDrillDownModalProps) {
  const isMobile = useIsMobile();
  if (!metric) return null;
  const meta = METRIC_META[metric];

  const body = (
    <div className="flex flex-col gap-3 min-h-0">
      <Header
        metric={metric}
        range={range}
        series={series}
        kpiValue={kpiValue}
        changePct={changePct}
      />
      <div className="flex-1 min-h-0 -mx-1">
        <ListBody metric={metric} range={range} />
      </div>
      <Button
        variant="outline"
        className="w-full justify-between"
        onClick={() => {
          onOpenSection(meta.sectionKey);
          onOpenChange(false);
        }}
      >
        {meta.sectionLabel}
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="h-[85vh] rounded-t-2xl flex flex-col p-4 gap-3"
        >
          <SheetHeader className="text-left">
            <SheetTitle className="text-base">{meta.title}</SheetTitle>
          </SheetHeader>
          {body}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg flex flex-col gap-3 max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>{meta.title}</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}