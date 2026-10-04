import { TrendingUp, Sparkles, Lock, Award } from 'lucide-react';
import { formatUGX } from '@/lib/businessAdvanceCalculations';
import { Progress } from '@/components/ui/progress';

interface Props {
  monthsRecorded: number;
  totalLimit: number;
  nextUnlockAmount: number | null;
  nextUnlockAtMonths: number | null;
  tierLabel: string;
  avgMonthlyRent: number;
}

const TIER_STYLES: Record<string, { gradient: string; ring: string; emoji: string }> = {
  Starter:        { gradient: 'from-slate-500 to-slate-700',    ring: 'ring-slate-300/40', emoji: '🌱' },
  Building:       { gradient: 'from-blue-500 to-indigo-600',     ring: 'ring-blue-300/40',  emoji: '🏗️' },
  Established:    { gradient: 'from-emerald-500 to-teal-600',    ring: 'ring-emerald-300/40', emoji: '⭐' },
  'Welile Trusted': { gradient: 'from-amber-500 to-orange-600',  ring: 'ring-amber-300/40', emoji: '👑' },
};

export default function AdvanceLimitMarketingCard({
  monthsRecorded,
  totalLimit,
  nextUnlockAmount,
  nextUnlockAtMonths,
  tierLabel,
  avgMonthlyRent,
}: Props) {
  const style = TIER_STYLES[tierLabel] || TIER_STYLES.Starter;
  const progress = nextUnlockAtMonths
    ? Math.min(100, (monthsRecorded / nextUnlockAtMonths) * 100)
    : 100;

  return (
    <div className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${style.gradient} text-white p-5 shadow-xl ring-2 ${style.ring}`}>
      {/* Decorative blob */}
      <div className="absolute -top-8 -right-8 w-32 h-32 rounded-full bg-white/10 blur-2xl" />
      <div className="absolute -bottom-12 -left-4 w-40 h-40 rounded-full bg-white/5 blur-3xl" />

      <div className="relative space-y-4">
        {/* Tier badge */}
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-widest font-bold bg-white/20 backdrop-blur px-2.5 py-1 rounded-full">
            <span>{style.emoji}</span> {tierLabel} tier
          </span>
          <span className="text-[10px] uppercase tracking-wider font-bold opacity-80">
            {monthsRecorded}/12 months
          </span>
        </div>

        {/* Headline accessible amount */}
        <div>
          <p className="text-[11px] uppercase tracking-widest font-bold opacity-80 flex items-center gap-1">
            <Sparkles className="h-3 w-3" /> You can access today
          </p>
          <p className="text-4xl sm:text-5xl font-black tracking-tight leading-none mt-1">
            {formatUGX(totalLimit)}
          </p>
          {avgMonthlyRent > 0 && (
            <p className="text-[11px] opacity-80 mt-1.5">
              Based on {formatUGX(avgMonthlyRent)} avg monthly rent
            </p>
          )}
        </div>

        {/* Next unlock */}
        {nextUnlockAmount && nextUnlockAtMonths && (
          <div className="space-y-2 pt-2 border-t border-white/20">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1 font-semibold">
                <Lock className="h-3 w-3" /> Unlock at {nextUnlockAtMonths} months
              </span>
              <span className="font-black text-base">{formatUGX(nextUnlockAmount)}</span>
            </div>
            <Progress value={progress} className="h-1.5 bg-white/20" />
            <p className="text-[10px] opacity-80 flex items-center gap-1">
              <TrendingUp className="h-3 w-3" />
              Add {nextUnlockAtMonths - monthsRecorded} more month{nextUnlockAtMonths - monthsRecorded === 1 ? '' : 's'} of rent history to unlock
            </p>
          </div>
        )}

        {!nextUnlockAmount && tierLabel === 'Welile Trusted' && (
          <div className="pt-2 border-t border-white/20">
            <p className="text-xs flex items-center gap-1.5 font-semibold">
              <Award className="h-3.5 w-3.5" /> Maximum tier unlocked — keep paying on time to grow further
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
