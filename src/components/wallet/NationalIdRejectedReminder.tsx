/**
 * National ID rejection banner.
 *
 * Shown whenever Financial Ops has rejected one of the user's payout
 * destinations (or their National ID verification failed). The banner is
 * persistent — it renders on every step of the withdraw flow until the user
 * resubmits — and fires a one-time toast per decision so the user is told
 * the moment they open the wallet.
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, IdCard } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useMyPayoutDestinations } from '@/hooks/usePayoutVerification';
import { Button } from '@/components/ui/button';
import NationalIdPrompt from '@/components/wallet/NationalIdPrompt';

const REMINDED_KEY = 'welile-nid-rejection-reminded';

function loadReminded(): string[] {
  try {
    return JSON.parse(localStorage.getItem(REMINDED_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function markReminded(keys: string[]) {
  try {
    const existing = loadReminded();
    localStorage.setItem(REMINDED_KEY, JSON.stringify([...new Set([...existing, ...keys])]));
  } catch {
    /* storage unavailable — banner still shows */
  }
}

export default function NationalIdRejectedReminder({
  className,
  withdrawableBalance = 1,
  onResubmit,
}: {
  className?: string;
  /** Passed through to the resubmit prompt so it renders even at 0 balance. */
  withdrawableBalance?: number;
  /** When provided, the main CTA navigates back to the National ID submission form instead of expanding inline. */
  onResubmit?: () => void;
}) {
  const { user } = useAuth();
  const { data: destinations } = useMyPayoutDestinations(user?.id);
  const [resubmitOpen, setResubmitOpen] = useState(false);

  // Only actually blocking when the user has NO verified destination at
  // all -- otherwise a single rejected destination (an old bank-transfer
  // attempt, a mistyped number, one of several MoMo numbers a proxy agent
  // tried) wrongly told the user their identity verification had entirely
  // failed and blocked withdrawal outright, even though a perfectly good
  // verified MTN/Airtel number already existed for them. Confirmed live
  // 2026-09-14: 2 real users had this exact shape (>=1 rejected + >=1
  // verified) and were both fully blocked by this banner. A rejected
  // destination the user no longer needs shouldn't hold their whole
  // withdrawal hostage once a working one exists.
  const hasVerified = useMemo(
    () => (destinations ?? []).some((d) => d.status === 'verified'),
    [destinations],
  );
  // Funders holding an investor portfolio are exempt from the ID/selfie and
  // payout-destination gates, so a rejection never blocks their payouts.
  const funder = useIsFunderWithPortfolio(user?.id);
  const rejected = useMemo(
    () =>
      hasVerified || funder.isFunder || funder.isLoading
        ? []
        : (destinations ?? []).filter((d) => d.status === 'rejected'),
    [destinations, hasVerified, funder.isFunder, funder.isLoading],
  );

  // One toast per decision; a new decision (different decided_at) reminds again.
  useEffect(() => {
    if (!rejected.length) return;
    const reminded = loadReminded();
    const fresh = rejected.filter((d) => !reminded.includes(`${d.id}:${d.decided_at ?? ''}`));
    if (!fresh.length) return;
    for (const d of fresh.slice(0, 2)) {
      toast.error('National ID verification failed', {
        description:
          d.decision_reason ??
          'Financial Ops could not confirm your National ID. Please resubmit to keep withdrawing.',
        duration: 12_000,
      });
    }
    markReminded(fresh.map((d) => `${d.id}:${d.decided_at ?? ''}`));
  }, [rejected]);

  if (!rejected.length) return null;

  const reasons = [...new Set(rejected.map((d) => d.decision_reason).filter(Boolean))] as string[];

  return (
    <div className={className} role="alert">
      <div className="rounded-lg border-2 border-destructive bg-destructive/10 p-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-destructive/15 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-destructive" />
          </div>
          <div className="flex-1 min-w-0 space-y-1">
            <h4 className="font-bold text-destructive leading-tight">
              National ID verification failed
            </h4>
            <p className="text-sm text-destructive/90">
              Your {rejected.length > 1 ? `${rejected.length} payout numbers/accounts are` : 'payout number/account is'}{' '}
              blocked until you resubmit your National ID and Financial Ops confirms it.
            </p>
            {reasons.map((r) => (
              <p key={r} className="text-xs text-destructive/80 italic">
                Reason given: {r}
              </p>
            ))}
          </div>
        </div>
        <Button
          variant="destructive"
          size="lg"
          className="w-full font-bold"
          onClick={() => {
            if (onResubmit) {
              onResubmit();
            } else {
              setResubmitOpen(true);
            }
          }}
        >
          <IdCard className="w-5 h-5 mr-2" />
          Resubmit National ID
        </Button>
        {!onResubmit && resubmitOpen && (
          <div className="space-y-2">
            <NationalIdPrompt
              blocking
              allowResubmit
              withdrawableBalance={Math.max(1, withdrawableBalance)}
            />
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-muted-foreground"
              onClick={() => setResubmitOpen(false)}
            >
              Hide form
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
