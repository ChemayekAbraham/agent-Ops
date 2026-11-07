import { Fragment, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { CALM, FOCUS, LABEL } from '../deskTheme';
import { DecisionButton } from './DecisionButton';
import { EmptyState, ErrorLine, LoadingRows } from './States';
import { stackLayout } from './layout';

/**
 * One list, two shapes — a table or a card list — from the same column
 * definition. The shape follows the list's OWN width (its container), not the
 * window: a table only when every visible column gets at least its minimum
 * width, so nothing is squeezed and nothing falls off the right edge.
 *
 *   1. all columns fit                 → the table
 *   2. too narrow                      → hide priority-3 columns (last first),
 *                                         then priority-2 columns (last first);
 *                                         what is hidden opens in a row's details
 *   3. even priority 1 alone won't fit → cards
 *
 * On a card:
 *   priority 1  always (the first priority-1 column is its title)
 *   priority 2  one small line
 *   priority 3  only under "More"
 *
 * Tables keep a sticky header (it sticks to the page; the list has no inner
 * scroll box). Names stay on one line and only take an
 * ellipsis beyond their minimum width; other text clamps to two lines. The
 * whole text is in the tooltip either way. Search, "Show 10 / Show all" and
 * the empty, loading and error states are built in.
 */

/** What a column holds, which sets its minimum width. */
export type ColumnKind = 'name' | 'money' | 'date' | 'chips' | 'number' | 'code' | 'text' | 'action';

export const COLUMN_MIN: Record<ColumnKind, number> = {
  name: 160,
  money: 110,
  date: 90,
  chips: 120,
  number: 72,
  code: 90,
  text: 140,
  action: 120,
};

/** The narrow column that opens a row's hidden columns. */
export const DETAILS_COL = 44;

export type DataColumn<T> = {
  key: string;
  label: string;
  priority: 1 | 2 | 3;
  render: (row: T) => ReactNode;
  /** The plain text of the cell, for search and the tooltip. Defaults to the rendered value when it is text. */
  text?: (row: T) => string;
  align?: 'left' | 'right';
  /** Sets the minimum width (COLUMN_MIN); 'name' cells also stay on one line. Defaults to 'text'. */
  kind?: ColumnKind;
  /** Overrides the kind's minimum width, in px. */
  minWidth?: number;
};

export const DEFAULT_LIMIT = 10;

export const columnMin = <T,>(c: Pick<DataColumn<T>, 'kind' | 'minWidth'>) => c.minWidth ?? COLUMN_MIN[c.kind ?? 'text'];

export type ColumnPlan = { layout: 'table' | 'cards'; shown: string[]; hidden: string[] };

/**
 * Which shape, and which columns, for a list this wide. Pure, so the rule is
 * tested on its own: the table only when the visible columns' minimum widths
 * (plus the details column, when anything is hidden) fit.
 */
export function planColumns<T>(columns: Pick<DataColumn<T>, 'key' | 'priority' | 'kind' | 'minWidth'>[], width: number): ColumnPlan {
  const need = (cols: typeof columns) => cols.reduce((sum, c) => sum + columnMin(c), 0) + (cols.length < columns.length ? DETAILS_COL : 0);
  const plan = (cols: typeof columns): ColumnPlan => ({
    layout: 'table',
    shown: cols.map((c) => c.key),
    hidden: columns.filter((c) => !cols.includes(c)).map((c) => c.key),
  });
  let shown = [...columns];
  if (need(shown) <= width) return plan(shown);
  for (const p of [3, 2] as const) {
    for (let i = columns.length - 1; i >= 0; i--) {
      if (columns[i].priority !== p) continue;
      shown = shown.filter((c) => c !== columns[i]);
      if (need(shown) <= width) return plan(shown);
    }
  }
  return { layout: 'cards', shown: columns.map((c) => c.key), hidden: [] };
}

/** Spare width a chips column takes first (a status pill a little wider than its minimum). */
export const CHIPS_SPARE = 16;

/**
 * Column widths for the table: every column its minimum; the room left over
 * goes first to chip columns (up to CHIPS_SPARE each, so a pill never meets the
 * edge), then to the name columns (so names show whole before anything else
 * widens); with no name column it is shared by minimum width.
 */
export function columnWidths<T>(visible: Pick<DataColumn<T>, 'key' | 'kind' | 'minWidth'>[], width: number, details: boolean): Record<string, number> {
  const need = visible.reduce((s, c) => s + columnMin(c), 0) + (details ? DETAILS_COL : 0);
  let spare = Math.max(0, width - need);
  const out: Record<string, number> = {};
  for (const c of visible) out[c.key] = columnMin(c);
  const chips = visible.filter((c) => c.kind === 'chips');
  for (const c of chips) {
    const give = Math.min(CHIPS_SPARE, spare / (chips.length - chips.indexOf(c)));
    out[c.key] += give;
    spare -= give;
  }
  const names = visible.filter((c) => c.kind === 'name');
  const total = visible.reduce((s, c) => s + columnMin(c), 0) || 1;
  for (const c of visible) {
    out[c.key] = Math.floor(out[c.key] + (names.length ? (c.kind === 'name' ? spare / names.length : 0) : (spare * columnMin(c)) / total));
  }
  return out;
}

function textOf<T>(c: DataColumn<T>, row: T): string {
  if (c.text) return c.text(row);
  const v = c.render(row);
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

const ONE_LINE: CSSProperties = { display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 };

/** One line, an ellipsis only when the cell is full, the whole text on hover. For names. */
export function OneLine({ children, title, className = '' }: { children: ReactNode; title?: string | null; className?: string }) {
  return (
    <span className={className} title={title || undefined} style={ONE_LINE}>
      {children}
    </span>
  );
}

/** Two lines at most, the whole text on hover. Words break only when one word is wider than the cell. */
function Clamp({ children, title }: { children: ReactNode; title: string }) {
  return (
    <span
      title={title || undefined}
      style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'break-word' }}
    >
      {children}
    </span>
  );
}

/** The list's own width: a ResizeObserver, with the window as a fallback before layout (and in tests). */
function useOwnWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1024 : window.innerWidth));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(el.clientWidth > 0 ? el.clientWidth : window.innerWidth);
    read();
    window.addEventListener('resize', read);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(read) : null;
    ro?.observe(el);
    return () => {
      window.removeEventListener('resize', read);
      ro?.disconnect();
    };
  }, []);
  return { ref, width };
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
  /** Tests and harnesses: pin the shape regardless of width ('table' shows every column). */
  forceLayout?: 'table' | 'cards';
  /** A board's own card for a row; replaces the priority layout in the card list. */
  card?: (row: T) => ReactNode;
  /** Extra data-* attributes for a row's <tr> / <li> (tests and styling hooks). */
  rowAttrs?: (row: T) => Record<string, string | undefined>;
}) {
  const { ref, width } = useOwnWidth();
  const measured = useMemo(() => planColumns(columns, width), [columns, width]);
  const plan: ColumnPlan =
    forceLayout === 'table'
      ? { layout: 'table', shown: columns.map((c) => c.key), hidden: [] }
      : forceLayout === 'cards'
        ? { layout: 'cards', shown: columns.map((c) => c.key), hidden: [] }
        : measured;
  const layout = plan.layout;
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
  const toggle = (k: string) => setOpen((m) => ({ ...m, [k]: !m[k] }));

  const cell = (c: DataColumn<T>, r: T) =>
    c.kind === 'name' ? (
      <span title={textOf(c, r) || undefined} style={ONE_LINE}>
        {c.render(r)}
      </span>
    ) : (
      <Clamp title={textOf(c, r)}>{c.render(r)}</Clamp>
    );

  const body = () => {
    if (loading) return <LoadingRows rows={3} height={layout === 'table' ? 32 : 72} label={`Loading ${label}`} />;
    if (error) return <ErrorLine>{error}</ErrorLine>;
    if (filtered.length === 0) return <EmptyState board={board}>{q ? `No ${label} match "${q}".` : emptyText}</EmptyState>;

    if (layout === 'table') {
      const visible = columns.filter((c) => plan.shown.includes(c.key));
      const hidden = columns.filter((c) => plan.hidden.includes(c.key));
      const details = hidden.length > 0;
      const minTable = visible.reduce((s, c) => s + columnMin(c), 0) + (details ? DETAILS_COL : 0);
      const widths = columnWidths(visible, width, details);
      const th = `${LABEL} whitespace-nowrap border-b border-[var(--desk-line-color)] px-3 py-2 font-medium`;
      return (
        // No inner scroll box: the columns are planned to fit (so a scrollbar would only steal their width),
        // and without one the sticky header sticks to the page. `clip` is a guard, not a scroller.
        <div className="desk-datalist-table" style={{ maxWidth: '100%', overflowX: 'clip' }}>
          <table
            className={`w-full text-left ${board ? 'text-base' : 'text-sm'}`}
            style={{ width: '100%', minWidth: minTable, tableLayout: 'fixed', borderCollapse: 'separate', borderSpacing: 0 }}
            data-layout="table"
            data-hidden={hidden.map((c) => c.key).join(' ') || undefined}
          >
            <caption className="sr-only">{label}</caption>
            <colgroup>
              {details && <col style={{ width: DETAILS_COL }} />}
              {visible.map((c) => (
                <col key={c.key} style={{ width: widths[c.key] }} />
              ))}
            </colgroup>
            <thead className="desk-thead">
              <tr>
                {details && (
                  <th scope="col" className={th} style={{ position: 'sticky', top: 0, zIndex: 1, padding: 0 }}>
                    <span className="sr-only">Details</span>
                  </th>
                )}
                {visible.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className={`${th} ${c.align === 'right' ? 'text-right' : ''}`}
                    style={{ position: 'sticky', top: 0, zIndex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}
                    title={c.label}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const k = rowKey(r);
                const isOpen = !!open[k];
                const name = titleCol ? textOf(titleCol, r) : k;
                return (
                  <Fragment key={k}>
                    <tr className="desk-row align-top" data-row={k} {...rowAttrs?.(r)}>
                      {details && (
                        <td className="border-b border-[var(--desk-line-soft)]" style={{ padding: 0, verticalAlign: 'top' }}>
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            aria-label={`${isOpen ? 'Hide' : 'Show'} details for ${name}`}
                            onClick={() => toggle(k)}
                            className={`text-muted-foreground ${CALM} ${FOCUS} hover:text-foreground`}
                            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: DETAILS_COL, minHeight: 44 }}
                          >
                            <ChevronDown className={`h-4 w-4 transition-transform motion-reduce:transition-none ${isOpen ? 'rotate-180' : ''}`} aria-hidden />
                          </button>
                        </td>
                      )}
                      {visible.map((c) => (
                        <td
                          key={c.key}
                          className={`border-b border-[var(--desk-line-soft)] px-3 py-2 text-foreground ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}
                          style={{ overflow: 'hidden' }}
                        >
                          {cell(c, r)}
                        </td>
                      ))}
                    </tr>
                    {details && isOpen && (
                      <tr data-details-for={k}>
                        <td colSpan={visible.length + 1} className="border-b border-[var(--desk-line-soft)] px-3 py-2">
                          <dl className="text-sm" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px', margin: 0, paddingLeft: DETAILS_COL - 12 }}>
                            {hidden.map((c) => (
                              <div key={c.key} style={{ display: 'contents' }}>
                                <dt className="text-muted-foreground">{c.label}</dt>
                                <dd className="text-foreground" style={{ margin: 0, minWidth: 0, overflowWrap: 'break-word' }}>
                                  {c.render(r)}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
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
              {titleCol && <div className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`} style={{ overflowWrap: 'break-word' }}>{titleCol.render(r)}</div>}
              {p1Rest.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px' }} className="text-sm text-foreground">
                  {p1Rest.map((c) => (
                    <span key={c.key} style={{ minWidth: 0, overflowWrap: 'break-word' }}>
                      <span className="sr-only">{c.label}: </span>
                      {c.render(r)}
                    </span>
                  ))}
                </div>
              )}
              {p2.length > 0 && (
                <div className={LABEL} style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px' }}>
                  {p2.map((c) => (
                    <span key={c.key} style={{ minWidth: 0, overflowWrap: 'break-word' }}>
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
                    onClick={() => toggle(k)}
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
                          <dd className="text-foreground" style={{ margin: 0, overflowWrap: 'break-word' }}>{c.render(r)}</dd>
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
    <div ref={ref} style={{ ...stackLayout(10), minWidth: 0 }} data-datalist={label} data-plan={layout}>
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
