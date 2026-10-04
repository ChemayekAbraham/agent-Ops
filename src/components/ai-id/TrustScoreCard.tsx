import { motion } from 'framer-motion';
import { Shield, TrendingUp, Wallet, Users, BadgeCheck, MapPin, Home, Sparkles, Share2, Trophy } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { formatUGX } from '@/lib/rentCalculations';
import { getRiskTierLabel } from '@/lib/welileAiId';
import type { TrustProfile } from '@/hooks/useTrustProfile';

interface Props {
  trust: TrustProfile['trust'];
  agentPerformance?: TrustProfile['agent_performance'];
  primaryRole?: string;
}

const tierGradient: Record<string, string> = {
  excellent: 'from-emerald-500 to-emerald-700',
  good: 'from-green-500 to-green-700',
  standard: 'from-blue-500 to-blue-700',
  caution: 'from-amber-500 to-amber-700',
  high_risk: 'from-red-500 to-red-700',
  new: 'from-slate-400 to-slate-600',
};

const tierBg: Record<string, string> = {
  excellent: 'bg-emerald-500/5 border-emerald-500/20',
  good: 'bg-green-500/5 border-green-500/20',
  standard: 'bg-blue-500/5 border-blue-500/20',
  caution: 'bg-amber-500/5 border-amber-500/20',
  high_risk: 'bg-red-500/5 border-red-500/20',
  new: 'bg-muted/40 border-border',
};

export function TrustScoreCard({ trust, agentPerformance, primaryRole }: Props) {
  const tier = getRiskTierLabel(trust.tier);
  const score = Math.round(trust.score);
  const isNew = trust.tier === 'new';
  const gradient = tierGradient[trust.tier] || tierGradient.standard;
  const bg = tierBg[trust.tier] || tierBg.standard;

  // Circular progress
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;

  return (
    <Card className={`overflow-hidden ${bg}`}>
      <CardContent className="p-4 sm:p-5 space-y-4">
        {/* Score ring — stacks on mobile, side-by-side on sm+ */}
        <div className="flex flex-col sm:flex-row items-center sm:items-center gap-4 sm:gap-5 text-center sm:text-left">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 200, damping: 18 }}
            className="relative shrink-0"
          >
            <svg
              viewBox="0 0 120 120"
              className="-rotate-90 w-[110px] h-[110px] sm:w-[120px] sm:h-[120px]"
            >
              <circle
                cx="60"
                cy="60"
                r={radius}
                fill="none"
                stroke="hsl(var(--muted))"
                strokeWidth="8"
              />
              <motion.circle
                cx="60"
                cy="60"
                r={radius}
                fill="none"
                stroke="url(#scoreGrad)"
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={circumference}
                initial={{ strokeDashoffset: circumference }}
                animate={{ strokeDashoffset: isNew ? circumference : offset }}
                transition={{ duration: 1.2, ease: 'easeOut' }}
              />
              <defs>
                <linearGradient id="scoreGrad" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" />
                  <stop offset="100%" stopColor="hsl(var(--primary) / 0.5)" />
                </linearGradient>
              </defs>
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-3xl font-bold text-foreground">{isNew ? '–' : score}</span>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">/ 100</span>
            </div>
          </motion.div>

          <div className="flex-1 min-w-0 w-full space-y-2">
            <div className="flex items-center gap-1.5 justify-center sm:justify-start">
              <Shield className="h-4 w-4 text-primary" />
              <span className="text-xs uppercase tracking-wider text-muted-foreground">Welile Trust Score</span>
            </div>
            <div className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-bold text-white bg-gradient-to-r ${gradient}`}>
              {tier.label}
            </div>
            {!isNew && trust.borrowing_limit_ugx > 0 && (
              <div className="pt-1">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Welile Vouches Up To</p>
                <p className="font-bold text-emerald-600 text-base break-words">{formatUGX(trust.borrowing_limit_ugx)}</p>
              </div>
            )}
            {isNew && (
              <p className="text-xs text-muted-foreground">
                Building trust… need {Math.max(5 - trust.data_points, 1)} more activities
              </p>
            )}
          </div>
        </div>

        {/* Breakdown bars */}
        <div className="space-y-2 pt-2 border-t border-border/50">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Score Breakdown</p>
          {trust.weights.supporter !== undefined && (
            <BreakdownBar
              icon={<Sparkles className="h-3 w-3 text-amber-500" />}
              label="Supporter Portfolio & ROI"
              weight={trust.weights.supporter}
              score={trust.breakdown.supporter ?? 0}
              highlight
            />
          )}
          <BreakdownBar
            icon={<TrendingUp className="h-3 w-3" />}
            label="Payment Behavior"
            weight={trust.weights.payment}
            score={trust.breakdown.payment}
          />
          <BreakdownBar
            icon={<Wallet className="h-3 w-3" />}
            label="Wallet Activity"
            weight={trust.weights.wallet}
            score={trust.breakdown.wallet}
          />
          <BreakdownBar
            icon={<Users className="h-3 w-3" />}
            label="Network & Contribution"
            weight={trust.weights.network}
            score={trust.breakdown.network}
            highlight
          />
          {trust.breakdown.referrals !== undefined && trust.breakdown.referrals > 0 && (
            <div className="pl-5 -mt-1">
              <BreakdownBar
                icon={<Share2 className="h-3 w-3 text-emerald-500" />}
                label="↳ Referrals (link sign-ups)"
                weight={18}
                score={trust.breakdown.referrals}
              />
            </div>
          )}
          <BreakdownBar
            icon={<BadgeCheck className="h-3 w-3" />}
            label="Verification & GPS"
            weight={trust.weights.verification}
            score={trust.breakdown.verification}
          />
          <BreakdownBar
            icon={<MapPin className="h-3 w-3" />}
            label="Movement Behavior"
            weight={trust.weights.behavior}
            score={trust.breakdown.behavior}
          />
          <BreakdownBar
            icon={<Home className="h-3 w-3" />}
            label="Landlord Listings"
            weight={trust.weights.landlord}
            score={trust.breakdown.landlord}
          />
          {(trust.weights.agent_performance ?? 0) > 0 &&
            ((trust.breakdown.agent_performance ?? 0) > 0 || primaryRole === 'agent') && (
            <BreakdownBar
              icon={<Trophy className="h-3 w-3 text-emerald-500" />}
              label="Agent Performance"
              weight={trust.weights.agent_performance ?? 10}
              score={trust.breakdown.agent_performance ?? 0}
              highlight
              subtitle={
                agentPerformance && agentPerformance.qualifying_tenants > 0
                  ? `${agentPerformance.healthy_tenants} of ${agentPerformance.qualifying_tenants} tenants paying ≥50% of daily expectation`
                  : 'Need ≥3 active tenants (>30 days) to unlock'
              }
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function BreakdownBar({
  icon,
  label,
  weight,
  score,
  highlight = false,
  subtitle,
}: {
  icon: React.ReactNode;
  label: string;
  weight: number;
  score: number;
  highlight?: boolean;
  subtitle?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className={`flex items-center gap-1.5 min-w-0 flex-1 ${highlight ? 'text-foreground font-semibold' : 'text-muted-foreground'}`}>
          <span className="shrink-0">{icon}</span>
          <span className="truncate">{label}</span>
          <span className="text-[10px] opacity-60 shrink-0">({weight}%)</span>
        </div>
        <span className="font-mono font-medium text-foreground shrink-0 tabular-nums">{Math.round(score)}</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${(score / weight) * 100}%` }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
          className={`h-full rounded-full ${highlight ? 'bg-gradient-to-r from-amber-500 to-amber-300' : 'bg-gradient-to-r from-primary to-primary/60'}`}
        />
      </div>
      {subtitle && (
        <p className="text-[10px] text-muted-foreground pl-5 leading-tight">{subtitle}</p>
      )}
    </div>
  );
}

export default TrustScoreCard;
