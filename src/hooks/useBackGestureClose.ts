import * as React from "react";
import { popBackEntry, pushBackEntry } from "@/lib/backStack";

/**
 * Wires an overlay's open/close state into the global back-gesture stack so
 * the Android hardware back button and iOS edge-swipe-back close the overlay
 * instead of navigating away from the current route.
 */
export function useBackGestureClose(open: boolean, onClose: () => void) {
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  React.useEffect(() => {
    if (!open) return;
    const entry = pushBackEntry(() => onCloseRef.current?.());
    return () => popBackEntry(entry);
  }, [open]);
}

/**
 * Helper that adapts Radix-style `open / defaultOpen / onOpenChange` props to
 * `useBackGestureClose`. Returns the props to spread onto the primitive Root.
 */
export function useBackAwareOpenState<T extends {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}>(props: T) {
  const { open, defaultOpen, onOpenChange, ...rest } = props;
  const isControlled = open !== undefined;
  const [internalOpen, setInternalOpen] = React.useState<boolean>(!!defaultOpen);
  const isOpen = isControlled ? !!open : internalOpen;

  const handleChange = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  useBackGestureClose(isOpen, () => handleChange(false));

  return {
    rootProps: { open: isOpen, onOpenChange: handleChange },
    rest: rest as Omit<T, "open" | "defaultOpen" | "onOpenChange">,
  };
}