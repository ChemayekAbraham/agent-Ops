/**
 * Global back-gesture stack.
 *
 * Bridges the browser's history navigation (Android hardware back button,
 * iOS edge-swipe-to-go-back, browser back button, PWA back gesture) with
 * in-app overlays (Dialog, Sheet, Drawer, AlertDialog).
 *
 * When an overlay opens we push a sentinel history entry and register an
 * `onClose` callback. A single global `popstate` listener pops the topmost
 * registered overlay instead of letting the browser navigate the route — so
 * the back gesture closes the open sheet/dialog first, just like a native app.
 *
 * If the overlay is closed via UI (X button, Esc, click outside) we silently
 * unwind the sentinel history entry so the user doesn't have to press back
 * twice to actually leave the page.
 */

const STATE_KEY = "__welile_overlay__";

type Entry = {
  id: number;
  close: () => void;
  popped: boolean;
};

const stack: Entry[] = [];
let idCounter = 0;
let initialized = false;
let suppressNext = 0;

function init() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  window.addEventListener("popstate", () => {
    // Sentinel `history.back()` calls we triggered ourselves — ignore.
    if (suppressNext > 0) {
      suppressNext--;
      return;
    }

    const entry = stack[stack.length - 1];
    if (!entry) return; // nothing open → let the browser navigate normally

    stack.pop();
    entry.popped = true;
    try {
      entry.close();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[backStack] close handler threw", err);
    }
  });
}

export function pushBackEntry(close: () => void): Entry | null {
  if (typeof window === "undefined") return null;
  init();
  const id = ++idCounter;
  const entry: Entry = { id, close, popped: false };
  stack.push(entry);
  try {
    window.history.pushState({ [STATE_KEY]: id }, "");
  } catch {
    // ignore — some embedded webviews block pushState
  }
  return entry;
}

export function popBackEntry(entry: Entry | null) {
  if (!entry || typeof window === "undefined") return;
  const idx = stack.indexOf(entry);
  if (idx === -1) return;
  stack.splice(idx, 1);
  if (entry.popped) return; // already removed via popstate
  entry.popped = true;

  // Only unwind history if our sentinel is still the current entry.
  // (If the user navigated to a new route while the overlay was open the
  // sentinel has been superseded — calling back() would jump too far.)
  const state = window.history.state as Record<string, unknown> | null;
  if (state && state[STATE_KEY] === entry.id) {
    suppressNext++;
    try {
      window.history.back();
    } catch {
      suppressNext = Math.max(0, suppressNext - 1);
    }
  }
}