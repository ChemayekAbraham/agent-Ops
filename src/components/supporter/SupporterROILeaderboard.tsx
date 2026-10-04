import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Trophy, Medal, Award, Crown, Users, TrendingUp, Wallet, Target } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { UserAvatar } from '@/components/UserAvatar';
import { useAuth } from '@/hooks/useAuth';
import { motion } from 'framer-motion';
import { Skeleton } from '@/components/ui/skeleton';

interface ROILeaderEntry {
  supporter_id: string;
  full_name: string;
  avatar_url: string | null;
  total_roi_earned: number;
  total_invested: number;
  payment_count: number;
  active_fundings: number;
}

interface SupporterROILeaderboardProps {
  limit?: number;
  compact?: boolean;
}

export function SupporterROILeaderboard({ limit = 10, compact = false }: SupporterROILeaderboardProps) {
  const { user } = useAuth();
  const [leaders, setLeaders] = useState<ROILeaderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [userRank, setUserRank] = useState<number | null>(null);
  const [userStats, setUserStats] = useState<ROILeaderEntry | null>(null);

  useEffect(() => {
    fetchLeaderboard();
  }, [user]);

  const fetchLeaderboard = async () => {
    setLoading(true);
    
    try {
      // supporter_roi_payments and landlord_payment_proofs tables removed - stub
      setLeaders([]);
    } catch (error) {
      console.error('Error fetching ROI leaderboard:', error);
    } finally {
      setLoading(false);
    }
  };

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

  const getRankStyle = (rank: number) => {
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

  if (loading) {
    return (
      <Card className="elevated-card">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-success/10">
              <TrendingUp className="h-5 w-5 text-success" />
            </div>
            <CardTitle className="text-lg">Top Reward Earners</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3 p-3 rounded-lg">
                <Skeleton className="w-8 h-8 rounded-full" />
                <div className="flex-1">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3 w-16 mt-1" />
                </div>
                <Skeleton className="h-6 w-20" />
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
            <div className="p-2 rounded-lg bg-success/10">
              <TrendingUp className="h-5 w-5 text-success" />
            </div>
            <CardTitle className="text-lg">Top Reward Earners</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6">
            <Users className="h-10 w-10 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No rewards earned yet. Be the first supporter!</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="elevated-card overflow-hidden">
      <CardHeader className="pb-3 bg-gradient-to-r from-success/5 to-primary/5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-success/10">
              <TrendingUp className="h-5 w-5 text-success" />
            </div>
            <div>
              <CardTitle className="text-lg">Top Reward Earners</CardTitle>
              <p className="text-xs text-muted-foreground">Ranked by total rewards earned</p>
            </div>
          </div>
          <Badge variant="outline" className="font-mono text-xs bg-success/10 text-success border-success/30">
            15% Monthly
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        {/* User's rank if not in top list */}
        {userRank && userRank > limit && userStats && (
          <div className="mb-4 p-3 rounded-xl border-2 border-primary/30 bg-primary/5">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-8">
                <span className="font-bold text-primary">#{userRank}</span>
              </div>
              <UserAvatar 
                avatarUrl={userStats.avatar_url} 
                fullName={userStats.full_name} 
                size="sm" 
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium truncate text-sm">{userStats.full_name}</p>
                  <Badge variant="secondary" className="text-[10px]">You</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {userStats.active_fundings} active • {userStats.payment_count} payments
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold text-success">{formatUGX(userStats.total_roi_earned)}</p>
              </div>
            </div>
          </div>
        )}

        {/* Leaderboard entries */}
        <div className="space-y-2">
          {leaders.map((entry, index) => {
            const rank = index + 1;
            const isCurrentUser = user?.id === entry.supporter_id;
            
            return (
              <motion.div
                key={entry.supporter_id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.05 }}
                className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${getRankStyle(rank)} ${
                  isCurrentUser ? 'ring-2 ring-primary/50' : ''
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
                      {entry.full_name || 'Anonymous'}
                    </p>
                    {isCurrentUser && (
                      <Badge variant="secondary" className="text-[10px]">You</Badge>
                    )}
                  </div>
                  {!compact && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Wallet className="h-3 w-3" />
                      <span>{formatUGX(entry.total_invested)}</span>
                      <span>•</span>
                      <span>{entry.payment_count} payments</span>
                    </div>
                  )}
                </div>
                
                <div className="text-right">
                  <p className="text-sm font-bold text-success">
                    +{formatUGX(entry.total_roi_earned)}
                  </p>
                  {!compact && (
                    <p className="text-[10px] text-muted-foreground">Rewards earned</p>
                  )}
                </div>
              </motion.div>
            );
          })}
        </div>

        {/* Stats footer */}
        {!compact && (
          <div className="mt-4 p-3 rounded-xl bg-gradient-to-r from-success/10 to-primary/10 border border-success/20">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <Target className="h-4 w-4 mx-auto mb-1 text-success" />
                <p className="text-lg font-bold">
                  {formatUGX(leaders.reduce((sum, l) => sum + l.total_roi_earned, 0))}
                </p>
                <p className="text-[10px] text-muted-foreground">Total Rewards Paid</p>
              </div>
              <div>
                <Wallet className="h-4 w-4 mx-auto mb-1 text-primary" />
                <p className="text-lg font-bold">
                  {formatUGX(leaders.reduce((sum, l) => sum + l.total_invested, 0))}
                </p>
                <p className="text-[10px] text-muted-foreground">Total Contributed</p>
              </div>
              <div>
                <Users className="h-4 w-4 mx-auto mb-1 text-muted-foreground" />
                <p className="text-lg font-bold">{leaders.length}</p>
                <p className="text-[10px] text-muted-foreground">Active Supporters</p>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
