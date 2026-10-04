import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Fingerprint, ShieldCheck, Sparkles, ChevronRight, ChevronDown, Info, Clock } from 'lucide-react';
import { useTrustProfile } from '@/hooks/useTrustProfile';
import { generateWelileAiId } from '@/lib/welileAiId';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticTap } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { AgentVouchHistoryFeed } from './AgentVouchHistoryFeed';
import { onVouchUpdated } from '@/lib/vouchEvents';
import { EarnedVouchRangeBreakdown } from './EarnedVouchRangeBreakdown';

interface Props {
  userId: string;
}

/**
 * Premium "Welile Vouches" highlight card on the Agent dashboard.
 * - Headline: vouch amount (borrowing_limit_ugx)
 * - Sub: trust score + tier
 * - Expandable section: explains the calculation (healthy ratio, collection rate, tier)
 * - AI ID chip: navigates to /profile/WEL-XXXXXX
 */
export function AgentVouchHighlightCard({ userId }: Props) {
  const navigate = useNavigate();
  const aiId = userId ? generateWelileAiId(userId) : undefined;
  const { profile, loading, refresh } = useTrustProfile(aiId);
  const [expanded, setExpanded] = useState(false);

  // Refresh trust profile in real-time when a collection lands.
  useEffect(() => {
    return onVouchUpdated((d) => {
      if (!d.agentId || d.agentId === userId) refresh();
    });
  }, [userId, refresh]);

  if (loading && !profile) return null;
  if (!profile) return null;

  const vouch = profile.trust.borrowing_limit_ugx ?? 0;
  const score = Math.round(profile.trust.score ?? 0);
  const tier = profile.trust.tier || 'building';
  const isTopAgent = !!profile.agent_performance?.top_performing;
  const ap = profile.agent_performance;

  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
  const healthyPct = ap ? Math.round(ap.healthy_ratio * 100) : 0;
  const collectionPct = ap ? Math.round(ap.collection_rate * 100) : 0;
  const monthlyBook = ap?.monthly_book ?? 0;
  const agentTerm = ap ? Math.round(monthlyBook * ap.healthy_ratio * 0.4) : 0;
  const qualifying = ap?.qualifying_tenants ?? 0;
  const healthy = ap?.healthy_tenants ?? 0;

  // Tier thresholds (must mirror trust scoring scale)
  const tierThresholds = [
    { key: 'excellent', label: 'Excellent', min: 80 },
    { key: 'good', label: 'Good', min: 60 },
    { key: 'fair', label: 'Fair', min: 40 },
    { key: 'building', label: 'Building', min: 0 },
  ];
  const currentTier = tierThresholds.find((t) => score >= t.min) ?? tierThresholds[3];
  const nextTier = [...tierThresholds].reverse().find((t) => t.min > score);

  const goToProfile = () => {
    hapticTap();
    if (aiId) navigate(`/profile/${aiId}`);
  };

  // Data freshness — `generated_at` is when the trust RPC computed this snapshot.
  const generatedAt = profile.generated_at ? new Date(profile.generated_at) : null;
  const fmtFull = (d: Date) =>
    d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  const fmtRelative = (d: Date) => {
    const diffMs = Date.now() - d.getTime();
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    return `${days}d ago`;
  };

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    hapticTap();
    setExpanded((v) => !v);
  };

  return (
    <div className="w-full rounded-2xl relative overflow-hidden border border-primary/25 bg-gradient-to-br from-primary/12 via-primary/[0.06] to-emerald-500/10">
      {/* Decorative shimmer */}
      <div className="pointer-events-none absolute -top-12 -right-12 h-40 w-40 rounded-full bg-primary/15 blur-2xl" />
      <div className="pointer-events-none absolute -bottom-10 -left-10 h-28 w-28 rounded-full bg-emerald-500/15 blur-2xl" />

      {/* Header row — display only (no tap behaviour) */}
      <div className="relative w-full p-4 flex items-center gap-3">
        <div className="h-12 w-12 rounded-xl bg-primary text-primary-foreground flex items-center justify-center shrink-0 shadow-sm">
          <ShieldCheck className="h-6 w-6" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="text-[10px] uppercase tracking-[0.14em] font-bold text-primary/80">
              Welile Vouches For You
            </p>
            {isTopAgent && (
              <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-emerald-600 text-white px-1.5 py-0.5 rounded">
                <Sparkles className="h-2.5 w-2.5" />
                TOP AGENT
              </span>
            )}
          </div>
          <p className="text-[clamp(1.25rem,6vw,1.75rem)] font-black tracking-tight leading-tight mt-1 text-foreground truncate">
            {vouch > 0 ? `Up to ${formatUGX(vouch)}` : 'Build your vouch limit'}
          </p>
          <p className="text-[11px] text-muted-foreground mt-1 truncate">
            Trust Score <span className="font-semibold text-foreground">{score}</span>
            <span className="mx-1">·</span>
            <span className="font-semibold text-foreground">{tierLabel}</span>
          </p>
        </div>
      </div>

      {/* Thumb-friendly action buttons — stacked on mobile, inline on sm+ */}
      <div className="relative px-4 pb-4 flex flex-col sm:flex-row gap-2">
        <button
          onClick={toggle}
          aria-expanded={expanded}
          className="flex-1 inline-flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-xl border border-primary/30 bg-background/60 hover:bg-primary/5 text-foreground text-sm font-semibold active:scale-[0.97] transition-all"
          style={{ WebkitTapHighlightColor: 'transparent' }}
        >
          <ChevronDown className={cn('h-4 w-4 transition-transform text-primary', expanded && 'rotate-180')} />
          {expanded ? 'Hide details' : 'How is this calculated?'}
        </button>
        <button
          onClick={goToProfile}
          className="flex-1 inline-flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-xl bg-primary text-primary-foreground text-sm font-bold shadow-sm active:scale-[0.97] transition-all"
          style={{ WebkitTapHighlightColor: 'transparent' }}
        >
          <Fingerprint className="h-4 w-4" />
          {vouch > 0 ? 'Open my AI ID' : 'Build my vouch limit'}
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Expandable explainer */}
      {expanded && (
        <div className="relative border-t border-primary/15 bg-background/40 backdrop-blur-sm px-4 py-3.5 space-y-3">
          {/* Trust pillar ranking — communicates that rent collection is the
              #2 trust pillar after Supporter Portfolio. Static order; the
              underlying weights live in recompute_trust_score on the backend. */}
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-2.5">
            <p className="text-[10px] uppercase tracking-wider font-bold text-emerald-700 dark:text-emerald-400 mb-1.5">
              Trust Pillars (in order of weight)
            </p>
            <ol className="text-[11px] space-y-1">
              <li className="flex items-center gap-1.5">
                <span className="font-bold text-muted-foreground w-3">1.</span>
                <span className="text-muted-foreground">Supporter Portfolio</span>
              </li>
              <li className="flex items-center gap-1.5 rounded px-1.5 py-1 -mx-1.5 bg-emerald-500/10">
                <span className="font-black text-emerald-700 dark:text-emerald-400 w-3">2.</span>
                <span className="font-bold text-foreground">Rent Collection</span>
                <span className="ml-auto text-[9px] uppercase tracking-wider font-bold text-emerald-700 dark:text-emerald-400">
                  You
                </span>
              </li>
              <li className="flex items-center gap-1.5">
                <span className="font-bold text-muted-foreground w-3">3.</span>
                <span className="text-muted-foreground">Verification &amp; GPS</span>
              </li>
              <li className="flex items-center gap-1.5">
                <span className="font-bold text-muted-foreground w-3">4.</span>
                <span className="text-muted-foreground">Wallet behaviour</span>
              </li>
            </ol>
          </div>

          <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
            <Info className="h-3.5 w-3.5 text-primary shrink-0 mt-px" />
            <span>
              Your vouch limit grows when your tenants pay on schedule. Welile uses three signals from your portfolio:
            </span>
          </p>

          {/* Healthy ratio */}
          <MetricRow
            label="Healthy tenants"
            sub={qualifying >= 3
              ? `${healthy} of ${qualifying} paying ≥50% of daily expectation`
              : `Need ≥3 tenants active 30+ days (you have ${qualifying})`}
            value={qualifying >= 3 ? `${healthyPct}%` : '—'}
            pct={qualifying >= 3 ? healthyPct : 0}
            tone={healthyPct >= 80 ? 'good' : healthyPct >= 50 ? 'mid' : 'low'}
          />

          {/* Collection rate */}
          <MetricRow
            label="Collection rate (30d)"
            sub="Total collected vs. expected across qualifying tenants"
            value={qualifying >= 3 ? `${collectionPct}%` : '—'}
            pct={qualifying >= 3 ? collectionPct : 0}
            tone={collectionPct >= 80 ? 'good' : collectionPct >= 50 ? 'mid' : 'low'}
          />

          {/*
           * Earned vouch breakdown — surfaces the new field-collections
           * driver so agents can see exactly how much extra vouch their
           * collecting work has earned them. Self-fetching subcomponent
           * keeps the parent simple and avoids re-fetching on unrelated
           * re-renders. Always visible (no `qualifying >= 3` gate)
           * because the 100k base + earned growth applies to every agent
           * regardless of trust-score eligibility.
           */}
          {/* Date-range filterable breakdown (7d / 30d / 90d / All).
              Replaces the legacy lifetime-only EarnedVouchBreakdown. */}
          {aiId && (
            <EarnedVouchRangeBreakdown
              aiId={aiId}
              effectiveLimitUgx={vouch}
            />
          )}

          {/* Per-collection vouch change feed (includes reversals) */}
          <AgentVouchHistoryFeed agentId={userId} />

          {/* Tier ladder */}
          <div className="rounded-xl border border-border/50 bg-card/60 p-2.5">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Trust Tier</p>
              <p className="text-[11px] font-bold text-foreground">
                {currentTier.label}
                <span className="text-muted-foreground font-normal"> · {score}/100</span>
              </p>
            </div>
            <div className="flex items-center gap-1">
              {tierThresholds.slice().reverse().map((t) => {
                const reached = score >= t.min;
                const active = t.key === currentTier.key;
                return (
                  <div
                    key={t.key}
                    className={cn(
                      'flex-1 text-center rounded-md py-1 text-[9px] font-bold uppercase tracking-wider border',
                      active && 'bg-primary text-primary-foreground border-primary',
                      !active && reached && 'bg-primary/10 text-primary border-primary/30',
                      !reached && 'bg-muted/40 text-muted-foreground border-border/50',
                    )}
                  >
                    {t.label}
                  </div>
                );
              })}
            </div>
            {nextTier && (
              <p className="text-[10px] text-muted-foreground mt-1.5">
                {nextTier.min - score} more points to reach <span className="font-semibold text-foreground">{nextTier.label}</span>
              </p>
            )}
          </div>

          {/* Vouch math */}
          {qualifying >= 3 && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-2.5">
              <p className="text-[10px] uppercase tracking-wider font-bold text-emerald-700 dark:text-emerald-400 mb-1">
                Why your vouch is {formatUGX(vouch)}
              </p>
              <p className="text-[11px] text-foreground/80 leading-relaxed">
                Monthly tenant book <span className="font-semibold">{formatUGX(monthlyBook)}</span>
                <span className="mx-1">×</span>
                healthy ratio <span className="font-semibold">{healthyPct}%</span>
                <span className="mx-1">×</span>
                <span className="font-semibold">40%</span>
                <span className="mx-1">=</span>
                <span className="font-bold text-emerald-700 dark:text-emerald-400">{formatUGX(agentTerm)}</span>
              </p>
              <p className="text-[10px] text-muted-foreground mt-1">
                Welile vouches the larger of this number and your other trust signals.
              </p>
            </div>
          )}

          {/* Exact inputs & timestamps */}
          <div className="rounded-xl border border-border/60 bg-card/70 p-2.5">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
                Exact inputs used
              </p>
              {generatedAt && (
                <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground" title={fmtFull(generatedAt)}>
                  <Clock className="h-3 w-3" />
                  {fmtRelative(generatedAt)}
                </span>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
              <dt className="text-muted-foreground">Healthy ratio</dt>
              <dd className="text-right font-bold tabular-nums text-foreground">
                {qualifying >= 3 ? `${healthyPct}%` : '—'}
              </dd>
              <dt className="text-muted-foreground">Healthy / qualifying</dt>
              <dd className="text-right font-bold tabular-nums text-foreground">
                {healthy} / {qualifying}
              </dd>
              <dt className="text-muted-foreground">Collection rate (30d)</dt>
              <dd className="text-right font-bold tabular-nums text-foreground">
                {qualifying >= 3 ? `${collectionPct}%` : '—'}
              </dd>
              <dt className="text-muted-foreground">Monthly tenant book</dt>
              <dd className="text-right font-bold tabular-nums text-foreground">
                {formatUGX(monthlyBook)}
              </dd>
              <dt className="text-muted-foreground">Trust score</dt>
              <dd className="text-right font-bold tabular-nums text-foreground">
                {score} / 100
              </dd>
              <dt className="text-muted-foreground">Current tier</dt>
              <dd className="text-right font-bold text-foreground">
                {currentTier.label}
              </dd>
              <dt className="text-muted-foreground">Vouch limit</dt>
              <dd className="text-right font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                {formatUGX(vouch)}
              </dd>
            </dl>
            {generatedAt && (
              <p className="text-[10px] text-muted-foreground mt-2 pt-2 border-t border-border/40">
                Last updated: <span className="font-medium text-foreground">{fmtFull(generatedAt)}</span>
              </p>
            )}
          </div>

          <button
            onClick={goToProfile}
            className="w-full mt-1 inline-flex items-center justify-center gap-1.5 py-2 rounded-lg bg-primary text-primary-foreground text-[11px] font-bold uppercase tracking-wider active:scale-95 transition-transform"
          >
            <Fingerprint className="h-3.5 w-3.5" />
            Open full Trust Profile
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

interface MetricRowProps {
  label: string;
  sub: string;
  value: string;
  pct: number;
  tone: 'good' | 'mid' | 'low';
}

function MetricRow({ label, sub, value, pct, tone }: MetricRowProps) {
  const barColor =
    tone === 'good' ? 'bg-emerald-500' : tone === 'mid' ? 'bg-primary' : 'bg-amber-500';
  const valueColor =
    tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'mid' ? 'text-primary' : 'text-amber-600 dark:text-amber-400';

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <p className="text-[11px] font-semibold text-foreground">{label}</p>
        <p className={cn('text-[11px] font-bold tabular-nums', valueColor)}>{value}</p>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', barColor)}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
      <p className="text-[10px] text-muted-foreground mt-1">{sub}</p>
    </div>
  );
}

export default AgentVouchHighlightCard;
