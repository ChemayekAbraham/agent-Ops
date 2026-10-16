import { AlertTriangle } from 'lucide-react';
import { landlordFloatExcess, type LandlordFloatPosition } from '@/lib/landlordFloatBudget';
import { formatUGX } from '@/lib/rentCalculations';

export function LandlordFloatExcessBanner({ daily, weekly }: { daily: number; weekly: number }) {
  if (daily <= 0 && weekly <= 0) return null;
  return <div role="alert" className="flex items-start gap-2 border border-warning/30 bg-warning/10 p-3 text-sm text-foreground">
    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
    <div className="min-w-0 space-y-1">{daily > 0 && <p>Approved landlord float exceeds the daily budget by {formatUGX(daily)}</p>}{weekly > 0 && <p>Approved landlord float exceeds the weekly budget by {formatUGX(weekly)}</p>}</div>
  </div>;
}

export function LandlordFloatBudgetPosition({ position }: { position: LandlordFloatPosition }) {
  const excess = landlordFloatExcess(position);
  return <section aria-label="Landlord float budget position" className="space-y-3 border-b border-border pb-4">
    <h3 className="font-semibold">Landlord float budget</h3>
    <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
      {([['Today’s budget', position.daily.amount], ['Used today', position.daily.used], ['Miscellaneous today', position.daily.misc_used], ['Remaining today', position.daily.remaining], ['Remaining this week', position.weekly.remaining], ['Room left', position.room]] as const).map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 font-semibold tabular-nums break-words">{value === null ? 'Not set' : formatUGX(value)}</dd></div>)}
    </dl>
    {position.blocked && <p role="alert" className="text-sm text-warning">Approvals paused: waiting for the CFO to set {position.blocked_reason === 'no_weekly_budget' ? 'this week’s' : 'today’s'} landlord float budget</p>}
    <LandlordFloatExcessBanner daily={excess.daily} weekly={excess.weekly} />
  </section>;
}