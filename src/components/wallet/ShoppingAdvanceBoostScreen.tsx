import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShoppingBag, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/businessAdvanceCalculations';

const DURATION_SECONDS = 39;
export const SHOPPING_ADVANCE_MIN = 30_000;
export const SHOPPING_ADVANCE_MAX = 30_000_000;

/**
 * Full-screen notice shown after every send. Message only: it does not
 * create or change any balance, limit or ledger entry.
 */
export function ShoppingAdvanceBoostScreen({
  amountSent,
  onClose,
}: {
  amountSent: number | null;
  onClose: () => void;
}) {
  const [secondsLeft, setSecondsLeft] = useState(DURATION_SECONDS);

  useEffect(() => {
    if (amountSent == null) return;
    setSecondsLeft(DURATION_SECONDS);
    const timer = window.setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          window.clearInterval(timer);
          onClose();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountSent]);

  if (amountSent == null) return null;
  const boost = Math.min(amountSent * 2, SHOPPING_ADVANCE_MAX);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="shopping-advance-title"
      className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-6 bg-primary p-6 text-center text-primary-foreground"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 rounded-full p-2 hover:bg-primary-foreground/10"
      >
        <X className="h-6 w-6" />
      </button>
      <ShoppingBag className="h-16 w-16" aria-hidden />
      <h2 id="shopping-advance-title" className="text-2xl font-bold">
        You have increased your Shopping Advance by
      </h2>
      <p className="text-5xl font-extrabold tracking-tight" aria-live="polite">
        {formatUGX(boost)}
      </p>
      <p className="max-w-sm text-base opacity-90">
        That is 2× the {formatUGX(amountSent)} you just sent.
      </p>
      <div className="max-w-sm rounded-xl bg-primary-foreground/10 p-4 text-sm">
        Every Welile user can access a Shopping Advance from a minimum of{' '}
        <strong>{formatUGX(SHOPPING_ADVANCE_MIN)}</strong> up to a maximum of{' '}
        <strong>{formatUGX(SHOPPING_ADVANCE_MAX)}</strong>.
      </div>
      <Button variant="secondary" onClick={onClose}>
        Continue ({secondsLeft}s)
      </Button>
    </div>,
    document.body,
  );
}
