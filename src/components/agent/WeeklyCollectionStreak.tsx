import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Flame, X, Check, Clock, CircleHelp } from 'lucide-react';
import { cn } from '@/lib/utils';

export const STREAK_TIERS = [
  { active: 7, reward: 50000 },
  { active: 6, reward: 30000 },
  { active: 5, reward: 20000 },
  { active: 4, reward: 10000 },
];

type Day = { day: string; tenants_due: number; tenants_paid: number; state: 'active' | 'missed' | 'in_progress' | 'upcoming' };
type Streak = { week_start: string; week_end: string; active_days: number; missed_days: number; best_possible_active: number; days: Day[]; payouts_enabled: boolean };

const fmt = (n: number) => `UGX ${n.toLocaleString('en-US')}`;
const rewardFor = (active: number) => STREAK_TIERS.find((t) => active >= t.active)?.reward ?? 0;
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function useWeeklyStreak() {
  return useQuery({
    queryKey: ['agent-weekly-collection-streak'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_weekly_collection_streak' as any, {});
      if (error) throw error;
      return data as unknown as Streak;
    },
    staleTime: 60_000,
  });
}

export function WeeklyCollectionStreakCard({ compact = false }: { compact?: boolean }) {
  const { data, isLoading, error } = useWeeklyStreak();
  const [helpOpen, setHelpOpen] = useState(false);
  if (isLoading) return <div className="h-40 rounded-2xl bg-muted/40 animate-pulse" />;
  if (error || !data) return <p className="text-sm text-muted-foreground">Could not load your weekly streak.</p>;

  const onTrack = rewardFor(data.best_possible_active);
  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Flame className="h-5 w-5 text-warning" />
        <p className="font-bold text-[15px]">Weekly Collection Streak</p>
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          aria-label="How the Weekly Collection Streak works"
          className="ml-auto inline-flex h-8 items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2.5 text-[11px] font-semibold text-muted-foreground hover:bg-muted/60"
        >
          <CircleHelp className="h-3.5 w-3.5" />
          How it works
        </button>
      </div>
      <p className="text-[12px] text-muted-foreground">
        Collect from <strong>every tenant</strong> each day, Monday to Sunday. Resets Monday 00:00 (Kampala time).
      </p>
      <div className="grid grid-cols-7 gap-1">
        {data.days.map((d, i) => (
          <div key={d.day} className={cn(
            'rounded-lg py-2 text-center text-[11px] font-semibold border',
            d.state === 'active' && 'bg-success/15 border-success/40 text-success',
            d.state === 'missed' && 'bg-destructive/10 border-destructive/30 text-destructive',
            d.state === 'in_progress' && 'bg-warning/10 border-warning/40 text-warning',
            d.state === 'upcoming' && 'bg-muted/30 border-border/40 text-muted-foreground',
          )}>
            <div>{DAY_LABELS[i]}</div>
            <div className="mt-1 flex justify-center">
              {d.state === 'active' ? <Check className="h-3.5 w-3.5" /> : d.state === 'missed' ? <X className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
            </div>
            {d.state !== 'upcoming' && <div className="mt-0.5 text-[10px] tabular-nums">{d.tenants_paid}/{d.tenants_due}</div>}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between rounded-xl bg-muted/40 px-3 py-2 text-[13px]">
        <span>{data.active_days} active · {data.missed_days} missed</span>
        <span className="font-bold">{onTrack > 0 ? `On track: ${fmt(onTrack)}` : 'No reward this week'}</span>
      </div>
      {!compact && (
        <ul className="text-[12px] space-y-1">
          {STREAK_TIERS.map((t) => (
            <li key={t.active} className="flex justify-between"><span>{t.active}/7 active days</span><span className="font-semibold tabular-nums">{fmt(t.reward)}</span></li>
          ))}
          <li className="flex justify-between text-muted-foreground"><span>3 or fewer</span><span>UGX 0</span></li>
        </ul>
      )}
      {!data.payouts_enabled && (
        <p className="text-[11px] text-muted-foreground">Rewards are being tested this week. Automatic payouts start soon.</p>
      )}
      <HowItWorksDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

export function HowItWorksDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1rem)] sm:w-full max-w-sm p-4 gap-3 max-h-[90dvh] overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-lg font-bold">How it works</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-[13px] text-muted-foreground">
          <p>
            Collect from <strong className="text-foreground">every tenant due</strong> each day to mark that day
            <strong className="text-success"> active</strong>. A day with any tenant still unpaid counts as
            <strong className="text-destructive"> missed</strong>. Today counts while it is still in progress.
          </p>
          <p>
            The week runs <strong className="text-foreground">Monday to Sunday</strong> and resets every Monday at
            00:00 Kampala time.
          </p>
          <div className="rounded-xl border border-border/60 bg-muted/30 p-3 space-y-1">
            <p className="font-semibold text-foreground text-[12px]">Weekly rewards</p>
            <ul className="space-y-1">
              {STREAK_TIERS.map((t) => (
                <li key={t.active} className="flex justify-between">
                  <span>{t.active}/7 active days</span>
                  <span className="font-semibold tabular-nums text-foreground">{fmt(t.reward)}</span>
                </li>
              ))}
              <li className="flex justify-between"><span>3 or fewer active days</span><span className="font-semibold tabular-nums">UGX 0</span></li>
            </ul>
          </div>
          <p>
            Rewards are paid automatically to your wallet the Monday after the week ends. Only real recorded
            collections count.
          </p>
        </div>
        <Button onClick={() => onOpenChange(false)} className="h-11 font-semibold">Got it</Button>
      </DialogContent>
    </Dialog>
  );
}

const STORAGE_KEY = 'welile.weeklyStreakDialog.dismissedAt';
const SUPPRESS_MS = 12 * 60 * 60 * 1000;

export function WeeklyStreakDialog() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      const at = Number(localStorage.getItem(STORAGE_KEY) || '0');
      if (at && Date.now() - at < SUPPRESS_MS) return;
    } catch {}
    const t = setTimeout(() => setOpen(true), 900);
    return () => clearTimeout(t);
  }, []);
  const close = () => { try { localStorage.setItem(STORAGE_KEY, String(Date.now())); } catch {} setOpen(false); };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="w-[calc(100vw-1rem)] sm:w-full max-w-sm p-4 gap-3 max-h-[90dvh] overflow-y-auto rounded-2xl">
        <h2 className="text-lg font-bold">Earn up to UGX 50,000 every week</h2>
        <WeeklyCollectionStreakCard />
        <Button onClick={close} className="h-11 font-semibold">Got it</Button>
      </DialogContent>
    </Dialog>
  );
}
