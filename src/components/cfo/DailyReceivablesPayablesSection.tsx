import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import {
  ArrowDownCircle, ArrowUpCircle, Scale, ChevronRight, CalendarDays, Loader2,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useCFODailyReceivablesPayables, type DailyRange } from '@/hooks/useCFODailyReceivablesPayables';

const fmt = (n: number) =>
  `${n < 0 ? '-' : ''}UGX ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.abs(n))}`;

type Preset = 'today' | 'yesterday' | '7days' | 'custom';

const presetRange = (p: Preset): DailyRange => {
  const now = new Date();
  if (p === 'yesterday') {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return { from: y, to: y };
  }
  if (p === '7days') {
    const s = new Date(now);
    s.setDate(s.getDate() - 6);
    return { from: s, to: now };
  }
  return { from: now, to: now };
};

function MetricRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('font-semibold tabular-nums', tone)}>{value}</span>
    </div>
  );
}

interface DailyReceivablesPayablesSectionProps {
  /** Heading shown above the cards. Override when a parent already titles the block. */
  heading?: string;
}

export function DailyReceivablesPayablesSection({
  heading = 'Receivables & Payables',
}: DailyReceivablesPayablesSectionProps) {
  const [preset, setPreset] = useState<Preset>('today');
  const [customFrom, setCustomFrom] = useState<Date | undefined>();
  const [customTo, setCustomTo] = useState<Date | undefined>();
  const [detail, setDetail] = useState<'receivables' | 'payables' | null>(null);

  const range = useMemo<DailyRange>(() => {
    if (preset === 'custom' && customFrom) return { from: customFrom, to: customTo || customFrom };
    return presetRange(preset);
  }, [preset, customFrom, customTo]);

  const { data, isLoading } = useCFODailyReceivablesPayables(range);

  const r = data?.receivables;
  const p = data?.payables;
  const receivableRemaining = r?.outstanding ?? 0;
  const payableRemaining = p?.outstanding ?? 0;
  const net = receivableRemaining - payableRemaining;
  const surplus = net >= 0;

  const rangeLabel =
    range.from.toDateString() === range.to.toDateString()
      ? format(range.from, 'd MMM yyyy')
      : `${format(range.from, 'd MMM')} – ${format(range.to, 'd MMM yyyy')}`;

  return (
    <div className="space-y-3">
      {/* header + filter */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">{heading}</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">{rangeLabel}</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1 shadow-sm">
          {(['today', 'yesterday', '7days'] as Preset[]).map((key) => (
            <Button
              key={key}
              size="sm"
              variant={preset === key ? 'default' : 'ghost'}
              className="h-7 rounded-md px-2.5 text-[11px]"
              onClick={() => setPreset(key)}
            >
              {key === 'today' ? 'Today' : key === 'yesterday' ? 'Yesterday' : '7 Days'}
            </Button>
          ))}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                size="sm"
                variant={preset === 'custom' ? 'default' : 'ghost'}
                className="h-7 rounded-md px-2.5 text-[11px] gap-1"
              >
                <CalendarDays className="h-3.5 w-3.5" /> Custom
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="range"
                selected={{ from: customFrom, to: customTo }}
                onSelect={(sel: any) => {
                  setCustomFrom(sel?.from);
                  setCustomTo(sel?.to);
                  if (sel?.from) setPreset('custom');
                }}
                initialFocus
                className={cn('p-3 pointer-events-auto')}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center rounded-xl border border-border bg-card py-10">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Receivables */}
          <Card
            role="button"
            tabIndex={0}
            onClick={() => setDetail('receivables')}
            onKeyDown={(e) => e.key === 'Enter' && setDetail('receivables')}
            className="rounded-xl shadow-sm cursor-pointer transition-colors hover:border-emerald-300 focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 p-1.5">
                    <ArrowDownCircle className="h-4 w-4 text-emerald-600" />
                  </span>
                  <p className="text-xs font-semibold">Receivables</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </div>
              <p className="text-xl font-bold text-emerald-600 tabular-nums">{fmt(r?.dueInRange ?? 0)}</p>
              <div className="space-y-1.5 pt-1 border-t border-border">
                <MetricRow label="Total due" value={fmt(r?.dueInRange ?? 0)} />
                <MetricRow label="Collected" value={fmt(r?.collectedInRange ?? 0)} tone="text-emerald-600" />
                <MetricRow label="Overdue" value={fmt(r?.overdue ?? 0)} tone="text-destructive" />
                <MetricRow label="Remaining outstanding" value={fmt(receivableRemaining)} tone="text-amber-600" />
              </div>
            </CardContent>
          </Card>

          {/* Payables */}
          <Card
            role="button"
            tabIndex={0}
            onClick={() => setDetail('payables')}
            onKeyDown={(e) => e.key === 'Enter' && setDetail('payables')}
            className="rounded-xl shadow-sm cursor-pointer transition-colors hover:border-orange-300 focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="rounded-lg bg-orange-50 dark:bg-orange-950/40 p-1.5">
                    <ArrowUpCircle className="h-4 w-4 text-orange-600" />
                  </span>
                  <p className="text-xs font-semibold">Payables</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </div>
              <p className="text-xl font-bold text-orange-600 tabular-nums">{fmt(p?.dueInRange ?? 0)}</p>
              <div className="space-y-1.5 pt-1 border-t border-border">
                <MetricRow label="Total due" value={fmt(p?.dueInRange ?? 0)} />
                <MetricRow label="Paid" value={fmt(p?.paidInRange ?? 0)} tone="text-emerald-600" />
                <MetricRow label="Overdue" value={fmt(p?.overdue ?? 0)} tone="text-destructive" />
                <MetricRow label="Remaining outstanding" value={fmt(payableRemaining)} tone="text-amber-600" />
              </div>
            </CardContent>
          </Card>

          {/* Net position */}
          <Card className="rounded-xl shadow-sm">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <span className="rounded-lg bg-blue-50 dark:bg-blue-950/40 p-1.5">
                  <Scale className="h-4 w-4 text-blue-600" />
                </span>
                <p className="text-xs font-semibold">Net Cash Position</p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <p className={cn('text-xl font-bold tabular-nums', surplus ? 'text-emerald-600' : 'text-destructive')}>
                  {fmt(net)}
                </p>
                <Badge variant={surplus ? 'secondary' : 'destructive'} className="text-[10px]">
                  {surplus ? 'Surplus' : 'Shortfall'}
                </Badge>
              </div>
              <div className="space-y-1.5 pt-1 border-t border-border">
                <MetricRow label="Receivables remaining" value={fmt(receivableRemaining)} tone="text-emerald-600" />
                <MetricRow label="Payables remaining" value={fmt(payableRemaining)} tone="text-orange-600" />
                <MetricRow label="Net (receivables − payables)" value={fmt(net)} tone={surplus ? 'text-emerald-600' : 'text-destructive'} />
              </div>
              <p className="text-[10px] text-muted-foreground italic">
                {surplus
                  ? 'Expected inflows exceed outstanding obligations.'
                  : 'Outstanding obligations exceed expected inflows.'}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* detail sheet */}
      <Sheet open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="text-base">
              {detail === 'receivables' ? 'Receivables detail' : 'Payables detail'} — {rangeLabel}
            </SheetTitle>
          </SheetHeader>

          {detail === 'receivables' && (
            <div className="mt-4 space-y-2">
              {(r?.rows ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground">No active receivables for this period.</p>
              )}
              {(r?.rows ?? []).map((row) => (
                <div key={row.id} className="rounded-lg border border-border p-3 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold truncate">{row.tenant_name}</p>
                    <Badge variant="outline" className="text-[10px]">{row.status}</Badge>
                  </div>
                  <MetricRow label="Daily amount" value={fmt(row.daily_repayment)} />
                  <MetricRow label="Repaid" value={fmt(row.amount_repaid)} tone="text-emerald-600" />
                  <MetricRow label="Overdue" value={fmt(row.overdue)} tone="text-destructive" />
                  <MetricRow label="Outstanding" value={fmt(row.outstanding)} tone="text-amber-600" />
                </div>
              ))}
            </div>
          )}

          {detail === 'payables' && (
            <div className="mt-4 space-y-2">
              {(p?.rows ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground">No payables for this period.</p>
              )}
              {(p?.rows ?? []).map((row) => (
                <div key={row.id} className="rounded-lg border border-border p-3 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold truncate">{row.name}</p>
                    <Badge variant="outline" className="text-[10px]">{row.status}</Badge>
                  </div>
                  <MetricRow label="Amount" value={fmt(row.amount)} />
                  <MetricRow label="Due" value={row.due_date ? format(new Date(`${row.due_date}T00:00:00`), "d MMM yyyy") : "—"} />
                  <MetricRow label="Type" value={row.payout_method || '—'} />
                  <MetricRow label="Category" value={row.category_label || '—'} />

                </div>
              ))}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
