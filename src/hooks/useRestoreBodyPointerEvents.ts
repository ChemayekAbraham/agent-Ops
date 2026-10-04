import { useEffect } from 'react';

/**
 * Fixes the Radix stacked-modal freeze.
 *
 * Radix sets `pointer-events: none` on <body> while a modal layer is open and
 * restores the previous value on close. When two modal layers are stacked
 * (e.g. a confirm AlertDialog opened over a Dialog) Radix can capture the
 * wrong "original" value and leave <body> stuck at `none` after BOTH layers
 * close — which makes the whole screen unclickable (a "frozen" screen).
 *
 * The same bug also strikes WHILE a dialog is still open: a Radix Select,
 * DropdownMenu or nested AlertDialog rendered inside the dialog toggles the
 * body lock, and on touch devices the restore can race and leave <body> stuck
 * at `none`. The dialog then *looks* fine but every tap dies before it reaches
 * a button — e.g. an agent taps "Submit Request" and nothing happens, no error
 * (the click never fires the handler).
 *
 * So this hook does two things:
 *  1. While mounted, it runs a live watchdog that clears a stuck body lock
 *     whenever no Radix popper/select/dropdown or nested alert-dialog is
 *     legitimately open. This is safe because our DialogContent always renders
 *     a full-screen Overlay that guards the background regardless.
 *  2. On unmount it clears the stuck value once no modal remains open.
 * Both resets are deferred a tick so they run after Radix's own synchronous
 * cleanup and win the race.
 */
export function useRestoreBodyPointerEvents() {
  useEffect(() => {
    if (typeof document === 'undefined') return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    // A genuinely-open Select / dropdown / popover / nested confirm dialog
    // still needs the body lock. We must NOT treat the host [role="dialog"]
    // as a blocker (it is always open here) — its interactivity comes from the
    // Overlay + Content layering, not the body lock.
    const lockStillNeeded = () =>
      !!document.querySelector(
        '[data-radix-popper-content-wrapper], [role="alertdialog"][data-state="open"]',
      );

    const unstick = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (
          document.body.style.pointerEvents === 'none' &&
          !lockStillNeeded()
        ) {
          document.body.style.pointerEvents = '';
        }
      }, 60);
    };

    // Re-check after every interaction (covers the touchend restore race) and
    // whenever something mutates the body's inline style.
    document.addEventListener('pointerup', unstick, true);
    document.addEventListener('touchend', unstick, true);
    const observer = new MutationObserver(unstick);
    observer.observe(document.body, { attributes: true, attributeFilter: ['style'] });

    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('pointerup', unstick, true);
      document.removeEventListener('touchend', unstick, true);
      observer.disconnect();
      setTimeout(() => {
        if (typeof document === 'undefined') return;
        const stillOpen = document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        );
        if (!stillOpen && document.body.style.pointerEvents === 'none') {
          document.body.style.pointerEvents = '';
        }
      }, 0);
    };
  }, []);
}
