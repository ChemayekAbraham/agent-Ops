import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { usePolling } from '@/hooks/usePolling';
import type { NudgeHistory } from '@/lib/nudges/engine';
import {
  canShowFunderNudge,
  pickFunderNudge,
  recordFunderNudge,
  type FunderNudgeStats,
  type RenderedFunderNudge,
} from '@/lib/funderNudges';

/**
 * Shows one warm, personal nudge toast on the funder/partner dashboard
 * ("Payday 💸 UGX 675,000 just landed in your wallet").
 *
 * Copy: src/lib/funderNudges/nudges.json (no buttons). Numbers:
 * `get_funder_nudge_stats()`, a read-only RPC that only ever reads the
 * signed-in partner's own data (it takes no arguments and uses auth.uid()).
 * Only partners with at least one active portfolio see nudges.
 *
 * Pacing: at most one a day, 07:00-21:00 Kampala, never one of the last few
 * shown. First check a few seconds after the dashboard opens, then every 30
 * minutes while it is open. History is per partner, per browser.
 */

const FIRST_CHECK_DELAY_MS = 8_000;
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

const storageKey = (userId: string) => `funder-nudges:${userId}`;

function readHistory(userId: string): NudgeHistory {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && Array.isArray(parsed.recent)) {
      return { lastShownAt: Number(parsed.lastShownAt) || null, recent: parsed.recent.map(String) };
    }
  } catch {
    // storage blocked or corrupt: treat as never shown
  }
  return { lastShownAt: null, recent: [] };
}

function writeHistory(userId: string, history: NudgeHistory) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(history));
  } catch {
    // storage blocked: the in-memory guard still stops repeats this session
  }
}

function showToast(nudge: RenderedFunderNudge) {
  const show = nudge.tone === 'celebrate' ? toast.success : toast.info;
  show(nudge.title, { id: 'funder-nudge', description: nudge.body, duration: 9_000 });
}

export function useFunderNudges(userId?: string | null, opts: { enabled?: boolean } = {}) {
  const { enabled = true } = opts;
  const lastShownThisSessionRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const active = enabled && !!userId;

  const showNextNudge = async (id: string) => {
    const history = readHistory(id);
    if (lastShownThisSessionRef.current != null) {
      history.lastShownAt = Math.max(history.lastShownAt ?? 0, lastShownThisSessionRef.current);
    }
    if (!canShowFunderNudge(history)) return;

    const { data, error } = await supabase.rpc('get_funder_nudge_stats' as any);
    if (error || !data) return;
    const stats = data as unknown as FunderNudgeStats;
    if (!(Number(stats.active_portfolios) >= 1)) return;

    const nudge = pickFunderNudge(stats, { exclude: history.recent });
    if (!nudge) return;

    showToast(nudge);
    lastShownThisSessionRef.current = Date.now();
    writeHistory(id, recordFunderNudge(history, nudge.id));
  };

  const check = async () => {
    if (!userId || inFlightRef.current || document.visibilityState !== 'visible') return;
    inFlightRef.current = true;
    try {
      await showNextNudge(userId);
    } finally {
      inFlightRef.current = false;
    }
  };

  const checkRef = useRef(check);
  checkRef.current = check;

  // First check once the dashboard has settled, then on the regular interval.
  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(() => void checkRef.current(), FIRST_CHECK_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [active, userId]);
  usePolling(check, CHECK_INTERVAL_MS, { enabled: active });
}

export default useFunderNudges;
