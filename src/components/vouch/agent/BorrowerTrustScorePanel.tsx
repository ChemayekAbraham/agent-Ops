import { ShieldCheck, TrendingUp, Wallet, Users, BadgeCheck, Activity, Home } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import type { TrustProfile } from '@/hooks/useTrustProfile';

/**
 * Prominent Welile Trust Score readout shown to a lending agent for a
 * looked-up borrower — surfaced BEFORE any lending decision.
 * Presentation only: reads the already-fetched trust profile.
 */
export function BorrowerTrustScorePanel({ profile }: { profile: TrustProfile }) {
  const score = Math.max(0, Math.min(100, Number(profile.trust?.score) || 0));
  const tier = profile.trust?.tier ?? 'unrated';
  const limit = Number(profile.trust?.borrowing_limit_ugx) || 0;
  const b = profile.trust?.breakdown ?? ({} as TrustProfile['trust']['breakdown']);
  const onTime = Number(profile.payment_history?.on_time_rate) || 0;

  const tone =
    score >= 75
      ? { text: 'text-emerald-600', ring: 'stroke-emerald-500', chip: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30', label: 'Low risk' }
      : score >= 50
        ? { text: 'text-amber-600', ring: 'stroke-amber-500', chip: 'bg-amber-500/10 text-amber-700 border-amber-500/30', label: 'Moderate risk' }
        : { text: 'text-destructive', ring: 'stroke-destructive', chip: 'bg-destructive/10 text-destructive border-destructive/30', label: 'High risk' };

  const R = 32;
  const C = 2 * Math.PI * R;

  const factors: { label: string; value: number; Icon: typeof Wallet }[] = [
    { label: 'Payments', value: Number(b.payment) || 0, Icon: TrendingUp },
    { label: 'Wallet', value: Number(b.wallet) || 0, Icon: Wallet },
    { label: 'Network', value: Number(b.network) || 0, Icon: Users },
    { label: 'Verification', value: Number(b.verification) || 0, Icon: BadgeCheck },
    { label: 'Behaviour', value: Number(b.behavior) || 0, Icon: Activity },
    { label: 'Landlord', value: Number(b.landlord) || 0, Icon: Home },
  ];
  const maxFactor = Math.max(1, ...factors.map((f) => f.value));

  return (
    <div className="rounded-2xl border border-border bg-muted/30 p-3 space-y-3">
      <div className="flex items-center gap-3">
        <div className="relative h-[76px] w-[76px] shrink-0">
          <svg viewBox="0 0 76 76" className="h-full w-full -rotate-90">
            <circle cx="38" cy="38" r={R} className="stroke-border" strokeWidth="7" fill="none" />
            <circle
              cx="38"
              cy="38"
              r={R}
              className={tone.ring}
              strokeWidth="7"
              strokeLinecap="round"
              fill="none"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - score / 100)}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={cn('text-xl font-bold tabular-nums leading-none', tone.text)}>{score}</span>
            <span className="text-[8px] uppercase tracking-wider text-muted-foreground">/ 100</span>
          </div>
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
            Welile Trust Score
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn('rounded-md border px-1.5 py-0.5 text-[10px] font-bold capitalize', tone.chip)}>
              {tier}
            </span>
            <span className={cn('rounded-md border px-1.5 py-0.5 text-[10px] font-semibold', tone.chip)}>
              {tone.label}
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground leading-snug">
            {profile.trust?.data_points ?? 0} data points · {onTime}% on-time repayments
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400 shrink-0" />
          <span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">
            Welile vouches up to
          </span>
        </div>
        <span className="text-xs font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
          {formatUGX(limit)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {factors.map(({ label, value, Icon }) => (
          <div key={label} className="space-y-1">
            <div className="flex items-center justify-between gap-1">
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground truncate">
                <Icon className="h-3 w-3 shrink-0" />
                {label}
              </span>
              <span className="text-[10px] font-semibold tabular-nums">{value}</span>
            </div>
            <div className="h-1 rounded-full bg-border overflow-hidden">
              <div
                className={cn('h-full rounded-full', score >= 75 ? 'bg-emerald-500' : score >= 50 ? 'bg-amber-500' : 'bg-destructive')}
                style={{ width: `${Math.min(100, (value / maxFactor) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      <p className="text-[10px] text-muted-foreground leading-relaxed">
        Review this score, the vouched amount and the borrower's cash flow before you disburse.
      </p>
    </div>
  );
}

export default BorrowerTrustScorePanel;
