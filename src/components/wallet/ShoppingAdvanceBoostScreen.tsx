import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShoppingBag, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/businessAdvanceCalculations';

const DURATION_SECONDS = 39;
export const SHOPPING_ADVANCE_MIN = 30_000;
export const SHOPPING_ADVANCE_MAX = 30_000_000;

/**
 * Speaking every second would talk over itself, so the remaining-time label
 * fires when the notice opens, every tenth second, and through the final five.
 */
function isAnnouncePoint(secondsLeft: number) {
  return (
    secondsLeft === DURATION_SECONDS || secondsLeft % 10 === 0 || secondsLeft <= 5
  );
}

function closingInText(secondsLeft: number) {
  return `This message closes in ${secondsLeft} ${secondsLeft === 1 ? 'second' : 'seconds'}.`;
}

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
  const [announcement, setAnnouncement] = useState('');

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

  useEffect(() => {
    if (amountSent == null) return;
    if (isAnnouncePoint(secondsLeft)) setAnnouncement(closingInText(secondsLeft));
  }, [amountSent, secondsLeft]);

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
      <div
        role="progressbar"
        aria-label="Time remaining before this message closes"
        aria-valuemin={0}
        aria-valuemax={DURATION_SECONDS}
        aria-valuenow={secondsLeft}
        aria-valuetext={`${secondsLeft} of ${DURATION_SECONDS} seconds remaining`}
        className="h-2 w-full max-w-sm overflow-hidden rounded-full bg-primary-foreground/25"
      >
        <div
          className="h-full rounded-full bg-primary-foreground transition-[width] duration-1000 ease-linear motion-reduce:transition-none"
          style={{ width: `${(secondsLeft / DURATION_SECONDS) * 100}%` }}
        />
      </div>
      {/* A progressbar is not a live region, so its own value text is not
          reliably spoken aloud. This visually-hidden status carries the same
          remaining-time figure for screen-reader users. role="status" already
          announces politely, so no extra aria-live is needed. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <Button variant="secondary" onClick={onClose}>
        Continue ({secondsLeft}s)
      </Button>
    </div>,
    document.body,
  );
}
