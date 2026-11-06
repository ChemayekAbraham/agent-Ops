/**
 * The desks are always the dark glass board, whatever theme the app is in, so
 * these maps no longer switch on board mode. The palette itself lives in
 * `src/index.css` under `.desk-root`, which redefines the Tailwind tokens; board
 * mode only changes size, never colour.
 *
 * Green / amber / rose carry status only — never decoration.
 */

export type Status = 'ok' | 'warn' | 'bad' | 'idle';

export const statusText: Record<Status, string> = {
  ok: 'text-[hsl(var(--desk-ok))]',
  warn: 'text-[hsl(var(--desk-warn))]',
  bad: 'text-[hsl(var(--desk-bad))]',
  idle: 'text-muted-foreground',
};

/**
 * Dots and fills read off their own tokens, separate from the text ones.
 *
 * On the dark board the two are identical. On light they cannot be: a red dark
 * enough to clear 4.5:1 as text on white is muddy as a 8px dot, and a dot
 * bright enough to read is too light to use as text. So light sets a brighter
 * `-dot` value and keeps the darker one for words.
 */
export const statusDot: Record<Status, string> = {
  ok: 'bg-[hsl(var(--desk-ok-dot)/0.8)]',
  warn: 'bg-[hsl(var(--desk-warn-dot)/0.8)]',
  bad: 'bg-[hsl(var(--desk-bad-dot)/0.8)]',
  idle: 'bg-muted-foreground/40',
};

export const statusFill: Record<Status, string> = {
  ok: 'bg-[hsl(var(--desk-ok-dot))]',
  warn: 'bg-[hsl(var(--desk-warn-dot))]',
  bad: 'bg-[hsl(var(--desk-bad-dot))]',
  idle: 'bg-muted-foreground/40',
};

export const statusEdge: Record<Status, string> = {
  ok: 'border-[hsl(var(--desk-ok-dot)/0.6)]',
  warn: 'border-[hsl(var(--desk-warn-dot)/0.6)]',
  bad: 'border-[hsl(var(--desk-bad-dot)/0.6)]',
  idle: 'border-[var(--desk-line-color)]',
};

/** Tinted glass: the status colour behind a border, with the readable text colour on top. */
export const statusGlass: Record<Status, string> = {
  ok: 'bg-[hsl(var(--desk-ok-dot)/0.15)] border-[hsl(var(--desk-ok-dot)/0.6)] text-[hsl(var(--desk-ok))]',
  warn: 'bg-[hsl(var(--desk-warn-dot)/0.15)] border-[hsl(var(--desk-warn-dot)/0.6)] text-[hsl(var(--desk-warn))]',
  bad: 'bg-[hsl(var(--desk-bad-dot)/0.15)] border-[hsl(var(--desk-bad-dot)/0.6)] text-[hsl(var(--desk-bad))]',
  idle: 'bg-[var(--desk-surface)] border-[var(--desk-line-color)] text-muted-foreground',
};

/** Glass surfaces, defined in index.css so the backdrop-filter fallback can live in @supports. */
export const PANEL = 'desk-panel';
export const TILE = 'desk-tile';
/** A river capsule: the panel glass at a tighter radius. */
export const CAPSULE = 'desk-panel desk-capsule';

/** Every small label on the desks: 13px at 70%, sentence case. */
export const LABEL = 'desk-label';

/** Large figures: white for contrast, with a faint violet glow. */
export const FIGURE = 'desk-figure tabular-nums font-semibold text-foreground';

/** Visible keyboard focus, in violet (--ring). */
export const FOCUS =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--background))]';

/** Transitions that stop when the viewer asks for reduced motion. */
export const CALM = 'transition-colors motion-reduce:transition-none';

/** True when the viewer has asked for less motion. Read at call time, not cached. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
