import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Flame, Trophy, Target, IdCard, MapPin, Briefcase,
  CheckCircle2, Home, Users, Sparkles, Crown, Medal, ArrowRight,
  HandCoins, FileSignature, Building2, Shield,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const ICON_MAP: Record<string, any> = {
  IdCard, MapPin, Briefcase, CheckCircle2, Home, Users,
};

const COLOR_MAP: Record<string, { bg: string; text: string; ring: string }> = {
  violet:  { bg: 'bg-violet-500/10',  text: 'text-violet-600',  ring: 'ring-violet-500/30' },
  blue:    { bg: 'bg-blue-500/10',    text: 'text-blue-600',    ring: 'ring-blue-500/30' },
  rose:    { bg: 'bg-rose-500/10',    text: 'text-rose-600',    ring: 'ring-rose-500/30' },
  emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-600', ring: 'ring-emerald-500/30' },
  amber:   { bg: 'bg-amber-500/10',   text: 'text-amber-600',   ring: 'ring-amber-500/30' },
  slate:   { bg: 'bg-slate-500/10',   text: 'text-muted-foreground',   ring: 'ring-slate-500/30' },
};

const TIER_META: Record<string, { label: string; icon: any; color: string }> = {
  starter: { label: 'Starter', icon: Sparkles, color: 'text-muted-foreground' },
  bronze:  { label: 'Bronze',  icon: Medal,    color: 'text-amber-700' },
  silver:  { label: 'Silver',  icon: Medal,    color: 'text-muted-foreground' },
  gold:    { label: 'Gold',    icon: Trophy,   color: 'text-yellow-500' },
  diamond: { label: 'Diamond', icon: Crown,    color: 'text-cyan-500' },
};

interface Mission {
  key: string;
  title: string;
  tagline: string;
  signal_type: string;
  target: number;
  gap_total: number;
  points_per_signal: number;
  commission_per_signal: number;
  icon: string;
  color: string;
  priority: 'high' | 'medium' | 'low';
}

interface MissionData {
  agent_id: string;
  managed_user_count: number;
  missions: Mission[];
  completions_today: Record<string, number>;
}

interface StatsData {
  signals_today: number;
  daily_quota: number;
  signals_this_week: number;
  current_streak_days: number;
  weekly_rank: number;
  tier: string;
}

interface LeaderboardEntry {
  agent_id: string;
  full_name: string;
  avatar_url: string | null;
  territory: string | null;
  signals: number;
  commission_earned: number;
  rank: number;
}

interface Props {
  onCaptureClick?: () => void;
}

export function AgentDailyMissions({ onCaptureClick }: Props) {
  const { user } = useAuth();

  const { data: missionData, isLoading: missionsLoading } = useQuery({
    queryKey: ['agent-daily-missions', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_daily_missions', { p_agent_id: user!.id });
      if (error) throw error;
      return data as unknown as MissionData;
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: stats } = useQuery({
    queryKey: ['agent-mission-stats', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_mission_stats', { p_agent_id: user!.id });
      if (error) throw error;
      return data as unknown as StatsData;
    },
    staleTime: 60_000,
  });

  const { data: leaderboard } = useQuery({
    queryKey: ['agent-mission-leaderboard'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_mission_leaderboard', { p_limit: 10 });
      if (error) throw error;
      return (data as any)?.leaderboard as LeaderboardEntry[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: networkSummary } = useQuery({
    queryKey: ['agent-network-summary', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_network_summary', { p_agent_id: user!.id });
      if (error) throw error;
      return data as unknown as {
        counts: { referrals: number; sub_agents: number; tenants: number; partners: number; landlords: number; promissory_notes: number; total: number };
        points: { referrals: number; sub_agents: number; tenants: number; partners: number; landlords: number; promissory_notes: number; total: number; max: number };
      };
    },
    staleTime: 2 * 60 * 1000,
  });

  const tier = TIER_META[stats?.tier || 'starter'];
  const TierIcon = tier.icon;
  const quota = stats?.daily_quota || 10;
  const today = stats?.signals_today || 0;
  const quotaPct = Math.min(100, (today / quota) * 100);

  // Bonus hour: 4–6pm
  const hour = new Date().getHours();
  const isBonusHour = hour >= 16 && hour < 18;

  return (
    <div className="space-y-6">
      {/* Hero stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Streak */}
        <Card className="overflow-hidden">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Flame className="h-3.5 w-3.5 text-orange-500" />
              Capture streak
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-bold">{stats?.current_streak_days ?? 0}</span>
              <span className="text-sm text-muted-foreground">days</span>
            </div>
            {(stats?.current_streak_days ?? 0) >= 3 && (
              <p className="text-xs text-orange-600 mt-1">🔥 Don't break it!</p>
            )}
          </CardContent>
        </Card>

        {/* Daily quota ring */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Target className="h-3.5 w-3.5 text-primary" />
              Today's quota
            </div>
            <div className="flex items-baseline gap-1 mb-2">
              <span className="text-3xl font-bold">{today}</span>
              <span className="text-sm text-muted-foreground">/ {quota}</span>
            </div>
            <Progress value={quotaPct} size="sm" variant={quotaPct >= 100 ? 'success' : 'default'} />
          </CardContent>
        </Card>

        {/* Tier */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <TierIcon className={cn('h-3.5 w-3.5', tier.color)} />
              Weekly tier
            </div>
            <div className="text-2xl font-bold capitalize">{tier.label}</div>
            <p className="text-xs text-muted-foreground mt-1">{stats?.signals_this_week ?? 0} signals this week</p>
          </CardContent>
        </Card>

        {/* Rank */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Trophy className="h-3.5 w-3.5 text-amber-500" />
              Weekly rank
            </div>
            <div className="text-2xl font-bold">
              {stats?.weekly_rank ? `#${stats.weekly_rank}` : '—'}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Among all agents</p>
          </CardContent>
        </Card>
      </div>

      {/* Bonus hour banner */}
      {isBonusHour && (
        <div className="rounded-xl border border-amber-500/30 bg-gradient-to-r from-amber-500/10 to-orange-500/10 p-4 flex items-center gap-3">
          <Sparkles className="h-5 w-5 text-amber-600 animate-pulse" />
          <div>
            <p className="font-semibold text-sm">2× Bonus Hours active!</p>
            <p className="text-xs text-muted-foreground">All signals captured 4–6pm earn double points & commission.</p>
          </div>
        </div>
      )}

      {/* Network trust panel — every relationship contributes to your trust score */}
      <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Shield className="h-5 w-5 text-primary" />
              Your network builds your trust
            </CardTitle>
            <Badge variant="secondary" className="text-xs">
              +{networkSummary?.points.total?.toFixed(1) ?? '0.0'} / {networkSummary?.points.max ?? 10} pts
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Every tenant, partner, sub-agent, landlord, and promissory note you manage lifts your own Welile Trust Score.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
            {[
              { key: 'tenants', label: 'Tenants', icon: Users, color: 'text-blue-600' },
              { key: 'partners', label: 'Partners', icon: HandCoins, color: 'text-emerald-600' },
              { key: 'sub_agents', label: 'Sub-Agents', icon: Briefcase, color: 'text-violet-600' },
              { key: 'landlords', label: 'Landlords', icon: Building2, color: 'text-amber-600' },
              { key: 'promissory_notes', label: 'Promissory', icon: FileSignature, color: 'text-rose-600' },
              { key: 'referrals', label: 'Referrals', icon: Users, color: 'text-cyan-600' },
            ].map(({ key, label, icon: Icon, color }) => {
              const count = networkSummary?.counts?.[key as keyof typeof networkSummary.counts] ?? 0;
              const pts = networkSummary?.points?.[key as keyof typeof networkSummary.points] ?? 0;
              return (
                <div key={key} className="rounded-lg border bg-background/60 p-2.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1">
                    <Icon className={cn('h-3 w-3', color)} />
                    <span className="truncate">{label}</span>
                  </div>
                  <div className="text-xl font-bold leading-none">{count}</div>
                  <p className="text-[10px] text-emerald-600 mt-1 font-medium">
                    +{Number(pts).toFixed(1)} pts
                  </p>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Target className="h-5 w-5 text-primary" />
              Today's Missions
            </CardTitle>
            <Badge variant="secondary" className="text-xs">
              {missionData?.managed_user_count ?? 0} managed users
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {missionsLoading ? (
            <div className="space-y-3">
              {[1,2,3].map(i => <div key={i} className="h-20 rounded-xl bg-muted/50 animate-pulse" />)}
            </div>
          ) : (
            <div className="grid gap-3">
              {missionData?.missions?.map((m) => {
                const Icon = ICON_MAP[m.icon] || Target;
                const colors = COLOR_MAP[m.color] || COLOR_MAP.slate;
                const completed = missionData.completions_today?.[m.key] || 0;
                const target = Math.max(m.target, 1);
                const pct = Math.min(100, (completed / target) * 100);
                const isDone = completed >= m.target && m.target > 0;
                const noGap = m.gap_total === 0;

                return (
                  <div
                    key={m.key}
                    className={cn(
                      'rounded-xl border p-4 transition-all',
                      isDone && 'bg-success/5 border-success/30',
                      !isDone && m.priority === 'high' && 'ring-1',
                      !isDone && m.priority === 'high' && colors.ring,
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div className={cn('h-10 w-10 rounded-lg flex items-center justify-center shrink-0', colors.bg)}>
                        <Icon className={cn('h-5 w-5', colors.text)} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="font-semibold text-sm">{m.title}</h4>
                          {m.priority === 'high' && !isDone && (
                            <Badge variant="destructive" className="text-[10px] h-4">HOT</Badge>
                          )}
                          {isDone && <Badge className="text-[10px] h-4 bg-success">✓ Complete</Badge>}
                          {noGap && <Badge variant="outline" className="text-[10px] h-4">All caught up</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{m.tagline}</p>
                        <div className="flex items-center gap-3 mt-2 text-xs">
                          <span className="font-medium">+{m.points_per_signal} pts</span>
                          <span className="text-muted-foreground">·</span>
                          <span className="text-emerald-600 font-medium">
                            +UGX {m.commission_per_signal.toLocaleString()}
                          </span>
                          {m.gap_total > 0 && (
                            <>
                              <span className="text-muted-foreground">·</span>
                              <span className="text-muted-foreground">{m.gap_total} users need this</span>
                            </>
                          )}
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <Progress value={pct} size="sm" variant={isDone ? 'success' : 'default'} className="flex-1" />
                          <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                            {completed} / {m.target}
                          </span>
                        </div>
                      </div>
                      {!isDone && m.target > 0 && (
                        <Button size="sm" variant="outline" onClick={onCaptureClick} className="shrink-0">
                          Start
                          <ArrowRight className="h-3 w-3 ml-1" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Leaderboard */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trophy className="h-5 w-5 text-amber-500" />
            Weekly Leaderboard
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!leaderboard || leaderboard.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              Be the first agent on the board this week!
            </p>
          ) : (
            <div className="space-y-2">
              {leaderboard.map((row) => {
                const isMe = row.agent_id === user?.id;
                return (
                  <div
                    key={row.agent_id}
                    className={cn(
                      'flex items-center gap-3 p-2.5 rounded-lg',
                      isMe && 'bg-primary/10 ring-1 ring-primary/30',
                      !isMe && 'hover:bg-muted/50',
                    )}
                  >
                    <div className={cn(
                      'h-8 w-8 rounded-full flex items-center justify-center font-bold text-sm shrink-0',
                      row.rank === 1 && 'bg-yellow-500/20 text-yellow-700',
                      row.rank === 2 && 'bg-slate-400/20 text-muted-foreground',
                      row.rank === 3 && 'bg-amber-700/20 text-amber-800',
                      row.rank > 3 && 'bg-muted text-muted-foreground',
                    )}>
                      {row.rank <= 3 ? ['🥇','🥈','🥉'][row.rank-1] : row.rank}
                    </div>
                    {row.avatar_url ? (
                      <img src={row.avatar_url} alt="" className="h-8 w-8 rounded-full object-cover" />
                    ) : (
                      <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold">
                        {row.full_name?.charAt(0) || 'A'}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">
                          {row.full_name}
                          {isMe && <span className="text-xs text-primary ml-1">(You)</span>}
                        </p>
                      </div>
                      {row.territory && (
                        <p className="text-xs text-muted-foreground truncate">{row.territory}</p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold">{row.signals}</p>
                      <p className="text-[10px] text-muted-foreground">signals</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
