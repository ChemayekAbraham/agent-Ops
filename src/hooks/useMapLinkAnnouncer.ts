import { useCallback, useEffect, useRef } from 'react';

const REGION_ID = 'map-link-live-region';
const DEDUPE_WINDOW_MS = 2000;

// Module-level so dedupe works across every component using this hook.
let lastAnnouncedTitle: string | null = null;
let lastAnnouncedAt = 0;

function ensureLiveRegion(): HTMLElement {
  let el = document.getElementById(REGION_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = REGION_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    el.className = 'sr-only';
    document.body.appendChild(el);
  }
  return el;
}

/**
 * Returns an `announce(title)` callback that posts a polite SR message
 * confirming that a Google Maps link is opening in a new tab.
 */
export function useMapLinkAnnouncer() {
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  return useCallback((title: string) => {
    const now = Date.now();
    if (
      title === lastAnnouncedTitle &&
      now - lastAnnouncedAt < DEDUPE_WINDOW_MS
    ) {
      // Same link re-activated in quick succession — skip duplicate announcement.
      return;
    }
    lastAnnouncedTitle = title;
    lastAnnouncedAt = now;

    const region = ensureLiveRegion();
    region.textContent = '';
    // Force re-announcement even if text is identical.
    window.requestAnimationFrame(() => {
      region.textContent = `Opening ${title} in Google Maps in a new tab`;
    });
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      const r = document.getElementById(REGION_ID);
      if (r) r.textContent = '';
    }, 4000);
  }, []);
}