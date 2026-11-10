import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CALM, FOCUS, FIGURE, LABEL, statusGlass } from '../deskTheme';
import { readableError, rpc } from '../reviewApi';
import { isMissingDbObject, logMissingOnce } from '../deskLive';
import { eatTime } from '../ontology/ontologyApi';
import { Skeleton } from '../Skeleton';
import { Card, EmptyState, ErrorLine, LoadingRows, Segmented, Sheet, stackLayout } from '../ui';
import { AccountabilityTable } from './AccountabilityFold';
import { ACCOUNTABILITY_WINDOWS, isDenied, stageName, useAccountability, type AccountabilityWindow } from './accountabilityApi';

/**
 * The command centre's "Accountability" tile (E63), from
 * `desk_accountability_tile(p_days)`: how many requests a later desk found
 * unfit, which desk passed them, the five people with the most, and the latest
 * eight. A desk chip opens that desk's people from `desk_accountability`.
 */

export type TileDesk = { stage: string; label: string | null; flags: number | null; people: number | null };
export type TilePerson = { name: string | null; staff_ref: string | null; stage: string | null; flags: number | null };
export type TileItem = {
  req: string | null;
  id: string | null;
  label: string | null;
  stage: string | null;
  found_at: string | null;
  found_on: string | null;
  person: string | null;
};
export type AccountabilityTileData = {
  total_flags: number | null;
  unattributed: number | null;
  by_desk: TileDesk[];
  top_people: TilePerson[];
  latest: TileItem[];
};

/** The tile's stage → the desk slug `desk_accountability(p_desk)` takes. */
const DESK_SLUG: Record<string, string> = {
  service_centre: 'service-centre',
  agent_ops: 'agent-ops',
  tenant_ops: 'tenant-ops',
  landlord_ops: 'landlord-ops',
  agent: 'agent-app',
};

export function deskSlug(stage: string): string {
  return DESK_SLUG[stage] ?? stage;
}

/** A stage in words: the tile's own label when it sent one; "agent" is the field agents. */
export function tileStageName(stage: string | null | undefined): string {
  if (stage === 'agent') return 'Field agents';
  return stageName(stage);
}

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export function normalizeTile(d: Partial<AccountabilityTileData> | null | undefined): AccountabilityTileData {
  return {
    total_flags: d?.total_flags ?? null,
    unattributed: d?.unattributed ?? null,
    by_desk: arr<TileDesk>(d?.by_desk),
    top_people: arr<TilePerson>(d?.top_people).slice(0, 5),
    latest: arr<TileItem>(d?.latest).slice(0, 8),
  };
}

export function useAccountabilityTile(days: AccountabilityWindow) {
  return useQuery({
    queryKey: ['desk-feed', 'accountability-tile', days],
    queryFn: async (): Promise<AccountabilityTileData> => {
      const { data, error } = await rpc('desk_accountability_tile', { p_days: days });
      if (error) throw error;
      return normalizeTile(data as Partial<AccountabilityTileData> | null);
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

const int = (v: number | null | undefined) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en'));

function DeskSheet({ desk, days, onClose }: { desk: TileDesk; days: AccountabilityWindow; onClose: () => void }) {
  const q = useAccountability(deskSlug(desk.stage), days);
  const title = `${desk.label ?? tileStageName(desk.stage)} — last ${days} days`;
  return (
    <Sheet title={title} onClose={onClose}>
      {q.isLoading ? (
        <LoadingRows rows={4} height={36} label="Loading this desk's people" />
      ) : q.error ? (
        <ErrorLine>This desk could not load: {readableError(q.error)}</ErrorLine>
      ) : (
        <AccountabilityTable rows={q.data?.rows ?? []} />
      )}
    </Sheet>
  );
}

function TileSkeleton() {
  return (
    <div role="status" aria-label="Loading accountability" style={stackLayout(12)}>
      <Skeleton className="h-9 w-20" />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-7 w-32" />
        ))}
      </div>
      <LoadingRows rows={4} height={22} label="Loading people" />
    </div>
  );
}

export function AccountabilityTile({ board }: { board: boolean }) {
  const [days, setDays] = useState<AccountabilityWindow>(7);
  const [desk, setDesk] = useState<TileDesk | null>(null);
  const close = useCallback(() => setDesk(null), []);
  const q = useAccountabilityTile(days);

  if (q.error && isMissingDbObject(q.error)) {
    logMissingOnce('desk_accountability_tile', q.error);
    return null;
  }
  if (q.error && isDenied(q.error)) return null;

  const d = q.data;
  const head = board ? 'text-base' : 'text-sm';

  return (
    <Card title="Accountability" hint="Requests a desk passed that a later desk found unfit" board={board} ariaLabel="Accountability" busy={q.isFetching}>
      <div data-accountability-tile style={stackLayout(14)}>
        <Segmented
          options={ACCOUNTABILITY_WINDOWS.map((n) => ({ value: n, label: `${n} days` }))}
          value={days}
          onChange={(n) => n !== null && setDays(n)}
          ariaLabel="Accountability window"
        />

        {q.isLoading || !d ? (
          q.error ? <ErrorLine>Accountability could not load: {readableError(q.error)}</ErrorLine> : <TileSkeleton />
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span className={`${FIGURE} ${board ? 'text-4xl' : 'text-3xl'}`} data-total-flags>
                {int(d.total_flags)}
              </span>
              <span className="text-sm text-muted-foreground">
                flagged in {days} days
                {Number(d.unattributed ?? 0) > 0 ? ` · ${int(d.unattributed)} with no one named` : ''}
              </span>
            </div>

            {d.by_desk.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} aria-label="Flags by desk">
                {d.by_desk.map((b) => (
                  <button
                    key={b.stage}
                    type="button"
                    onClick={() => setDesk(b)}
                    data-desk-chip={b.stage}
                    aria-label={`${b.label ?? tileStageName(b.stage)}: ${int(b.flags)} flags, ${int(b.people)} people — open`}
                    className={`desk-pill border text-xs ${CALM} ${FOCUS} ${Number(b.flags ?? 0) > 0 ? statusGlass.warn : statusGlass.idle} hover:opacity-90`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderWidth: 1, borderStyle: 'solid', borderRadius: 999, whiteSpace: 'nowrap', cursor: 'pointer' }}
                  >
                    <span className="font-medium">{b.label ?? tileStageName(b.stage)}</span>
                    <span className="tabular-nums">{int(b.flags)} flags</span>
                    <span className="tabular-nums opacity-80">· {int(b.people)} people</span>
                  </button>
                ))}
              </div>
            )}

            {Number(d.total_flags ?? 0) === 0 && d.latest.length === 0 ? (
              <EmptyState board={board}>No passed request was found unfit in the last {days} days.</EmptyState>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2" style={{ display: 'grid', gap: 16 }}>
                <section aria-label="Most flagged people" style={stackLayout(6)}>
                  <h3 className={`${head} font-semibold text-foreground`} style={{ margin: 0 }}>
                    Most flagged
                  </h3>
                  {d.top_people.length === 0 ? (
                    <EmptyState>No one named yet.</EmptyState>
                  ) : (
                    <ol style={{ ...stackLayout(4), margin: 0, padding: 0, listStyle: 'none' }}>
                      {d.top_people.map((p, i) => (
                        <li key={`${p.staff_ref ?? p.name}-${p.stage}-${i}`} data-top-person style={{ display: 'flex', justifyContent: 'space-between', gap: 8, minWidth: 0 }} className="text-sm">
                          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                            <span className="text-foreground">{p.name ?? '—'}</span>{' '}
                            <span className={`${LABEL} font-mono`}>{p.staff_ref ?? 'no staff ID'}</span>
                            <span className={LABEL}> · {tileStageName(p.stage)}</span>
                          </span>
                          <span className="tabular-nums font-medium text-foreground" style={{ whiteSpace: 'nowrap' }}>
                            {int(p.flags)}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>

                <section aria-label="Latest flags" style={stackLayout(6)}>
                  <h3 className={`${head} font-semibold text-foreground`} style={{ margin: 0 }}>
                    Latest
                  </h3>
                  <ul style={{ ...stackLayout(4), margin: 0, padding: 0, listStyle: 'none' }}>
                    {d.latest.map((it, i) => (
                      <li key={`${it.id ?? it.req}-${i}`} data-latest className="text-sm leading-snug" style={{ overflowWrap: 'anywhere' }}>
                        <span className="font-mono text-xs text-foreground">{it.req ?? '—'}</span>{' '}
                        <span className="text-foreground">{it.label ?? 'No reason given'}</span>
                        <span className="text-muted-foreground">
                          {' '}
                          · passed by {it.person ?? tileStageName(it.stage)} · found by {stageName(it.found_on)}
                          {it.found_at ? ` · ${eatTime(it.found_at)}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            )}
          </>
        )}
      </div>
      {desk && <DeskSheet desk={desk} days={days} onClose={close} />}
    </Card>
  );
}
