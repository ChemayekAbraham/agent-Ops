import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { UserAvatar } from '@/components/UserAvatar';
import { hapticTap } from '@/lib/haptics';
import {
  ArrowLeft, UserPlus, Users, Crown, Medal, Award, Trophy,
  Info, Sparkles, Loader2,
} from 'lucide-react';
import bannerImg from '@/assets/leaderboard-banner.jpg';
import { LeaderboardHowItWorksDialog } from '@/components/agent/LeaderboardHowItWorksDialog';

type Period = 'weekly' | 'monthly';
const PER_PAGE = 20;

interface Row {
  agent_id: string;
  rank: number;
  agent_name: string;
  avatar_url: string | null;
  active_count: number;
  total_subagents: number;
  active_rate: number;
  total_matched: number;
}

interface MyRank {
  agent_id: string;
  rank: number;
  agent_name: string;
  avatar_url: string | null;
  active_count: number;
  total_subagents: number;
  active_rate: number;
  total_ranked: number;
}

const RANK_META = [
  { color: '#FACC15', label: 'Gold', icon: Crown },
  { color: '#C0C0C0', label: 'Silver', icon: Medal },
  { color: '#CD7F32', label: 'Bronze', icon: Award },
];

export default function AgentLeaderboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [period, setPeriod] = useState<Period>('weekly');
  const [howOpen, setHowOpen] = useState(false);

  // Explain how the leaderboard works when the page first opens.
  useEffect(() => {
    const t = setTimeout(() => setHowOpen(true), 350);
    return () => clearTimeout(t);
  }, []);

  const { data: rows = [], isFetching } = useQuery({
    queryKey: ['subagent-leaderboard', period],
    queryFn: async () => {
      // Only the top 20 overall (3 podium + 17 list). No pagination.
      const { data, error } = await supabase.rpc('get_subagent_leaderboard', {
        p_period: period,
        p_limit: PER_PAGE,
        p_offset: 0,
      });
      if (error) throw error;
      return (data ?? []) as Row[];
    },
    placeholderData: keepPreviousData,
  });

  const { data: myRank } = useQuery({
    queryKey: ['my-subagent-rank', period, user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_my_subagent_rank', {
        p_period: period,
      });
      if (error) throw error;
      return ((data?.[0] as MyRank) ?? null);
    },
  });

  const totalMatched = rows[0]?.total_matched ?? 0;

  // Top 3 → podium bars, the rest of the top 20 → list.
  const top3 = rows.slice(0, 3);
  const tableRows = rows.slice(3);

  const changePeriod = (p: Period) => {
    hapticTap();
    setPeriod(p);
  };

  const podiumOrder = useMemo(() => {
    // [#2, #1, #3] for left/center/right
    const byRank = (r: number) => top3.find((t) => t.rank === r) ?? null;
    return [byRank(2), byRank(1), byRank(3)];
  }, [top3]);

  const hasData = totalMatched > 0;

  return (
    <div className="min-h-screen" style={{ background: '#F8FAFC' }}>
      <LeaderboardHowItWorksDialog open={howOpen} onOpenChange={setHowOpen} />
      {/* Hero banner */}
      <div className="relative overflow-hidden">
        <img
          src={bannerImg}
          alt="Agent leaderboard"
          width={1600}
          height={640}
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div
          className="absolute inset-0"
          style={{ background: 'linear-gradient(90deg, rgba(45,10,90,0.92) 0%, rgba(109,40,217,0.75) 45%, rgba(147,52,235,0.35) 100%)' }}
        />
        <div className="relative z-10 mx-auto w-full max-w-3xl px-5 pt-5 pb-8">
          <button
            onClick={() => { hapticTap(); navigate(-1); }}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-white/90 hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </button>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="mt-8"
          >
            <div className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-white backdrop-blur-sm">
              <Trophy className="h-3.5 w-3.5" style={{ color: '#FACC15' }} /> Recognition & Competition
            </div>
            <h1 className="mt-3 text-3xl font-extrabold leading-tight text-white sm:text-4xl">
              Agent Leaderboard
            </h1>
            <p className="mt-2 max-w-md text-sm text-white/85 sm:text-base">
              Keep your sub-agents active — listing houses, submitting rent requests, and allocating rent — to climb the rankings.
            </p>
            <div className="mt-5 flex flex-nowrap gap-2.5">
              <Button
                onClick={() => { hapticTap(); navigate('/sub-agents'); }}
                className="flex-1 min-w-0 rounded-full px-3 text-sm font-semibold text-white shadow-lg sm:flex-none sm:px-4"
                style={{ background: 'linear-gradient(135deg, #9334EB, #6D28D9)' }}
              >
                <UserPlus className="mr-1.5 h-4 w-4 shrink-0" /> <span className="truncate">Invite Sub-Agent</span>
              </Button>
              <Button
                variant="secondary"
                onClick={() => { hapticTap(); navigate('/sub-agents'); }}
                className="flex-1 min-w-0 rounded-full border border-white/40 bg-white/10 px-3 text-sm font-semibold text-white backdrop-blur-sm hover:bg-white/20 sm:flex-none sm:px-4"
              >
                <Users className="mr-1.5 h-4 w-4 shrink-0" /> <span className="truncate">View My Network</span>
              </Button>
            </div>
          </motion.div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl px-4 pb-24">
        {/* Period toggle */}
        <div className="-mt-5 relative z-20 mb-6 flex justify-center">
          <div className="inline-flex rounded-full bg-card p-1 shadow-lg" style={{ boxShadow: '0 10px 30px -12px rgba(109,40,217,0.4)' }}>
            {(['weekly', 'monthly'] as Period[]).map((p) => (
              <button
                key={p}
                onClick={() => changePeriod(p)}
                className="relative rounded-full px-6 py-2 text-sm font-semibold capitalize transition-colors"
                style={period === p ? { color: '#FFFFFF' } : { color: '#6D28D9' }}
              >
                {period === p && (
                  <motion.span
                    layoutId="period-pill"
                    className="absolute inset-0 rounded-full"
                    style={{ background: 'linear-gradient(135deg, #9334EB, #6D28D9)' }}
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                  />
                )}
                <span className="relative z-10">{p}</span>
              </button>
            ))}
          </div>
        </div>

        {isFetching && !hasData ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin" style={{ color: '#9334EB' }} />
          </div>
        ) : !hasData ? (
          <EmptyState onInvite={() => navigate('/sub-agents')} />
        ) : (
          <>
            {/* Podium */}
            {top3.length > 0 && (
              <div className="mb-8 flex items-end justify-center gap-3 sm:gap-5">
                {podiumOrder.map((agent, i) => {
                  if (!agent) return <div key={i} className="flex-1" />;
                  const meta = RANK_META[agent.rank - 1];
                  const height = agent.rank === 1 ? 200 : agent.rank === 2 ? 158 : 130;
                  const RankIcon = meta.icon;
                  return (
                    <div key={agent.agent_id} className="flex flex-1 flex-col items-center">
                      {/* Avatar */}
                      <motion.div
                        initial={{ opacity: 0, y: -12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.15 + i * 0.1 }}
                        className="relative"
                      >
                        <div
                          className="rounded-full p-[3px]"
                          style={{ background: meta.color }}
                        >
                          <UserAvatar avatarUrl={agent.avatar_url} fullName={agent.agent_name} size={agent.rank === 1 ? 'lg' : 'md'} />
                        </div>
                        <div
                          className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full text-white shadow"
                          style={{ background: meta.color }}
                        >
                          <RankIcon className="h-3.5 w-3.5" />
                        </div>
                      </motion.div>
                      <p className="mt-2 max-w-[92px] truncate text-center text-xs font-bold text-foreground sm:text-sm">
                        {agent.agent_name}
                      </p>
                      {/* Bar */}
                      <motion.div
                        initial={{ height: 0 }}
                        animate={{ height }}
                        transition={{ type: 'spring', stiffness: 120, damping: 18, delay: 0.2 + i * 0.1 }}
                        className="mt-2 flex w-full max-w-[110px] flex-col items-center justify-start rounded-t-2xl pt-3 text-white shadow-lg"
                        style={{
                          background: agent.rank === 1
                            ? 'linear-gradient(180deg, #9334EB, #6D28D9)'
                            : 'linear-gradient(180deg, #C084FC, #9334EB)',
                        }}
                      >
                        <span className="text-2xl font-extrabold leading-none drop-shadow">{agent.active_count}</span>
                        <span className="text-[10px] font-medium uppercase tracking-wide text-white/80">Active</span>
                        <span className="mt-2 rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-semibold">
                          {agent.active_rate}% of {agent.total_subagents}
                        </span>
                        <span className="mt-auto pb-2 text-lg font-black text-white/90">#{agent.rank}</span>
                      </motion.div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Current user card */}
            {myRank && (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                className="mb-6 overflow-hidden rounded-3xl p-5 text-white shadow-xl"
                style={{ background: 'linear-gradient(135deg, #9334EB, #6D28D9)' }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="rounded-full bg-white/20 p-[2px]">
                      <UserAvatar avatarUrl={myRank.avatar_url} fullName={myRank.agent_name} size="md" />
                    </div>
                    <div>
                      <p className="text-xs font-medium text-white/80">Your Position</p>
                      <p className="text-xl font-extrabold">Rank #{myRank.rank}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-medium text-white/80">Active Sub-Agents</p>
                    <p className="text-lg font-extrabold">{myRank.active_count} <span className="text-sm font-semibold text-white/80">({myRank.active_rate}%)</span></p>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Rankings table */}
            {tableRows.length > 0 && (
              <Card className="mb-6 overflow-hidden rounded-3xl border-none shadow-sm">
                <div className="grid grid-cols-[44px_1fr_auto] items-center gap-3 border-b bg-muted px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <span>Rank</span>
                  <span>Agent</span>
                  <span className="text-right">Active / Rate</span>
                </div>
                {tableRows.map((r, i) => {
                  const isMe = r.agent_id === user?.id;
                  return (
                    <motion.div
                      key={r.agent_id}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: Math.min(i * 0.03, 0.4) }}
                      className="grid grid-cols-[44px_1fr_auto] items-center gap-3 border-b px-4 py-3 last:border-b-0 transition-colors hover:bg-muted"
                      style={isMe ? { background: 'rgba(147,52,235,0.1)' } : undefined}
                    >
                      <span className="text-sm font-bold" style={{ color: isMe ? '#6D28D9' : '#64748b' }}>#{r.rank}</span>
                      <div className="flex min-w-0 items-center gap-2.5">
                        <UserAvatar avatarUrl={r.avatar_url} fullName={r.agent_name} size="sm" />
                        <span className="truncate text-sm font-semibold text-foreground">
                          {isMe
                            ? <><span style={{ color: '#6D28D9' }}>You</span> ({r.agent_name})</>
                            : r.agent_name}
                        </span>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold text-foreground">{r.active_count} active</p>
                        <p className="text-xs font-medium" style={{ color: '#6D28D9' }}>{r.active_rate}% of {r.total_subagents}</p>
                      </div>
                    </motion.div>
                  );
                })}
                {/* Pin the logged-in user as the last row when they're outside the top 20 */}
                {myRank && !rows.some((r) => r.agent_id === user?.id) && (
                  <>
                    <div className="flex items-center justify-center gap-1.5 border-t bg-muted py-2 text-muted-foreground">
                      <span className="h-1 w-1 rounded-full bg-slate-300" />
                      <span className="h-1 w-1 rounded-full bg-slate-300" />
                      <span className="h-1 w-1 rounded-full bg-slate-300" />
                    </div>
                    <div
                      className="grid grid-cols-[44px_1fr_auto] items-center gap-3 px-4 py-3"
                      style={{ background: 'rgba(147,52,235,0.1)' }}
                    >
                      <span className="text-sm font-bold" style={{ color: '#6D28D9' }}>#{myRank.rank}</span>
                      <div className="flex min-w-0 items-center gap-2.5">
                        <UserAvatar avatarUrl={myRank.avatar_url} fullName={myRank.agent_name} size="sm" />
                        <span className="truncate text-sm font-semibold text-foreground">
                          <span style={{ color: '#6D28D9' }}>You</span> ({myRank.agent_name})
                        </span>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold text-foreground">{myRank.active_count} active</p>
                        <p className="text-xs font-medium" style={{ color: '#6D28D9' }}>{myRank.active_rate}% of {myRank.total_subagents}</p>
                      </div>
                    </div>
                  </>
                )}
              </Card>
            )}
          </>
        )}

        {/* How rankings work */}
        <Card className="rounded-3xl border-none p-5 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-full" style={{ background: 'rgba(147,52,235,0.12)' }}>
              <Info className="h-4.5 w-4.5" style={{ color: '#9334EB' }} />
            </div>
            <h2 className="text-base font-bold text-foreground">How Rankings Work</h2>
          </div>
          <ul className="space-y-2 text-sm text-muted-foreground">
            {[
              'Rankings are based on how many of your sub-agents are ACTIVE this period.',
              'A sub-agent is active when they list at least one empty house, submit a rent request, or allocate a rent amount during the period.',
              'Agents are ranked first by number of active sub-agents, then by their activation rate (percent active).',
              "You still earn a 2% lifetime override on your sub-agents' rent commissions.",
              'Weekly rankings reset every Monday.',
              'Monthly rankings reset on the first day of every month.',
            ].map((t) => (
              <li key={t} className="flex gap-2">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0" style={{ color: '#C084FC' }} />
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function EmptyState({ onInvite }: { onInvite: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex flex-col items-center rounded-3xl bg-card px-6 py-14 text-center shadow-sm"
    >
      <div className="flex h-20 w-20 items-center justify-center rounded-full" style={{ background: 'rgba(147,52,235,0.1)' }}>
        <Trophy className="h-10 w-10" style={{ color: '#9334EB' }} />
      </div>
      <h3 className="mt-5 text-lg font-bold text-foreground">No recruitment activity yet.</h3>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">
        Be the first to invite a sub-agent and claim the #1 position.
      </p>
      <Button
        onClick={() => { hapticTap(); onInvite(); }}
        className="mt-6 rounded-full font-semibold text-white shadow-lg"
        style={{ background: 'linear-gradient(135deg, #9334EB, #6D28D9)' }}
      >
        <UserPlus className="mr-1.5 h-4 w-4" /> Invite Sub-Agent
      </Button>
    </motion.div>
  );
}
