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

/** One switch read per user per page load, shared by every caller (gate, launcher). */
const inflight = new Map<string, Promise<boolean>>();

function readSwitch(userId: string): Promise<boolean> {
  let pending = inflight.get(userId);
  if (!pending) {
    pending = (async () => {
      try {
        // Not yet in the generated types; the call shape matches the live function.
        const { data, error } = await (supabase.rpc as unknown as (
          fn: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: unknown }>)('feature_preview_on', { p_feature: FUNDERS_UI_V3_FEATURE });
        const next = !error && data === true;
        try {
          if (next) window.localStorage.setItem(cacheKey(userId), '1');
          else window.localStorage.removeItem(cacheKey(userId));
        } catch {
          /* private mode */
        }
        return next;
      } catch {
        return false;
      }
    })();
    inflight.set(userId, pending);
  }
  return pending;
}

export interface FunderUiV3PreviewState {
  /** The switch is on for this viewer (last known answer until the read returns). */
  on: boolean;
  /** The server has answered for this viewer (or there is no viewer). */
  resolved: boolean;
}

/**
 * Whether this viewer has the `funders_ui_v3` preview switch. Default OFF.
 *
 * Reads the existing `feature_preview_on(p_feature)` RPC — the same mechanism as
 * `feature:funders_app_v2`. The last answer is remembered per user (a flag only)
 * so a preview viewer does not see the old screen flash first; any error means
 * OFF. With `network: false` only that remembered flag is used (no RPC), for
 * global UI that must not add a boot request for every user.
 */
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
    void readSwitch(userId).then((on) => {
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
