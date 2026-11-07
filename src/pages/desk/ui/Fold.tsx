import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { CALM, FOCUS, LABEL, statusDot, type Status } from '../deskTheme';
import { CountChip } from './Chip';
import { rowLayout, stackLayout } from './layout';

/**
 * A section that opens on a press. Children mount only when open, so a closed
 * section costs nothing and never queries.
 *
 *   count   — a count chip after the title ("—" while it is loading)
 *   changed — an amber dot: something in here changed this week
 *   badge   — anything else that belongs on the title line
 */
export function Fold({
  title,
  count,
  countTone,
  changed,
  changedLabel = 'Changed this week',
  badge,
  hint,
  board,
  defaultOpen = false,
  children,
}: {
  title: string;
  count?: number | null;
  countTone?: Status;
  changed?: boolean;
  changedLabel?: string;
  badge?: ReactNode;
  hint?: string;
  board: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-t border-[var(--desk-line-color)]" style={{ ...stackLayout(12), paddingTop: 12 }}>
      <h2 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`} style={{ margin: 0 }}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={`w-full rounded-lg text-left ${CALM} ${FOCUS}`}
          style={{ ...rowLayout(8), width: '100%' }}
        >
          <ChevronRight
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
            style={{ flexShrink: 0 }}
            aria-hidden
          />
          <span>{title}</span>
          {count !== undefined && <CountChip n={count} tone={countTone} />}
          {changed && (
            <span
              className={`h-2 w-2 rounded-full ${statusDot.warn}`}
              style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, flexShrink: 0 }}
              role="img"
              aria-label={changedLabel}
              title={changedLabel}
            />
          )}
          {badge}
          {hint && <span className={`${LABEL} font-normal`}>{hint}</span>}
        </button>
      </h2>
      {open && <div style={stackLayout(20)}>{children}</div>}
    </section>
  );
}
