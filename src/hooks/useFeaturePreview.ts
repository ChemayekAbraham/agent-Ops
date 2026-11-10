import { useContext, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { AuthContext } from '@/hooks/useAuth';

/**
 * Preview switches. `feature_preview_on(p_feature)` (SECURITY DEFINER) is true
 * when `pipeline_switches` has `feature:<p_feature>` on (everyone) or
 * `feature_previews` has a row for the caller with that feature. Default OFF;
 * any error means OFF.
 */
export const FEATURE_FUNDERS_UI_V3 = 'funders_ui_v3';
export const FEATURE_FUNDERS_BOARD_TAGS = 'funders_board_tags';

const cacheKey = (feature: string, userId: string) => `welile.preview.${feature}.${userId}`;

function readCached(feature: string, userId: string | null | undefined): boolean {
  if (!userId) return false;
  try {
    return window.localStorage.getItem(cacheKey(feature, userId)) === '1';
  } catch {
    return false;
  }
}

/** One read per feature per user per page load, shared by every caller. */
const inflight = new Map<string, Promise<boolean>>();

export function readFeaturePreview(feature: string, userId: string): Promise<boolean> {
  const key = `${feature}|${userId}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        // Not in the generated types; the call shape matches the live function.
        const { data, error } = await (supabase.rpc as unknown as (
          fn: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: unknown }>)('feature_preview_on', { p_feature: feature });
        const next = !error && data === true;
        try {
          if (next) window.localStorage.setItem(cacheKey(feature, userId), '1');
          else window.localStorage.removeItem(cacheKey(feature, userId));
        } catch {
          /* private mode */
        }
        return next;
      } catch {
        return false;
      }
    })();
    inflight.set(key, pending);
  }
  return pending;
}

/** Test hook: forget the shared answers. */
export function resetFeaturePreviewCache() {
  inflight.clear();
}

export interface FeaturePreviewState {
  /** The switch is on for this viewer (the remembered answer until the read returns). */
  on: boolean;
  /** The server has answered for this viewer (or there is no viewer). */
  resolved: boolean;
}

/**
 * Whether `feature` is on for this viewer. The last answer is remembered per
 * user (a flag only) so a preview viewer does not see the old UI flash first.
 * With `network: false` only that remembered flag is used (no RPC).
 */
export function useFeaturePreviewState(
  feature: string,
  userId: string | null | undefined,
  { network = true }: { network?: boolean } = {},
): FeaturePreviewState {
  const [state, setState] = useState<FeaturePreviewState>(() => ({ on: readCached(feature, userId), resolved: !userId }));

  useEffect(() => {
    if (!userId) {
      setState({ on: false, resolved: true });
      return;
    }
    setState({ on: readCached(feature, userId), resolved: false });
    if (!network) return;
    let cancelled = false;
    void readFeaturePreview(feature, userId).then((on) => {
      if (!cancelled) setState({ on, resolved: true });
    });
    return () => {
      cancelled = true;
    };
  }, [feature, userId, network]);

  return state;
}

/** Shorthand for the signed-in viewer (AuthContext; no provider means signed out). */
export function useFeaturePreview(feature: string, { enabled = true }: { enabled?: boolean } = {}): boolean {
  const userId = useContext(AuthContext)?.user?.id ?? null;
  return useFeaturePreviewState(feature, enabled ? userId : null).on;
}
