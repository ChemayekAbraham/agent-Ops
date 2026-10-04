import { useMemo } from 'react';
import { Check, X, Minus, ArrowUpRight, ArrowDownRight, History } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import {
  calculateRentAccessLimit,
  type RepaymentLike,
} from '@/lib/rentAccessLimit';
import { useRentAccessLimitParams } from '@/hooks/useRentAccessLimitParams';
import { cn } from '@/lib/utils';

interface Props {
  tenantName: string;
  monthlyRent: number | null;
  repayments: RepaymentLike[];
  /** How many recent days to render in the timeline. Default 14. */
  windowDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const startOfDayUtc = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const fmtShortDay = (key: number) =>
  new Date(key).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

type DayStatus = 'paid' | 'missed' | 'pre-track';

/**
 * Activity / audit feed for a tenant's Rent Access Limit.
 * Shows exactly what changed the limit today, plus a daily breakdown
 * over the recent window so agents (and auditors) can verify the math.
 */
export default function RentAccessLimitActivity({
  tenantName,
  monthlyRent,
  repayments,
  windowDays = 14,
}: Props) {
  const { params } = useRentAccessLimitParams();

  const result = useMemo(
    () =>
      calculateRentAccessLimit(monthlyRent, repayments, new Date(), {
        paidIncrementUgx: params.paid_increment_ugx,
        missedDecrementUgx: params.missed_decrement_ugx,
        maxLimitUgx: params.max_limit_ugx,
      }),
    [monthlyRent, repayments, params],
  );

  const timeline = useMemo(() => {
    const valid = (repayments || []).filter(r => Number(r.amount) > 0 && r.created_at);
    const paidSet = new Set<number>();
    for (const r of valid) {
      const d = new Date(r.created_at);
      if (!Number.isNaN(d.getTime())) paidSet.add(startOfDayUtc(d));
    }
    const firstKey = paidSet.size > 0 ? Math.min(...paidSet) : null;
    const today = startOfDayUtc(new Date());

    const rows: Array<{ key: number; status: DayStatus; delta: number }> = [];
    for (let i = 0; i < windowDays; i++) {
      const key = today - i * DAY_MS;
      let status: DayStatus = 'pre-track';
      let delta = 0;
      if (firstKey !== null && key >= firstKey) {
        if (paidSet.has(key)) {
          status = 'paid';
          delta = params.paid_increment_ugx;
        } else {
          status = 'missed';
          delta = -params.missed_decrement_ugx;
        }
      }
      rows.push({ key, status, delta });
    }
    return rows;
  }, [repayments, params, windowDays]);

  const firstName = tenantName.split(' ')[0] || tenantName;
  const todayRow = timeline[0];
  const todayPaid = todayRow?.status === 'paid';
  const todayDelta = todayRow?.delta ?? 0;

  return (
    <section
      aria-label="Rent Access Limit activity"
      className="rounded-2xl border border-border bg-card p-4 sm:p-5 space-y-4"
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-xl bg-muted flex items-center justify-center shrink-0">
          <History className="h-4.5 w-4.5 text-foreground" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-foreground">Activity & audit</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Exactly how today changed {firstName}'s limit, with every counted day.
          </p>
        </div>
      </div>

      {/* Today's change */}
      <div
        className={cn(
          'rounded-xl border p-3 flex items-center gap-3',
          todayRow?.status === 'pre-track'
            ? 'bg-muted/40 border-border'
            : todayPaid
              ? 'bg-success/10 border-success/30'
              : 'bg-destructive/10 border-destructive/30',
        )}
        role="status"
        aria-live="polite"
      >
        <div
          className={cn(
            'h-10 w-10 rounded-lg flex items-center justify-center shrink-0',
            todayRow?.status === 'pre-track'
              ? 'bg-background text-muted-foreground'
              : todayPaid
                ? 'bg-success text-success-foreground'
                : 'bg-destructive text-destructive-foreground',
          )}
        >
          {todayRow?.status === 'pre-track' ? (
            <Minus className="h-5 w-5" />
          ) : todayPaid ? (
            <ArrowUpRight className="h-5 w-5" />
          ) : (
            <ArrowDownRight className="h-5 w-5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground">
            Today's change
          </p>
          <p className="text-sm font-bold text-foreground mt-0.5">
            {todayRow?.status === 'pre-track'
              ? 'No payments recorded yet — tracking hasn\'t started'
              : todayPaid
                ? `+${formatUGX(todayDelta)} added (paid today)`
                : `−${formatUGX(Math.abs(todayDelta))} removed (no payment yet)`}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            New limit: <span className="font-mono font-semibold">{formatUGX(result.limit)}</span>
            {result.atMax && ' · at ceiling'}
          </p>
          {result.paymentsToday > 1 && (
            <p className="text-[11px] text-muted-foreground mt-1">
              <span className="font-semibold">{result.paymentsToday} payments</span> logged today —
              counted as <span className="font-semibold">1 on-time day</span> (same-day payments don't stack).
            </p>
          )}
        </div>
      </div>

      {/* Counted days summary */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <Tally
          label="Paid days"
          value={result.paidDays}
          formula={`× +${formatUGX(params.paid_increment_ugx)}`}
          tone="success"
        />
        <Tally
          label="Missed days"
          value={result.missedDays}
          formula={`× −${formatUGX(params.missed_decrement_ugx)}`}
          tone="destructive"
        />
        <Tally
          label="Tracked total"
          value={result.trackedDays}
          formula="calendar days"
          tone="muted"
        />
      </div>

      {/* Math line */}
      <div className="rounded-xl bg-muted/40 border border-border/60 p-3 text-xs space-y-1">
        <p className="font-semibold text-foreground">Limit math</p>
        <p className="font-mono text-muted-foreground break-words">
          {result.paidDays} × {formatUGX(params.paid_increment_ugx)} − {result.missedDays} ×{' '}
          {formatUGX(params.missed_decrement_ugx)} ={' '}
          <span className="text-foreground font-bold">{formatUGX(result.limit)}</span>
          {result.atMax && (
            <span className="text-warning"> (capped at {formatUGX(params.max_limit_ugx)})</span>
          )}
        </p>
        <p className="text-[11px] text-muted-foreground italic pt-1">
          Each calendar day counts once — paying twice in the same day still earns a single
          +{formatUGX(params.paid_increment_ugx)} bump.
        </p>
      </div>

      {/* Day-by-day timeline */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground">
            Last {windowDays} days
          </p>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <LegendDot tone="success" label="Paid" />
            <LegendDot tone="destructive" label="Missed" />
            <LegendDot tone="muted" label="Pre-track" />
          </div>
        </div>
        <ul className="divide-y divide-border rounded-lg border border-border overflow-hidden">
          {timeline.map((row, idx) => (
            <li
              key={row.key}
              className={cn(
                'flex items-center gap-3 px-3 py-2 text-xs',
                idx === 0 && 'bg-muted/30',
              )}
            >
              <div
                className={cn(
                  'h-6 w-6 rounded-md flex items-center justify-center shrink-0',
                  row.status === 'paid'
                    ? 'bg-success/15 text-success'
                    : row.status === 'missed'
                      ? 'bg-destructive/15 text-destructive'
                      : 'bg-muted text-muted-foreground',
                )}
                aria-label={row.status}
              >
                {row.status === 'paid' ? (
                  <Check className="h-3.5 w-3.5" />
                ) : row.status === 'missed' ? (
                  <X className="h-3.5 w-3.5" />
                ) : (
                  <Minus className="h-3.5 w-3.5" />
                )}
              </div>
              <span className="flex-1 font-medium text-foreground">
                {idx === 0 ? 'Today' : idx === 1 ? 'Yesterday' : fmtShortDay(row.key)}
                <span className="text-muted-foreground font-normal"> · {fmtShortDay(row.key)}</span>
              </span>
              <span
                className={cn(
                  'font-mono font-semibold tabular-nums',
                  row.delta > 0
                    ? 'text-success'
                    : row.delta < 0
                      ? 'text-destructive'
                      : 'text-muted-foreground',
                )}
              >
                {row.delta > 0 ? '+' : row.delta < 0 ? '−' : ''}
                {row.delta !== 0 ? formatUGX(Math.abs(row.delta)) : '—'}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Tally({
  label,
  value,
  formula,
  tone,
}: {
  label: string;
  value: number;
  formula: string;
  tone: 'success' | 'destructive' | 'muted';
}) {
  const valueClass =
    tone === 'success' ? 'text-success' : tone === 'destructive' ? 'text-destructive' : 'text-foreground';
  return (
    <div className="rounded-lg border border-border bg-background px-2 py-2">
      <p className={cn('text-lg font-black font-mono leading-none', valueClass)}>{value}</p>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground mt-1">{label}</p>
      <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{formula}</p>
    </div>
  );
}

function LegendDot({ tone, label }: { tone: 'success' | 'destructive' | 'muted'; label: string }) {
  const dotClass =
    tone === 'success' ? 'bg-success' : tone === 'destructive' ? 'bg-destructive' : 'bg-muted-foreground/40';
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn('h-1.5 w-1.5 rounded-full', dotClass)} />
      {label}
    </span>
  );
}
