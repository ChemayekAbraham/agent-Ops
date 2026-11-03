/**
 * One accent (the app's brand violet, via --primary) on neutral slate surfaces.
 * Green / amber / red carry status only — never decoration.
 *
 * Board mode re-declares the surface tokens inline on the desk wrapper, so the
 * wall display is dark whatever theme the browser is in. Token-driven classes
 * (bg-card, text-muted-foreground, border-border) follow automatically; the
 * fixed palette colours below cannot, so each has a board variant.
 */

export type Status = 'ok' | 'warn' | 'bad' | 'idle';

/** Dark slate surfaces for Board mode. Applied as inline custom properties. */
export const BOARD_TOKENS: Record<string, string> = {
  '--background': '222 47% 7%',
  '--foreground': '210 20% 98%',
  '--card': '222 40% 11%',
  '--card-foreground': '210 20% 98%',
  '--muted': '222 30% 17%',
  '--muted-foreground': '214 20% 72%',
  '--border': '215 25% 26%',
  '--input': '215 25% 26%',
  '--primary': '271 81% 72%',
  '--primary-foreground': '222 47% 8%',
  '--ring': '271 81% 72%',
  colorScheme: 'dark',
};

const TEXT_APP: Record<Status, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-800 dark:text-amber-300',
  bad: 'text-red-700 dark:text-red-400',
  idle: 'text-muted-foreground',
};
const TEXT_BOARD: Record<Status, string> = {
  ok: 'text-emerald-300',
  warn: 'text-amber-300',
  bad: 'text-red-300',
  idle: 'text-muted-foreground',
};

const FILL_APP: Record<Status, string> = {
  ok: 'bg-emerald-600',
  warn: 'bg-amber-500',
  bad: 'bg-red-600',
  idle: 'bg-muted-foreground/40',
};
const FILL_BOARD: Record<Status, string> = {
  ok: 'bg-emerald-400',
  warn: 'bg-amber-300',
  bad: 'bg-red-400',
  idle: 'bg-muted-foreground/40',
};

const EDGE_APP: Record<Status, string> = {
  ok: 'border-emerald-600/40',
  warn: 'border-amber-600/50',
  bad: 'border-red-600/50',
  idle: 'border-border',
};
const EDGE_BOARD: Record<Status, string> = {
  ok: 'border-emerald-400/40',
  warn: 'border-amber-300/50',
  bad: 'border-red-400/50',
  idle: 'border-border',
};

export const statusText = (board: boolean): Record<Status, string> => (board ? TEXT_BOARD : TEXT_APP);
export const statusFill = (board: boolean): Record<Status, string> => (board ? FILL_BOARD : FILL_APP);
export const statusEdge = (board: boolean): Record<Status, string> => (board ? EDGE_BOARD : EDGE_APP);

/** Visible keyboard focus, used on every interactive element in the desks. */
export const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/** Transitions that stop when the viewer asks for reduced motion. */
export const CALM = 'transition-colors motion-reduce:transition-none';
