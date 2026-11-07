import type { ReactNode } from 'react';
import { CAPSULE } from '../deskTheme';

/**
 * One stage in the pipeline strip, drawn as a small river capsule: the card
 * surface, 16px corners, one line. The desk you are on is edged and tinted in
 * the primary colour (`aria-current="step"`); a retired stage is dashed.
 */
export function StripStep({
  active,
  retired,
  board,
  title,
  children,
}: {
  active?: boolean;
  retired?: boolean;
  board: boolean;
  title?: string;
  children: ReactNode;
}) {
  const tone = retired
    ? 'border-dashed text-muted-foreground'
    : active
      ? 'border-[hsl(var(--primary)/0.7)] bg-[hsl(var(--primary)/0.14)] text-foreground'
      : 'text-muted-foreground';
  return (
    <div
      aria-current={active ? 'step' : undefined}
      title={title}
      className={`${CAPSULE} ${board ? 'text-sm' : 'text-xs'} ${tone}`}
      style={{
        // Positioned, so the screen-reader text inside (sr-only is absolute) stays inside the strip's
        // scroll box instead of widening the whole page on a phone.
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        whiteSpace: 'nowrap',
        padding: board ? '8px 14px' : '6px 12px',
        borderRadius: 'var(--desk-radius-capsule, 16px)',
        ...(active ? { borderWidth: 1, borderStyle: 'solid' } : null),
        ...(retired ? { borderWidth: 1, borderStyle: 'dashed', background: 'transparent', boxShadow: 'none' } : null),
      }}
    >
      {children}
    </div>
  );
}
