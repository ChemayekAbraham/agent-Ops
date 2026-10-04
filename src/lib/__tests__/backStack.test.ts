import { describe, it, expect, beforeEach, vi } from 'vitest';

// The backStack module holds singleton state (the overlay stack and a
// `suppressNext` counter that tracks the sentinel `history.back()` calls
// it makes itself). Re-import a fresh copy per test so leftovers from
// one scenario can't bleed into the next.
let pushBackEntry: typeof import('@/lib/backStack').pushBackEntry;
let popBackEntry: typeof import('@/lib/backStack').popBackEntry;

/**
 * Verifies the global back-gesture stack used by every overlay (Dialog,
 * Sheet, AlertDialog, Drawer) so the Android hardware Back button — and
 * iOS edge-swipe — closes overlays in LIFO order instead of navigating
 * the route.
 */
describe('backStack — stacked overlay Back handling', () => {
  beforeEach(async () => {
    vi.resetModules();
    window.history.replaceState(null, '');
    const mod = await import('@/lib/backStack');
    pushBackEntry = mod.pushBackEntry;
    popBackEntry = mod.popBackEntry;
  });

  it('pushes a sentinel history entry per overlay opened', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');
    const a = pushBackEntry(() => {});
    const b = pushBackEntry(() => {});
    expect(pushSpy).toHaveBeenCalledTimes(2);
    pushSpy.mockRestore();
    // Tests are isolated via vi.resetModules — no shared-state cleanup needed.
    void a; void b;
  });

  it('closes only the topmost overlay on a single Back press (LIFO)', () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    const closeC = vi.fn();

    const a = pushBackEntry(closeA);
    const b = pushBackEntry(closeB);
    const c = pushBackEntry(closeC);

    // One hardware Back → only the most recently opened overlay closes.
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(closeC).toHaveBeenCalledTimes(1);
    expect(closeB).not.toHaveBeenCalled();
    expect(closeA).not.toHaveBeenCalled();

    // Next Back → middle overlay closes.
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(closeA).not.toHaveBeenCalled();

    // Final Back → bottom overlay closes; stack is now empty.
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(closeA).toHaveBeenCalledTimes(1);

    // Entries are gone — popBackEntry is a no-op and shouldn't crash.
    popBackEntry(a);
    popBackEntry(b);
    popBackEntry(c);
  });

  it('lets the browser navigate normally once all overlays are closed', () => {
    const closeA = vi.fn();
    const a = pushBackEntry(closeA);

    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(closeA).toHaveBeenCalledTimes(1);

    // No overlays left — a subsequent popstate must NOT throw and must
    // not invoke any handler (the route is allowed to change).
    expect(() => window.dispatchEvent(new PopStateEvent('popstate'))).not.toThrow();
    expect(closeA).toHaveBeenCalledTimes(1);

    popBackEntry(a);
  });

  it('UI-driven close (X / Esc / outside click) unwinds without invoking close again', () => {
    const closeA = vi.fn();
    const closeB = vi.fn();

    const a = pushBackEntry(closeA);
    const b = pushBackEntry(closeB);

    // User dismisses the TOP overlay via its X button — popBackEntry is
    // called directly, the close handler must not fire (UI already closed
    // it) and the sentinel history entry must be unwound silently.
    popBackEntry(b);
    expect(closeB).not.toHaveBeenCalled();

    // Hardware Back should now target the remaining overlay (A), never
    // the already-dismissed one (B). We fire popstate events until the
    // remaining handler runs — backStack swallows one popstate per
    // sentinel `history.back()` it issued to unwind B, so the *next*
    // real Back press is what reaches A.
    for (let i = 0; i < 3 && closeA.mock.calls.length === 0; i++) {
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).not.toHaveBeenCalled();

    popBackEntry(a);
  });

  it('handles UI-closing a MIDDLE overlay while others remain stacked', () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    const closeC = vi.fn();

    const a = pushBackEntry(closeA);
    const b = pushBackEntry(closeB);
    const c = pushBackEntry(closeC);

    // Middle overlay closes itself via UI (e.g. its own action button).
    popBackEntry(b);
    expect(closeB).not.toHaveBeenCalled();

    // Back still targets the topmost remaining overlay (C), then A.
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(closeC).toHaveBeenCalledTimes(1);
    expect(closeA).not.toHaveBeenCalled();

    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(closeA).toHaveBeenCalledTimes(1);

    popBackEntry(a);
    popBackEntry(c);
  });
});
