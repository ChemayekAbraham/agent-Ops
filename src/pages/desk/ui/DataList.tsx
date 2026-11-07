import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { CALM, FOCUS, LABEL } from '../deskTheme';
import { atLeast, useBreakpoint } from './breakpoints';
import { DecisionButton } from './DecisionButton';
import { EmptyState, ErrorLine, LoadingRows } from './States';
import { stackLayout } from './layout';

/**
 * One list, two shapes: a table from md (600 px) up, a card list below — from
 * the same column definition.
 *
 *   priority 1  always on the card (the first priority-1 column is its title)
 *   priority 2  on the card as one small line
 *   priority 3  on the card only under "More"
 *
 * Tables keep a sticky header, clamp long text to two lines (the full text in
 * a tooltip) and scroll inside their own box — the page never scrolls sideways.
 * Search, "Show 10 / Show all" and the empty, loading and error states are
 * built in.
 */

export type DataColumn<T> = {
  key: string;
  label: string;
  priority: 1 | 2 | 3;
  render: (row: T) => ReactNode;
  /** The plain text of the cell, for search and the clamp's tooltip. Defaults to the rendered value when it is text. */
  text?: (row: T) => string;
  align?: 'left' | 'right';
};

export const DEFAULT_LIMIT = 10;

function textOf<T>(c: DataColumn<T>, row: T): string {
  if (c.text) return c.text(row);
  const v = c.render(row);
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

/** Two lines at most, the whole text on hover and for screen readers. */
function Clamp({ children, title }: { children: ReactNode; title: string }) {
  return (
    <span
      title={title || undefined}
      style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}
    >
      {children}
    </span>
  );
}

export function DataList<T>({
  columns,
  rows,
  rowKey,
  label,
  loading,
  error,
  emptyText = 'Nothing here yet.',
  searchable = true,
  limit = DEFAULT_LIMIT,
  board = false,
  forceLayout,
  card,
  rowAttrs,
}: {
  columns: DataColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** What the list is, for the search box and the table caption ("agents"). */
  label: string;
  loading?: boolean;
  error?: ReactNode;
  emptyText?: string;
  searchable?: boolean;
  limit?: number;
  board?: boolean;
  /** Tests and harnesses: pin the shape regardless of width. */
  forceLayout?: 'table' | 'cards';
  /** A board's own phone card for a row; replaces the priority layout below md. */
  card?: (row: T) => ReactNode;
  /** Extra data-* attributes for a row's <tr> / <li> (tests and styling hooks). */
  rowAttrs?: (row: T) => Record<string, string | undefined>;
}) {
  const bp = useBreakpoint();
  const layout = forceLayout ?? (atLeast(bp, 'md') ? 'table' : 'cards');
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => columns.some((c) => textOf(c, r).toLowerCase().includes(needle)));
  }, [rows, columns, q]);
  const shown = all ? filtered : filtered.slice(0, limit);

  const p1 = columns.filter((c) => c.priority === 1);
  const p2 = columns.filter((c) => c.priority === 2);
  const p3 = columns.filter((c) => c.priority === 3);
  const [titleCol, ...p1Rest] = p1;

  const body = () => {
    if (loading) return <LoadingRows rows={3} height={layout === 'table' ? 32 : 72} label={`Loading ${label}`} />;
    if (error) return <ErrorLine>{error}</ErrorLine>;
    if (filtered.length === 0) return <EmptyState board={board}>{q ? `No ${label} match "${q}".` : emptyText}</EmptyState>;

    if (layout === 'table') {
      return (
        <div className="desk-datalist-table" style={{ maxWidth: '100%', overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto' }}>
          <table className={`w-full text-left ${board ? 'text-base' : 'text-sm'}`} style={{ borderCollapse: 'separate', borderSpacing: 0 }} data-layout="table">
            <caption className="sr-only">{label}</caption>
            <thead className="desk-thead">
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className={`${LABEL} whitespace-nowrap border-b border-[var(--desk-line-color)] px-3 py-2 font-medium ${c.align === 'right' ? 'text-right' : ''}`}
                    style={{ position: 'sticky', top: 0, zIndex: 1 }}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={rowKey(r)} className="desk-row align-top" data-row={rowKey(r)} {...rowAttrs?.(r)}>
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`border-b border-[var(--desk-line-soft)] px-3 py-2 text-foreground ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}
                      style={{ maxWidth: 320 }}
                    >
                      <Clamp title={textOf(c, r)}>{c.render(r)}</Clamp>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    return (
      <ul style={{ ...stackLayout(8), margin: 0, padding: 0, listStyle: 'none' }} data-layout="cards">
        {shown.map((r) => {
          const k = rowKey(r);
          const more = open[k];
          if (card) {
            return (
              <li key={k} data-row={k} {...rowAttrs?.(r)} style={{ minWidth: 0 }}>
                {card(r)}
              </li>
            );
          }
          return (
            <li key={k} data-row={k} {...rowAttrs?.(r)} className="desk-tile" style={{ ...stackLayout(4), padding: 12 }}>
              {titleCol && <div className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`} style={{ overflowWrap: 'anywhere' }}>{titleCol.render(r)}</div>}
              {p1Rest.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px' }} className="text-sm text-foreground">
                  {p1Rest.map((c) => (
                    <span key={c.key} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                      <span className="sr-only">{c.label}: </span>
                      {c.render(r)}
                    </span>
                  ))}
                </div>
              )}
              {p2.length > 0 && (
                <div className={LABEL} style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px' }}>
                  {p2.map((c) => (
                    <span key={c.key} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                      {c.label} {c.render(r)}
                    </span>
                  ))}
                </div>
              )}
              {p3.length > 0 && (
                <>
                  <button
                    type="button"
                    aria-expanded={!!more}
                    onClick={() => setOpen((m) => ({ ...m, [k]: !m[k] }))}
                    className={`${LABEL} w-fit rounded ${CALM} ${FOCUS} hover:text-foreground`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 44 }}
                  >
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform motion-reduce:transition-none ${more ? 'rotate-180' : ''}`} aria-hidden />
                    {more ? 'Less' : 'More'}
                  </button>
                  {more && (
                    <dl className="text-sm" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', margin: 0 }}>
                      {p3.map((c) => (
                        <div key={c.key} style={{ display: 'contents' }}>
                          <dt className="text-muted-foreground">{c.label}</dt>
                          <dd className="text-foreground" style={{ margin: 0, overflowWrap: 'anywhere' }}>{c.render(r)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div style={stackLayout(10)} data-datalist={label}>
      {searchable && rows.length > 0 && (
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${label}`}
          aria-label={`Search ${label}`}
          className={`w-full rounded-xl border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 text-sm text-foreground ${FOCUS}`}
          style={{ minHeight: 44, maxWidth: 420, borderWidth: 1, borderStyle: 'solid', borderRadius: 12, padding: '0 12px' }}
        />
      )}
      {body()}
      {!loading && !error && filtered.length > limit && (
        <DecisionButton onClick={() => setAll((a) => !a)} style={{ alignSelf: 'flex-start' }}>
          {all ? `Show ${limit}` : `Show all ${filtered.length.toLocaleString('en')}`}
        </DecisionButton>
      )}
    </div>
  );
}
