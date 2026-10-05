import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import {
  badgeLabel,
  usePayoutDestinationDetail,
  usePayoutStatusTimeline,
  type PayoutTimelineEvent,
  type UnverifiedWithdrawalRow,
} from '@/hooks/useUnverifiedWithdrawals';
import { AlertTriangle, BadgeCheck, Clock, XCircle } from 'lucide-react';

/**
 * Side panel opened from a payout's status badge: the full audit-style
 * timeline of how it moved between Pending, Needs review and Verified, plus
 * every verification detail and Financial Ops note on file.
 */

function when(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function eventBadge(badge: PayoutTimelineEvent['badge']) {
  if (badge === 'verified') {
    return { Icon: BadgeCheck, tone: 'text-emerald-600 dark:text-emerald-400', label: 'Verified' };
  }
  if (badge === 'rejected') {
    return { Icon: XCircle, tone: 'text-destructive', label: 'Rejected' };
  }
  if (badge === 'needs_review') {
    return { Icon: AlertTriangle, tone: 'text-amber-600 dark:text-amber-400', label: 'Needs review' };
  }
  return { Icon: Clock, tone: 'text-sky-600 dark:text-sky-400', label: 'Pending' };
}

function matchWords(score: number | null): string {
  if (score === null || score === undefined) return 'No National ID to compare';
  if (score >= 0.8) return 'Names match';
  if (score >= 0.5) return 'Names partly match';
  return 'Names do not match';
}

interface Props {
  row: UnverifiedWithdrawalRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function PayoutStatusDetailSheet({ row, open, onOpenChange }: Props) {
  const timeline = usePayoutStatusTimeline(row?.user_id ?? null, row?.id ?? null, open);
  const destinations = usePayoutDestinationDetail(row?.user_id ?? null, open);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader className="text-left">
          <SheetTitle>{row?.full_name ?? 'Payout details'}</SheetTitle>
          <SheetDescription>
            {row ? `${formatUGX(row.amount)} · ${badgeLabel(row.badge)}` : ''}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          <section aria-labelledby="payout-timeline-title">
            <h3 id="payout-timeline-title" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Status timeline
            </h3>
            {timeline.isLoading ? (
              <div className="mt-3 space-y-2" aria-busy="true">
                {[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}
              </div>
            ) : timeline.isError ? (
              <p role="alert" className="mt-3 text-sm text-destructive">
                Could not load the timeline. {(timeline.error as Error)?.message ?? ''}
              </p>
            ) : (timeline.data ?? []).length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">Nothing recorded yet.</p>
            ) : (
              <ol className="mt-3 space-y-0 border-l pl-4">
                {(timeline.data ?? []).map((e, i) => {
                  const { Icon, tone, label } = eventBadge(e.badge);
                  return (
                    <li key={`${e.occurred_at}-${i}`} className="relative pb-4">
                      <span className={`absolute -left-[25px] top-1 rounded-full bg-background p-0.5 ${tone}`}>
                        <Icon className="h-4 w-4" aria-hidden />
                      </span>
                      <p className="text-sm font-medium capitalize">{e.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {when(e.occurred_at)}
                        {e.badge ? ` · ${label}` : ''}
                        {e.actor_name ? ` · ${e.actor_name}` : ''}
                      </p>
                      {e.detail ? <p className="mt-0.5 text-sm">{e.detail}</p> : null}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <section aria-labelledby="payout-detail-title">
            <h3 id="payout-detail-title" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Verification details and notes
            </h3>
            {destinations.isLoading ? (
              <div className="mt-3 space-y-2" aria-busy="true">
                {[0, 1].map((i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
              </div>
            ) : destinations.isError ? (
              <p role="alert" className="mt-3 text-sm text-destructive">
                Could not load the verification details.
              </p>
            ) : (destinations.data ?? []).length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                No payout destination has been recorded for this person yet.
              </p>
            ) : (
              <ul className="mt-3 space-y-3">
                {(destinations.data ?? []).map((d) => (
                  <li key={d.id} className="rounded-xl border bg-card p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium">
                        {d.destination_type === 'bank_transfer'
                          ? [d.bank_name, d.bank_account_number].filter(Boolean).join(' · ')
                          : [d.provider, d.momo_number].filter(Boolean).join(' · ')}
                      </p>
                      <Badge variant="outline" className="capitalize">{d.status}</Badge>
                    </div>
                    <dl className="mt-2 grid grid-cols-1 gap-1 text-muted-foreground">
                      <div className="flex gap-2">
                        <dt className="shrink-0">Name on destination:</dt>
                        <dd className="text-foreground">{d.account_name ?? '—'}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="shrink-0">National ID:</dt>
                        <dd className="text-foreground">{d.national_id ?? '—'}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="shrink-0">Name on ID:</dt>
                        <dd className="text-foreground">{d.national_id_name ?? '—'}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="shrink-0">Name check:</dt>
                        <dd className="text-foreground">{matchWords(d.name_match_score)}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="shrink-0">ID submitted:</dt>
                        <dd className="text-foreground">{when(d.national_id_submitted_at)}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="shrink-0">Decision:</dt>
                        <dd className="text-foreground">
                          {d.decided_at ? when(d.decided_at) : 'Not decided yet'}
                        </dd>
                      </div>
                    </dl>
                    {d.decision_reason ? (
                      <p className="mt-2 rounded-lg bg-muted/60 p-2 text-sm">
                        <span className="font-medium">Note: </span>{d.decision_reason}
                      </p>
                    ) : null}
                    {d.call_outcome ? (
                      <p className="mt-1 text-xs text-muted-foreground">Call: {d.call_outcome}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
