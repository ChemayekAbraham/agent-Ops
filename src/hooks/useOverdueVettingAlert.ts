import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { buildDueSoonBanner, buildOverdueDialogCopy, type OverdueVetting } from '@/lib/vettingOverdueCopy';

export const OVERDUE_VETTING_QUERY_KEY = ['overdue-vetting'] as const;

/**
 * Drives the in-app "vetting overdue" dialog for Service Centre managers.
 *  - The server decides what is overdue (get_my_overdue_vetting); nothing is stored in the browser, so a refresh shows it again at once.
 *  - After the manager closes it, it comes back after remind_after_seconds (60) for as long as anything is still overdue.
 *  - `suppressed` hides the dialog (for example on the vetting queue page, where a banner is used instead) without clearing the data.
 *  - Deciding an item invalidates this query (see the Service Centre queue hooks), so the dialog ends the moment the queue is clear.
 */
export function useOverdueVettingAlert(opts: { suppressed?: boolean } = {}) {
  const { user, roles } = useAuth();
  // Only agents can be Service Centre managers, so nobody else polls.
  const isAgent = (roles as string[]).some((r) => r === 'agent' || r === 'senior_agent' || r === 'sub_agent');
  const [snoozedUntil, setSnoozedUntil] = useState(0);
  const [, setTick] = useState(0);
  const loggedForCountRef = useRef<number | null>(null);

  const query = useQuery({
    queryKey: [...OVERDUE_VETTING_QUERY_KEY, user?.id],
    enabled: !!user?.id && isAgent,
    staleTime: 0,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_my_overdue_vetting');
      if (error) throw error;
      return data as OverdueVetting;
    },
  });

  const data = query.data;
  const overdue = !!data?.enabled && (data?.overdue_count ?? 0) > 0;
  const open = overdue && !opts.suppressed && Date.now() >= snoozedUntil;

  // Wake up when the snooze ends so the dialog reopens without waiting for the next poll.
  useEffect(() => {
    const wait = snoozedUntil - Date.now();
    if (wait <= 0) return;
    const t = setTimeout(() => setTick((n) => n + 1), wait + 50);
    return () => clearTimeout(t);
  }, [snoozedUntil]);

  // Audit each time the dialog appears (the server throttles to one row per manager per 15 minutes).
  useEffect(() => {
    if (!open) { loggedForCountRef.current = null; return; }
    if (loggedForCountRef.current !== null) return;
    loggedForCountRef.current = data?.overdue_count ?? 0;
    void (supabase.rpc as any)('log_overdue_vetting_alert_shown');
  }, [open, data?.overdue_count]);

  const remindLater = useCallback(() => {
    setSnoozedUntil(Date.now() + (data?.remind_after_seconds ?? 60) * 1000);
  }, [data?.remind_after_seconds]);

  return {
    open,
    data,
    copy: data && overdue ? buildOverdueDialogCopy(data) : null,
    dueSoonBanner: data?.enabled ? buildDueSoonBanner(data) : null,
    overdueCount: data?.overdue_count ?? 0,
    remindLater,
    refetch: query.refetch,
  };
}

/** For the Ops review screen: managers holding overdue items, oldest first. */
export function useOverdueVettingOverview() {
  return useQuery({
    queryKey: ['overdue-vetting-overview'],
    refetchInterval: 120_000,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_overdue_vetting_overview');
      if (error) throw error;
      return (data ?? []) as {
        manager_id: string; manager_name: string | null; overdue_count: number; escalated_count: number;
        oldest_age_hours: number; rent_plans: number; landlords: number; lc1: number; last_alert_at: string | null;
      }[];
    },
  });
}
