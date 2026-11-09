import { AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { useLandlordFloatPerformance } from '@/hooks/useLandlordFloatPerformance';

const fmtDay = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(`${iso.slice(0, 10)}T12:00:00+03:00`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Kampala' });
};

/**
 * Tells the agent where they stand before they try to withdraw landlord float: the rate against the 50% minimum, how much more to
 * collect, and whether management has made an exception this week. The withdrawal dialogs still open for everyone; this is what they
 * see at the top.
 */
export function LandlordFloatPerformanceNotice({ className = '' }: { className?: string }) {
  const { performance: p, blocked } = useLandlordFloatPerformance();
  if (!p) return null;

  const period =
    p.basis === 'rolling_7d'
      ? 'over the last 7 days'
      : `this week (${fmtDay(p.weekStart)} to ${fmtDay(p.weekEnd)})`;

  if (blocked) {
    return (
      <div role="alert" className={`rounded-xl border-2 border-destructive/40 bg-destructive/5 p-3 text-sm ${className}`}>
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0">
            <p className="font-bold text-destructive">You can&apos;t withdraw landlord float yet</p>
            <p className="mt-1 text-foreground">
              Your collection rate {period} is <strong>{p.ratePct}%</strong> ({formatUGX(p.collected)} collected of {formatUGX(p.expected)} due). The minimum is 50%.
            </p>
            {p.shortfallTo50 > 0 && (
              <p className="mt-1 text-foreground">
                Collect <strong>{formatUGX(p.shortfallTo50)}</strong> more to reach 50% and you can withdraw.
                {p.basis !== 'rolling_7d' ? ' The week resets every Thursday.' : ''}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (p.exceptionReason) {
    return (
      <div className={`flex items-start gap-2 rounded-xl border border-sky-500/40 bg-sky-500/5 p-3 text-sm ${className}`}>
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" aria-hidden />
        <p className="text-foreground">
          Management has allowed you to withdraw landlord float this week, although your collection rate {period} is {p.ratePct}%.
        </p>
      </div>
    );
  }

  if (p.ratePct != null) {
    return (
      <div className={`flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs ${className}`}>
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
        <p className="text-foreground">
          Collection rate {period}: <strong>{p.ratePct}%</strong>. You meet the 50% minimum.
        </p>
      </div>
    );
  }
  return null;
}
