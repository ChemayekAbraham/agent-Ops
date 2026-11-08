import type { ReactNode } from 'react';
import { statusGlass, type Status } from '../deskTheme';
import { pillLayout } from './layout';

/**
 * A status chip: a flag, a state, a count. Tone is the only colour choice and
 * it comes from the desk status tokens — green / amber / red carry status only.
 *
 *   xs — 11px, inside a row of data
 *   sm — 12px, headers and counts
 */

export type ChipSize = 'xs' | 'sm';

const SIZE: Record<ChipSize, { cls: string; padX: number; padY: number }> = {
  xs: { cls: 'text-[11px]', padX: 8, padY: 2 },
  sm: { cls: 'text-xs', padX: 10, padY: 2 },
};

export function Chip({
  children,
  tone = 'idle',
  size = 'xs',
  strong,
  title,
  className = '',
}: {
  children: ReactNode;
  tone?: Status;
  size?: ChipSize;
  /** Bold text, for chips that are the point of the row ("Time up"). */
  strong?: boolean;
  title?: string;
  className?: string;
}) {
  const s = SIZE[size];
  return (
    <span
      data-tone={tone}
      title={title}
      className={`desk-pill ${s.cls} ${strong ? 'font-semibold' : ''} ${statusGlass[tone]} ${className}`}
      style={pillLayout(s.padX, s.padY)}
    >
      {children}
    </span>
  );
}

/** A small count, "—" while it is unknown. */
export function CountChip({ n, tone = 'idle' }: { n: number | null | undefined; tone?: Status }) {
  return (
    <Chip size="sm" tone={tone} className="tabular-nums">
      {n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en')}
    </Chip>
  );
}
