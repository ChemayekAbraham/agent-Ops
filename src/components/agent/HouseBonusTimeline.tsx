import { CheckCircle2, Circle, Clock, Coins } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import type { HouseListing } from '@/hooks/useHouseListings';

function formatWhen(value?: string | null) {
  if (!value) return null;
  try {
    return new Date(value).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
}

interface BonusStage {
  amount: number;
  title: string;
  hint: string;
  done: boolean;
  when: string | null;
}

/**
 * Per-house bonus status timeline.
 * Single stage: UGX 2,000 released ONLY after Landlord Ops verifies the house.
 * There is no instant listing reward.
 */
const LISTING_BONUS = 2000;

export function HouseBonusTimeline({ listing }: { listing: HouseListing }) {
  const verified = !!listing.verified;
  const releasePaid = !!listing.listing_bonus_paid;
  const releaseWhen = formatWhen(listing.listing_bonus_paid_at) ?? formatWhen(listing.verified_at);

  const stages: BonusStage[] = [
    {
      amount: LISTING_BONUS,
      title: 'Verification bonus released',
      hint: verified
        ? 'Released after Landlord Ops verified the house'
        : 'No instant reward — releases once Landlord Ops verifies the house',
      done: releasePaid,
      when: releaseWhen,
    },
  ];

  const earned = stages.filter((s) => s.done).reduce((sum, s) => sum + s.amount, 0);

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold flex items-center gap-1.5">
          <Coins className="h-3.5 w-3.5 text-success" />
          Listing bonus
        </p>
        <span className="text-[11px] text-muted-foreground">
          <span className="font-bold text-success">{formatUGX(earned)}</span> of {formatUGX(LISTING_BONUS)}
        </span>
      </div>

      <ol className="relative space-y-3 pl-1">
        {stages.map((stage, i) => {
          const isLast = i === stages.length - 1;
          return (
            <li key={stage.title} className="relative flex gap-2.5">
              {!isLast && (
                <span
                  aria-hidden
                  className={`absolute left-[7px] top-5 h-[calc(100%-4px)] w-px ${stage.done ? 'bg-success/40' : 'bg-border'}`}
                />
              )}
              <span className="relative z-10 mt-0.5 shrink-0">
                {stage.done ? (
                  <CheckCircle2 className="h-4 w-4 text-success" />
                ) : (
                  <Circle className="h-4 w-4 text-muted-foreground/50" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className={`text-[11px] font-medium ${stage.done ? '' : 'text-muted-foreground'}`}>
                    {stage.title}
                  </p>
                  <span className={`text-[11px] font-bold shrink-0 ${stage.done ? 'text-success' : 'text-muted-foreground'}`}>
                    +{formatUGX(stage.amount)}
                  </span>
                </div>
                <p className="text-[10px] text-muted-foreground leading-snug">{stage.hint}</p>
                {stage.done && stage.when ? (
                  <p className="text-[10px] text-success/80 mt-0.5">Credited {stage.when}</p>
                ) : (
                  <p className="text-[10px] text-muted-foreground/70 mt-0.5 flex items-center gap-1">
                    <Clock className="h-3 w-3" /> Pending
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}