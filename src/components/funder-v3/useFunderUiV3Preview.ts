import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

/** Preview switch name. On for a viewer when `pipeline_switches` has `feature:funders_ui_v3`
 *  on (everyone) or `feature_previews` has a row for them (feature = 'funders_ui_v3'). */
export const FUNDERS_UI_V3_FEATURE = 'funders_ui_v3';

const cacheKey = (userId: string) => `welile.preview.${FUNDERS_UI_V3_FEATURE}.${userId}`;

function readCached(userId: string | null | undefined): boolean {
  if (!userId) return false;
  try {
    return window.localStorage.getItem(cacheKey(userId)) === '1';
  } catch {
    return false;
  }
}

/**
 * Whether this viewer gets the funder V3 dashboard. Default OFF.
 *
 * Reads the existing `feature_preview_on(p_feature)` RPC — the same mechanism as
 * `feature:funders_app_v2`. The last answer is remembered per user (a flag only)
 * so a preview viewer does not see the old screen flash first; any error falls
 * back to OFF, the live dashboard.
 */
export function useFunderUiV3Preview(userId: string | null | undefined): boolean {
  const [on, setOn] = useState(() => readCached(userId));

  useEffect(() => {
    if (!userId) {
      setOn(false);
      return;
    }
    setOn(readCached(userId));
    let cancelled = false;
    void (async () => {
      try {
        // Not yet in the generated types; the call shape matches the live function.
        const { data, error } = await (supabase.rpc as unknown as (
          fn: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: unknown }>)('feature_preview_on', { p_feature: FUNDERS_UI_V3_FEATURE });
        if (cancelled) return;
        const next = !error && data === true;
        setOn(next);
        try {
          if (next) window.localStorage.setItem(cacheKey(userId), '1');
          else window.localStorage.removeItem(cacheKey(userId));
        } catch {
          /* private mode */
        }
      } catch {
        if (!cancelled) setOn(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return on;
}
