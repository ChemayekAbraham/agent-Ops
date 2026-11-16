import { useEffect, useState } from 'react';
import { CALM, FOCUS, LABEL } from '../deskTheme';
import { fmt } from '../format';
import { Chip, EmptyState, ErrorLine, LoadingRows, Tile, TileRow, moneyFull, stackLayout } from '../ui';
import { TIERS, TIER_WORDS, callDay, defaultWatchMode, lastSundayKampala, plainError, tierTone, useArrearsWatch, yesterdayKampala, type ArrearsRow, type ArrearsTotals, type Tier, type WatchMode } from './arrearsApi';
import { ACTION_BUTTON, LogCallSheet, TenantCard, WatchControls, rangeText } from './ArrearsParts';
import { DeskPromises } from './promises';

/**
 * Tenant Ops · Arrears calls (E102): every plan short on the watch day,
 * new slips first (the server's order), 50 at a time. The header is the
 * server's totals and tier counts; the cards say who to ring and what is owed.
 */

export const PAGE = 50;

export function useDebounced<T>(v: T, ms = 300): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = window.setTimeout(() => setD(v), ms);
    return () => window.clearTimeout(t);
  }, [v, ms]);
  return d;
}

/** The totals across the top, and the tier chips that filter the list. */
export function ArrearsHeader({ totals, tier, onTier, board }: { totals: ArrearsTotals; tier: Tier | null; onTier: (t: Tier | null) => void; board: boolean }) {
  const chip = (t: Tier | null, label: string, n: number | null) => (
    <button
      key={t ?? 'all'}
      type="button"
      aria-pressed={tier === t}
      onClick={() => onTier(t)}
      data-tier-chip={t ?? 'all'}
      className={`desk-pill border px-3 py-1 text-sm ${CALM} ${FOCUS} ${
        tier === t ? 'border-[hsl(var(--primary)/0.6)] bg-[hsl(var(--primary)/0.18)] text-foreground' : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground'
      }`}
    >
      {label}
      {n !== null && <span className="ml-1.5 tabular-nums">{fmt('int', n)}</span>}
    </button>
  );
  return (
    <div style={stackLayout(10)}>
      <TileRow>
        <Tile board={board} label="Plans short" value={fmt('int', totals.plans)} />
        <Tile board={board} label="Agents" value={fmt('int', totals.agents)} />
        <Tile board={board} label="Shortfall" value={moneyFull(totals.shortfall)} tone={totals.shortfall > 0 ? 'bad' : undefined} />
        <Tile board={board} label="Arrears to date" value={moneyFull(totals.arrears_to_date)} />
      </TileRow>
      <div role="group" aria-label="Tier" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {chip(null, 'All', totals.plans)}
        {TIERS.map((t) => chip(t, TIER_WORDS[t], totals[t]))}
      </div>
      <p className="text-sm text-foreground" style={{ margin: 0 }} data-progress>
        Tenants called {fmt('int', totals.tenant_called)} / agents called {fmt('int', totals.agent_called)}
      </p>
    </div>
  );
}

export function TenantArrearsTab({ board }: { board: boolean }) {
  // Mondays open on last week (E113).
  const [mode, setMode] = useState<WatchMode>(() => defaultWatchMode());
  const [dates, setDates] = useState<Record<WatchMode, string>>(() => ({ day: yesterdayKampala(), week: lastSundayKampala() }));
  const day = dates[mode];
  const [tier, setTier] = useState<Tier | null>(null);
  const [searchText, setSearchText] = useState('');
  const search = useDebounced(searchText);
  const [offset, setOffset] = useState(0);
  const [logging, setLogging] = useState<ArrearsRow | null>(null);
  const q = useArrearsWatch({ day, mode, tier, search, limit: PAGE, offset });

  // A new filter starts from the first page.
  useEffect(() => setOffset(0), [day, mode, tier, search]);

  const d = q.data;
  const matching = d?.matching ?? null;
  return (
    <section aria-label="Arrears calls" data-arrears-tab="tenant-ops" style={stackLayout(14)}>
      {/* E116: my promises, the desk board and the broken promises, first. */}
      <DeskPromises desk="tenant-ops" />
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
        <WatchControls mode={mode} onMode={setMode} value={day} onValue={(v) => setDates((d) => ({ ...d, [mode]: v }))} />
        <label style={{ ...stackLayout(4), flex: '1 1 220px' }}>
          <span className={LABEL}>Search</span>
          <input type="search" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Name, phone, village, district" className="rounded-md border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-2 py-1.5 text-sm text-foreground" aria-label="Search arrears" />
        </label>
      </div>

      {q.isLoading ? (
        <LoadingRows rows={4} label="Loading the arrears" />
      ) : q.error ? (
        <ErrorLine>{plainError(q.error)}</ErrorLine>
      ) : d ? (
        <>
          <p className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`} style={{ margin: 0 }} data-watch-range>
            Arrears for {rangeText(mode, d)}
          </p>
          {d.totals && <ArrearsHeader totals={d.totals} tier={tier} onTier={setTier} board={board} />}
          {d.rule && (
            <p className={LABEL} style={{ margin: 0 }}>
              {d.rule}
            </p>
          )}
          {d.rows.length === 0 ? (
            <EmptyState>No plan was short for {rangeText(mode, d)}{tier || search ? ' for this filter' : ''}.</EmptyState>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 380px), 1fr))', gap: 12 }}>
                {d.rows.map((r) => (
                  <TenantCard key={r.rent_request_id} row={r} tiers={d.tiers} onLog={setLogging} />
                ))}
              </div>
              {matching !== null && matching > PAGE && (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }} data-pager>
                  <button type="button" className={ACTION_BUTTON} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                    Previous
                  </button>
                  <span className={LABEL}>
                    {fmt('int', offset + 1)}–{fmt('int', offset + d.rows.length)} of {fmt('int', matching)}
                  </span>
                  <button type="button" className={ACTION_BUTTON} disabled={offset + d.rows.length >= matching} onClick={() => setOffset(offset + PAGE)}>
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </>
      ) : null}

      {logging && (
        <LogCallSheet
          title={`Log call · ${logging.tenant?.name ?? 'tenant'}`}
          parties={['tenant', 'agent', 'landlord', 'funder']}
          defaultParty="tenant"
          rentRequestId={logging.rent_request_id}
          desk="tenant-ops"
          day={callDay(mode, day, d)}
          onClose={() => setLogging(null)}
        />
      )}
    </section>
  );
}

/** The tier counts as small chips (the Command Centre's tile). */
export function TierCounts({ totals }: { totals: ArrearsTotals }) {
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {TIERS.map((t) => (
        <Chip key={t} tone={totals[t] > 0 ? tierTone(t) : 'idle'}>
          {TIER_WORDS[t]} {fmt('int', totals[t])}
        </Chip>
      ))}
    </span>
  );
}
