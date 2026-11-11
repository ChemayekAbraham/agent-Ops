import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { rpc } from './reviewApi';
import { CALM, FOCUS, LABEL, statusText } from './deskTheme';
import { EmptyState, ErrorLine, LoadingRows, Sheet, moneyFull, stackLayout } from './ui';
import { KindChip, type RequestKind } from './KindChip';
import { DeskHistory } from './deskHistory';

/**
 * Desk search (E72): `desk_search(p_query, p_desk, p_limit)`.
 *
 * A stage desk passes its own slug and searches only the requests at that
 * desk; the COO desk ('coo') and the Command Centre ('command') search every
 * desk by any name (tenant, agent, landlord, funder), phone or request id.
 * It starts at 2 letters or 6 digits, waits for the typing to pause, and the
 * server's refusals ("This desk is not assigned to you", "Searching every
 * desk is for the COO desk and the Command Centre") are shown as written.
 */

export type SearchDesk = 'service-centre' | 'agent-ops' | 'tenant-ops' | 'landlord-ops' | 'coo' | 'command';

export type SearchRow = {
  id: string;
  short_id: string;
  status: string | null;
  /** Where the request is now, in words ("Tenant Ops", "Funders board", "Back with the agent"). */
  desk: string | null;
  tenant: string | null;
  tenant_phone: string | null;
  agent: string | null;
  agent_phone: string | null;
  landlord: string | null;
  landlord_phone: string | null;
  funder: string | null;
  rent: number | null;
  kind: RequestKind | null;
  matched_on: string | null;
};

export type SearchAnswer = { rows: SearchRow[]; scope: string | null; note: string | null };

export const SEARCH_PLACEHOLDER: Record<SearchDesk, string> = {
  'service-centre': 'Search tenant or agent',
  'agent-ops': 'Search agent or tenant',
  'tenant-ops': 'Search tenant name or phone',
  'landlord-ops': 'Search landlord or tenant',
  coo: 'Search any name, phone or request id',
  command: 'Search any name, phone or request id',
};

/** The status a request carries while it waits at the COO: the one result that opens the COO's drawer. */
export const AT_COO = 'partner_ops_approved';
export const SEARCH_LIMIT = 30;
export const SEARCH_DEBOUNCE_MS = 300;

/** A query worth sending: 6+ digits when it is a number, otherwise 2+ characters. */
export function searchReady(raw: string): boolean {
  const q = raw.trim();
  if (q.length === 0) return false;
  if (/^[\d\s+()-]+$/.test(q)) return q.replace(/\D/g, '').length >= 6;
  return q.length >= 2;
}

export function useDebounced<T>(value: T, ms = SEARCH_DEBOUNCE_MS): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useDeskSearch(desk: SearchDesk, raw: string) {
  const q = useDebounced(raw.trim());
  return useQuery({
    queryKey: ['desk-feed', 'search', desk, q],
    enabled: searchReady(q),
    queryFn: async (): Promise<SearchAnswer> => {
      const { data, error } = await rpc('desk_search', { p_query: q, p_desk: desk, p_limit: SEARCH_LIMIT });
      if (error) throw error;
      const d = (data ?? {}) as { rows?: SearchRow[]; scope?: string; note?: string };
      return { rows: Array.isArray(d.rows) ? d.rows : [], scope: d.scope ?? null, note: d.note ?? null };
    },
    staleTime: 15_000,
    retry: false,
  });
}

/** The server's refusal, word for word. */
const asIs = (e: unknown) => String((e as { message?: string } | null)?.message ?? e ?? 'The search did not go through.');

export function DeskSearchBox({ desk, value, onChange }: { desk: SearchDesk; value: string; onChange: (v: string) => void }) {
  const label = SEARCH_PLACEHOLDER[desk];
  return (
    <div role="search" className="relative" style={{ maxWidth: 520 }}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onChange('');
        }}
        placeholder={label}
        aria-label={label}
        data-desk-search={desk}
        autoComplete="off"
        className={`desk-pill h-10 w-full border border-[var(--desk-line-color)] bg-[var(--desk-surface)] pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground ${FOCUS}`}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear the search"
          className={`absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:text-foreground ${CALM} ${FOCUS}`}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
    </div>
  );
}

function who(name: string | null, phone: string | null): string {
  if (!name && !phone) return '—';
  return phone ? `${name ?? '—'} · ${phone}` : (name as string);
}

/**
 * The results, in place of the list. `onOpen` is the review drawer: a stage
 * desk opens every result there (they are all at its desk); the COO desk and
 * the Command Centre open it only for a request at the COO, and show any
 * other one read-only.
 */
export function SearchResults({
  desk,
  query,
  showDesk,
  onOpen,
  openWhen = () => true,
}: {
  desk: SearchDesk;
  query: string;
  /** Every-desk search: say where each request is. */
  showDesk?: boolean;
  onOpen?: (id: string) => void;
  /** Which results open the drawer; the rest open the read-only view. */
  openWhen?: (row: SearchRow) => boolean;
}) {
  const q = useDeskSearch(desk, query);
  const [viewing, setViewing] = useState<SearchRow | null>(null);
  const settled = useDebounced(query.trim()) === query.trim();

  const pick = (r: SearchRow) => {
    if (onOpen && openWhen(r)) onOpen(r.id);
    else setViewing(r);
  };

  let body: React.ReactNode;
  if (!searchReady(query)) body = <p className={LABEL}>Type at least 2 letters or 6 digits.</p>;
  else if (q.error) body = <ErrorLine>{asIs(q.error)}</ErrorLine>;
  else if (!settled || q.isLoading || q.isFetching) body = <LoadingRows rows={3} height={44} label="Searching" />;
  else if ((q.data?.rows ?? []).length === 0) body = <EmptyState>Nothing matches “{query.trim()}”{q.data?.scope ? ` in ${q.data.scope}` : ''}.</EmptyState>;
  else
    body = (
      <>
        <p className={LABEL} style={{ margin: 0 }}>
          {q.data!.rows.length === SEARCH_LIMIT ? `The first ${SEARCH_LIMIT}` : `${q.data!.rows.length}`} found
          {q.data?.scope ? ` · ${q.data.scope}` : ''}
        </p>
        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }} aria-label="Search results">
          {q.data!.rows.map((r) => (
            <li key={r.id} data-result={r.short_id} className="border-t border-[var(--desk-line-color)] first:border-t-0">
              <button
                type="button"
                onClick={() => pick(r)}
                className={`w-full rounded-xl px-2 py-2.5 text-left hover:bg-[var(--desk-surface-hover)] ${CALM} ${FOCUS}`}
                style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', columnGap: 12, rowGap: 4 }}
              >
                <span className="font-medium text-foreground" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  {r.tenant ?? '—'}
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{r.short_id}</span>
                </span>
                <span className="tabular-nums text-foreground" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {moneyFull(r.rent)}
                </span>
                <span style={{ gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <KindChip kind={r.kind} />
                  {showDesk && r.desk && (
                    <span data-at-desk className="desk-pill border border-[var(--desk-line-color)] px-2 py-0.5 text-[11px] text-foreground">
                      At {r.desk}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground" style={{ overflowWrap: 'anywhere' }}>
                    Agent {r.agent ?? '—'} · Landlord {r.landlord ?? '—'}
                    {r.funder ? ` · Funder ${r.funder}` : ''}
                    {r.matched_on ? ` · matched on ${r.matched_on}` : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </>
    );

  return (
    <section aria-label="Search results" data-search-results={desk} style={stackLayout(8)}>
      {body}
      {viewing && <RequestView row={viewing} onClose={() => setViewing(null)} />}
    </section>
  );
}

/** The read-only view of a request found by search: where it is, who is on it, and what the desks decided. */
export function RequestView({ row, onClose }: { row: SearchRow; onClose: () => void }) {
  return (
    <Sheet title={`${row.tenant ?? 'Request'} · ${row.short_id}`} onClose={onClose}>
      <div data-request-view style={stackLayout(10)}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
          <KindChip kind={row.kind} />
          {row.desk && <span className="desk-pill border border-[var(--desk-line-color)] px-2 py-0.5 text-xs text-foreground">At {row.desk}</span>}
        </div>
        <dl className="grid gap-x-4 gap-y-1.5 text-sm" style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', margin: 0 }}>
          <dt className={LABEL}>Rent</dt>
          <dd className="m-0 tabular-nums text-foreground">{moneyFull(row.rent)}</dd>
          <dt className={LABEL}>Tenant</dt>
          <dd className="m-0 text-foreground">{who(row.tenant, row.tenant_phone)}</dd>
          <dt className={LABEL}>Agent</dt>
          <dd className="m-0 text-foreground">{who(row.agent, row.agent_phone)}</dd>
          <dt className={LABEL}>Landlord</dt>
          <dd className="m-0 text-foreground">{who(row.landlord, row.landlord_phone)}</dd>
          {row.funder && (
            <>
              <dt className={LABEL}>Funder</dt>
              <dd className="m-0 text-foreground">{row.funder}</dd>
            </>
          )}
        </dl>
        {/* E79: what every desk did with it, the calls, and the moves. */}
        <DeskHistory requestId={row.id} />
        <p className={`text-xs ${statusText.idle}`} style={{ margin: 0 }}>
          Read-only: it is acted on at the desk it is at.
        </p>
      </div>
    </Sheet>
  );
}
