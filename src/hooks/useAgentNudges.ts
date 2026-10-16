import { createElement, useEffect, useRef } from 'react';
import { AgentNudgeToast } from '@/components/agent/AgentNudgeToast';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { usePolling } from '@/hooks/usePolling';
import {
  canShowNudge,
  pickNudge,
  recordNudge,
  type AgentNudgeStats,
  type NudgeCta,
  type NudgeHistory,
  type RenderedNudge,
} from '@/lib/agentNudges';

/**
 * Shows one catchy, personal nudge toast on the agent dashboard ("Hi 👋 Boss,
 * you're missing out on UGX 12,000 in commission 😎").
 *
 * Copy: src/lib/agentNudges/nudges.json. Numbers: `get_agent_nudge_stats()`.
 * Pacing: at most one nudge every 3 hours, 06:00-21:00 Kampala, never the same
 * nudge as one of the last few. The first check waits a few seconds so the
 * dashboard settles; later checks run every 20 minutes while it is open and
 * only fire once the cooldown has passed. History is per agent, per browser.
 *
 * `onAction` receives the nudge's call to action; without it the toast has no
 * button.
 */

const FIRST_CHECK_DELAY_MS = 8_000;
const CHECK_INTERVAL_MS = 20 * 60 * 1000;

const CTA_LABELS: Record<NudgeCta, string> = {
  collect: 'Collect now',
  add_tenant: 'Add tenant',
  leaderboard: 'See the board',
};

const storageKey = (agentId: string) => `agent-nudges:${agentId}`;

function readHistory(agentId: string): NudgeHistory {
  try {
    const raw = localStorage.getItem(storageKey(agentId));
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && Array.isArray(parsed.recent)) {
      return { lastShownAt: Number(parsed.lastShownAt) || null, recent: parsed.recent.map(String) };
    }
  } catch {
    // storage blocked or corrupt: treat as never shown
  }
  return { lastShownAt: null, recent: [] };
}

function writeHistory(agentId: string, history: NudgeHistory) {
  try {
    localStorage.setItem(storageKey(agentId), JSON.stringify(history));
  } catch {
    // storage blocked: the in-memory guard still stops repeats this session
  }
}

function showToast(nudge: RenderedNudge, onAction?: (cta: NudgeCta) => void) {
  toast.custom(
    (t) =>
      createElement(AgentNudgeToast, {
        nudge,
        ctaLabel: nudge.cta && onAction ? CTA_LABELS[nudge.cta] : undefined,
        onCta:
          nudge.cta && onAction
            ? () => {
                onAction(nudge.cta!);
                toast.dismiss(t);
              }
            : undefined,
        onClose: () => toast.dismiss(t),
      }),
    { id: 'agent-nudge', duration: 9_000, unstyled: true },
  );
}

export function useAgentNudges(
  agentId?: string | null,
  opts: { onAction?: (cta: NudgeCta) => void; enabled?: boolean } = {},
) {
  const { onAction, enabled = true } = opts;
  const lastShownThisSessionRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const active = enabled && !!agentId;

  const check = async () => {
    if (!agentId || inFlightRef.current || document.visibilityState !== 'visible') return;
    inFlightRef.current = true;
    try {
      await showNextNudge(agentId);
    } finally {
      inFlightRef.current = false;
    }
  };

  const showNextNudge = async (id: string) => {
    const history = readHistory(id);
    if (lastShownThisSessionRef.current != null) {
      history.lastShownAt = Math.max(history.lastShownAt ?? 0, lastShownThisSessionRef.current);
    }
    if (!canShowNudge(history)) return;

    const { data, error } = await supabase.rpc('get_agent_nudge_stats' as any);
    if (error || !data) return;

    const nudge = pickNudge(data as unknown as AgentNudgeStats, { exclude: history.recent });
    if (!nudge) return;

    showToast(nudge, onActionRef.current ? (cta) => onActionRef.current?.(cta) : undefined);
    lastShownThisSessionRef.current = Date.now();
    writeHistory(id, recordNudge(history, nudge.id));
  };

  const checkRef = useRef(check);
  checkRef.current = check;

  // First check once the dashboard has settled, then on the regular interval.
  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(() => void checkRef.current(), FIRST_CHECK_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [active, agentId]);
  usePolling(check, CHECK_INTERVAL_MS, { enabled: active });
}

export default useAgentNudges;
