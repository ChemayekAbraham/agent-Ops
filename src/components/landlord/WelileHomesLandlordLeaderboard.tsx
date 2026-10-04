import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Trophy, Medal, Award, Crown, Users, Home, TrendingUp, Heart } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { UserAvatar } from '@/components/UserAvatar';
import { useAuth } from '@/hooks/useAuth';
import { motion } from 'framer-motion';

interface LeaderboardEntry {
  landlord_id: string;
  full_name: string;
  avatar_url: string | null;
  tenant_count: number;
  total_savings: number;
  total_contributed: number;
}

interface WelileHomesLandlordLeaderboardProps {
  limit?: number;
}

export function WelileHomesLandlordLeaderboard({ limit = 10 }: WelileHomesLandlordLeaderboardProps) {
  const { user } = useAuth();

  const { data: leaders = [], isLoading, error } = useQuery({
    queryKey: ['welile-homes-landlord-leaderboard', limit],
    queryFn: async () => {
      // Get all subscriptions with landlord info via rent_requests
      const { data: subscriptions, error: subError } = await supabase
        .from('welile_homes_subscriptions')
        .select('id, tenant_id, total_savings, monthly_rent, months_enrolled, subscription_status');

      if (subError) throw subError;
      if (!subscriptions || subscriptions.length === 0) return [];

      // Get tenant IDs
      const tenantIds = [...new Set(subscriptions.map(s => s.tenant_id))];

      // Get rent_requests to map tenants to landlords
      const { data: rentRequests, error: rrError } = await supabase
        .from('rent_requests')
        .select('tenant_id, landlord_id')
        .in('tenant_id', tenantIds)
        .not('landlord_id', 'is', null);

      if (rrError) throw rrError;

      // Create tenant-to-landlord mapping
      const tenantToLandlord: Record<string, string> = {};
      rentRequests?.forEach(rr => {
        if (rr.landlord_id) {
          tenantToLandlord[rr.tenant_id] = rr.landlord_id;
        }
      });

      // Aggregate by landlord
      const landlordStats: Record<string, {
        tenant_count: number;
        total_savings: number;
        total_contributed: number;
        tenant_ids: Set<string>;
      }> = {};

      subscriptions.forEach(sub => {
        const landlordId = tenantToLandlord[sub.tenant_id];
        if (!landlordId) return;

        if (!landlordStats[landlordId]) {
          landlordStats[landlordId] = {
            tenant_count: 0,
            total_savings: 0,
            total_contributed: 0,
            tenant_ids: new Set(),
          };
        }

        // Count unique tenants
        if (!landlordStats[landlordId].tenant_ids.has(sub.tenant_id)) {
          landlordStats[landlordId].tenant_ids.add(sub.tenant_id);
          landlordStats[landlordId].tenant_count++;
        }

        landlordStats[landlordId].total_savings += sub.total_savings || 0;
        landlordStats[landlordId].total_contributed += (sub.monthly_rent * 0.10 * sub.months_enrolled) || 0;
      });

      // Get landlord profiles
      const landlordIds = Object.keys(landlordStats);
      if (landlordIds.length === 0) return [];

      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_url')
        .in('id', landlordIds);

      // Build leaderboard entries
      const entries: LeaderboardEntry[] = landlordIds.map(landlordId => {
        const profile = profiles?.find(p => p.id === landlordId);
        const stats = landlordStats[landlordId];

        return {
          landlord_id: landlordId,
          full_name: profile?.full_name || 'Anonymous Landlord',
          avatar_url: profile?.avatar_url || null,
          tenant_count: stats.tenant_count,
          total_savings: stats.total_savings,
          total_contributed: stats.total_contributed,
        };
      });

      // Sort by total savings impact (descending)
      entries.sort((a, b) => b.total_savings - a.total_savings);

      return entries.slice(0, limit);
    },
  });

  // Find current user's rank
  const userRank = user ? leaders.findIndex(e => e.landlord_id === user.id) + 1 : null;
  const isUserOnLeaderboard = userRank && userRank > 0;

  const getRankIcon = (rank: number) => {
    switch (rank) {
      case 1:
        return <Crown className="h-5 w-5 text-yellow-500" />;
      case 2:
        return <Medal className="h-5 w-5 text-muted-foreground" />;
      case 3:
        return <Award className="h-5 w-5 text-amber-600" />;
      default:
        return <span className="font-bold text-muted-foreground w-5 text-center">{rank}</span>;
    }
  };

  const getRankBadgeColor = (rank: number) => {
    switch (rank) {
      case 1:
        return 'bg-gradient-to-r from-yellow-500/20 to-amber-500/20 border-yellow-500/30';
      case 2:
        return 'bg-gradient-to-r from-slate-300/20 to-slate-400/20 border-slate-400/30';
      case 3:
        return 'bg-gradient-to-r from-amber-600/20 to-orange-500/20 border-amber-600/30';
      default:
        return 'bg-secondary/30 border-border/50';
    }
  };

  if (isLoading) {
    return (
      <Card className="elevated-card">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-purple-500/10">
              <Trophy className="h-5 w-5 text-purple-600" />
            </div>
            <CardTitle className="text-lg">Welile Homes Champions</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse flex items-center gap-3 p-3 rounded-lg bg-secondary/20">
                <div className="w-8 h-8 rounded-full bg-muted" />
                <div className="flex-1">
                  <div className="h-4 w-24 bg-muted rounded" />
                  <div className="h-3 w-16 bg-muted rounded mt-1" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (leaders.length === 0) {
    return (
      <Card className="elevated-card">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-purple-500/10">
              <Trophy className="h-5 w-5 text-purple-600" />
            </div>
            <CardTitle className="text-lg">Welile Homes Champions</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6">
            <Home className="h-10 w-10 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No landlords on the leaderboard yet.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Landlords with tenants enrolled in Welile Homes will appear here.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Calculate total platform impact
  const totalPlatformSavings = leaders.reduce((sum, e) => sum + e.total_savings, 0);
  const totalTenantsHelped = leaders.reduce((sum, e) => sum + e.tenant_count, 0);

  return (
    <Card className="elevated-card overflow-hidden">
      <CardHeader className="pb-3 bg-gradient-to-r from-purple-500/5 to-amber-500/5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-purple-500/10">
              <Trophy className="h-5 w-5 text-purple-600" />
            </div>
            <CardTitle className="text-lg">Welile Homes Champions</CardTitle>
          </div>
          <Badge variant="outline" className="font-mono text-xs border-purple-300">
            Top {Math.min(limit, leaders.length)}
          </Badge>
        </div>
        {isUserOnLeaderboard && (
          <p className="text-xs text-muted-foreground mt-1">
            You're ranked #{userRank} on the leaderboard! 🎉
          </p>
        )}
      </CardHeader>
      
      <CardContent className="pt-4">
        {/* Platform Stats */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="p-3 rounded-lg bg-purple-50 border border-purple-200">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="h-4 w-4 text-purple-600" />
              <span className="text-xs font-medium text-purple-600">Total Savings</span>
            </div>
            <p className="text-lg font-bold text-purple-700">{formatUGX(totalPlatformSavings)}</p>
          </div>
          <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200">
            <div className="flex items-center gap-2 mb-1">
              <Heart className="h-4 w-4 text-emerald-600" />
              <span className="text-xs font-medium text-emerald-600">Tenants Helped</span>
            </div>
            <p className="text-lg font-bold text-emerald-700">{totalTenantsHelped}</p>
          </div>
        </div>

        {/* Leaderboard Entries */}
        <div className="space-y-2">
          {leaders.map((entry, index) => {
            const rank = index + 1;
            const isCurrentUser = user?.id === entry.landlord_id;
            
            return (
              <motion.div
                key={entry.landlord_id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.05 }}
                className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${getRankBadgeColor(rank)} ${
                  isCurrentUser ? 'ring-2 ring-purple-500/50' : ''
                }`}
              >
                <div className="flex items-center justify-center w-8">
                  {getRankIcon(rank)}
                </div>
                
                <UserAvatar 
                  avatarUrl={entry.avatar_url} 
                  fullName={entry.full_name} 
                  size="sm" 
                />
                
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium truncate text-sm">
                      {entry.full_name}
                    </p>
                    {isCurrentUser && (
                      <Badge variant="secondary" className="text-[10px] bg-purple-100 text-purple-700">You</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Users className="h-3 w-3" />
                    {entry.tenant_count} {entry.tenant_count === 1 ? 'tenant' : 'tenants'} helped
                  </p>
                </div>
                
                <div className="text-right">
                  <p className="text-sm font-bold text-emerald-600">
                    {formatUGX(entry.total_savings)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">savings impact</p>
                </div>
              </motion.div>
            );
          })}
        </div>

        {/* Encouragement for non-leaders */}
        {user && !isUserOnLeaderboard && (
          <div className="mt-4 p-3 rounded-lg bg-purple-50 border border-purple-200 text-center">
            <Home className="h-5 w-5 text-purple-600 mx-auto mb-1" />
            <p className="text-sm text-purple-700 font-medium">Not on the leaderboard yet?</p>
            <p className="text-xs text-muted-foreground mt-1">
              Invite your tenants to enroll in Welile Homes and start making an impact!
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
