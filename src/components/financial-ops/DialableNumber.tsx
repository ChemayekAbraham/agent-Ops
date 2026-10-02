import type { MouseEvent, ReactNode } from 'react';
import { toUgandaE164 } from '@/lib/ugandaPhone';
import { cn } from '@/lib/utils';

/**
 * Presentation-only helper that turns a phone number already shown on an email
 * row into a tappable link that opens the phone's dialer.
 *
 * It never rewrites the displayed copy: the number is rendered exactly as the
 * email stored it (`0756…`, `+256756…`, `256756…`), and the `tel:` href is
 * built from the same digits the platform's own validator resolves, so every
 * stored shape lands on the identical `tel:+256…` target. Text with no dialable
 * number renders as the plain text it was before — no link, no wrapper.
 */

/**
 * A Ugandan mobile number as it is printed inside email rows: local (`0756…`),
 * international (`+256756…` / `256756…`) or bare, including the spacing and
 * hyphens the SMS relays emit. The second digit is 3-9 so every network the
 * platform accepts (MTN, Airtel, Telecel) is dialable.
 */
const PHONE_IN_TEXT = /(?:\+?256|0)\s*[3-9]\d{2}[\s-]?\d{3}[\s-]?\d{3}/g;

/** `tel:` href for the first dialable number in the text, or null when none. */
export function dialHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  for (const match of raw.matchAll(PHONE_IN_TEXT)) {
    const e164 = toUgandaE164(match[0]);
    if (e164) return `tel:+${e164}`;
  }
  return null;
}

/**
 * A tap on the number must reach the dialer only — it must never also open or
 * select the email row behind it. The default action is left intact so the
 * device still handles the `tel:` link; on a desktop with no dialer the click
 * simply resolves and nothing changes.
 */
function dialOnly(event: MouseEvent<HTMLAnchorElement>) {
  event.stopPropagation();
}

/**
 * Subtle inline number styling, plus an invisible hit area that extends well
 * past the glyphs so the dialer is reachable with a thumb without the row
 * growing taller or the text shifting.
 */
const DIAL_CLASSES = cn(
  'relative inline-flex items-center rounded-[3px]',
  'underline decoration-dotted decoration-1 underline-offset-2',
  'transition-colors hover:text-primary',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  'touch-manipulation',
  "before:absolute before:-inset-y-[14px] before:-inset-x-2 before:content-['']",
);

interface DialableNumberProps {
  /** The text exactly as it is displayed today — never rewritten. */
  text: string | null | undefined;
  /** Extra classes for a revealed link. Plain text is untouched. */
  className?: string;
}

/**
 * Renders `text` with every phone number inside it as a dialable link. Rows
 * whose sender is a name ("MTN Mobile Money", "Android SMS via IFTTT") render
 * byte-identical to how they render today.
 */
export function DialableNumber({ text, className }: DialableNumberProps) {
  if (!text) return null;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  let found = 0;

  for (const match of text.matchAll(PHONE_IN_TEXT)) {
    const e164 = toUgandaE164(match[0]);
    if (!e164) continue;
    const at = match.index ?? 0;
    if (at > cursor) nodes.push(text.slice(cursor, at));
    nodes.push(
      <a
        key={`dial-${found++}`}
        href={`tel:+${e164}`}
        onClick={dialOnly}
        title={`Call ${e164}`}
        aria-label={`Call ${e164}`}
        className={cn(DIAL_CLASSES, className)}
      >
        {match[0]}
      </a>,
    );
    cursor = at + match[0].length;
  }

  // Nothing dialable: hand back the original string, unwrapped.
  if (found === 0) return <>{text}</>;
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}
