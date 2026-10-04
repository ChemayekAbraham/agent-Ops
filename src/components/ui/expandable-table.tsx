import { Fragment, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ExpandableColumn<T> {
  /** Stable key for the column. */
  key: string;
  /** Header text/node shown on desktop and as the field label on mobile. */
  header: ReactNode;
  /** Cell renderer. */
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right';
  /**
   * Show this column in the collapsed mobile summary row. Keep to 1-2 columns
   * (e.g. a label and the amount). Non-primary columns appear when expanded.
   */
  primary?: boolean;
  className?: string;
  headClassName?: string;
  /** Hide this field from the expanded mobile detail (e.g. duplicate of primary). */
  hideOnMobileDetail?: boolean;
}

interface ExpandableTableProps<T> {
  columns: ExpandableColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  /** Optional click handler for a whole row (desktop). Mobile uses tap-to-expand. */
  emptyText?: ReactNode;
  loading?: boolean;
  loadingText?: ReactNode;
  /** Rendered after the rows on desktop (inside tfoot) and below the cards on mobile. */
  footer?: ReactNode;
  className?: string;
  /** Tailwind max-height utility applied to the scroll area, e.g. "max-h-[600px]". */
  maxHeight?: string;
}

/**
 * Responsive table that, on phones, collapses each row into a tap-to-expand
 * card so users can review every field without horizontal scrolling. On
 * `sm` and up it renders a normal scannable table.
 */
export function ExpandableTable<T>({
  columns,
  rows,
  getRowKey,
  emptyText = 'No records found.',
  loading = false,
  loadingText,
  footer,
  className,
  maxHeight = 'max-h-[600px]',
}: ExpandableTableProps<T>) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setExpanded((p) => ({ ...p, [key]: !p[key] }));

  const primaryCols = columns.filter((c) => c.primary);
  const summaryCols = primaryCols.length > 0 ? primaryCols : columns.slice(0, 2);
  const summaryKeys = new Set(summaryCols.map((c) => c.key));

  return (
    <div className={cn('rounded-lg border overflow-hidden', className)}>
      {/* ── Desktop / tablet: normal table ── */}
      <div className={cn('hidden sm:block overflow-auto', maxHeight)}>
        <table className="w-full text-xs">
          <thead className="bg-muted/40 sticky top-0 z-10">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={cn(
                    'px-3 py-2 font-semibold text-[11px] uppercase tracking-wider text-muted-foreground',
                    c.align === 'right' ? 'text-right' : 'text-left',
                    c.headClassName,
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-10 text-center text-muted-foreground">
                  {loadingText || 'Loading…'}
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-10 text-center text-muted-foreground">
                  {emptyText}
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={getRowKey(row)} className="border-t hover:bg-muted/30 transition-colors">
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      'px-3 py-2.5 align-top',
                      c.align === 'right' ? 'text-right' : 'text-left',
                      c.className,
                    )}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {footer && rows.length > 0 && (
            <tfoot className="bg-muted/30 border-t-2">
              <tr>
                <td colSpan={columns.length} className="px-3 py-2">
                  {footer}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* ── Mobile: tap-to-expand cards ── */}
      <div className={cn('sm:hidden divide-y overflow-auto', maxHeight)}>
        {loading && rows.length === 0 && (
          <div className="px-3 py-10 text-center text-muted-foreground text-xs">
            {loadingText || 'Loading…'}
          </div>
        )}
        {!loading && rows.length === 0 && (
          <div className="px-3 py-10 text-center text-muted-foreground text-xs">{emptyText}</div>
        )}
        {rows.map((row) => {
          const key = getRowKey(row);
          const isOpen = !!expanded[key];
          const detailCols = columns.filter((c) => !summaryKeys.has(c.key) && !c.hideOnMobileDetail);
          return (
            <div key={key} className="bg-background">
              <button
                type="button"
                onClick={() => toggle(key)}
                aria-expanded={isOpen}
                className="w-full flex items-center gap-3 px-3 py-3 text-left active:bg-muted/40 touch-manipulation"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <div className="flex-1 min-w-0 space-y-0.5">
                  {summaryCols.map((c) => (
                    <div key={c.key} className="text-xs min-w-0">
                      {c.cell(row)}
                    </div>
                  ))}
                </div>
                <ChevronDown
                  className={cn(
                    'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                    isOpen && 'rotate-180',
                  )}
                />
              </button>
              {isOpen && detailCols.length > 0 && (
                <dl className="px-3 pb-3 pt-0 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-xs">
                  {detailCols.map((c) => (
                    <Fragment key={c.key}>
                      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground self-center">
                        {c.header}
                      </dt>
                      <dd className={cn('min-w-0', c.align === 'right' ? 'text-right' : 'text-left')}>
                        {c.cell(row)}
                      </dd>
                    </Fragment>
                  ))}
                </dl>
              )}
            </div>
          );
        })}
        {footer && rows.length > 0 && <div className="px-3 py-2 bg-muted/30 text-xs">{footer}</div>}
      </div>
    </div>
  );
}
