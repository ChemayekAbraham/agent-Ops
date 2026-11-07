import type { ReactNode } from 'react';
import { LABEL, PANEL } from '../deskTheme';
import { stackLayout } from './layout';

/**
 * The command centre's card: the panel every section on every desk sits in.
 *
 *   panel — 24px corners, 20px padding, 14px between title and body
 *           ("Today's blockers", "Money out")
 *   brief — the "Today on Welile" card: the same shell, 8px between lines,
 *           sentences in 14px with a 13px footnote
 *
 * The title is the command centre's section title: 16px semibold, 18px on a
 * board.
 */
export function Card({
  title,
  hint,
  board,
  variant = 'panel',
  footnote,
  ariaLabel,
  busy,
  children,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  board: boolean;
  variant?: 'panel' | 'brief';
  footnote?: ReactNode;
  ariaLabel?: string;
  busy?: boolean;
  children: ReactNode;
}) {
  const gap = variant === 'brief' ? 'var(--desk-space-2, 8px)' : 'var(--desk-card-gap, 14px)';
  return (
    <section
      className={`${PANEL} min-w-0`}
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      style={{ ...stackLayout(0), gap, padding: 'var(--desk-card-pad, 20px)' }}
    >
      {(title || hint) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          {title && <CardTitle board={board}>{title}</CardTitle>}
          {hint && <span className={LABEL}>{hint}</span>}
        </div>
      )}
      {children}
      {footnote && <p className={LABEL} style={{ margin: 0 }}>{footnote}</p>}
    </section>
  );
}

/** A section title, exactly as the command centre sets them. */
export function CardTitle({ board, children }: { board: boolean; children: ReactNode }) {
  return (
    <h2 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`} style={{ margin: 0 }}>
      {children}
    </h2>
  );
}

/** The brief's lines: up to three sentences, 14px (16px on a board), snug. */
export function BriefLines({ lines, board }: { lines: ReactNode[]; board: boolean }) {
  return (
    <ol style={{ ...stackLayout(6), margin: 0, padding: 0, listStyle: 'none' }}>
      {lines.map((l, i) => (
        <li key={i} className={`${board ? 'text-base' : 'text-sm'} leading-snug text-foreground`}>
          {l}
        </li>
      ))}
    </ol>
  );
}
