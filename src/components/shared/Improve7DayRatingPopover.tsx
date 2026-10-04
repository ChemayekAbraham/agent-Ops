import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import {
  HelpCircle, CheckCircle2, Calendar, Users, TrendingUp,
  AlertTriangle, Sparkles, Sunrise, Trophy,
} from 'lucide-react';
import {
  AGENT_TIER_THRESHOLDS,
  GOOD_DAYS_UNLOCK_THRESHOLD,
  type AgentCapacity,
} from '@/hooks/useAgentCapacityMap';
import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

const TIER_RANGE: Record<AgentCapacity['tier'], string> = {
  Positive:   '≥ 70% of tenants paying daily',
  Fair:       '40–69% of tenants paying daily',
  Bad:        '10–39% of tenants paying daily',
  'Very Bad': '< 10% of tenants paying daily',
  Starter:    'No active rents yet',
};

const TIER_TONE: Record<AgentCapacity['tier'], string> = {
  Positive:   'text-emerald-700 bg-emerald-50 border-emerald-200',
  Fair:       'text-amber-700 bg-amber-50 border-amber-200',
  Bad:        'text-orange-700 bg-orange-50 border-orange-200',
  'Very Bad': 'text-destructive bg-destructive/5 border-destructive/20',
  Starter:    'text-violet-700 bg-violet-50 border-violet-200',
};

type Rec = {
  icon: typeof Calendar;
  tone: string;
  text: React.ReactNode;
  /** Stable machine code recorded in the audit log (why this rec fired). */
  code: string;
  /** Plain-text version of the recommendation stored in the audit log. */
  summary: string;
};

/**
 * Builds a PERSONALIZED, prioritized list of recommendations from the agent's
 * own recent activity — silent tenants, the gap to the next tier, today's
 * progress, weekly consistency — instead of generic advice. The weakest areas
 * are surfaced first so the agent knows exactly what to fix.
 */
function buildRecommendations(cap: AgentCapacity): Rec[] {
  const recs: Rec[] = [];

  // Starter / new agents — nothing to measure yet.
  if (cap.tier === 'Starter' || cap.active_tenant_count <= 0) {
    recs.push({
      icon: Sunrise,
      tone: 'text-violet-600',
      text: <>You have no active tenants yet — post your first rent requests to start building a 7-day rating.</>,
      code: 'starter_no_tenants',
      summary: 'No active tenants yet — post first rent requests to start building a 7-day rating.',
    });
    return recs;
  }

  const activeTenants = cap.active_tenant_count || cap.active_count || 0;
  const payingTenants = cap.paying_tenants_last_week || 0;
  const silentTenants = Math.max(0, activeTenants - payingTenants);

  // 1. Weakest area first: tenants who paid NOTHING in the last 7 days.
  if (silentTenants > 0) {
    recs.push({
      icon: AlertTriangle,
      tone: 'text-destructive',
      text: (
        <>
          <strong>{silentTenants}</strong> of your {activeTenants} tenant{activeTenants === 1 ? '' : 's'}{' '}
          paid <strong>nothing</strong> in the last 7 days — visit these first to lift your rate fastest.
        </>
      ),
      code: 'silent_tenants',
      summary: `${silentTenants} of ${activeTenants} tenants paid nothing in last 7 days — visit them first.`,
    });
  }

  // 2. Gap to the next tier, expressed in extra responding tenant-days.
  const nextTarget =
    cap.tier === 'Bad'  ? AGENT_TIER_THRESHOLDS.fair :
    cap.tier === 'Fair' ? AGENT_TIER_THRESHOLDS.positive :
    cap.tier === 'Very Bad' ? AGENT_TIER_THRESHOLDS.bad :
    null;
  const nextTierLabel =
    cap.tier === 'Bad'  ? 'Fair' :
    cap.tier === 'Fair' ? 'Positive' :
    cap.tier === 'Very Bad' ? 'Bad' :
    null;

  if (nextTarget != null && nextTierLabel) {
    const needCells = Math.max(
      1,
      Math.ceil(nextTarget * (cap.expected_tenant_days || activeTenants * 7)) - (cap.responding_tenant_days || 0),
    );
    recs.push({
      icon: TrendingUp,
      tone: 'text-amber-600',
      text: (
        <>
          Get <strong>{needCells}</strong> more tenant-payment{needCells === 1 ? '' : 's'} across this week to
          reach the <strong>{nextTierLabel}</strong> tier.
        </>
      ),
      code: 'next_tier_gap',
      summary: `Get ${needCells} more tenant-payments this week to reach the ${nextTierLabel} tier.`,
    });
  } else if (cap.tier === 'Positive') {
    recs.push({
      icon: Trophy,
      tone: 'text-emerald-600',
      text: <>You're in the top <strong>Positive</strong> tier — keep every tenant paying daily to hold it.</>,
      code: 'positive_hold',
      summary: 'In the top Positive tier — keep every tenant paying daily to hold it.',
    });
  }

  // 3. Today's progress — has the agent started collecting today?
  if ((cap.today_response_pct || 0) <= 0) {
    recs.push({
      icon: Calendar,
      tone: 'text-orange-600',
      text: <>You haven't collected from anyone <strong>today</strong> yet — each tenant who pays today counts toward this week.</>,
      code: 'no_collection_today',
      summary: "No collection today yet — each tenant who pays today counts toward this week.",
    });
  }

  // 4. Weekly consistency (good days last week).
  if ((cap.good_days_last_week || 0) < GOOD_DAYS_UNLOCK_THRESHOLD) {
    const need = GOOD_DAYS_UNLOCK_THRESHOLD - (cap.good_days_last_week || 0);
    recs.push({
      icon: Sparkles,
      tone: 'text-primary',
      text: (
        <>
          Hit your 50% daily target on <strong>{need}</strong> more day{need === 1 ? '' : 's'} this week to unlock
          unlimited posting.
        </>
      ),
      code: 'weekly_consistency',
      summary: `Hit the 50% daily target on ${need} more day(s) this week to unlock unlimited posting.`,
    });
  }

  // 5. Universal nudge — encourage small, frequent payments.
  recs.push({
    icon: Users,
    tone: 'text-primary',
    text: <>Encourage <strong>small, frequent</strong> payments — even UGX 1 a day from a tenant counts as a response.</>,
    code: 'frequent_payments_nudge',
    summary: 'Encourage small, frequent payments — even UGX 1 a day counts as a response.',
  });

  return recs;
}

/**
 * Session-scoped dedupe so opening the same popover repeatedly does not spam
 * the audit table. Keyed by agent + the exact set of reason codes generated.
 */
const loggedRecommendationKeys = new Set<string>();

/**
 * "How to improve your 7-day rating?" — now PERSONALIZED. The 7-day tier
 * measures DAILY RESPONSE RATE (how many tenants paid something on each of the
 * last 7 days). Recommendations are derived from this agent's recent activity
 * and weak areas, weakest first.
 */
export function Improve7DayRatingPopover({
  capacity,
  agentId,
  className,
}: {
  capacity: AgentCapacity;
  /** The agent these recommendations are generated for (recorded in the audit log). */
  agentId: string;
  className?: string;
}) {
  const { user } = useAuth();
  const pct = Math.round((capacity.response_rate || 0) * 100);
  const tone = TIER_TONE[capacity.tier];
  const range = TIER_RANGE[capacity.tier];
  const recs = buildRecommendations(capacity);

  // Record WHEN and WHY recommendations were generated for this agent.
  const logGeneration = useCallback(() => {
    if (!agentId) return;
    const reasonCodes = recs.map((r) => r.code);
    const dedupeKey = `${agentId}|${reasonCodes.join(',')}`;
    if (loggedRecommendationKeys.has(dedupeKey)) return;
    loggedRecommendationKeys.add(dedupeKey);

    supabase
      .from('agent_recommendation_audit')
      .insert({
        generated_for: agentId,
        generated_by: user?.id ?? null,
        tier: capacity.tier,
        response_rate: capacity.response_rate ?? null,
        reason_codes: reasonCodes,
        reasons: recs.map((r) => ({ code: r.code, summary: r.summary })),
        context: {
          active_tenant_count: capacity.active_tenant_count,
          active_count: capacity.active_count,
          paying_tenants_last_week: capacity.paying_tenants_last_week,
          responding_tenant_days: capacity.responding_tenant_days,
          expected_tenant_days: capacity.expected_tenant_days,
          today_response_pct: capacity.today_response_pct,
          yesterday_response_pct: capacity.yesterday_response_pct,
          good_days_last_week: capacity.good_days_last_week,
          daily_status: capacity.daily_status,
        },
      })
      .then(({ error }) => {
        if (error) {
          // Non-critical: roll back the dedupe guard so a later open can retry.
          loggedRecommendationKeys.delete(dedupeKey);
        }
      });
  }, [agentId, user?.id, capacity, recs]);

  return (
    <Popover onOpenChange={(open) => { if (open) logGeneration(); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center justify-center h-5 w-5 rounded-full border border-border bg-background hover:bg-muted transition-colors ${className || ''}`}
          aria-label="How to improve your 7-day rating?"
          title="How to improve your 7-day rating?"
          onClick={(e) => e.stopPropagation()}
        >
          <HelpCircle className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3 space-y-2.5" align="end" sideOffset={4}>
        <p className="text-xs font-bold text-foreground">How to improve your 7-day rating</p>

        <p className="text-[11px] text-muted-foreground leading-snug">
          This rating tracks how many of your tenants pay
          <strong className="text-foreground"> something every day</strong> — not the amount.
          Here's what will help <strong className="text-foreground">you</strong> most right now:
        </p>

        <div className={`rounded-md border px-2 py-1.5 flex items-center justify-between text-[11px] ${tone}`}>
          <span className="font-bold">Now: {capacity.tier} · {pct}%</span>
          <span className="tabular-nums text-right">{range}</span>
        </div>

        <ul className="space-y-1.5">
          {recs.map((r, i) => {
            const Icon = r.icon;
            return (
              <li key={i} className="flex items-start gap-2 text-[11px] text-foreground">
                <Icon className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${r.tone}`} />
                <span>{r.text}</span>
              </li>
            );
          })}
        </ul>

        <p className="text-[10px] text-muted-foreground leading-snug flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-600" />
          Reach <strong className="text-foreground">70%</strong> daily response for the top
          <strong className="text-foreground"> Positive</strong> tier &amp; highest rent limits.
        </p>
      </PopoverContent>
    </Popover>
  );
}

export default Improve7DayRatingPopover;
