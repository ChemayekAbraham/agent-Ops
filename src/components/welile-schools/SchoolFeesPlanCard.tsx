import { useMemo, useState } from 'react';
import { CalendarDays, Receipt, Sparkles, TrendingDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { formatDynamic } from '@/lib/currencyFormat';
import { cn } from '@/lib/utils';
import { PLAN_ENDS_DAYS_BEFORE_TERM_END, clearEarly, planDaysUntil, planSummary } from '@/lib/welileSchoolsFeePlan';

const FEE_PRESETS = [500_000, 1_000_000, 2_000_000, 3_000_000];

function isoDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function roundUp(n: number) {
  return Math.ceil(n / 100) * 100;
}

/**
 * Parent home: "Your School Fees Plan". Until the Welile agent signs the family up there is no
 * live plan, so this works out what a plan would cost from the term fee and the end of term,
 * using the agreed rules (lib/welileSchoolsFeePlan). Estimates only: nothing is saved or sent.
 */
export default function SchoolFeesPlanCard() {
  const [fee, setFee] = useState(1_000_000);
  const [termEnd, setTermEnd] = useState(() => isoDate(new Date(Date.now() + 90 * 86_400_000)));

  const days = useMemo(() => planDaysUntil(new Date(`${termEnd}T00:00:00`)), [termEnd]);
  const summary = useMemo(() => planSummary(fee, days), [fee, days]);
  const halfway = useMemo(() => (summary ? clearEarly(fee, days, Math.ceil(days / 2)) : null), [fee, days, summary]);

  return (
    <section className="overflow-hidden rounded-3xl border border-border/70 bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
        <Receipt className="h-5 w-5 text-primary" aria-hidden />
        <h3 className="text-sm font-semibold">Your School Fees Plan</h3>
        <span className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">Opening soon</span>
      </div>

      <div className="space-y-4 p-4">
        <p className="text-sm text-muted-foreground">See what a plan would cost. The Welile agent at your child's school signs you up, then your real plan shows here.</p>

        <div className="space-y-2">
          <label htmlFor="ws-fee" className="text-xs font-medium text-muted-foreground">Term fees</label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">UGX</span>
            <Input id="ws-fee" inputMode="numeric" className="h-12 pl-12 text-base font-semibold"
              value={fee ? fee.toLocaleString('en-UG') : ''}
              onChange={(e) => setFee(Number(e.target.value.replace(/\D/g, '')) || 0)} />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {FEE_PRESETS.map((p) => (
              <button key={p} type="button" aria-pressed={fee === p} onClick={() => setFee(p)}
                className={cn('min-h-[36px] rounded-full px-3 text-xs font-semibold transition-colors', fee === p ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/70')}>
                {p >= 1_000_000 ? `${p / 1_000_000}M` : `${p / 1_000}K`}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="ws-term-end" className="text-xs font-medium text-muted-foreground">End of term</label>
          <div className="relative">
            <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input id="ws-term-end" type="date" className="h-12 pl-9" value={termEnd} min={isoDate(new Date())} onChange={(e) => setTermEnd(e.target.value)} />
          </div>
        </div>

        {summary ? (
          <>
            {/* The headline: what the parent pays each day. */}
            <div className="rounded-2xl bg-primary p-4 text-primary-foreground">
              <p className="text-xs font-medium text-primary-foreground/80">You pay about</p>
              <p className="text-2xl font-bold tracking-tight">{formatDynamic(roundUp(summary.averageDailyPayment))} <span className="text-sm font-medium">a day</span></p>
              <p className="mt-1 text-xs text-primary-foreground/80">
                For {summary.days} days, starting near {formatDynamic(roundUp(summary.firstDayPayment))} and falling each day to {formatDynamic(roundUp(summary.lastDayPayment))}.
              </p>
            </div>

            <dl className="divide-y divide-border/60 rounded-2xl bg-muted/50 px-3 text-sm">
              <div className="flex items-center justify-between gap-3 py-2.5">
                <dt className="text-muted-foreground">Welile pays the school</dt>
                <dd className="font-semibold">{formatDynamic(fee)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 py-2.5">
                <dt className="text-muted-foreground">Facilitation fee, if paid on schedule</dt>
                <dd className="font-semibold">{formatDynamic(Math.round(summary.totalFacilitationFee))}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 py-2.5">
                <dt className="font-medium">Total you repay</dt>
                <dd className="font-bold">{formatDynamic(Math.round(summary.totalOnSchedule))}</dd>
              </div>
            </dl>

            {halfway && halfway.saved > 0 ? (
              <p className="flex items-start gap-2 rounded-2xl bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-900/20 dark:text-emerald-100">
                <TrendingDown className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span><span className="font-semibold">Pay early, pay less.</span> Clear the plan halfway, on day {Math.ceil(summary.days / 2)}, and save about {formatDynamic(Math.round(halfway.saved))}.</span>
              </p>
            ) : null}

            <p className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
              <Sparkles className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              Estimate only. The fee is worked out daily on what you still owe, and your plan is cleared {PLAN_ENDS_DAYS_BEFORE_TERM_END} days before the end of term. Your agent confirms the exact figures.
            </p>
          </>
        ) : (
          <p className="rounded-2xl bg-muted/50 p-3 text-sm text-muted-foreground">
            {fee > 0
              ? `Plans are cleared ${PLAN_ENDS_DAYS_BEFORE_TERM_END} days before the end of term, so pick a term end date further away.`
              : 'Enter the term fees to see your daily amount.'}
          </p>
        )}
      </div>
    </section>
  );
}
