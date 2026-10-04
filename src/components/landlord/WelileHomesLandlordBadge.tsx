import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { motion } from 'framer-motion';
import { formatUGX } from '@/lib/rentCalculations';
import { Home, Trophy, Star, Crown, Gem } from 'lucide-react';

// Tier thresholds based on total tenant savings generated
const TIERS = {
  starter: { min: 0, label: 'Starter', icon: Home, color: 'text-muted-foreground', bg: 'bg-muted', border: 'border-border' },
  bronze: { min: 100000, label: 'Bronze', icon: Trophy, color: 'text-amber-700', bg: 'bg-amber-100', border: 'border-amber-400' },
  silver: { min: 500000, label: 'Silver', icon: Star, color: 'text-muted-foreground', bg: 'bg-muted', border: 'border-slate-400' },
  gold: { min: 2000000, label: 'Gold', icon: Crown, color: 'text-yellow-500', bg: 'bg-yellow-50', border: 'border-yellow-400' },
  platinum: { min: 10000000, label: 'Platinum', icon: Gem, color: 'text-purple-600', bg: 'bg-purple-100', border: 'border-purple-400' },
} as const;

type TierKey = keyof typeof TIERS;

function getTier(totalSavings: number): TierKey {
  if (totalSavings >= TIERS.platinum.min) return 'platinum';
  if (totalSavings >= TIERS.gold.min) return 'gold';
  if (totalSavings >= TIERS.silver.min) return 'silver';
  if (totalSavings >= TIERS.bronze.min) return 'bronze';
  return 'starter';
}

function getNextTier(currentTier: TierKey): TierKey | null {
  const order: TierKey[] = ['starter', 'bronze', 'silver', 'gold', 'platinum'];
  const currentIndex = order.indexOf(currentTier);
  if (currentIndex < order.length - 1) {
    return order[currentIndex + 1];
  }
  return null;
}

interface WelileHomesLandlordBadgeProps {
  userId: string;
  variant?: 'compact' | 'full' | 'icon-only';
  showProgress?: boolean;
}

export function WelileHomesLandlordBadge({ 
  userId, 
  variant = 'compact',
  showProgress = false 
}: WelileHomesLandlordBadgeProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['landlord-welile-homes-badge', userId],
    queryFn: async () => {
      // Get all tenants from rent_requests for this landlord
      const { data: rentRequests } = await supabase
        .from('rent_requests')
        .select('tenant_id')
        .eq('landlord_id', userId);

      if (!rentRequests || rentRequests.length === 0) {
        return { totalSavings: 0, tenantCount: 0 };
      }

      const tenantIds = [...new Set(rentRequests.map((rr) => rr.tenant_id))];

      // Get Welile Homes subscriptions for these tenants
      const { data: subscriptions } = await supabase
        .from('welile_homes_subscriptions')
        .select('total_savings, subscription_status')
        .in('tenant_id', tenantIds);

      if (!subscriptions || subscriptions.length === 0) {
        return { totalSavings: 0, tenantCount: 0 };
      }

      const totalSavings = subscriptions.reduce((sum, s) => sum + (s.total_savings || 0), 0);
      const activeCount = subscriptions.filter(s => s.subscription_status === 'active').length;

      return { totalSavings, tenantCount: activeCount };
    },
    enabled: !!userId,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  if (isLoading || !data) {
    return null;
  }

  const { totalSavings, tenantCount } = data;
  const tierKey = getTier(totalSavings);
  const tier = TIERS[tierKey];
  const nextTierKey = getNextTier(tierKey);
  const nextTier = nextTierKey ? TIERS[nextTierKey] : null;
  
  const Icon = tier.icon;
  const progressToNext = nextTier 
    ? Math.min(((totalSavings - tier.min) / (nextTier.min - tier.min)) * 100, 100)
    : 100;

  if (variant === 'icon-only') {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className={`p-1.5 rounded-full ${tier.bg} ${tier.border} border`}
            >
              <Icon className={`h-4 w-4 ${tier.color}`} />
            </motion.div>
          </TooltipTrigger>
          <TooltipContent>
            <p className="font-semibold">{tier.label} Landlord</p>
            <p className="text-xs text-muted-foreground">
              {formatUGX(totalSavings)} tenant savings impact
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (variant === 'compact') {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge 
              variant="outline" 
              className={`gap-1 ${tier.bg} ${tier.border} ${tier.color} font-medium`}
            >
              <Icon className="h-3 w-3" />
              {tier.label}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            <div className="space-y-1">
              <p className="font-semibold">Welile Homes {tier.label}</p>
              <p className="text-xs">
                {tenantCount} tenant{tenantCount !== 1 ? 's' : ''} helped
              </p>
              <p className="text-xs text-muted-foreground">
                {formatUGX(totalSavings)} total savings generated
              </p>
              {nextTier && (
                <p className="text-xs text-muted-foreground">
                  {formatUGX(nextTier.min - totalSavings)} to {nextTier.label}
                </p>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // Full variant with progress
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`p-4 rounded-xl ${tier.bg} border ${tier.border}`}
    >
      <div className="flex items-center gap-3 mb-3">
        <div className={`p-2.5 rounded-full bg-white/80 shadow-sm`}>
          <Icon className={`h-6 w-6 ${tier.color}`} />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h3 className={`font-bold text-lg ${tier.color}`}>{tier.label}</h3>
            <Badge variant="outline" className="text-[10px] bg-white/50">
              Welile Homes
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {tenantCount} tenant{tenantCount !== 1 ? 's' : ''} building towards homeownership
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Total Savings Impact</span>
          <span className="font-semibold">{formatUGX(totalSavings)}</span>
        </div>
        
        {showProgress && nextTier && (
          <>
            <div className="h-2 bg-white/60 rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${progressToNext}%` }}
                transition={{ duration: 0.8, ease: 'easeOut' }}
                className={`h-full rounded-full bg-gradient-to-r from-current to-current/70 ${tier.color.replace('text-', 'bg-')}`}
                style={{ 
                  background: tierKey === 'gold' 
                    ? 'linear-gradient(90deg, #EAB308, #FCD34D)' 
                    : tierKey === 'platinum'
                    ? 'linear-gradient(90deg, #9333EA, #C084FC)'
                    : undefined
                }}
              />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{tier.label}</span>
              <span>{formatUGX(nextTier.min - totalSavings)} to {nextTier.label}</span>
            </div>
          </>
        )}

        {!nextTier && tierKey === 'platinum' && (
          <p className="text-xs text-center text-purple-700 font-medium mt-2">
            🎉 You've reached the highest tier! Thank you for your impact.
          </p>
        )}
      </div>
    </motion.div>
  );
}

// Export tier info for use elsewhere
export { TIERS, getTier, type TierKey };
