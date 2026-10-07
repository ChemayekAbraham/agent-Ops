import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion, animate } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Gem, Zap, Users, FlaskConical, Trophy, UserPlus, Percent, BadgeCheck } from 'lucide-react';

type Tier = 'diamond' | 'platinum' | 'gold' | 'silver';

export const TIER_META: Record<Tier, { label: string; from: string; to: string }> = {
  diamond: { label: 'Diamond', from: '#22D3EE', to: '#8B5CF6' },
  platinum: { label: 'Platinum', from: '#E2E8F0', to: '#64748B' },
  gold: { label: 'Gold', from: '#FDE047', to: '#D97706' },
  silver: { label: 'Silver', from: '#F1F5F9', to: '#94A3B8' },
};

type Perk = { icon: typeof Zap; text: string };
const SHARED: Perk[] = [
  { icon: Users, text: "UGX 5,000 when a sub-agent's tenant gets their first funded Rent Plan" },
  { icon: UserPlus, text: 'UGX 200 when someone your invitee invites is verified' },
  { icon: Percent, text: 'Keep your full 10% commission as a sub-agent' },
  { icon: BadgeCheck, text: 'Rank badge on your profile picture' },
];
const EARLY: Perk = { icon: FlaskConical, text: 'First access to new features' };
export const RANK_PERKS: Record<Tier, Perk[]> = {
  diamond: [{ icon: Zap, text: 'Rent Plan requests skip Service Centre and go straight to Agent Ops' }, ...SHARED, EARLY],
  platinum: [...SHARED, EARLY],
  gold: SHARED,
  silver: SHARED,
};

export function useMyEliteRank() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-elite-rank', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_my_elite_rank');
      if (error) throw error;
      return (data?.[0] ?? null) as { rank_position: number; tier_name: Tier; composite_score: number } | null;
    },
  });
}

function CountUp({ to }: { to: number }) {
  const reduce = useReducedMotion();
  const [v, setV] = useState(reduce ? to : 0);
  useEffect(() => {
    if (reduce) { setV(to); return; }
    const c = animate(0, to, { duration: 1.2, ease: 'easeOut', onUpdate: (x) => setV(x) });
    return () => c.stop();
  }, [to, reduce]);
  return <>{v.toFixed(1)}</>;
}

const WAS_RANKED_KEY = 'elite-rank-was-ranked';

export function AgentRankCelebrationDialog() {
  const { user } = useAuth();
  const { data: rank, isSuccess } = useMyEliteRank();
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const toasted = useRef(false);
  const name = (user?.user_metadata?.full_name as string | undefined)?.split(' ')[0] ?? 'Agent';

  useEffect(() => {
    if (!isSuccess) return;
    if (!rank) {
      if (sessionStorage.getItem(WAS_RANKED_KEY) && !toasted.current) {
        toasted.current = true;
        sessionStorage.removeItem(WAS_RANKED_KEY);
        toast('You are no longer in the Top 4. You are back to a normal agent rate until the next refresh.');
      }
      return;
    }
    sessionStorage.setItem(WAS_RANKED_KEY, '1');
    const key = `elite-rank-seen:${rank.rank_position}:${rank.tier_name}`;
    if (sessionStorage.getItem(key)) return;
    const t = setTimeout(() => { setOpen(true); sessionStorage.setItem(key, '1'); }, 400);
    return () => clearTimeout(t);
  }, [rank, isSuccess]);

  if (!rank) return null;
  const meta = TIER_META[rank.tier_name];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-sm rounded-3xl border-0 p-0 overflow-hidden gap-0 max-h-[90vh] overflow-y-auto">
        <div className="relative flex flex-col items-center px-6 pt-10 pb-6 text-center"
          style={{ background: `radial-gradient(circle at 50% 30%, ${meta.from}55, transparent 70%)` }}>
          {!reduce && [...Array(10)].map((_, i) => (
            <motion.span key={i} className="absolute h-1.5 w-1.5 rounded-full"
              style={{ background: meta.from, left: `${10 + i * 8}%`, top: '55%' }}
              initial={{ opacity: 0, y: 0 }}
              animate={{ opacity: [0, 1, 0], y: -90 - (i % 3) * 20 }}
              transition={{ duration: 1.8, delay: i * 0.12, repeat: Infinity, repeatDelay: 1 }} />
          ))}
          <motion.div
            initial={reduce ? false : { scale: 0, rotate: -180 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 160, damping: 12 }}
            className="flex h-24 w-24 items-center justify-center rounded-3xl shadow-2xl"
            style={{ background: `linear-gradient(135deg, ${meta.from}, ${meta.to})` }}>
            <motion.div animate={reduce ? undefined : { rotate: [0, 8, -8, 0] }} transition={{ duration: 3, repeat: Infinity }}>
              <Gem className="h-12 w-12 text-white drop-shadow" strokeWidth={1.8} />
            </motion.div>
          </motion.div>
          <DialogTitle className="mt-5 text-xl font-extrabold tracking-tight">
            Hi {name}, you have unlocked {meta.label}
          </DialogTitle>
          <DialogDescription className="mt-1 flex items-center gap-1.5 text-sm">
            <Trophy className="h-4 w-4" /> You are #{rank.rank_position} on the leaderboard
          </DialogDescription>
          <p className="mt-2 text-3xl font-black tabular-nums">
            <CountUp to={Number(rank.composite_score)} /><span className="text-sm font-semibold text-muted-foreground"> / 100</span>
          </p>
        </div>
        <div className="space-y-2 px-5 pb-5">
          {RANK_PERKS[rank.tier_name].map((p, i) => (
            <motion.div key={p.text} initial={reduce ? false : { opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.4 + i * 0.1 }}
              className="flex items-center gap-3 rounded-2xl border bg-muted/40 p-3 text-sm">
              <p.icon className="h-4 w-4 shrink-0 text-primary" />
              <span>{p.text}</span>
            </motion.div>
          ))}
          <p className="pt-1 text-center text-xs text-muted-foreground">
            Ranks refresh every night. Stay active to keep your rank.
          </p>
          <Button className="w-full rounded-2xl" onClick={() => setOpen(false)}>View leaderboard</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
