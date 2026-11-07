import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { CALM, FOCUS, statusGlass } from '../deskTheme';
import { pillLayout } from './layout';

/**
 * The desk button. One `primary` per row — the decision the rules reached —
 * and everything else `quiet` (or tucked into the row's "…" menu).
 *
 *   primary — solid violet with white text, the one main move on a row or sheet
 *   quiet   — secondary moves, menu items, "Done"
 *   danger  — a primary that rejects
 *   warn    — retry a half-finished move
 *   ok      — confirm a batch in a sheet ("Push all 12")
 *
 * The wording a desk puts on its main button is fixed: see DECISION_WORDS.
 */

export type ButtonVariant = 'primary' | 'quiet' | 'danger' | 'warn' | 'ok';
export type ButtonSize = 'sm' | 'md';

/** The words a row's main button uses. "…" means the rest names who or what. */
export const DECISION_WORDS = ['Pass', 'Send back', 'Reject', 'Transfer → …', 'Call …', 'Finish checks', 'Wait …'] as const;

/**
 * Keyboard focus is an outline as well as FOCUS's ring: index.css turns every
 * box-shadow off on standard-density screens (`@media (max-resolution:
 * 1.5dppx)`), and Tailwind's ring is a box-shadow, so on most desktop monitors
 * the ring alone never shows.
 */
const FOCUS_OUTLINE =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))]';

const BASE = `desk-pill font-medium ${CALM} ${FOCUS} ${FOCUS_OUTLINE} disabled:cursor-not-allowed disabled:opacity-50`;

export const VARIANT_CLASS: Record<ButtonVariant, string> = {
  // Solid: the brand fill with white text, darker on hover (tokens in index.css, 4.5:1 or better).
  primary:
    'border-[hsl(var(--desk-primary-solid))] bg-[hsl(var(--desk-primary-solid))] text-[hsl(var(--desk-primary-solid-fg))] font-semibold shadow-sm hover:border-[hsl(var(--desk-primary-solid-hover))] hover:bg-[hsl(var(--desk-primary-solid-hover))]',
  quiet: 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground hover:bg-[var(--desk-surface-hover)] hover:text-foreground',
  danger: statusGlass.bad,
  warn: statusGlass.warn,
  ok: statusGlass.ok,
};

const SIZE: Record<ButtonSize, { cls: string; padX: number; padY: number }> = {
  sm: { cls: 'text-xs', padX: 12, padY: 4 },
  md: { cls: 'text-sm', padX: 16, padY: 8 },
};

/** A rejecting decision gets the red button; every other decision the violet one. */
export function decisionVariant(decision: string | null | undefined): ButtonVariant {
  return decision === 'reject' ? 'danger' : 'primary';
}

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Menu items read left-aligned and full width. */
  align?: 'center' | 'start';
};

export const DecisionButton = forwardRef<HTMLButtonElement, Props>(function DecisionButton(
  { variant = 'quiet', size = 'sm', align = 'center', className = '', style, type = 'button', ...rest },
  ref,
) {
  const s = SIZE[size];
  return (
    <button
      ref={ref}
      type={type}
      data-variant={variant}
      className={`${BASE} ${s.cls} ${VARIANT_CLASS[variant]} ${align === 'start' ? 'text-left' : ''} ${className}`}
      style={{
        ...pillLayout(s.padX, s.padY, 6),
        justifyContent: align === 'start' ? 'flex-start' : 'center',
        ...(align === 'start' ? { width: '100%' } : null),
        ...style,
      }}
      {...rest}
    />
  );
});

/** An item in a row's "…" menu. */
export function MenuItem(props: Omit<Props, 'variant' | 'align'>) {
  return <DecisionButton variant="quiet" align="start" {...props} />;
}
