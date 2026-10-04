import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Flame, Trophy, Zap, Star } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  agentId: string;
}

const BADGE_INFO: Record<string, { label: string; icon: string }> = {
  '7_day_streak': { label: '7-Day Streak', icon: '🔥' },
  '30_day_streak': { label: '30-Day Legend', icon: '🏆' },
};

export function CollectionStreakCard({ agentId }: Props) {
  const { data: streak } = useQuery({
    queryKey: ['agent-streak', agentId],
    queryFn: async () => {
      const { data } = await supabase
        .from('agent_collection_streaks')
        .select('*')
        .eq('agent_id', agentId)
        .maybeSingle();
      return data;
    },
    staleTime: 300000,
  });

  const currentStreak = streak?.current_streak || 0;
  const longestStreak = streak?.longest_streak || 0;
  const multiplier = Number(streak?.streak_multiplier || 1.0);
  const badges = (streak?.badges as string[] || []);

  // Determine streak status
  const streakStatus = currentStreak >= 7 ? 'fire' : currentStreak >= 3 ? 'warm' : 'cold';
  const statusConfig = {
    fire: { bg: 'bg-warning/10 border-warning/30', icon: Flame, color: 'text-warning' },
    warm: { bg: 'bg-chart-4/10 border-chart-4/30', icon: Zap, color: 'text-chart-4' },
    cold: { bg: 'bg-muted/30 border-border/40', icon: Star, color: 'text-muted-foreground' },
  };

  const config = statusConfig[streakStatus];
  const Icon = config.icon;

  // Next milestone
  const nextMilestone = currentStreak < 7 ? 7 : currentStreak < 30 ? 30 : 90;
  const progress = (currentStreak / nextMilestone) * 100;

  return (
    <div className={cn("rounded-xl border p-3 space-y-2", config.bg)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className={cn("h-5 w-5", config.color)} />
          <div>
            <p className="font-bold text-sm">
              {currentStreak > 0 ? `${currentStreak}-Day Streak` : 'Start Collecting!'}
            </p>
            <p className="text-[10px] text-muted-foreground">Best: {longestStreak} days</p>
          </div>
        </div>
        {multiplier > 1 && (
          <div className="px-2 py-0.5 rounded-full bg-warning/15 border border-warning/25">
            <span className="text-[10px] font-bold text-warning">{multiplier.toFixed(2)}x commission</span>
          </div>
        )}
      </div>

      {/* Progress to next milestone */}
      <div className="space-y-1">
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>Next: {nextMilestone}-day milestone</span>
          <span>{nextMilestone - currentStreak} days to go</span>
        </div>
        <div className="h-1.5 rounded-full bg-background/80 overflow-hidden">
          <div
            className={cn("h-full rounded-full", streakStatus === 'fire' ? 'bg-warning' : streakStatus === 'warm' ? 'bg-chart-4' : 'bg-muted-foreground/30')}
            style={{ width: `${Math.min(100, progress)}%` }}
          />
        </div>
      </div>

      {/* Badges */}
      {badges.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {badges.map(b => {
            const info = BADGE_INFO[b];
            return info ? (
              <span key={b} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-background/60 text-[10px] font-medium">
                {info.icon} {info.label}
              </span>
            ) : null;
          })}
        </div>
      )}

      {currentStreak === 0 && (
        <p className="text-[10px] text-muted-foreground text-center">
          Collect from any tenant today to start your streak! 🚀
        </p>
      )}
    </div>
  );
}
