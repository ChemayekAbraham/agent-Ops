import type { ReactNode } from 'react';
import { CALM, FOCUS, LABEL, statusGlass, type Status } from '../deskTheme';
import { pillLayout, rowLayout } from './layout';

/**
 * Period, scope and sort toggles: a row of pills, one pressed.
 *
 * `deselectable` lets a second press clear the choice (a filter that can show
 * everything). An option with a `tone` lights in that status colour when
 * pressed; one with a `count` shows it after the label.
 */

export type SegmentOption<T> = { value: T; label: ReactNode; count?: number; tone?: Status };

export const SEG_ACTIVE = 'border-[hsl(var(--primary)/0.6)] bg-[hsl(var(--primary)/0.18)] text-foreground';
export const SEG_IDLE =
  'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground hover:bg-[var(--desk-surface-hover)] hover:text-foreground';

const SIZE = {
  sm: { cls: 'text-xs font-medium', padX: 12, padY: 4 },
  md: { cls: 'text-sm', padX: 14, padY: 6 },
} as const;

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  label,
  size = 'sm',
  deselectable = false,
}: {
  options: readonly SegmentOption<T>[];
  value: T | null;
  onChange: (next: T | null) => void;
  ariaLabel: string;
  /** Words before the pills, e.g. "What changed in". */
  label?: ReactNode;
  size?: keyof typeof SIZE;
  deselectable?: boolean;
}) {
  const s = SIZE[size];
  return (
    <div role="group" aria-label={ariaLabel} style={rowLayout(6)}>
      {label && <span className={LABEL}>{label}</span>}
      {options.map((o) => {
        const on = value === o.value;
        const tone = on ? (o.tone ? statusGlass[o.tone] : SEG_ACTIVE) : SEG_IDLE;
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on && deselectable ? null : o.value)}
            className={`desk-pill ${s.cls} ${CALM} ${FOCUS} ${tone}`}
            style={pillLayout(s.padX, s.padY, 6)}
          >
            {o.label}
            {o.count !== undefined && <span className="tabular-nums text-foreground">{o.count.toLocaleString('en')}</span>}
          </button>
        );
      })}
    </div>
  );
}
