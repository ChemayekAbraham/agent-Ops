import { useCallback, useRef, useState } from "react";

/**
 * useIdempotentSubmit
 * --------------------
 * Single-flight submit guard for forms that mutate money / state.
 *
 * Protects against:
 *  - Double-clicks on slow 3G (button taps before React paints `disabled`)
 *  - "Retry" key spam after a network hang
 *  - Re-renders that re-fire the same submit handler
 *
 * Provides an `idempotency_key` (UUID v4) per logical submission attempt so
 * the server can dedupe identical retried requests if it stores the key.
 * The key only rotates after a successful submit (or explicit `reset()`),
 * so if a request fails and the user retries, the SAME key is replayed —
 * which is the whole point of an idempotency token.
 *
 * Usage:
 *   const { submit, isSubmitting, idempotencyKey, reset } = useIdempotentSubmit();
 *   await submit(async (key) => { await api.post(..., { idempotency_key: key }); });
 */

const newKey = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for very old browsers
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

export interface UseIdempotentSubmitOptions {
  /** Cooldown (ms) after a successful submit before another can fire. Default: 1500 */
  cooldownMs?: number;
}

export function useIdempotentSubmit(opts: UseIdempotentSubmitOptions = {}) {
  const { cooldownMs = 1500 } = opts;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const lockRef = useRef(false);
  const keyRef = useRef<string>(newKey());
  const lastSuccessAtRef = useRef<number>(0);

  const reset = useCallback(() => {
    keyRef.current = newKey();
    lockRef.current = false;
    setIsSubmitting(false);
  }, []);

  const submit = useCallback(
    async <T>(fn: (idempotencyKey: string) => Promise<T>): Promise<T | undefined> => {
      // Hard lock — prevents double-click race even before React paints
      if (lockRef.current) return undefined;
      // Cooldown after a successful submit
      if (Date.now() - lastSuccessAtRef.current < cooldownMs) return undefined;

      lockRef.current = true;
      setIsSubmitting(true);
      try {
        const result = await fn(keyRef.current);
        lastSuccessAtRef.current = Date.now();
        // Rotate key only on success — failed attempts must replay the same key
        keyRef.current = newKey();
        return result;
      } finally {
        lockRef.current = false;
        setIsSubmitting(false);
      }
    },
    [cooldownMs],
  );

  return {
    submit,
    isSubmitting,
    idempotencyKey: keyRef.current,
    reset,
  };
}