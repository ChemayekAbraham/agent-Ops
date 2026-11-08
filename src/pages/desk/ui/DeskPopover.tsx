import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { CALM, FOCUS } from '../deskTheme';
import { stackLayout } from './layout';

/**
 * A small popover that stays inside `.desk-root`, so the desk palette and the
 * light/dark choice reach it (a portalled popover would land outside both).
 * Closes on an outside press or Escape.
 */

/** The "…" trigger every board row uses. */
export const MORE_TRIGGER = `desk-pill border border-[var(--desk-line-color)] bg-[var(--desk-surface)] p-1 text-muted-foreground ${CALM} ${FOCUS} hover:bg-[var(--desk-surface-hover)] hover:text-foreground`;
/** Its layout, inline so it holds before index.css arrives. */
export const MORE_TRIGGER_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  whiteSpace: 'nowrap',
  padding: 4,
  borderWidth: 1,
  borderStyle: 'solid',
  borderRadius: 999,
};

export function DeskPopover({
  trigger,
  label,
  children,
  align = 'left',
  disabled,
  title,
  triggerClass,
  triggerStyle,
}: {
  trigger: ReactNode;
  label: string;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  disabled?: boolean;
  title?: string;
  triggerClass: string;
  triggerStyle?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span ref={ref} className="relative inline-flex" style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        title={title}
        onClick={() => setOpen(!open)}
        className={triggerClass}
        style={triggerStyle}
      >
        {trigger}
      </button>
      {open && (
        <span
          role="dialog"
          aria-label={label}
          className="desk-panel absolute top-full z-40 mt-1.5 block w-72 max-w-[85vw] p-3 text-left shadow-2xl"
          style={{
            position: 'absolute',
            top: '100%',
            marginTop: 6,
            zIndex: 40,
            display: 'block',
            width: 288,
            maxWidth: '85vw',
            padding: 12,
            ...(align === 'right' ? { right: 0 } : { left: 0 }),
          }}
        >
          {children(() => setOpen(false))}
        </span>
      )}
    </span>
  );
}

/** A row's "…" menu: the trigger, and a column of MenuItems inside. */
export function MoreMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  return (
    <DeskPopover label={label} align="right" trigger={<MoreHorizontal className="h-4 w-4" aria-hidden />} triggerClass={MORE_TRIGGER} triggerStyle={MORE_TRIGGER_STYLE}>
      {(close) => <span style={stackLayout(4)}>{children(close)}</span>}
    </DeskPopover>
  );
}
