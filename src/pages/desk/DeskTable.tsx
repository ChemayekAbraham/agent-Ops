import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Search } from 'lucide-react';
import type { TableSpec } from './deskConfig';
import type { FeedState, Row } from './useDeskFeed';
import { decisionTone, fmt, type Tone } from './format';
import { useDeskPrefs } from './deskPrefs';
import { CALM, FOCUS, PANEL, statusGlass, statusText, type Status } from './deskTheme';
import { SkeletonRows } from './Skeleton';
import { RETRY_LABEL, useReviewStatus } from './reviewStatus';

type Sort = { field: string; dir: 1 | -1 } | null;

/**
 * The review column, added by the desks that have a checklist (E26). The feeds
 * print `req` as the first eight characters of the request id; the desk turns
 * that back into the whole id when the button is pressed, not before, so no
 * desk pays for a lookup on rows nobody opens.
 */
export type ReviewHook = {
  /** The 8-character code this row carries, or null when the row has none. */
  shortFor: (row: Row) => string | null;
  onOpen: (short: string) => void;
  /** The code currently being resolved, so that one row can say "opening". */
  opening: string | null;
  /** Why a code could not be opened, by code — ambiguous, gone, or an error. */
  notes: Record<string, string>;
};

const TONE_STATUS: Record<Tone, Status> = { go: 'ok', wait: 'warn', stop: 'bad', plain: 'idle' };

function DecisionPill({ value }: { value: unknown }) {
  const state = TONE_STATUS[decisionTone(value)];
  return (
    <span className={`desk-pill inline-block whitespace-nowrap border px-2.5 py-0.5 text-xs font-medium ${statusGlass[state]}`}>
      {fmt('text', value)}
    </span>
  );
}

function ReviewCell({
  row,
  review,
  cell,
  state,
}: {
  row: Row;
  review: ReviewHook;
  cell: string;
  state: Record<string, { kind: string; message: string }>;
}) {
  const short = review.shortFor(row);
  const mark = short ? state[short] : undefined;
  const note = short ? review.notes[short] : undefined;
  const opening = !!short && review.opening === short;

  return (
    <td className={`${cell} align-top text-right`}>
      {short ? (
        <div className="inline-flex flex-col items-end gap-1">
          <button
            type="button"
            disabled={opening}
            onClick={() => review.onOpen(short)}
            className={`desk-pill border border-[hsl(var(--primary)/0.5)] bg-[hsl(var(--primary)/0.15)] px-3 py-1 text-xs font-medium text-foreground ${CALM} ${FOCUS} hover:bg-[hsl(var(--primary)/0.25)] disabled:cursor-not-allowed disabled:opacity-60`}
          >
            {opening ? 'Opening…' : mark?.kind === 'move_failed' ? 'Retry' : 'Review'}
          </button>
          {mark?.kind === 'move_failed' && (
            <span className={`text-[11px] leading-tight ${statusText.bad}`}>{RETRY_LABEL}</span>
          )}
          {mark?.kind === 'moved' && <span className={`text-[11px] leading-tight ${statusText.ok}`}>{mark.message}</span>}
          {note && (
            <span className={`max-w-[16rem] text-[11px] leading-tight ${statusText.warn}`} role="alert">
              {note}
            </span>
          )}
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      )}
    </td>
  );
}

export function DeskTable({
  spec,
  feed,
  board,
  review,
}: {
  spec: TableSpec;
  feed: FeedState;
  board: boolean;
  review?: ReviewHook;
}) {
  const { density } = useDeskPrefs();
  const { byShort } = useReviewStatus();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>(null);
  const [only, setOnly] = useState<string | null>(null);
  const hasDecision = spec.columns.some((c) => c.field === 'decision' || c.field === 'next_step');
  const cell = density === 'compact' ? 'px-3 py-1.5' : 'px-3 py-2.5';
  const colCount = spec.columns.length + (review ? 1 : 0);

  const summary = useMemo(() => {
    if (!spec.summarySum) return [] as { decision: string; n: number; sum: number }[];
    const m = new Map<string, { decision: string; n: number; sum: number }>();
    feed.rows.forEach((r) => {
      const k = String(r.decision ?? '—');
      const cur = m.get(k) ?? { decision: k, n: 0, sum: 0 };
      cur.n += 1;
      cur.sum += Number(r[spec.summarySum!]) || 0;
      m.set(k, cur);
    });
    return Array.from(m.values()).sort((a, b) => b.n - a.n);
  }, [feed.rows, spec.summarySum]);

  const rows = useMemo(() => {
    let out: Row[] = feed.rows;
    if (only) out = out.filter((r) => String(r.decision) === only);
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      out = out.filter((r) => spec.columns.some((c) => String(r[c.field] ?? '').toLowerCase().includes(needle)));
    }
    if (sort) {
      const { field, dir } = sort;
      out = [...out].sort((a, b) => {
        const x = a[field], y = b[field];
        const nx = Number(x), ny = Number(y);
        if (x !== null && y !== null && !Number.isNaN(nx) && !Number.isNaN(ny)) return (nx - ny) * dir;
        return String(x ?? '').localeCompare(String(y ?? '')) * dir;
      });
    }
    return out;
  }, [feed.rows, only, q, sort, spec.columns]);

  const barMax = useMemo(() => {
    const m: Record<string, number> = {};
    spec.columns.filter((c) => c.fmt === 'bar').forEach((c) => {
      m[c.field] = Math.max(1, ...feed.rows.map((r) => Number(r[c.field]) || 0));
    });
    return m;
  }, [feed.rows, spec.columns]);

  return (
    <section id={spec.id} className={`${PANEL} p-4 sm:p-5 space-y-3 min-w-0`}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <h2 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`}>{spec.title}</h2>
          {spec.note && <p className="text-xs text-muted-foreground max-w-3xl leading-snug">{spec.note}</p>}
        </div>
        {feed.rows.length > 8 && (
          <label className="relative block w-full sm:w-64">
            <span className="sr-only">Search {spec.title}</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search names, IDs, decisions"
              className={`desk-pill h-9 w-full border border-white/12 bg-white/5 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground ${FOCUS}`}
            />
          </label>
        )}
      </div>

      {summary.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {summary.map((s) => {
            const state = TONE_STATUS[decisionTone(s.decision)];
            const active = only === s.decision;
            return (
              <button
                key={s.decision}
                type="button"
                onClick={() => setOnly(active ? null : s.decision)}
                aria-pressed={active}
                className={`desk-pill border px-3 py-1 text-xs text-left ${CALM} ${FOCUS} ${statusGlass[state]} ${active ? 'ring-1 ring-inset ring-white/25' : ''}`}
              >
                <span className="font-medium">{s.decision}</span>
                <span className="ml-2 tabular-nums">{fmt('int', s.n)}</span>
                {spec.summarySum && spec.summarySum !== 'days_open' && (
                  <span className="ml-2 tabular-nums opacity-70">{fmt('ugx', s.sum)}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className={`${board ? 'max-h-[22rem]' : 'max-h-[32rem]'} overflow-auto rounded-xl border border-white/10`}>
        <table className="w-full border-collapse text-sm tabular-nums">
          <thead className="desk-thead">
            <tr>
              {spec.columns.map((c) => {
                const active = sort?.field === c.field;
                return (
                  <th
                    key={c.field}
                    scope="col"
                    aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                    className={`sticky top-0 z-10 border-b border-white/12 px-3 py-2 font-medium text-muted-foreground whitespace-nowrap ${c.right ? 'text-right' : 'text-left'}`}
                  >
                    <button
                      type="button"
                      className={`inline-flex items-center gap-1 rounded hover:text-foreground ${FOCUS} ${active ? 'text-foreground' : ''}`}
                      onClick={() =>
                        setSort(active ? { field: c.field, dir: sort.dir === 1 ? -1 : 1 } : { field: c.field, dir: c.right ? -1 : 1 })
                      }
                    >
                      {c.label}
                      {active &&
                        (sort.dir === 1 ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
                    </button>
                  </th>
                );
              })}
              {review && (
                <th
                  scope="col"
                  className="sticky top-0 z-10 border-b border-white/12 px-3 py-2 text-right font-medium text-muted-foreground whitespace-nowrap"
                >
                  Review
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {feed.loading && <SkeletonRows cols={colCount} />}

            {!feed.loading && feed.error && (
              <tr>
                <td colSpan={colCount} className="px-3 py-8 text-center">
                  <p className={`font-medium ${statusText.bad}`}>Could not load this table</p>
                  <p className="mt-1 text-sm text-muted-foreground">{feed.error}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Use “Refresh now” at the top. If it keeps failing, tell the COO office.
                  </p>
                </td>
              </tr>
            )}

            {!feed.loading && !feed.error && rows.length === 0 && (
              <tr>
                <td colSpan={colCount} className="px-3 py-8 text-center">
                  {feed.rows.length === 0 ? (
                    <>
                      <p className="font-medium text-foreground">Nothing waiting</p>
                      <p className="mt-1 text-sm text-muted-foreground">This desk is clear. Nothing to decide here right now.</p>
                    </>
                  ) : (
                    <>
                      <p className="font-medium text-foreground">No rows match</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Clear the search box{only ? ' or the decision filter above' : ''} to see all {fmt('int', feed.rows.length)} rows.
                      </p>
                    </>
                  )}
                </td>
              </tr>
            )}

            {!feed.loading && !feed.error && rows.map((r, i) => (
              <tr key={String(r[spec.rowKey] ?? i)} className={`desk-row border-b border-white/5 last:border-0 ${CALM}`}>
                {spec.columns.map((c) => (
                  <td
                    key={c.field}
                    className={`${cell} align-top ${c.right ? 'text-right' : 'text-left'} ${
                      c.field === 'req' ? 'font-mono text-xs text-muted-foreground' : 'text-foreground'
                    }`}
                  >
                    {c.fmt === 'decision' ? (
                      <DecisionPill value={r[c.field]} />
                    ) : c.fmt === 'bar' ? (
                      <span className="inline-flex items-center justify-end gap-2">
                        <span
                          className="block h-1.5 rounded-full bg-[hsl(var(--primary))]"
                          style={{ width: `${Math.max(2, (64 * (Number(r[c.field]) || 0)) / barMax[c.field])}px` }}
                          aria-hidden
                        />
                        {fmt('bar', r[c.field])}
                      </span>
                    ) : (
                      fmt(c.fmt, r[c.field])
                    )}
                  </td>
                ))}

                {review && <ReviewCell row={r} review={review} cell={cell} state={byShort} />}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hasDecision && !feed.loading && !feed.error && (
        <p className="text-xs text-muted-foreground">
          {fmt('int', rows.length)} of {fmt('int', feed.rows.length)} rows shown.
        </p>
      )}
    </section>
  );
}
