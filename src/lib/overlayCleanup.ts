/**
 * Safety net for overlays (Radix Dialog / Sheet) that get unmounted *while
 * still open* — for example when a parent subtree remounts (deferred provider
 * activation, route swap, lazy chunk landing) right after the user opened a
 * sheet.
 *
 * When that happens Radix never runs its own teardown, so the page is left with
 * `body { pointer-events: none }` + the scroll lock and (on slower devices) a
 * frozen, washed-out backdrop. The screen looks "stuck" and nothing is
 * clickable.
 *
 * `releaseOverlayLockIfIdle()` restores the body once no overlay is actually
 * open anymore. It is deliberately conservative: if another dialog/sheet is
 * still mounted and open, it does nothing.
 */
export function releaseOverlayLockIfIdle() {
  if (typeof document === 'undefined') return;

  const stillOpen = document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
  );
  if (stillOpen) return;

  const body = document.body;
  if (!body) return;

  if (body.style.pointerEvents === 'none') body.style.pointerEvents = '';
  if (body.style.overflow === 'hidden') body.style.overflow = '';
  body.removeAttribute('data-scroll-locked');

  // Radix leaves the aria hider behind in the same scenario.
  document
    .querySelectorAll('[aria-hidden="true"][data-aria-hidden]')
    .forEach((el) => {
      el.removeAttribute('aria-hidden');
      el.removeAttribute('data-aria-hidden');
    });

  // Orphaned backdrops from the unmounted overlay.
  document
    .querySelectorAll('[data-radix-popper-content-wrapper]:empty')
    .forEach((el) => el.remove());
}

/** Runs the cleanup on the next frame, after React has flushed the unmount. */
export function scheduleOverlayLockRelease() {
  if (typeof window === 'undefined') return;
  window.requestAnimationFrame(() => {
    releaseOverlayLockIfIdle();
    // A second pass catches Radix teardown that lands one frame later.
    window.setTimeout(releaseOverlayLockIfIdle, 120);
  });
}
