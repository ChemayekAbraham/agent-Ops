import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CooOverrideLine } from '@/components/coo/CooOverrideLine';

/**
 * COO/CEO only: a red "Incomplete: family size, LC1 (…)" chip on a Verified
 * card, from funders_board_items.incomplete, to help decide a manual demote.
 * The server sends the list only when funders_board_can_demote() is true (it is
 * null for funders), so this renders nothing for them and nothing when the
 * list is empty.
 *
 * E131: with the request id, a request the COO pushed anyway also shows the
 * amber "COO pushed with items missing: … — <reason>" line under the chip
 * (looked up only when this staff-only list is there).
 */
export function FundersIncompleteChip({ items, requestId, className }: { items: string[] | null | undefined; requestId?: string | null; className?: string }) {
  if (!items || items.length === 0) return null;
  const text = items.join(', ');
  const chip = (
    <p
      data-testid="fv3-incomplete-chip"
      className={cn(
        'flex w-fit max-w-full items-start gap-1.5 rounded-lg bg-destructive/10 px-2.5 py-1 text-[12px] font-semibold leading-snug text-destructive ring-1 ring-destructive/40',
        className,
      )}
      style={{ margin: 0 }}
    >
      <AlertCircle className="mt-px h-3.5 w-3.5 flex-none" aria-hidden />
      <span className="min-w-0 break-words">Incomplete: {text}</span>
    </p>
  );
  if (!requestId) return chip;
  return (
    <>
      {chip}
      <CooOverrideLine requestId={requestId} />
    </>
  );
}

export default FundersIncompleteChip;
