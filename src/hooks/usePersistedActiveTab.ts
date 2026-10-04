import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';

/**
 * Persists the active sidebar tab per (role, route) so a refresh restores the
 * exact submenu the user was on. Different roles or routes get isolated memory
 * (e.g. CFO on /cfo/dashboard vs admin on /admin/dashboard).
 *
 * The active section is ALSO reflected in the URL as a `?section=<id>` query
 * param, so deep links survive refresh and are shareable — opening a shared
 * link lands the recipient on the same breadcrumb path. The default tab is
 * represented by the absence of the param (clean URLs). Resolution order on
 * load: URL param → localStorage → defaultTab.
 *
 * Falls back to `defaultTab` when storage is unavailable or empty.
 *
 * Pass `validTabs` to harden against invalid/stale deep links: any `?section=`
 * value (or stored value) that isn't in the allowlist is silently coerced to
 * `defaultTab`, so the user always lands on a valid section without errors and
 * the bad param is scrubbed from the URL.
 */
export function usePersistedActiveTab(
  role: string,
  defaultTab = 'overview',
  validTabs?: readonly string[],
) {
  const { pathname } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const storageKey = `dashboard:${role}:${pathname}:activeTab`;

  // When an allowlist is supplied, anything outside it (incl. typos, removed
  // sections, or hand-edited URLs) resolves to the default section.
  const isValid = useCallback(
    (tab: string | null | undefined): tab is string => {
      if (!tab) return false;
      if (tab === defaultTab) return true;
      if (!validTabs) return true; // no allowlist => accept any non-empty value
      return validTabs.includes(tab);
    },
    [defaultTab, validTabs],
  );

  const [activeTab, setActiveTabState] = useState<string>(() => {
    // URL wins so deep links / refresh restore the exact section.
    const fromUrl = searchParams.get('section');
    if (isValid(fromUrl)) return fromUrl;
    if (typeof window === 'undefined') return defaultTab;
    try {
      const stored = window.localStorage.getItem(storageKey);
      return isValid(stored) ? stored : defaultTab;
    } catch {
      return defaultTab;
    }
  });

  const setActiveTab = useCallback(
    (tab: string) => {
      const next = isValid(tab) ? tab : defaultTab;
      setActiveTabState(next);
      try {
        window.localStorage.setItem(storageKey, next);
      } catch {
        /* storage unavailable */
      }
      // Reflect into the URL (replace — don't spam history). The default tab is
      // the bare URL with no `section` param.
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === defaultTab) params.delete('section');
          else params.set('section', next);
          return params;
        },
        { replace: true },
      );
    },
    [storageKey, defaultTab, setSearchParams, isValid],
  );

  /**
   * On mount, if we restored a non-default section from storage but the URL has
   * no `section` param, write it once so a subsequent refresh / copy-link keeps
   * the deep link intact.
   */
  const didInitUrl = useRef(false);
  useEffect(() => {
    if (didInitUrl.current) return;
    didInitUrl.current = true;
    const urlSection = searchParams.get('section');
    // Scrub an invalid/stale `?section=` value from the URL on first load.
    if (urlSection && !isValid(urlSection)) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('section');
          return next;
        },
        { replace: true },
      );
    } else if (!urlSection && activeTab !== defaultTab) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('section', activeTab);
          return next;
        },
        { replace: true },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * React to external URL changes (browser back/forward, incoming shared link
   * navigations) by mirroring the `section` param into state + storage.
   */
  useEffect(() => {
    const raw = searchParams.get('section');
    const fromUrl = isValid(raw) ? (raw as string) : defaultTab;
    setActiveTabState((prev) => {
      if (prev === fromUrl) return prev;
      try {
        window.localStorage.setItem(storageKey, fromUrl);
      } catch {
        /* storage unavailable */
      }
      return fromUrl;
    });
  }, [searchParams, defaultTab, storageKey, isValid]);

  /**
   * Cross-tab sync: when another tab writes to the same storage key (or the
   * Reset button removes it), mirror the change here. The native `storage`
   * event only fires in OTHER tabs, so this never causes a feedback loop.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: StorageEvent) => {
      if (e.storageArea !== window.localStorage) return;
      if (e.key !== storageKey) return;
      setActiveTabState(isValid(e.newValue) ? (e.newValue as string) : defaultTab);
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [storageKey, defaultTab, isValid]);

  return [activeTab, setActiveTab] as const;
}
