import { useId, type ReactNode } from 'react';
import { CALM, FOCUS, LABEL, statusGlass, type Status } from '../deskTheme';
import { BREAKPOINTS, useBreakpoint } from './breakpoints';
import { useFadeEdges } from './useFadeEdges';
import { pillLayout } from './layout';

/**
 * Period, scope and sort toggles: a row of pills, one pressed.
 *
 * It never wraps. When the pills do not fit, the row scrolls sideways (wheel,
 * trackpad, touch) with a fade on the edge that has more, and the pressed pill
 * is kept in view. Below 360 px it becomes a native select, which every phone
 * draws well. `deselectable` lets a second press clear the choice; an option's
 * `tone` lights it in that status colour when pressed; `count` follows the label.
 */

export type SegmentOption<T> = { value: T; label: ReactNode; count?: number; tone?: Status };

export const SEG_ACTIVE = 'border-[hsl(var(--primary)/0.6)] bg-[hsl(var(--primary)/0.18)] text-foreground';
export const SEG_IDLE =
  'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground hover:bg-[var(--desk-surface-hover)] hover:text-foreground';

const SIZE = {
  // The command centre's toolbar pill (Refresh, Compact, Board mode).
  sm: { cls: 'text-xs font-medium', padX: 12, padY: 6 },
  md: { cls: 'text-sm', padX: 14, padY: 6 },
} as const;

/** The option's words for the native select (a label that is not plain text falls back to its value). */
function plainLabel(o: SegmentOption<unknown>): string {
  const base = typeof o.label === 'string' || typeof o.label === 'number' ? String(o.label) : String(o.value);
  return o.count !== undefined ? `${base} (${o.count.toLocaleString('en')})` : base;
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  label,
  size = 'sm',
  deselectable = false,
  forceSelect,
}: {
  options: readonly SegmentOption<T>[];
  value: T | null;
  onChange: (next: T | null) => void;
  ariaLabel: string;
  /** Words before the pills, e.g. "What changed in". */
  label?: ReactNode;
  size?: keyof typeof SIZE;
  deselectable?: boolean;
  /** Tests and harnesses: draw the select regardless of width. */
  forceSelect?: boolean;
}) {
  const bp = useBreakpoint();
  const selectId = useId();
  const activeIndex = options.findIndex((o) => o.value === value);
  const { ref, fade } = useFadeEdges<HTMLDivElement>(activeIndex >= 0 ? `[data-seg-index="${activeIndex}"]` : null, [options.length]);
  const s = SIZE[size];
  const tiny = forceSelect ?? (typeof window !== 'undefined' && window.innerWidth < BREAKPOINTS.sm && bp === 'xs');

  if (tiny) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {label && (
          <label htmlFor={selectId} className={LABEL}>
            {label}
          </label>
        )}
        <select
          id={selectId}
          aria-label={label ? undefined : ariaLabel}
          value={activeIndex >= 0 ? String(activeIndex) : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : options[Number(e.target.value)].value)}
          className={`desk-pill border border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-sm text-foreground ${FOCUS}`}
          style={{ minHeight: 44, padding: '6px 12px', borderRadius: 999, borderWidth: 1, borderStyle: 'solid', maxWidth: '100%' }}
        >
          {deselectable && <option value="">All</option>}
          {options.map((o, i) => (
            <option key={String(o.value)} value={String(i)}>
              {plainLabel(o as SegmentOption<unknown>)}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '100%' }}>
      {label && (
        <span className={LABEL} style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
          {label}
        </span>
      )}
      <div
        ref={ref}
        role="group"
        aria-label={ariaLabel}
        data-fade={fade}
        className="desk-scroll-row"
        style={{ position: 'relative', display: 'flex', flexWrap: 'nowrap', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '100%', overflowX: 'auto', overflowY: 'hidden' }}
      >
        {options.map((o, i) => {
          const on = value === o.value;
          const tone = on ? (o.tone ? statusGlass[o.tone] : SEG_ACTIVE) : SEG_IDLE;
          return (
            <button
              key={String(o.value)}
              type="button"
              data-seg-index={i}
              aria-pressed={on}
              onClick={() => onChange(on && deselectable ? null : o.value)}
              className={`desk-pill ${s.cls} ${CALM} ${FOCUS} ${tone}`}
              style={{ ...pillLayout(s.padX, s.padY, 6), flexShrink: 0 }}
            >
              {o.label}
              {o.count !== undefined && <span className="tabular-nums text-foreground">{o.count.toLocaleString('en')}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
