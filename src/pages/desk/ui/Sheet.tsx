import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { CALM, FOCUS } from '../deskTheme';
import { stackLayout } from './layout';

/**
 * A bottom sheet on a phone, a centred card from md up. Rendered in place, so
 * it stays inside `.desk-root` and the desk theme reaches it. Escape or a press
 * on the dim background closes it; focus moves into the sheet when it opens.
 */
export function Sheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    panel.current?.querySelector<HTMLElement>('button, a, input, select, textarea')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="desk-sheet-wrap fixed inset-0 z-50 flex items-end justify-center"
      style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
    >
      <button type="button" aria-label="Close" tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-[hsl(var(--desk-blocked)/0.5)]" style={{ position: 'absolute', inset: 0 }} />
      <div
        ref={panel}
        className="desk-panel desk-sheet relative w-full max-w-lg bg-[hsl(var(--background))] shadow-2xl"
        style={{ ...stackLayout(12), position: 'relative', width: '100%', maxWidth: 512, maxHeight: '85dvh', overflow: 'auto', padding: 'var(--desk-card-pad, 20px)', paddingBottom: 'calc(var(--desk-card-pad, 20px) + env(safe-area-inset-bottom, 0px))' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <h2 className="text-base font-semibold text-foreground" style={{ margin: 0 }}>
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`desk-pill border border-[var(--desk-line-color)] text-muted-foreground ${CALM} ${FOCUS} hover:text-foreground`}
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 8, borderRadius: 999, borderWidth: 1, borderStyle: 'solid' }}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {children}
        {footer}
      </div>
    </div>
  );
}
