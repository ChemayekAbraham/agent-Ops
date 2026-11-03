import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { TableSpec } from './deskConfig';
import type { FeedState, Row } from './useDeskFeed';
import { decisionTone, fmt, toneClass } from './format';

type Sort = { field: string; dir: 1 | -1 } | null;

function DecisionPill({ value }: { value: unknown }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium ${toneClass[decisionTone(value)]}`}>
      {fmt('text', value)}
    </span>
  );
}

export function DeskTable({ spec, feed }: { spec: TableSpec; feed: FeedState }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>(null);
  const [only, setOnly] = useState<string | null>(null);
  const hasDecision = spec.columns.some((c) => c.field === 'decision' || c.field === 'next_step');

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
          <h2 className="text-base font-semibold text-foreground">{spec.title}</h2>
          {spec.note && <p className="text-xs text-muted-foreground max-w-3xl">{spec.note}</p>}
        </div>
        {feed.rows.length > 8 && (
          <label className="relative block w-full sm:w-64">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search names, IDs, decisions"
              aria-label={`Search ${spec.title}`}
              className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
        )}
      </div>

      {summary.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {summary.map((s) => (
            <button
              key={s.decision}
              type="button"
              onClick={() => setOnly(only === s.decision ? null : s.decision)}
              aria-pressed={only === s.decision}
              className={`rounded-md border px-2.5 py-1 text-xs text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${toneClass[decisionTone(s.decision)]} ${only === s.decision ? 'bg-muted' : 'bg-background hover:bg-muted/60'}`}
            >
              <span className="font-medium">{s.decision}</span>
              <span className="ml-2 tabular-nums">{fmt('int', s.n)}</span>
              {spec.summarySum && spec.summarySum !== 'days_open' && <span className="ml-2 tabular-nums text-muted-foreground">{fmt('ugx', s.sum)}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="max-h-[32rem] overflow-auto rounded-md border border-border">
        <table className="w-full border-collapse text-sm tabular-nums">
          <thead>
            <tr>
              {spec.columns.map((c) => (
                <th key={c.field} scope="col" aria-sort={sort?.field === c.field ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                  className={`sticky top-0 z-10 bg-card border-b border-border px-3 py-2 font-medium text-muted-foreground whitespace-nowrap ${c.right ? 'text-right' : 'text-left'}`}>
                  <button type="button" className="hover:text-foreground focus:outline-none focus-visible:underline"
                    onClick={() => setSort(sort?.field === c.field ? { field: c.field, dir: sort.dir === 1 ? -1 : 1 } : { field: c.field, dir: c.right ? -1 : 1 })}>
                    {c.label}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {feed.loading && (
              <tr><td colSpan={spec.columns.length} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!feed.loading && feed.error && (
              <tr><td colSpan={spec.columns.length} className="px-3 py-6 text-center text-red-700 dark:text-red-400">Could not load: {feed.error}</td></tr>
            )}
            {!feed.loading && !feed.error && rows.length === 0 && (
              <tr><td colSpan={spec.columns.length} className="px-3 py-6 text-center text-muted-foreground">{feed.rows.length ? 'No rows match.' : 'Nothing waiting.'}</td></tr>
            )}
            {!feed.loading && !feed.error && rows.map((r, i) => (
              <tr key={String(r[spec.rowKey] ?? i)} className="border-b border-border last:border-0 hover:bg-muted/40">
                {spec.columns.map((c) => (
                  <td key={c.field} className={`px-3 py-2 align-top ${c.right ? 'text-right' : 'text-left'} ${c.field === 'req' ? 'font-mono text-xs text-muted-foreground' : ''}`}>
                    {c.fmt === 'decision' ? <DecisionPill value={r[c.field]} />
                      : c.fmt === 'bar' ? (
                        <span className="inline-flex items-center justify-end gap-2">
                          <span className="block h-1.5 rounded bg-primary/60" style={{ width: `${Math.max(2, (64 * (Number(r[c.field]) || 0)) / barMax[c.field])}px` }} aria-hidden />
                          {fmt('bar', r[c.field])}
                        </span>
                      ) : fmt(c.fmt, r[c.field])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasDecision && !feed.loading && !feed.error && (
        <p className="text-xs text-muted-foreground">{fmt('int', rows.length)} of {fmt('int', feed.rows.length)} rows shown.</p>
      )}
    </section>
  );
}
