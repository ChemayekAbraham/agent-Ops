/**
 * Full-width callout at the top of the Financial Ops dashboard: how many
 * payout numbers and bank accounts are waiting to be called and verified,
 * and how much money is held behind that verification.
 */
import { PhoneCall, ShieldAlert } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { usePayoutVerificationCounts } from '@/hooks/usePayoutVerification';

export default function PayoutVerificationCallout({ onOpen }: { onOpen: () => void }) {
  const { data, isLoading } = usePayoutVerificationCounts();
  const waiting = data?.waiting ?? 0;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left rounded-2xl border-2 border-primary/40 bg-gradient-to-br from-primary/10 via-card to-card p-4 sm:p-5 shadow-2xs hover:border-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <div className="flex items-start gap-3">
        <div className="h-12 w-12 rounded-2xl bg-primary/15 border border-primary/30 flex items-center justify-center shrink-0">
          <ShieldAlert className="h-6 w-6 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base sm:text-lg font-bold text-foreground">Verify Payout Numbers</h2>
            {waiting > 0 && (
              <span className="rounded-full bg-destructive px-2 py-0.5 text-[10px] font-bold text-destructive-foreground">
                {waiting > 999 ? '999+' : waiting} waiting
              </span>
            )}
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            Call each holder, confirm the number or bank account is theirs and that it matches their
            National ID. Nobody is paid until you verify.
          </p>
          <p className="text-xs sm:text-sm font-semibold text-foreground mt-2">
            {isLoading
              ? 'Loading…'
              : waiting === 0
                ? 'Everything verified — no numbers waiting.'
                : `${formatUGX(data?.waiting_balance ?? 0)} held behind verification`}
          </p>
        </div>
        <span className="hidden sm:inline-flex items-center gap-1.5 shrink-0 rounded-xl bg-primary text-primary-foreground px-3 py-2 text-xs font-bold">
          <PhoneCall className="h-4 w-4" /> Start calling
        </span>
      </div>
      <span className="sm:hidden mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-primary text-primary-foreground h-11 text-sm font-bold">
        <PhoneCall className="h-4 w-4" /> Start calling
      </span>
    </button>
  );
}
