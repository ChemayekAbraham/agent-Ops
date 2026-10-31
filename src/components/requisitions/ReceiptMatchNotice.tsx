import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/creditFeeCalculations';
import {
  assessReceiptPayout,
  type ReceiptFacts,
  type ReceiptVerdict,
} from '../../../supabase/functions/_shared/requisitionReceiptMatch';

const TITLES: Record<ReceiptVerdict['status'], string> = {
  no_receipt: 'No requisition receipt',
  pending: 'Receipt not read yet',
  matched: 'Receipt matches the typed amount',
  partial: 'Receipt is short of the typed amount',
  mismatch: 'Receipt is higher than the typed amount',
  needs_manual_review: 'Receipt needs a person to read it',
};

function signed(n: number) {
  const abs = formatUGX(Math.abs(n));
  if (n > 0) return `${abs} more was typed than the receipt shows`;
  if (n < 0) return `${abs} more is on the receipt than was typed`;
  return 'No difference';
}

/** Displays the server receipt facts. The payout decision is the shared gate. */
export function ReceiptMatchNotice({ row, className }: { row: ReceiptFacts; className?: string }) {
  const verdict = assessReceiptPayout(row);
  if (!verdict.active || verdict.status === 'no_receipt') return null;
  const tone = verdict.payoutFrozen
    ? 'border-amber-500/40 bg-amber-500/10 text-amber-950'
    : verdict.status === 'matched'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-950'
      : 'border-muted bg-muted/40';
  return (
    <div className={cn('rounded-xl border p-3 text-sm', tone, className)}>
      <p className="font-medium">{TITLES[verdict.status]}</p>
      <p className="mt-1 text-xs leading-relaxed">{verdict.message}</p>
      {verdict.amountUnaccounted != null && (
        <p className="mt-1 text-xs">Unaccounted (typed − receipt): {signed(verdict.amountUnaccounted)}.</p>
      )}
      {verdict.approvedUnaccounted != null && (
        <p className="mt-1 text-xs">
          Approved amount versus receipt: {signed(verdict.approvedUnaccounted)}. Payout still follows the typed amount.
        </p>
      )}
    </div>
  );
}

export { assessReceiptPayout };
