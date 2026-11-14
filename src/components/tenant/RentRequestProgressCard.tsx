import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  daysSince,
  describeRentRequestProgress,
  type TenantRentRequestRow,
} from '@/lib/rentRequestProgress';

const SUPPORT_PHONE_DISPLAY = '+256 748 747134';

const formatUGX = (n: number) => `UGX ${Math.round(n).toLocaleString('en-UG')}`;
const formatDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-UG', { day: 'numeric', month: 'short', year: 'numeric' });

function sentLine(iso: string): string {
  const d = daysSince(iso);
  const ago = d === 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
  return `Sent ${formatDay(iso)} · ${ago}`;
}

/**
 * Where the tenant's rent request is, step by step. Read-only: everything
 * comes from the tenant's own request (see rentRequestProgress.ts).
 */
export function RentRequestProgressCard({ request }: { request: TenantRentRequestRow }) {
  const progress = describeRentRequestProgress(request);
  const stopped = progress.phase === 'stopped';

  return (
    <section
      aria-label="Your rent request"
      className="w-full rounded-xl border border-border/40 bg-card p-4 text-left"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-bold uppercase tracking-wider text-foreground">Your rent request</p>
        <span
          className={cn(
            'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold',
            stopped && 'border-destructive/30 bg-destructive/10 text-destructive',
            progress.phase === 'in_progress' && 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
            progress.phase === 'active' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
          )}
        >
          {stopped ? 'Stopped' : progress.phase === 'active' ? 'Active' : 'In progress'}
        </span>
      </div>

      <h3 className="mt-2 text-base font-bold text-foreground">{progress.headline}</h3>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{progress.detail}</p>
      <p className="mt-1 text-[11px] text-muted-foreground/80">{sentLine(request.created_at)}</p>

      <ol className="mt-4 space-y-3">
        {progress.steps.map((step, i) => {
          const last = i === progress.steps.length - 1;
          return (
            <li key={step.key} className="relative flex gap-3">
              {!last && (
                <span
                  aria-hidden
                  className={cn(
                    'absolute left-[11px] top-6 h-[calc(100%-4px)] w-0.5',
                    step.state === 'done' ? 'bg-emerald-500' : 'bg-border',
                  )}
                />
              )}
              <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-card">
                {step.state === 'done' && <CheckCircle2 className="h-6 w-6 text-emerald-600" />}
                {step.state === 'current' && <Loader2 className="h-5 w-5 animate-spin text-primary motion-reduce:animate-none" />}
                {step.state === 'upcoming' && <Circle className="h-5 w-5 text-muted-foreground/50" />}
                {step.state === 'stopped' && <XCircle className="h-6 w-6 text-destructive" />}
              </span>
              <div className="min-w-0 pb-1">
                <p
                  className={cn(
                    'text-sm font-semibold',
                    step.state === 'upcoming' && 'text-muted-foreground',
                    step.state === 'current' && 'text-primary',
                    step.state === 'stopped' && 'text-destructive',
                  )}
                >
                  {step.label}
                  {step.state === 'current' && <span className="sr-only"> (now)</span>}
                </p>
                {step.at && <p className="text-[11px] text-muted-foreground">{formatDay(step.at)}</p>}
              </div>
            </li>
          );
        })}
      </ol>

      {!stopped && request.rent_amount ? (
        <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg bg-muted/40 p-3 text-xs">
          <div>
            <dt className="text-muted-foreground">Rent asked for</dt>
            <dd className="font-semibold tabular-nums">{formatUGX(request.rent_amount)}</dd>
          </div>
          {request.total_repayment ? (
            <div>
              <dt className="text-muted-foreground">Total to repay</dt>
              <dd className="font-semibold tabular-nums">{formatUGX(request.total_repayment)}</dd>
            </div>
          ) : null}
          {request.daily_repayment ? (
            <div>
              <dt className="text-muted-foreground">Each day</dt>
              <dd className="font-semibold tabular-nums">{formatUGX(request.daily_repayment)}</dd>
            </div>
          ) : null}
          {request.duration_days ? (
            <div>
              <dt className="text-muted-foreground">Repayment period</dt>
              <dd className="font-semibold tabular-nums">{request.duration_days} days</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      <p className="mt-3 text-[11px] text-muted-foreground">
        Questions? Call <span className="font-medium text-foreground select-all">{SUPPORT_PHONE_DISPLAY}</span>.
      </p>
    </section>
  );
}
