import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export type A11ySize = 0 | 1 | 2; // 0 = M, 1 = L, 2 = XL

const LS_MODE = 'welile_statement_a11y';
const LS_SIZE = 'welile_statement_a11y_size';

const scaleFor = (s: A11ySize) => (s === 2 ? 1.3 : s === 1 ? 1.15 : 1);
const sizeLabel = (s: A11ySize) =>
  s === 2 ? 'Extra-large' : s === 1 ? 'Large' : 'Medium';

const LIVE_REGION_ID = 'welile-easy-read-live';

/** Lazily create (and reuse) a singleton aria-live region on <body>. */
function getLiveRegion(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById(LIVE_REGION_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = LIVE_REGION_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    // Visually hidden, screen-reader only
    el.style.cssText =
      'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;';
    document.body.appendChild(el);
  }
  return el;
}

function announce(message: string) {
  const el = getLiveRegion();
  if (!el) return;
  // Re-trigger announcement even if message text is identical
  el.textContent = '';
  // Microtask flush so SR notices the change
  window.setTimeout(() => { el.textContent = message; }, 30);
}

/**
 * Shared easy-read accessibility mode for wallet + receipt surfaces.
 * Toggles `.a11y-large` on <body> and sets `--a11y-scale`, so the styles in
 * index.css cascade uniformly to every wallet/receipt/dialog descendant.
 *
 * The boolean ON/OFF is persisted per-user via `profiles.prefers_easy_read`
 * (cross-device). The size step persists locally for snappy mobile fine-tuning.
 */
export function useEasyReadMode() {
  const { user } = useAuth();

  const [enabled, setEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_MODE) === '1'; } catch { return false; }
  });
  const [size, setSize] = useState<A11ySize>(() => {
    try {
      const n = parseInt(localStorage.getItem(LS_SIZE) ?? '0', 10);
      return (n === 1 || n === 2) ? (n as A11ySize) : 0;
    } catch { return 0; }
  });
  const [hydrated, setHydrated] = useState(false);
  // Track whether the current change came from the user (vs. initial hydrate)
  // so we only announce in response to deliberate actions.
  const userInitiatedRef = useRef(false);

  // Hydrate from server-side preference.
  useEffect(() => {
    if (!user) { setHydrated(true); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('profiles')
        .select('prefers_easy_read, easy_read_size')
        .eq('id', user.id)
        .maybeSingle();
      if (cancelled) return;
      if (data && typeof (data as any).prefers_easy_read === 'boolean') {
        setEnabled((data as any).prefers_easy_read);
      }
      const srvSize = (data as any)?.easy_read_size;
      if (srvSize === 0 || srvSize === 1 || srvSize === 2) {
        setSize(srvSize as A11ySize);
      }
      setHydrated(true);
    })();
    return () => { cancelled = true; };
  }, [user]);

  // Apply to <body> and persist.
  useEffect(() => {
    const body = document.body;
    if (enabled) {
      body.classList.add('a11y-large');
      body.style.setProperty('--a11y-scale', String(scaleFor(size)));
    } else {
      body.classList.remove('a11y-large');
      body.style.removeProperty('--a11y-scale');
    }
    try { localStorage.setItem(LS_MODE, enabled ? '1' : '0'); } catch {}
    try { localStorage.setItem(LS_SIZE, String(size)); } catch {}

    if (user && hydrated) {
      supabase
        .from('profiles')
        .update({ prefers_easy_read: enabled, easy_read_size: size })
        .eq('id', user.id)
        .then(({ error }) => {
          if (error) console.error('[useEasyReadMode] save pref', error);
        });
    }
  }, [enabled, size, user, hydrated]);

  // Announce size changes to screen readers (only on user-driven changes).
  useEffect(() => {
    if (!hydrated || !userInitiatedRef.current) return;
    if (enabled) {
      announce(`Easy-read text size set to ${sizeLabel(size)}.`);
    }
  }, [size, hydrated, enabled]);

  // Announce on/off toggle.
  useEffect(() => {
    if (!hydrated || !userInitiatedRef.current) return;
    announce(
      enabled
        ? `Easy-read mode on. Text size ${sizeLabel(size)}.`
        : 'Easy-read mode off.'
    );
    // size intentionally omitted to avoid double-announce with size effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, hydrated]);

  const toggle = useCallback(() => {
    userInitiatedRef.current = true;
    setEnabled(v => !v);
  }, []);

  const setSizeAnnounced = useCallback((s: A11ySize) => {
    userInitiatedRef.current = true;
    setSize(s);
  }, []);

  const setEnabledAnnounced = useCallback((v: boolean) => {
    userInitiatedRef.current = true;
    setEnabled(v);
  }, []);

  return {
    enabled,
    setEnabled: setEnabledAnnounced,
    toggle,
    size,
    setSize: setSizeAnnounced,
    hydrated,
  };
}