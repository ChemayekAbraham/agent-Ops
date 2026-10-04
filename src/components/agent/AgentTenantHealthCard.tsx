import { useTrustProfile } from '@/hooks/useTrustProfile';
import { generateWelileAiId } from '@/lib/welileAiId';
import { Trophy, TrendingUp, TrendingDown } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';

interface Props {
  userId: string;
}

/**
 * Mini "Tenant Health" card on the Agent dashboard.
 * Reads the agent's own trust profile and surfaces:
 *   - % of tenants paying ≥50% of daily expectation
 *   - the vouch limit boost their performance has unlocked
 */
export function AgentTenantHealthCard({ userId }: Props) {
  const aiId = userId ? generateWelileAiId(userId) : undefined;
  const { profile } = useTrustProfile(aiId);

  const ap = profile?.agent_performance;
  if (!ap || ap.qualifying_tenants < 3) return null;

  const pct = Math.round(ap.healthy_ratio * 100);
  const isHealthy = ap.healthy_ratio >= 0.5;
  const isTop = !!ap.top_performing;
  const vouch = profile?.trust.borrowing_limit_ugx ?? 0;

  return (
    <div
      className={`rounded-2xl border p-3.5 flex items-center gap-3 ${
        isTop
          ? 'border-emerald-500/40 bg-gradient-to-br from-emerald-500/10 to-emerald-500/5'
          : isHealthy
          ? 'border-primary/30 bg-gradient-to-br from-primary/10 to-primary/5'
          : 'border-amber-500/40 bg-gradient-to-br from-amber-500/10 to-amber-500/5'
      }`}
    >
      <div
        className={`h-11 w-11 rounded-xl flex items-center justify-center shrink-0 ${
          isTop
            ? 'bg-emerald-600 text-white'
            : isHealthy
            ? 'bg-primary text-primary-foreground'
            : 'bg-amber-500 text-white'
        }`}
      >
        {isTop ? <Trophy className="h-5 w-5" /> : isHealthy ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <p className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground">
            Tenant Health
          </p>
          {isTop && (
            <span className="text-[9px] font-bold bg-emerald-600 text-white px-1.5 py-0.5 rounded">
              TOP AGENT
            </span>
          )}
        </div>
        <p className="text-sm font-bold text-foreground leading-tight mt-0.5">
          {pct}% paying on schedule
          <span className="text-muted-foreground font-normal"> · {ap.healthy_tenants}/{ap.qualifying_tenants}</span>
        </p>
        {vouch > 0 && (
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
            Welile vouches up to <span className="font-semibold text-emerald-600">{formatUGX(vouch)}</span>
          </p>
        )}
      </div>
    </div>
  );
}

export default AgentTenantHealthCard;