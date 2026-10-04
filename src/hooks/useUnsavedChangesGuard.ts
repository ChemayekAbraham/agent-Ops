import { useEffect } from 'react';

/**
 * Global registry of "is this form currently dirty?" getters.
 *
 * Any form can register a getter via `useUnsavedChangesGuard(isDirty)`.
 * Navigation surfaces (the global agent Back pill, hardware Back) consult
 * `confirmDiscardIfDirty()` before performing a destructive navigation.
 *
 * Kept outside React state on purpose so it survives renders and is cheap
 * to read from imperative event handlers (popstate, touchend, etc.).
 */
type DirtyGetter = () => boolean;
const dirtyGetters = new Set<DirtyGetter>();

export function registerDirtyGetter(getter: DirtyGetter): () => void {
  dirtyGetters.add(getter);
  return () => {
    dirtyGetters.delete(getter);
  };
}

export function hasAnyUnsavedChanges(): boolean {
  for (const get of dirtyGetters) {
    try {
      if (get()) return true;
    } catch {
      /* ignore broken getter */
    }
  }
  return false;
}

/**
 * Returns true when it's safe to navigate away. If any registered form is
 * dirty, prompts the user with a native confirm and respects their choice.
 *
 * Native `window.confirm` is used intentionally: it's synchronous, works
 * inside popstate / touchend handlers without races, and matches the OS
 * Back gesture's "interrupt and ask" expectation on mobile.
 */
export function confirmDiscardIfDirty(
  message = 'You have unsaved changes. Leave this screen and discard them?',
): boolean {
  if (!hasAnyUnsavedChanges()) return true;
  // eslint-disable-next-line no-alert
  return window.confirm(message);
}

/**
 * Register `isDirty` for the lifetime of the component. The latest value
 * wins because we re-register on every change.
 */
export function useUnsavedChangesGuard(isDirty: boolean | (() => boolean)) {
  useEffect(() => {
    const getter: DirtyGetter = typeof isDirty === 'function' ? isDirty : () => isDirty;
    return registerDirtyGetter(getter);
  }, [isDirty]);
}
