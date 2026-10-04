import { RefObject, useEffect } from 'react';

/**
 * Wires "/" to focus a search input and "Esc" to clear all filters.
 * - "/" is ignored when the user is already typing in an input/textarea/contenteditable.
 * - "Esc" only clears when something is active (search text or non-default filter).
 * - `enabled` lets sheets bind only while open.
 */
export function useFilterKeyboardShortcuts(opts: {
  inputRef: RefObject<HTMLInputElement>;
  onClear: () => void;
  hasActiveFilter: boolean;
  enabled?: boolean;
}) {
  const { inputRef, onClear, hasActiveFilter, enabled = true } = opts;
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          (t as HTMLElement).isContentEditable);

      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      if (e.key === 'Escape') {
        const isOurInput = t === inputRef.current;
        if (isOurInput || (!typing && hasActiveFilter)) {
          if (hasActiveFilter) {
            e.preventDefault();
            onClear();
            inputRef.current?.blur();
          }
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled, hasActiveFilter, inputRef, onClear]);
}