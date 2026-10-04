import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Target, TrendingDown, CheckCircle2, Bike, Smartphone, Home, UtensilsCrossed,
  Loader2, Info, CalendarClock, ChevronDown, Gift, AlertTriangle,
} from 'lucide-react';


import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDynamic } from '@/lib/currencyFormat';
import { hapticTap } from '@/lib/haptics';
import { cn } from '@/lib/utils';

const money = (v: unknown) => formatDynamic(Number(v ?? 0));

export interface ProxyTargetModeState {
  agent_id: string;
  status: 'undecided' | 'accepted' | 'declined';
  decided_at: string | null;
  monthly_note_target: number;
  monthly_reward: number;
  min_notes: number;
  min_reward: number;
  rate_per_note: number;
  days_in_month: number;
  day_of_month: number;
  daily_target: number;
  daily_min: number;
  stretch_daily: number;
  notes_month: number;
  notes_today: number;
  daily_min_hit_today: boolean;
  behind_today: boolean;
  today_shortfall: number;
  zero_note_days: number;
  benefits_active: boolean;
  guaranteed_min_income: number;
  expected_to_date: number;
  missed_notes: number;
  earned_now: number;
  available_income: number;
  tier_hit: boolean;
  target_hit: boolean;
  on_track: boolean;
  month_start: string;

}

export function useProxyTargetMode(agentId?: string | null) {
  return useQuery({
    queryKey: ['proxy-target-mode', agentId ?? 'self'],
    enabled: !!agentId,
    staleTime: 30_000,
    queryFn: async (): Promise<ProxyTargetModeState> => {
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>)(
        'get_proxy_target_mode', { p_agent_id: agentId ?? null },
      );
      if (error) throw new Error(error.message);
      return data as ProxyTargetModeState;
    },
  });
}

const perks = [
  { icon: UtensilsCrossed, label: 'Daily facilitation at Welile offices' },
  { icon: Home, label: 'Welile proxy agent accommodation' },
  { icon: Bike, label: 'Welile bikes for field work' },
  { icon: Smartphone, label: 'Welile smartphone' },
  { icon: UtensilsCrossed, label: 'Welile restaurant access' },
];

/**
 * Target Mode standing for a proxy agent.
 *
 * Presentation only — every figure comes from `get_proxy_target_mode`, and the
 * accept / decline button writes through `set_proxy_target_mode`.
 */
export function ProxyTargetModeCard({ agentId }: { agentId?: string | null }) {
  const qc = useQueryClient();
  const q = useProxyTargetMode(agentId);
  const t = q.data;
  const [rewardsOpen, setRewardsOpen] = useState(false);

  const decide = useMutation({
    mutationFn: async (accept: boolean) => {
      const { error } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>)(
        'set_proxy_target_mode', { p_accept: accept, p_agent_id: agentId ?? null },
      );
      if (error) throw new Error(error.message);
      return accept;
    },
    onSuccess: (accept) => {
      toast.success(accept ? 'Target Mode is on' : 'Staying on your current earning');
      qc.invalidateQueries({ queryKey: ['proxy-target-mode'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const progressPct = useMemo(() => {
    if (!t || !t.monthly_note_target) return 0;
    return Math.min(100, Math.round((t.notes_month / t.monthly_note_target) * 100));
  }, [t]);

  if (q.isLoading) return <Skeleton className="h-56 rounded-2xl" />;
  if (q.error) {
    return (
      <Card><CardContent className="p-4 text-sm text-destructive">
        {(q.error as Error).message}
      </CardContent></Card>
    );
  }
  if (!t) return null;

  const lost = Math.max(0, Number(t.monthly_reward) - Number(t.available_income));

  /* ---------------- Offer: not decided yet ---------------- */
  if (t.status === 'undecided') {
    return (
      <Card className="border-primary/40 bg-primary/5 shadow-sm">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-1.5 text-primary">
            <Target className="h-3.5 w-3.5" />
            <span className="text-[10px] font-semibold uppercase tracking-wider">
              Target Mode offer
            </span>
          </div>

          <div>
            <p className="text-2xl font-semibold leading-none">{money(t.monthly_reward)}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Monthly income on the table if you register {t.monthly_note_target} promissory notes.
              Your daily minimum is just {t.daily_min ?? 10} notes a day — go beyond it and the
              reward grows with every extra note. Hit only {t.min_notes} notes and you still
              receive {money(t.min_reward)}.
            </p>
          </div>

          <div className="rounded-xl border border-border bg-background p-3 space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              What you also get
            </p>
            {perks.map((p) => (
              <div key={p.label} className="flex items-center gap-2 text-[12px]">
                <p.icon className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span className="truncate">{p.label}</span>
              </div>
            ))}
          </div>

          <p className="text-[11px] text-muted-foreground">
            Record at least 1 note every day to keep the benefits above — a day with no note at
            all pauses them. Hit the {t.daily_min ?? 10}-note daily minimum and{' '}
            {money(t.min_reward)} is secured for your wallet. Fall short and the income you can
            still receive drops by about {money(t.rate_per_note)} for every note behind. Decline
            and you keep earning exactly the way you do today — commissions are untouched either
            way.
          </p>


          <div className="flex gap-2">
            <Button
              className="flex-1 h-11 font-semibold"
              disabled={decide.isPending}
              onClick={() => { hapticTap(); decide.mutate(true); }}
            >
              {decide.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Accept Target Mode'}
            </Button>
            <Button
              variant="outline"
              className="h-11"
              disabled={decide.isPending}
              onClick={() => { hapticTap(); decide.mutate(false); }}
            >
              Decline
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  /* ---------------- Declined ---------------- */
  if (t.status === 'declined') {
    return (
      <Card className="shadow-sm">
        <CardContent className="p-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">Target Mode is off</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              You earn on commission only. Turn it on any time to open up{' '}
              {money(t.monthly_reward)} a month plus facilitation, accommodation, bikes,
              smartphone and restaurant access.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={decide.isPending}
            onClick={() => { hapticTap(); decide.mutate(true); }}
          >
            Turn on
          </Button>
        </CardContent>
      </Card>
    );
  }

  /* ---------------- Accepted: live standing ---------------- */
  return (
    <Card className="border-primary/40 shadow-sm">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-primary">
              <Target className="h-3.5 w-3.5" />
              <span className="text-[10px] font-semibold uppercase tracking-wider">
                Available income this month
              </span>
            </div>
            <p className="mt-1 text-3xl font-semibold leading-none">{money(t.available_income)}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Paid to your wallet at month end. Full target pays {money(t.monthly_reward)}.
            </p>
          </div>
          <Badge
            variant="outline"
            className={cn(
              'shrink-0 text-[10px]',
              t.on_track
                ? 'border-emerald-500/30 text-emerald-600'
                : 'border-amber-500/30 text-amber-600',
            )}
          >
            {t.on_track ? 'On track' : 'Behind'}
          </Badge>
        </div>

        {t.benefits_active === false && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <p className="text-[11px] leading-snug">
              <span className="font-semibold">Target Mode benefits paused.</span> You went{' '}
              {t.zero_note_days} {t.zero_note_days === 1 ? 'day' : 'days'} without recording a
              single promissory note. At least 1 note every day keeps facilitation,
              accommodation, bike, smartphone and restaurant access active.
            </p>
          </div>
        )}

        {t.daily_min_hit_today ? (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
            <p className="text-[11px] leading-snug">
              <span className="font-semibold">
                {money(t.guaranteed_min_income ?? t.min_reward)} secured
              </span>{' '}
              — you hit today&apos;s {t.daily_min ?? 10}-note minimum with {t.notes_today} notes.
              It is paid to your wallet automatically at month end.
            </p>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
            <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            <p className="text-[11px] leading-snug">
              <span className="font-semibold">You are behind today.</span> {t.notes_today} of{' '}
              {t.daily_min ?? 10} notes recorded — {t.today_shortfall} more to secure{' '}
              {money(t.min_reward)}. Record at least 1 note today to keep your benefits.
            </p>
          </div>
        )}

        {lost > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
            <TrendingDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            <p className="text-[11px] leading-snug">
              <span className="font-semibold">{money(lost)} lost</span> to{' '}
              {t.missed_notes} notes behind the daily target. Catch up and it comes back —
              each note is worth about {money(t.rate_per_note)}.
            </p>
          </div>
        )}

        <div>
          <div className="flex items-center justify-between text-[11px] font-medium">
            <span>{t.notes_month} of {t.monthly_note_target} notes</span>
            <span className="text-muted-foreground">{progressPct}%</span>
          </div>
          <Progress value={progressPct} className="mt-1 h-1.5" />
        </div>

        <div className="grid grid-cols-4 divide-x divide-border rounded-lg border border-border">
          {[
            { label: 'Notes today', value: `${t.notes_today ?? 0}` },
            { label: 'Daily minimum', value: `${t.daily_min ?? t.daily_target}` },
            { label: 'Expected by today', value: `${t.expected_to_date}` },
            { label: 'Behind by', value: `${t.missed_notes}` },
          ].map((c) => (
            <div key={c.label} className="px-2 py-2 text-center">
              <div className="text-base font-semibold leading-none">{c.value}</div>
              <div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                {c.label}
              </div>
            </div>
          ))}
        </div>


        <button
          type="button"
          onClick={() => { hapticTap(); setRewardsOpen((v) => !v); }}
          className="flex w-full items-center justify-between rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5 text-left"
        >
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-primary">
            <Gift className="h-3.5 w-3.5" />
            Go beyond the {t.daily_min ?? 10}-note daily minimum — see what Welile rewards
          </span>
          <ChevronDown
            className={cn('h-4 w-4 text-primary transition-transform', rewardsOpen && 'rotate-180')}
          />
        </button>

        {rewardsOpen && (
          <div className="rounded-lg border border-border p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Reward ladder this month
            </p>
            {[
              { notes: t.min_notes, label: `${t.min_notes} notes` },
              { notes: 400, label: '400 notes' },
              { notes: 600, label: '600 notes' },
              { notes: 800, label: '800 notes' },
              { notes: 1000, label: '1,000 notes' },
              { notes: t.monthly_note_target, label: `${t.monthly_note_target} notes (full target)` },
            ].map((r) => {
              const payout = r.notes >= t.monthly_note_target
                ? t.monthly_reward
                : r.notes >= t.min_notes
                  ? t.min_reward + (r.notes - t.min_notes) * t.rate_per_note
                  : r.notes * (t.min_reward / Math.max(t.min_notes, 1));
              const reached = t.notes_month >= r.notes;
              return (
                <div key={r.notes} className="flex items-center justify-between text-[11px]">
                  <span className={cn('flex items-center gap-1.5', reached ? 'font-semibold' : 'text-muted-foreground')}>
                    {reached && <CheckCircle2 className="h-3 w-3 text-emerald-600" />}
                    {r.label}
                  </span>
                  <span className={cn('font-mono font-semibold', reached ? 'text-emerald-600' : '')}>
                    {money(Math.round(payout))}
                  </span>
                </div>
              );
            })}
            <p className="pt-0.5 text-[10px] leading-snug text-muted-foreground">
              {t.daily_min ?? 10} notes a day keeps you safe. A pace of about {t.stretch_daily} a day
              unlocks the full {money(t.monthly_reward)}. Every note beyond the minimum adds about{' '}
              {money(t.rate_per_note)}.
            </p>
          </div>
        )}

        <div className="rounded-lg border border-border bg-muted/40 p-2.5 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Info className="h-3 w-3" /> How it is worked out
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            {t.min_notes} notes pays {money(t.min_reward)}. Every note after that adds about{' '}
            {money(t.rate_per_note)}, up to {money(t.monthly_reward)} at{' '}
            {t.monthly_note_target} notes. Day {t.day_of_month} of {t.days_in_month}.
          </p>
          <p className="text-[11px] leading-snug text-muted-foreground">
            Your count and target reset on the 1st of every month, and you get three reminder
            emails a day (9am, midday and 3pm) to keep recording notes.
          </p>

          <div className="flex items-center gap-1.5 pt-0.5 text-[11px] font-medium">
            {t.tier_hit ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                <span>Qualified — {money(t.earned_now)} already earned</span>
              </>
            ) : (
              <>
                <CalendarClock className="h-3.5 w-3.5 text-amber-600" />
                <span>{Math.max(0, t.min_notes - t.notes_month)} more notes to qualify</span>
              </>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-border p-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t.benefits_active === false
              ? 'Paused until you record a note every day'
              : 'Included while on Target Mode'}
          </p>
          <div className={cn('mt-1.5 flex flex-wrap gap-1.5', t.benefits_active === false && 'opacity-50')}>
            {perks.map((p) => (
              <Badge key={p.label} variant="secondary" className="gap-1 text-[10px] font-medium">
                <p.icon className="h-3 w-3" /> {p.label}
              </Badge>
            ))}
          </div>
        </div>


        <Button
          variant="ghost"
          size="sm"
          className="w-full text-[11px] text-muted-foreground"
          disabled={decide.isPending}
          onClick={() => { hapticTap(); decide.mutate(false); }}
        >
          Leave Target Mode and earn on commission only
        </Button>
      </CardContent>
    </Card>
  );
}
