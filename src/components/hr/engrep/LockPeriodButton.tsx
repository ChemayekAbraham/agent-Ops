/**
 * ENGREP P12 — LOCK PERIOD control.
 *
 * The RPC refuses a non-adjudicator; the button is disabled for them too, with the
 * reason on screen, so a rejection is never the first thing they learn.
 * No point, K, score, percentage or payout figure appears or is computed here.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { lockWindow } from '@/hr/engrep/api';
import type { EngrepGranularity } from '@/hr/engrep/types';

const RESTRICTED = 'Adjudication is restricted to the Lead Engineer.';
const LOCKED_BANNER = 'Locked. Corrections by dated addendum.';

const GRANULARITY_LABEL: Record<EngrepGranularity, string> = {
  day: 'DAILY',
  week: 'WEEKLY',
  month: 'MONTHLY',
};

export function pendingAdjudicationReason(unadjudicated: number): string {
  return `${unadjudicated} row${unadjudicated === 1 ? '' : 's'} still need${
    unadjudicated === 1 ? 's' : ''
  } a band and a written basis`;
}

export function LockPeriodButton({
  windowId,
  granularity,
  periodStart,
  periodEnd,
  unadjudicated,
  status,
  canAdjudicate,
}: {
  windowId: string | null;
  granularity: EngrepGranularity;
  periodStart: string | null;
  periodEnd: string | null;
  unadjudicated: number | null;
  status: string | null;
  canAdjudicate: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const queryClient = useQueryClient();
  const locked = status === 'locked';
  const pending = unadjudicated ?? 0;

  const lock = useMutation({
    mutationFn: () => lockWindow(windowId as string),
    onSuccess: () => {
      toast.success(LOCKED_BANNER);
      queryClient.invalidateQueries({ queryKey: ['engrep'] });
      setConfirmOpen(false);
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : 'Could not lock the period'),
  });

  if (locked) {
    return (
      <div className="rounded-lg border border-muted bg-muted/40 p-3">
        <p className="text-sm font-medium">{LOCKED_BANNER}</p>
      </div>
    );
  }

  const reason = !windowId
    ? 'No window opened yet.'
    : !canAdjudicate
      ? RESTRICTED
      : pending > 0
        ? pendingAdjudicationReason(pending)
        : null;

  return (
    <div className="space-y-2">
      <Button
        type="button"
        disabled={Boolean(reason) || lock.isPending}
        onClick={() => setConfirmOpen(true)}
      >
        LOCK PERIOD
      </Button>
      {reason && <p className="text-xs font-medium text-destructive">{reason}</p>}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Lock the {GRANULARITY_LABEL[granularity]} period?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {GRANULARITY_LABEL[granularity]} · {periodStart ?? '—'} to {periodEnd ?? '—'}. Once
              locked, every field on this page becomes read-only. {LOCKED_BANNER}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                lock.mutate();
              }}
            >
              {lock.isPending ? 'Locking…' : 'Lock period'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default LockPeriodButton;
