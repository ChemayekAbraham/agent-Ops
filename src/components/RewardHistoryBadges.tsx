import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Trophy, Medal, Award, Sparkles } from 'lucide-react';
import { motion } from 'framer-motion';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';

interface ReferralReward {
  id: string;
  reward_month: string;
  rank: number;
  reward_amount: number;
  referral_count: number;
  credited: boolean;
  credited_at: string | null;
}

export function RewardHistoryBadges() {
  const { user } = useAuth();
  const [rewards, setRewards] = useState<ReferralReward[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;

    const fetchRewards = async () => {
      const { data, error } = await supabase
        .from('referral_rewards')
        .select('*')
        .eq('user_id', user.id)
        .order('reward_month', { ascending: false });

      if (!error && data) {
        setRewards(data);
      }
      setLoading(false);
    };

    fetchRewards();
  }, [user]);

  const getRankIcon = (rank: number) => {
    switch (rank) {
      case 1:
        return <Trophy className="h-5 w-5 text-yellow-500" />;
      case 2:
        return <Medal className="h-5 w-5 text-muted-foreground" />;
      case 3:
        return <Award className="h-5 w-5 text-amber-600" />;
      default:
        return <Sparkles className="h-4 w-4 text-primary" />;
    }
  };

  const getRankColor = (rank: number) => {
    switch (rank) {
      case 1:
        return 'from-yellow-500/20 via-yellow-400/10 to-yellow-500/5 border-yellow-500/30';
      case 2:
        return 'from-gray-400/20 via-gray-300/10 to-gray-400/5 border-gray-400/30';
      case 3:
        return 'from-amber-600/20 via-amber-500/10 to-amber-600/5 border-amber-600/30';
      default:
        return 'from-primary/20 via-primary/10 to-primary/5 border-primary/30';
    }
  };

  const getRankLabel = (rank: number) => {
    switch (rank) {
      case 1:
        return '1st Place 🥇';
      case 2:
        return '2nd Place 🥈';
      case 3:
        return '3rd Place 🥉';
      default:
        return `#${rank}`;
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Trophy className="h-5 w-5 text-yellow-500" />
            Monthly Achievements
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-24 w-28 bg-muted rounded-xl animate-pulse flex-shrink-0" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (rewards.length === 0) {
    return (
      <Card className="border-dashed border-2">
        <CardContent className="py-6 text-center">
          <Trophy className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No monthly achievements yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Refer friends to climb the leaderboard and earn rewards!
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Trophy className="h-5 w-5 text-yellow-500" />
            Monthly Achievements
          </CardTitle>
          <Badge variant="secondary" className="text-xs">
            {rewards.length} {rewards.length === 1 ? 'badge' : 'badges'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
          {rewards.map((reward, index) => (
            <motion.div
              key={reward.id}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: index * 0.1 }}
              className={`flex-shrink-0 p-4 rounded-xl bg-gradient-to-br border ${getRankColor(reward.rank)} min-w-[140px] text-center`}
            >
              <div className="flex justify-center mb-2">
                {getRankIcon(reward.rank)}
              </div>
              <p className="font-bold text-sm">{getRankLabel(reward.rank)}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {format(new Date(reward.reward_month), 'MMM yyyy')}
              </p>
              <div className="mt-2 pt-2 border-t border-border/50">
                <p className="text-sm font-bold text-success">
                  {formatUGX(reward.reward_amount)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {reward.referral_count} referrals
                </p>
              </div>
            </motion.div>
          ))}
        </div>
        
        {/* Total Rewards Summary */}
        <div className="mt-4 p-3 rounded-lg bg-gradient-to-r from-success/10 to-transparent border border-success/20">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-success" />
              <span className="text-sm font-medium">Total Monthly Rewards</span>
            </div>
            <span className="font-bold text-success">
              {formatUGX(rewards.reduce((sum, r) => sum + Number(r.reward_amount), 0))}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
