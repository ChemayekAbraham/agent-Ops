/**
 * "All calls made and taken this week" and "Who was called" for the Weekly Staff Forwarding report.
 * Additive and read-only: it prints what `cc_weekly_all_calls_report` returned, arranged by `pivotAllCalls`. Nothing here counts or writes.
 */
import { Fragment } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { CALL_KINDS, type AllCallsPivot } from '@/lib/callingCenterAllCalls';

interface Props {
  dayLabels: string[];
  pivot: AllCallsPivot;
  isLoading: boolean;
  error: unknown;
}

const cell = (n: number) => (n ? n : '—');
const dayCell = (n: number) => (n ? 'p-2.5 text-center font-semibold' : 'p-2.5 text-center text-muted-foreground');

export function AllCallsWeeklySections({ dayLabels, pivot, isLoading, error }: Props) {
  return (
    <div className="mt-4 space-y-4" data-testid="all-calls-sections">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Could not load all calls: {error instanceof Error ? error.message : 'unknown error'}</span>
        </div>
      ) : null}

      <section className="min-w-0 space-y-2">
        <h3 className="text-xs font-bold">All calls made and taken this week</h3>
        <p className="text-[11px] text-muted-foreground">
          Calls made in the Rent Plan pipeline (to landlords and tenants), calls made and taken at the Calling Center, and awareness calls. A call
          recorded in more than one place is counted once.
        </p>
        {!isLoading && !error ? (
          <p className="text-[11px] text-muted-foreground" data-testid="all-calls-summary">
            {pivot.bySource.length
              ? pivot.bySource.map((s) => `${s.label}: ${s.calls.toLocaleString()}`).join(' · ')
              : 'No call was recorded in this week.'}
            {pivot.grandTotal > 0 &&
              ` · Answered: ${pivot.answered.toLocaleString()} · Not answered: ${pivot.notAnswered.toLocaleString()}`}
          </p>
        ) : null}
        <div className="min-w-0 overflow-x-auto rounded-xl border border-border">
          {isLoading ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : !pivot.staff.length ? (
            <div className="p-8 text-center text-xs text-muted-foreground">No call was recorded in this week.</div>
          ) : (
            <table className="w-full min-w-[820px] text-xs">
              <thead>
                <tr className="border-b bg-muted/30 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="p-2.5 font-semibold">Staff member</th>
                  {dayLabels.map((d) => (
                    <th key={d} className="p-2.5 text-center font-semibold">{d}</th>
                  ))}
                  <th className="p-2.5 text-center font-semibold">Weekly total</th>
                </tr>
              </thead>
              <tbody>
                {pivot.staff.map((s) => (
                  <tr key={s.key} className="border-b border-border/50 last:border-0 hover:bg-muted/40">
                    <td className="p-2.5 font-semibold">{s.name}</td>
                    {s.perDay.map((n, i) => (
                      <td key={`${s.key}-${i}`} className={dayCell(n)}>{cell(n)}</td>
                    ))}
                    <td className="p-2.5 text-center font-bold text-primary">{s.total}</td>
                  </tr>
                ))}
                <tr className="border-t bg-muted/40 font-bold">
                  <td className="p-2.5">Daily total — all calls</td>
                  {pivot.dailyTotals.map((n, i) => (
                    <td key={`all-daily-${i}`} className="p-2.5 text-center">{n}</td>
                  ))}
                  <td className="p-2.5 text-center text-primary">{pivot.grandTotal}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="min-w-0 space-y-2">
        <h3 className="text-xs font-bold">Who was called</h3>
        <div className="min-w-0 overflow-x-auto rounded-xl border border-border">
          {isLoading ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : !pivot.staff.length ? (
            <div className="p-8 text-center text-xs text-muted-foreground">No call was recorded in this week.</div>
          ) : (
            <table className="w-full min-w-[860px] text-xs">
              <thead>
                <tr className="border-b bg-muted/30 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="p-2.5 font-semibold">Staff member</th>
                  <th className="p-2.5 font-semibold">Who was called</th>
                  {dayLabels.map((d) => (
                    <th key={d} className="p-2.5 text-center font-semibold">{d}</th>
                  ))}
                  <th className="p-2.5 text-center font-semibold">Total</th>
                </tr>
              </thead>
              <tbody>
                {pivot.staff.map((s) => (
                  <Fragment key={s.key}>
                    {CALL_KINDS.map((k, ki) => (
                      <tr key={`${s.key}-${k.kind}`} className="border-b border-border/50 hover:bg-muted/40">
                        <td className="p-2.5 font-semibold">{ki === 0 ? s.name : ''}</td>
                        <td className="p-2.5">{k.label}</td>
                        {s.kinds[k.kind].perDay.map((n, i) => (
                          <td key={`${s.key}-${k.kind}-${i}`} className={dayCell(n)}>{cell(n)}</td>
                        ))}
                        <td className="p-2.5 text-center font-bold">{s.kinds[k.kind].total}</td>
                      </tr>
                    ))}
                    <tr key={`${s.key}-subtotal`} className="border-b bg-muted/40 font-bold">
                      <td className="p-2.5" />
                      <td className="p-2.5">Subtotal</td>
                      {s.perDay.map((n, i) => (
                        <td key={`${s.key}-sub-${i}`} className="p-2.5 text-center">{n}</td>
                      ))}
                      <td className="p-2.5 text-center text-primary">{s.total}</td>
                    </tr>
                  </Fragment>
                ))}
                <tr className="border-t bg-primary/10 font-bold">
                  <td className="p-2.5">All staff</td>
                  <td className="p-2.5">Total</td>
                  {pivot.dailyTotals.map((n, i) => (
                    <td key={`who-total-${i}`} className="p-2.5 text-center">{n}</td>
                  ))}
                  <td className="p-2.5 text-center text-primary">{pivot.grandTotal}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

export default AllCallsWeeklySections;
