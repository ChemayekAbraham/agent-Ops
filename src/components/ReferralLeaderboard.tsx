import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Trophy, Medal, Award, Crown, Users, Gift } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { Separator } from '@/components/ui/separator';
import { UserAvatar } from '@/components/UserAvatar';
import { useAuth } from '@/hooks/useAuth';
import { motion } from 'framer-motion';

interface LeaderboardEntry {
  user_id: string;
  full_name: string;
  avatar_url: string | null;
  referral_count: number;
  total_earned: number;
}

interface ReferralLeaderboardProps {
  limit?: number;
}

export function ReferralLeaderboard({ limit = 10 }: ReferralLeaderboardProps) {
  const { user } = useAuth();
  const [leaders, setLeaders] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [userRank, setUserRank] = useState<number | null>(null);

  useEffect(() => {
    fetchLeaderboard();
  }, [user]);

  const fetchLeaderboard = async () => {
    setLoading(true);
    
    const { data, error } = await supabase
      .from('referral_leaderboard')
      .select('*')
      .limit(limit);

    if (!error && data) {
      setLeaders(data as LeaderboardEntry[]);
      
      // Find current user's rank
      if (user) {
        const userIndex = data.findIndex((entry: LeaderboardEntry) => entry.user_id === user.id);
        if (userIndex !== -1) {
          setUserRank(userIndex + 1);
        }
      }
    }
    setLoading(false);
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

  if (loading) {
    return (
      <Card className="elevated-card">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-primary/10">
              <Trophy className="h-5 w-5 text-primary" />
            </div>
            <CardTitle className="text-lg">Top Referrers</CardTitle>
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
            <div className="p-2 rounded-lg bg-primary/10">
              <Trophy className="h-5 w-5 text-primary" />
            </div>
            <CardTitle className="text-lg">Top Referrers</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6">
            <Users className="h-10 w-10 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No referrals yet. Be the first!</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="elevated-card overflow-hidden">
      <CardHeader className="pb-3 bg-gradient-to-r from-primary/5 to-success/5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-primary/10">
              <Trophy className="h-5 w-5 text-primary" />
            </div>
            <CardTitle className="text-lg">Top Referrers</CardTitle>
          </div>
          <Badge variant="outline" className="font-mono text-xs">
            Top {Math.min(limit, leaders.length)}
          </Badge>
        </div>
        {userRank && (
          <p className="text-xs text-muted-foreground mt-1">
            You're ranked #{userRank} on the leaderboard!
          </p>
        )}
      </CardHeader>
      <CardContent className="pt-4">
        <div className="space-y-2">
          {leaders.map((entry, index) => {
            const rank = index + 1;
            const isCurrentUser = user?.id === entry.user_id;
            
            return (
              <motion.div
                key={entry.user_id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.05 }}
                className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${getRankBadgeColor(rank)} ${
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
                  <p className="text-xs text-muted-foreground">
                    {entry.referral_count} {entry.referral_count === 1 ? 'referral' : 'referrals'}
                  </p>
                </div>
                
                <div className="text-right">
                  <p className="text-sm font-bold text-success">
                    {formatUGX(Number(entry.total_earned))}
                  </p>
                  <p className="text-[10px] text-muted-foreground">earned</p>
                </div>
              </motion.div>
            );
          })}
        </div>
        
        {/* Monthly Rewards Info */}
        <Separator className="my-4" />
        <div className="p-3 rounded-xl bg-gradient-to-r from-yellow-500/10 to-amber-500/10 border border-yellow-500/20">
          <div className="flex items-center gap-2 mb-2">
            <Gift className="h-4 w-4 text-yellow-500" />
            <span className="font-semibold text-sm">Monthly Rewards</span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="p-2 rounded-lg bg-yellow-500/10">
              <Crown className="h-4 w-4 text-yellow-500 mx-auto mb-1" />
              <p className="text-xs font-bold">1st Place</p>
              <p className="text-xs text-success font-semibold">{formatUGX(5000)}</p>
            </div>
            <div className="p-2 rounded-lg bg-slate-400/10">
              <Medal className="h-4 w-4 text-muted-foreground mx-auto mb-1" />
              <p className="text-xs font-bold">2nd Place</p>
              <p className="text-xs text-success font-semibold">{formatUGX(3000)}</p>
            </div>
            <div className="p-2 rounded-lg bg-amber-600/10">
              <Award className="h-4 w-4 text-amber-600 mx-auto mb-1" />
              <p className="text-xs font-bold">3rd Place</p>
              <p className="text-xs text-success font-semibold">{formatUGX(1000)}</p>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground text-center mt-2">
            Top referrers are rewarded at the start of each month!
          </p>
        </div>

        {/* CTA for non-leaders */}
        {!userRank && user && (
          <div className="mt-4 p-3 rounded-lg bg-primary/5 border border-primary/20 text-center">
            <p className="text-sm text-muted-foreground">
              Share your link to start climbing the leaderboard!
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
