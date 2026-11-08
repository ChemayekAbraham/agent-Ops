/**
 * Full-width banner at the top of the Financial Ops overview: how many payout
 * numbers and bank accounts are waiting to be called and verified, and how much
 * money is held behind that verification.
 */
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { usePayoutVerificationCounts } from '@/hooks/usePayoutVerification';

export default function PayoutVerificationCallout({ onOpen }: { onOpen: () => void }) {
  const { data, isLoading } = usePayoutVerificationCounts();
  const waiting = data?.waiting ?? 0;

  const status = isLoading
    ? 'Confirm payout destinations before payment.'
    : waiting === 0
      ? 'Everything is verified. No numbers are waiting.'
      : `${waiting.toLocaleString()} payout destination${waiting === 1 ? ' is' : 's are'} waiting for verification. ${formatUGX(data?.waiting_balance ?? 0)} is held behind it.`;

  return (
    <div className="flex flex-wrap items-center gap-3 sm:gap-4 rounded-2xl border border-primary/25 bg-primary/10 p-4 sm:px-5 shadow-2xs">
      <div className="h-11 w-11 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center shrink-0">
        <ShieldCheck className="h-6 w-6 text-primary" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-bold tracking-tight text-foreground">Verify phone numbers</h2>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">{status}</p>
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background w-full sm:w-auto"
      >
        Verify phone numbers <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
