import { useEffect, useState } from 'react';
import { X, Trophy } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

const STORAGE_KEY = 'welile.lastWeekWinnerOverlay.dismissedAt';
const SUPPRESS_MS = 60 * 60 * 1000; // 1 hour

interface Winner {
  agent_id: string;
  amount: number;
  full_name: string | null;
  avatar_url: string | null;
  week_start: string;
  week_end: string;
}

export function LastWeekWinnerOverlay() {
  const [winner, setWinner] = useState<Winner | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      const dismissedAt = Number(localStorage.getItem(STORAGE_KEY) || '0');
      if (dismissedAt && Date.now() - dismissedAt < SUPPRESS_MS) return;
    } catch {}

    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('agent_listing_campaign_bonuses')
        .select('agent_id, amount, week_start, week_end')
        .lt('week_end', new Date().toISOString().slice(0, 10))
        .order('week_start', { ascending: false })
        .order('amount', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled || error || !data) return;
      const { data: prof } = await supabase
        .from('profiles')
        .select('full_name, avatar_url')
        .eq('id', data.agent_id)
        .maybeSingle();
      if (cancelled) return;
      setWinner({
        agent_id: data.agent_id,
        amount: Number(data.amount),
        week_start: data.week_start,
        week_end: data.week_end,
        full_name: prof?.full_name ?? null,
        avatar_url: prof?.avatar_url ?? null,
      });
      setOpen(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const close = () => {
    try {
      localStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {}
    setOpen(false);
  };

  if (!open || !winner) return null;

  const initials = (winner.full_name || 'W')
    .split(' ')
    .map((s) => s[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in"
      onClick={close}
    >
      <div
        className={cn(
          'relative w-full max-w-sm rounded-3xl border border-primary/30 bg-gradient-to-br from-primary/15 via-card to-card p-6 shadow-2xl',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={close}
          aria-label="Close"
          className="absolute top-3 right-3 h-8 w-8 rounded-full flex items-center justify-center bg-muted hover:bg-muted/80 text-muted-foreground"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex flex-col items-center text-center">
          <div className="flex items-center gap-1.5 rounded-full bg-warning/15 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-warning mb-4">
            <Trophy className="h-3.5 w-3.5" style={{ color: '#FACC15' }} />
            Last week's winner
          </div>

          <Avatar className="h-20 w-20 ring-4 ring-primary/30 mb-3">
            {winner.avatar_url && <AvatarImage src={winner.avatar_url} alt={winner.full_name || ''} />}
            <AvatarFallback className="text-lg font-bold bg-primary/15 text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>

          <p className="text-lg font-bold text-foreground leading-tight">
            {winner.full_name || 'Top Agent'}
          </p>
          <p className="text-[12px] text-muted-foreground mb-4">
            Weekly Listing Mission champion
          </p>

          <div className="w-full rounded-2xl bg-background/60 border border-border/50 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Amount won
            </p>
            <p className="text-3xl font-bold tracking-tight tabular-nums text-success mt-1">
              {formatUGX(winner.amount)}
            </p>
          </div>

          <button
            onClick={close}
            className="mt-5 w-full rounded-2xl bg-primary text-primary-foreground py-3 font-bold text-sm active:scale-[0.98] transition-transform"
          >
            Let's go 🚀
          </button>
        </div>
      </div>
    </div>
  );
}

export default LastWeekWinnerOverlay;