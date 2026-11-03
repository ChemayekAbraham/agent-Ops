import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Search } from 'lucide-react';
import type { TableSpec } from './deskConfig';
import type { FeedState, Row } from './useDeskFeed';
import { decisionTone, fmt, type Tone } from './format';
import { useDeskPrefs } from './deskPrefs';
import { CALM, FOCUS, statusEdge, statusText, type Status } from './deskTheme';
import { SkeletonRows } from './Skeleton';

type Sort = { field: string; dir: 1 | -1 } | null;

const TONE_STATUS: Record<Tone, Status> = { go: 'ok', wait: 'warn', stop: 'bad', plain: 'idle' };

function DecisionPill({ value, board }: { value: unknown; board: boolean }) {
  const state = TONE_STATUS[decisionTone(value)];
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium ${statusEdge(board)[state]} ${statusText(board)[state]}`}
    >
      {fmt('text', value)}
    </span>
  );
}

export function DeskTable({ spec, feed, board }: { spec: TableSpec; feed: FeedState; board: boolean }) {
  const { density } = useDeskPrefs();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>(null);
  const [only, setOnly] = useState<string | null>(null);
  const hasDecision = spec.columns.some((c) => c.field === 'decision' || c.field === 'next_step');
  const cell = density === 'compact' ? 'px-3 py-1.5' : 'px-3 py-2.5';

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
    <section id={spec.id} className="rounded-lg border border-border bg-card p-4 sm:p-5 space-y-3 min-w-0">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <h2 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`}>{spec.title}</h2>
          {spec.note && <p className="text-xs text-muted-foreground max-w-3xl leading-snug">{spec.note}</p>}
        </div>
        {feed.rows.length > 8 && (
          <label className="relative block w-full sm:w-64">
            <span className="sr-only">Search {spec.title}</span>
            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search names, IDs, decisions"
              className={`h-9 w-full rounded-md border border-input bg-background pl-8 pr-2 text-sm ${FOCUS}`}
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
                className={`rounded-md border px-2.5 py-1 text-xs text-left ${CALM} ${FOCUS} ${statusEdge(board)[state]} ${statusText(board)[state]} ${active ? 'bg-muted' : 'bg-background hover:bg-muted/60'}`}
              >
                <span className="font-medium">{s.decision}</span>
                <span className="ml-2 tabular-nums">{fmt('int', s.n)}</span>
                {spec.summarySum && spec.summarySum !== 'days_open' && (
                  <span className="ml-2 tabular-nums text-muted-foreground">{fmt('ugx', s.sum)}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className={`${board ? 'max-h-[26rem]' : 'max-h-[32rem]'} overflow-auto rounded-md border border-border`}>
        <table className="w-full border-collapse text-sm tabular-nums">
          <thead>
            <tr>
              {spec.columns.map((c) => {
                const active = sort?.field === c.field;
                return (
                  <th
                    key={c.field}
                    scope="col"
                    aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                    className={`sticky top-0 z-10 bg-card border-b border-border px-3 py-2 font-medium text-muted-foreground whitespace-nowrap ${c.right ? 'text-right' : 'text-left'}`}
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
            </tr>
          </thead>
          <tbody>
            {feed.loading && <SkeletonRows cols={spec.columns.length} />}

            {!feed.loading && feed.error && (
              <tr>
                <td colSpan={spec.columns.length} className="px-3 py-8 text-center">
                  <p className={`font-medium ${statusText(board).bad}`}>Could not load this table</p>
                  <p className="mt-1 text-sm text-muted-foreground">{feed.error}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Use “Refresh now” at the top. If it keeps failing, tell the COO office.
                  </p>
                </td>
              </tr>
            )}

            {!feed.loading && !feed.error && rows.length === 0 && (
              <tr>
                <td colSpan={spec.columns.length} className="px-3 py-8 text-center">
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
              <tr key={String(r[spec.rowKey] ?? i)} className={`border-b border-border last:border-0 hover:bg-muted/40 ${CALM}`}>
                {spec.columns.map((c) => (
                  <td
                    key={c.field}
                    className={`${cell} align-top ${c.right ? 'text-right' : 'text-left'} ${c.field === 'req' ? 'font-mono text-xs text-muted-foreground' : ''}`}
                  >
                    {c.fmt === 'decision' ? (
                      <DecisionPill value={r[c.field]} board={board} />
                    ) : c.fmt === 'bar' ? (
                      <span className="inline-flex items-center justify-end gap-2">
                        <span
                          className="block h-1.5 rounded bg-primary/60"
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
