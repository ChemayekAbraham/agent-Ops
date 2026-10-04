import { motion } from 'framer-motion';
import { roleToSlug } from '@/lib/roleRoutes';
import { Sparkles, ChevronRight, MapPin, Home, Wallet, Users, IdCard, Activity, Trophy } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

import { useNavigate } from 'react-router-dom';
import type { TrustProfile } from '@/hooks/useTrustProfile';

interface Suggestion {
  icon: React.ReactNode;
  title: string;
  description: string;
  cta: string;
  action: () => void;
  priority: number; // higher = stronger boost
}

interface Props {
  profile: TrustProfile;
  /** When false, hide entirely (e.g., public/lender view) */
  showForSelfOnly?: boolean;
}

/**
 * Inline "Boost Your Trust" suggestions shown on a member's own profile.
 * Provokes action: rent payments, landlord onboarding, GPS opt-in, etc.
 */
export function TrustBoostSuggestions({ profile, showForSelfOnly = true }: Props) {
  const navigate = useNavigate();

  if (showForSelfOnly && !profile.permissions.is_self) return null;

  const suggestions: Suggestion[] = [];

  // Rent payment history
  if (profile.payment_history.total_rent_plans === 0) {
    suggestions.push({
      icon: <Home className="h-4 w-4" />,
      title: 'Start paying rent through Welile',
      description: 'Build your strongest trust signal — every paid month adds points.',
      cta: 'Request Rent Plan',
      action: () => navigate('/tenant/request-rent'),
      priority: 10,
    });
  } else if (profile.payment_history.on_time_rate < 90) {
    suggestions.push({
      icon: <Home className="h-4 w-4" />,
      title: 'Catch up on rent to boost your score',
      description: `Your on-time rate is ${profile.payment_history.on_time_rate}%. Pay on time to reach 90%+.`,
      cta: 'View Rent Plans',
      action: () => navigate('/dashboard/tenant'),
      priority: 8,
    });
  }

  // Landlord onboarding
  if (profile.landlord_activity.total_listings === 0) {
    suggestions.push({
      icon: <Home className="h-4 w-4" />,
      title: 'Onboard your landlord',
      description: 'Landlords listed with Welile get guaranteed rent — and you get +5 trust.',
      cta: 'Add Landlord',
      action: () => navigate('/tenant/onboard-landlord'),
      priority: 9,
    });
  }

  // GPS opt-in
  if (!profile.behavior.always_share_location) {
    suggestions.push({
      icon: <MapPin className="h-4 w-4" />,
      title: 'Enable Always-On Location',
      description: 'Share your live location to prove reliability — agents can find you when needed.',
      cta: 'Enable GPS',
      action: () => navigate('/profile/settings#location'),
      priority: 7,
    });
  }

  // Movement behavior
  if (profile.behavior.visits_total_60d < 5) {
    suggestions.push({
      icon: <Activity className="h-4 w-4" />,
      title: 'Track your routine places',
      description: 'Worship, malls, restaurants — regular visits prove you are findable.',
      cta: 'Learn How',
      action: () => navigate('/profile/settings#location'),
      priority: 5,
    });
  }

  // Wallet shopping
  if ((profile.behavior.wallet_shopping_count || 0) < 3) {
    suggestions.push({
      icon: <Wallet className="h-4 w-4" />,
      title: 'Shop with Welile Wallet',
      description: 'Pay merchants from your wallet — strong cash-flow signal for lenders.',
      cta: 'Open Wallet',
      action: () => navigate('/wallet'),
      priority: 6,
    });
  }

  // Network — onboard others
  if (profile.network.referrals + profile.network.tenants_onboarded < 3) {
    suggestions.push({
      icon: <Users className="h-4 w-4" />,
      title: 'Invite friends to Welile',
      description: 'The more people you bring in, the more trusted you become.',
      cta: 'Share Invite',
      action: () => navigate('/profile/referrals'),
      priority: 5,
    });
  }

  // Verification
  if (!profile.identity.national_id_present) {
    suggestions.push({
      icon: <IdCard className="h-4 w-4" />,
      title: 'Verify your National ID',
      description: 'Adds permanent trust points and unlocks higher borrowing limits.',
      cta: 'Verify Now',
      action: () => navigate('/profile/settings'),
      priority: 9,
    });
  }

  // Agent performance — nudge low-healthy-ratio agents
  if (
    profile.identity.primary_role === 'agent' &&
    profile.agent_performance &&
    profile.agent_performance.qualifying_tenants >= 3 &&
    profile.agent_performance.healthy_ratio < 0.5
  ) {
    suggestions.push({
      icon: <Trophy className="h-4 w-4" />,
      title: 'Visit late-paying tenants',
      description: `Only ${profile.agent_performance.healthy_tenants} of ${profile.agent_performance.qualifying_tenants} tenants are paying ≥50%. Capture trust signals to nudge collections and grow your vouch limit.`,
      cta: 'Open Agent Hub',
      action: () => navigate('/dashboard/tenant'),
      priority: 10,
    });
  }

  if (suggestions.length === 0) return null;

  // Show top 3 highest-priority
  const top = [...suggestions].sort((a, b) => b.priority - a.priority).slice(0, 4);

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
      <Card className="bg-gradient-to-br from-primary/10 to-emerald-500/5 border-primary/20">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-bold text-foreground">Boost Your Trust Score</h3>
          </div>
          <p className="text-xs text-muted-foreground -mt-1">
            Higher trust = bigger lending limits and more landlords willing to rent to you.
          </p>
          <div className="space-y-2">
            {top.map((s, i) => (
              <button
                key={i}
                onClick={s.action}
                className="w-full flex items-center gap-3 p-3 rounded-xl bg-background/60 hover:bg-background border border-border/50 transition text-left group"
              >
                <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary shrink-0">
                  {s.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">{s.title}</p>
                  <p className="text-[11px] text-muted-foreground line-clamp-2">{s.description}</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary shrink-0" />
              </button>
            ))}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

export default TrustBoostSuggestions;
