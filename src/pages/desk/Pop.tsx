import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A small popover that stays inside `.desk-root`, so the desk palette and the
 * light/dark choice reach it (a portalled popover would land outside both).
 * Closes on an outside press or Escape.
 */
export function Pop({
  trigger,
  label,
  children,
  align = 'left',
  disabled,
  title,
  triggerClass,
}: {
  trigger: ReactNode;
  label: string;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  disabled?: boolean;
  title?: string;
  triggerClass: string;
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
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        title={title}
        onClick={() => setOpen(!open)}
        className={triggerClass}
      >
        {trigger}
      </button>
      {open && (
        <span
          role="dialog"
          aria-label={label}
          className={`desk-panel absolute top-full z-40 mt-1.5 block w-72 max-w-[85vw] p-3 text-left shadow-2xl ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {children(() => setOpen(false))}
        </span>
      )}
    </span>
  );
}
