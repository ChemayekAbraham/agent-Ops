import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Banknote, Clock, AlertTriangle, Ban } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';

interface CashSession {
  id: string;
  depositor_name: string | null;
  amount: number;
  pin: string;
  status: string;
  attempts: number;
  max_attempts: number;
  expires_at: string;
  created_at: string;
  completed_at: string | null;
}

/**
 * Live panel shown on the agent dashboard. Whenever a user starts a
 * "cash with agent" deposit targeting THIS agent, a pending session lands
 * here in realtime with the 4-digit code displayed large. The agent reads
 * the code back to the depositor AFTER receiving the cash. RLS guarantees
 * only the targeted agent can read the code.
 */
export function AgentCashDepositCodesPanel() {
  const { user } = useAuth();
  const [sessions, setSessions] = useState<CashSession[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!user?.id) return;
    // Look back ~35 min so we can also surface codes that just expired or
    // locked after too many attempts (so the agent knows why it vanished).
    const since = new Date(Date.now() - 35 * 60_000).toISOString();
    const { data } = await supabase
      .from('agent_cash_deposit_sessions')
      .select('id, depositor_name, amount, pin, status, attempts, max_attempts, expires_at, created_at, completed_at')
      .eq('agent_id', user.id)
      .gte('created_at', since)
      .order('created_at', { ascending: false });
    setSessions((data ?? []) as CashSession[]);
  }, [user?.id]);

  useEffect(() => { void load(); }, [load]);

  // Tick every 15s to drop expired sessions and refresh the countdown.
  useEffect(() => {
    const iv = window.setInterval(() => {
      setNow(Date.now());
      void load();
    }, 15_000);
    return () => window.clearInterval(iv);
  }, [load]);

  // Realtime: instantly surface / remove sessions for this agent.
  useEffect(() => {
    if (!user?.id) return;
    const channel = supabase
      .channel(`agent-cash-sessions-${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'agent_cash_deposit_sessions', filter: `agent_id=eq.${user.id}` },
        () => void load(),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user?.id, load]);

  const isExpiredByTime = (s: CashSession) => new Date(s.expires_at).getTime() <= now;
  const live = sessions.filter((s) => s.status === 'pending' && !isExpiredByTime(s));
  // Codes that just terminated unsuccessfully — show a short-lived notice so the
  // agent understands the code is no longer usable and can ask for a new deposit.
  const terminated = sessions.filter(
    (s) =>
      s.status !== 'completed' &&
      (s.status === 'expired' || (s.status === 'pending' && isExpiredByTime(s))),
  );

  if (live.length === 0 && terminated.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <Banknote className="h-4 w-4 text-emerald-600" />
        <h3 className="text-sm font-semibold">Cash deposit codes</h3>
        <span className="text-xs text-muted-foreground">Read the code to the customer after you receive the cash</span>
      </div>
      {live.map((s) => {
        const minsLeft = Math.max(0, Math.round((new Date(s.expires_at).getTime() - now) / 60000));
        const wrongTries = Math.max(0, Number(s.attempts) || 0);
        const triesLeft = Math.max(0, (Number(s.max_attempts) || 5) - wrongTries);
        return (
          <Card key={s.id} className="border-emerald-500/40 bg-emerald-500/5">
            <CardContent className="p-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{s.depositor_name || 'Welile user'}</p>
                <p className="text-xs text-muted-foreground">wants {formatUGX(s.amount)}</p>
                <p className="mt-1 text-[11px] text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" /> expires in {minsLeft} min
                </p>
                {wrongTries > 0 && (
                  <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-500 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    {wrongTries} wrong {wrongTries === 1 ? 'try' : 'tries'} · {triesLeft} left
                  </p>
                )}
              </div>
              <div className="text-right shrink-0">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Code</p>
                <p className="text-3xl font-bold tracking-[0.3em] tabular-nums text-emerald-700 dark:text-emerald-400">
                  {s.pin}
                </p>
              </div>
            </CardContent>
          </Card>
        );
      })}
      {terminated.map((s) => {
        const lockedByAttempts = (Number(s.attempts) || 0) >= (Number(s.max_attempts) || 5);
        return (
          <Card key={s.id} className="border-destructive/30 bg-destructive/5">
            <CardContent className="p-3 flex items-center gap-2">
              <Ban className="h-4 w-4 text-destructive shrink-0" />
              <p className="text-xs text-muted-foreground">
                Code for <span className="font-medium text-foreground">{s.depositor_name || 'Welile user'}</span>{' '}
                ({formatUGX(s.amount)}){' '}
                {lockedByAttempts ? 'was locked after too many wrong tries.' : 'has expired.'}{' '}
                Ask them to start a new cash deposit.
              </p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export default AgentCashDepositCodesPanel;