import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { CALM, FOCUS, LABEL, PANEL, statusDot, type Status } from '../deskTheme';
import { CountChip } from './Chip';
import { rowLayout, stackLayout } from './layout';

/**
 * A section that opens on a press, drawn as a command-centre card: closed it
 * is one 24px-round row (16px tall padding, 20px across); open, the body sits
 * inside the same card 14px below the title. Panels inside an open fold lose
 * their own glass (`.desk-fold .desk-panel` in index.css), so a table reads as
 * part of the card rather than a card in a card. Children mount only when
 * open, so a closed section costs nothing and never queries.
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
    <section
      className={`${PANEL} desk-fold min-w-0`}
      data-open={open ? 'true' : 'false'}
      style={{
        ...stackLayout(0),
        gap: 'var(--desk-card-gap, 14px)',
        padding: open ? 'var(--desk-card-pad, 20px)' : 'var(--desk-space-4, 16px) var(--desk-card-pad, 20px)',
      }}
    >
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
