import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

/**
 * One open budget cycle the signed-in user still owes a submission for, as an
 * active designated head of a department that cycle targets.
 */
export interface BudgetObligation {
  call_id: string;
  cycle_title: string;
  deadline: string | null;
  department_id: string;
  department_name: string;
  department_key: string;
  /** Existing draft for this cycle+department, so the action resumes it rather than starting a second one. */
  draft_submission_id: string | null;
  is_overdue: boolean;
}

export const BUDGET_GATE_QUERY_KEY = 'budget-outstanding-obligations';

const SKIP_STORAGE_KEY = 'welile.budgetGate.skipped';

/**
 * In-memory mirror of the session skip set.
 *
 * sessionStorage throws in some contexts (private browsing, blocked site data,
 * embedded webviews). If a skip failed to persist there, the prompt would
 * reappear on the very next render and the user could never get past it. This
 * module-level fallback guarantees "Skip for Now" always works for the lifetime
 * of the page, storage or no storage.
 */
const memorySkips = new Set<string>();

/** Skip is scoped to user + cycle + department, so skipping one obligation never hides another, and a newly opened cycle still prompts. */
function skipKey(userId: string, o: BudgetObligation) {
  return `${userId}:${o.call_id}:${o.department_id}`;
}

function readSkips(): Set<string> {
  const out = new Set(memorySkips);
  try {
    const raw = sessionStorage.getItem(SKIP_STORAGE_KEY);
    if (raw) for (const k of JSON.parse(raw) as string[]) out.add(k);
  } catch {
    /* storage unavailable - the in-memory set still applies */
  }
  return out;
}

function writeSkip(key: string) {
  memorySkips.add(key);
  try {
    const raw = sessionStorage.getItem(SKIP_STORAGE_KEY);
    const list = raw ? (JSON.parse(raw) as string[]) : [];
    if (!list.includes(key)) {
      list.push(key);
      sessionStorage.setItem(SKIP_STORAGE_KEY, JSON.stringify(list));
    }
  } catch {
    /* storage unavailable - in-memory skip is enough for this page lifetime */
  }
}

/**
 * Authoritative state for the mandatory budget-submission prompt.
 *
 * The obligation itself comes entirely from
 * `budget_my_outstanding_obligations`, a SECURITY DEFINER RPC that reads
 * `auth.uid()` and takes no arguments. There is no client-held flag that can
 * mark an obligation complete, so a refresh, a direct route, or signing out and
 * back in re-derives the same state from the database.
 *
 * "Skip for Now" is a PRESENTATION-ONLY, PER-SESSION dismissal. It suppresses
 * the full-screen prompt and nothing else:
 *   * the obligation stays outstanding in the database,
 *   * no submission is created and no status is altered,
 *   * `obligation` keeps being returned, so the notification bell and any
 *     deep-link continue to offer the path to complete it.
 *
 * It is held in sessionStorage rather than localStorage on purpose: a skip must
 * survive route changes and re-renders within the session (so the user is not
 * interrupted repeatedly) but must NOT survive into a new session, which would
 * amount to the permanent "don't remind me again" bypass that is explicitly out
 * of scope.
 *
 * FAILS OPEN, DELIBERATELY. While loading, or if the query errors,
 * `shouldPrompt` is false and the caller must render the application normally.
 * A transient network error must never wall a user off from every page.
 */
export function useBudgetSubmissionGate() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  // Bumped by skip() purely to re-read the skip set and re-render.
  const [skipVersion, setSkipVersion] = useState(0);

  const { data, isLoading, isError } = useQuery({
    queryKey: [BUDGET_GATE_QUERY_KEY, user?.id],
    enabled: !!user?.id,
    queryFn: async (): Promise<BudgetObligation[]> => {
      const { data, error } = await supabase.rpc('budget_my_outstanding_obligations' as any);
      if (error) throw error;
      return (data ?? []) as BudgetObligation[];
    },
    // The prompt must clear promptly once the budget is submitted, and pick up
    // a newly opened cycle without a full reload.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    // Never retry into a blocked state; fail open fast instead.
    retry: 1,
  });

  const obligations = data ?? [];
  /** Most urgent outstanding obligation (earliest deadline first), or null. Independent of skip. */
  const obligation = obligations.length > 0 ? obligations[0] : null;

  const skipped = (() => {
    if (!user?.id || !obligation) return false;
    void skipVersion; // re-evaluate after a skip
    return readSkips().has(skipKey(user.id, obligation));
  })();

  /** Temporarily dismiss the full-screen prompt for this session. Does not touch the obligation. */
  const skip = useCallback(() => {
    if (!user?.id || !obligation) return;
    writeSkip(skipKey(user.id, obligation));
    setSkipVersion(v => v + 1);
  }, [user?.id, obligation]);

  /** Call after a successful submission so the obligation is re-evaluated server-side. */
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [BUDGET_GATE_QUERY_KEY, user?.id] });
  }, [queryClient, user?.id]);

  return {
    /** Authoritative outstanding obligation, still returned after a skip so the bell can link to it. */
    obligation,
    obligations,
    /** True when the full-screen prompt should render: authoritative obligation exists and has not been skipped this session. */
    shouldPrompt: !isLoading && !isError && !!obligation && !skipped,
    /** True when there is a real outstanding obligation, regardless of skip. Use for the bell's required-action state. */
    hasOutstanding: !isLoading && !isError && !!obligation,
    /** Whether the current obligation was skipped in this session. */
    isSkipped: skipped,
    isLoading,
    isError,
    skip,
    refresh,
  };
}

export default useBudgetSubmissionGate;
