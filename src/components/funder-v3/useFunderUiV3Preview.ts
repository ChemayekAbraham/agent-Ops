import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { FEATURE_FUNDERS_UI_V3, type FeaturePreviewState } from '@/hooks/useFeaturePreview';

/** Preview switch name for the funder V3 dashboard. */
export const FUNDERS_UI_V3_FEATURE = FEATURE_FUNDERS_UI_V3;

export type FunderUiV3PreviewState = FeaturePreviewState;

/*
 * Funder V3 is a PERSONAL preview only (decided 12 Nov 2026, Timothy Kalyango).
 *
 * The generic preview check (feature_preview_on) also turns a feature on for everyone when
 * pipeline_switches 'feature:funders_ui_v3' is on. For the funder dashboard that global switch
 * is deliberately ignored: every funder keeps the live SupporterDashboard, and only people with
 * their own row in feature_previews (feature = 'funders_ui_v3') see V3. RLS lets each user
 * read only their own preview rows (policy feature_previews_own).
 */

// Own cache key: an older '1' cached from the global switch must not flash V3 on load.
const cacheKey = (userId: string) => `feature-preview-personal:${FEATURE_FUNDERS_UI_V3}:${userId}`;

function readCached(userId: string | null | undefined): boolean {
  if (!userId) return false;
  try {
    return window.localStorage.getItem(cacheKey(userId)) === '1';
  } catch {
    return false;
  }
}

/** One read per user per page load, shared by every caller (gate and toolbar). */
const inflight = new Map<string, Promise<boolean>>();

function readPersonalPreview(userId: string): Promise<boolean> {
  let pending = inflight.get(userId);
  if (!pending) {
    pending = (async () => {
      try {
        // feature_previews is not in the generated types; the shape matches the live table.
        const { data, error } = await (supabase as unknown as {
          from: (t: string) => {
            select: (c: string) => {
              eq: (k: string, v: string) => {
                eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: unknown; error: unknown }> };
              };
            };
          };
        }).from('feature_previews').select('feature').eq('feature', FEATURE_FUNDERS_UI_V3).eq('user_id', userId).maybeSingle();
        const on = !error && !!data;
        try {
          if (on) window.localStorage.setItem(cacheKey(userId), '1');
          else window.localStorage.removeItem(cacheKey(userId));
        } catch {
          /* private mode */
        }
        return on;
      } catch {
        return false;
      }
    })();
    inflight.set(userId, pending);
  }
  return pending;
}

/** Whether this viewer has their own `funders_ui_v3` preview. Default OFF; the global switch is ignored. */
export function useFunderUiV3PreviewState(
  userId: string | null | undefined,
  { network = true }: { network?: boolean } = {},
): FunderUiV3PreviewState {
  const [state, setState] = useState<FunderUiV3PreviewState>(() => ({ on: readCached(userId), resolved: !userId }));

  useEffect(() => {
    if (!userId) {
      setState({ on: false, resolved: true });
      return;
    }
    setState({ on: readCached(userId), resolved: false });
    if (!network) return;
    let cancelled = false;
    void readPersonalPreview(userId).then((on) => {
      if (!cancelled) setState({ on, resolved: true });
    });
    return () => {
      cancelled = true;
    };
  }, [userId, network]);

  return state;
}

/** Shorthand: just the on/off answer. */
export function useFunderUiV3Preview(userId: string | null | undefined): boolean {
  return useFunderUiV3PreviewState(userId).on;
}
