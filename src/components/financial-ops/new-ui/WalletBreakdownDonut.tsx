import { ArrowRight, FileText } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';

/**
 * Wallet Breakdown on the overview: how the money in wallets splits between withdrawable and operational float.
 * Pure display of the two figures get_wallet_totals already returns. The full searchable list is one click away.
 */
export default function WalletBreakdownDonut({
  withdrawable, float, loading, onViewAll,
}: {
  withdrawable?: number;
  float?: number;
  loading: boolean;
  onViewAll: () => void;
}) {
  const w = Math.max(withdrawable ?? 0, 0);
  const f = Math.max(float ?? 0, 0);
  const total = w + f;
  const wPct = total > 0 ? (w / total) * 100 : 0;
  const fPct = total > 0 ? 100 - wPct : 0;

  // Donut as two stroked circles on a pathLength of 100, so the arc length is the percentage.
  const R = 52;
  const C = 2 * Math.PI * R;
  const arc = (pct: number) => `${(pct / 100) * C} ${C}`;

  return (
    <section className="flex h-full flex-col rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6" aria-label="Wallet breakdown">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <FileText className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h2 className="text-base font-bold tracking-tight text-foreground">Wallet Breakdown</h2>
            <p className="text-xs text-muted-foreground">How money is distributed across wallet buckets.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onViewAll}
          className="inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:min-h-0 sm:py-1"
        >
          View all wallets <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      <div className="mt-5 flex flex-1 flex-wrap items-center gap-6">
        <div className="relative mx-auto h-40 w-40 shrink-0 sm:mx-0" role="img" aria-label={`Withdrawable ${wPct.toFixed(1)} percent, float ${fPct.toFixed(1)} percent`}>
          <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
            <circle cx="60" cy="60" r={R} fill="none" strokeWidth="14" className="stroke-muted" />
            {total > 0 && (
              <>
                <circle cx="60" cy="60" r={R} fill="none" strokeWidth="14" strokeDasharray={arc(fPct)} strokeDashoffset={-((wPct / 100) * C)} className="stroke-[#B07CF0]" />
                <circle cx="60" cy="60" r={R} fill="none" strokeWidth="14" strokeDasharray={arc(wPct)} className="stroke-[#6D28D9]" />
              </>
            )}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">UGX</span>
            <span className={`text-lg font-black tabular-nums leading-tight ${loading ? 'animate-pulse text-muted-foreground' : 'text-foreground'}`}>
              {loading ? '—' : Math.round(total).toLocaleString('en-UG')}
            </span>
            <span className="text-[11px] font-semibold text-muted-foreground">Total</span>
          </div>
        </div>

        <div className="min-w-[14rem] flex-1 space-y-4">
          {[
            { label: 'Withdrawable', amount: w, pct: wPct, dot: 'bg-[#6D28D9]' },
            { label: 'Float', amount: f, pct: fPct, dot: 'bg-[#B07CF0]' },
          ].map((r) => (
            <div key={r.label} className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2 font-medium text-foreground">
                <span className={`h-3 w-3 rounded-full ${r.dot}`} aria-hidden /> {r.label}
              </span>
              <span className="flex items-baseline gap-3 tabular-nums">
                <span className="font-bold text-foreground">{loading ? '—' : formatUGX(r.amount)}</span>
                <span className="w-12 text-right text-xs text-muted-foreground">{loading ? '' : `${r.pct.toFixed(1)}%`}</span>
              </span>
            </div>
          ))}
          <div className="flex h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className="bg-[#6D28D9]" style={{ width: `${wPct}%` }} />
            <div className="bg-[#B07CF0]" style={{ width: `${fPct}%` }} />
          </div>
        </div>
      </div>
    </section>
  );
}
