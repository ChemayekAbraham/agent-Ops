/**
 * Dev-only Playwright harness for the funder V3 screens. No auth, no network:
 * fixtures drive the same presentational components the live V3 dashboard
 * renders, with a fake map (absolutely placed pins) instead of Google Maps.
 *
 * Mounted at `/__e2e/funder-v3` ONLY when `import.meta.env.DEV` is true.
 *
 * Query params:
 *   view=houses|home   (default houses)
 *   ui=v3|old          old = the live card + hero on the same fixtures (before/after)
 *   count=12           cards loaded at first; "Show more" adds 12
 *   total=2534         filtered total reported by the read service
 *   state=ready|loading|error|empty
 *   loc=granted|prompt|denied
 *   map=fake|real      real = the V3 Google map (live pin read; needs Maps to load)
 *   unchecked=1        every third empty house has house_listings.verified = false
 *   tags=on|off|board  funders board tags (off = switch off and no preview row);
 *                      board = tags on with the E72b grouped list (fixture board items in all four tags)
 *   demote=1           E59 viewer may demote (funders_board_can_demote() true); fake submit
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { FunderNewCategory, FunderNewEmptyHouse, FunderNewReadyPlan } from '@/components/funder-new/types';
import { itemId } from '@/components/funder-new/utils';
import { FunderNewHouseCard } from '@/components/funder-new/FunderNewHouseCard';
import { FunderV3HousesScreen, type FunderV3MapRenderProps } from '@/components/funder-v3/FunderV3HousesScreen';
import { FunderV3Home } from '@/components/funder-v3/FunderV3Home';
import { FunderV3Map } from '@/components/funder-v3/FunderV3Map';
import { AgentAssistant } from '@/components/agent/AgentAssistant';
import { launcherHidden, useOverlayState } from '@/components/FloatingToolbar';
import { FIXTURE_SUMMARY, fixtureApi, fixtureLocation, makeFeed } from '@/components/funder-v3/__fixtures__/funderV3Fixtures';
import { formatDynamic } from '@/lib/currencyFormat';
import type { FunderV3DemoteApi } from '@/components/funder-v3/FunderV3HousesScreen';
import type { FeedEntry } from '@/components/supporter/FunderHouseListingsSection';
import { buildBoardGroups } from '@/components/funder-new/boardGroups';
import type { BoardItem, BoardItemsCounts } from '@/lib/fundersBoard';
import type { BoardTag } from '@/lib/fundersBoard';
import { getDynamicCurrencySymbol } from '@/lib/currencyFormat';

function FakeMap({ api, activeHouseId, onPinHouse, insets, interactive, onMapTap, boardTagsOn, boardPins, onPinCard }: FunderV3MapRenderProps & { api: ReturnType<typeof fixtureApi> }) {
  const pins = api.items.filter((entry) => entry.category === 'empty').slice(0, 40) as Array<{ category: 'empty'; item: FunderNewEmptyHouse }>;
  return (
    <div
      data-testid="fv3-fake-map"
      data-interactive={interactive ? 'true' : 'false'}
      onClick={() => {
        if (!interactive) onMapTap?.();
      }}
      className="relative h-full w-full overflow-hidden bg-[hsl(210_14%_95%)] dark:bg-[hsl(220_15%_18%)]"
    >
      <div className="absolute inset-0 opacity-40 [background-image:linear-gradient(hsl(0_0%_100%/.6)_1px,transparent_1px),linear-gradient(90deg,hsl(0_0%_100%/.6)_1px,transparent_1px)] [background-size:48px_48px]" />
      <div className="absolute" style={{ top: insets.top, right: insets.right, bottom: insets.bottom, left: insets.left }}>
        {pins.map(({ item }, index) => {
          const house = item;
          const x = 8 + ((index * 37) % 84);
          const y = 10 + ((index * 53) % 78);
          const active = activeHouseId === house.house_id;
          return (
            <button
              key={house.house_id}
              type="button"
              data-testid="fv3-fake-pin"
              data-house-id={house.house_id}
              data-active={active ? 'true' : undefined}
              data-tone={boardTagsOn ? 'empty' : 'plain'}
              onClick={(event) => {
                event.stopPropagation();
                onPinHouse(house);
              }}
              className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full px-2.5 py-1 text-[11.5px] font-bold shadow-[0_2px_6px_rgb(15_23_42/0.22)] ring-1 ${active ? `z-10 scale-110 text-white ring-white ${boardTagsOn ? 'bg-[#4b5563]' : 'bg-[hsl(271_100%_40%)]'}` : boardTagsOn ? 'bg-[#e5e7eb] text-[#374151] ring-black/15' : 'bg-white text-[#1f2328] ring-black/10'}`}
              style={{ left: `${x}%`, top: `${y}%` }}
            >
              {formatDynamic(Number(house.monthly_rent) || 100000)}
            </button>
          );
        })}
        {(boardPins ?? []).map((pin, index) => (
          <button
            key={pin.cardId}
            type="button"
            data-testid="fv3-fake-board-pin"
            data-card-id={pin.cardId}
            data-tone={pin.tag}
            onClick={(event) => {
              event.stopPropagation();
              onPinCard?.(pin.cardId);
            }}
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full px-2.5 py-1 text-[11.5px] font-bold text-white shadow-[0_2px_6px_rgb(15_23_42/0.22)] ring-1 ring-white"
            style={{ left: `${12 + ((index * 23) % 76)}%`, top: `${14 + ((index * 31) % 70)}%`, backgroundColor: { verified: '#16A34A', booked: '#2563EB', funded: '#6900CC', pending_verification: '#D97706', empty_house: '#6B7280' }[pin.tag] }}
          >
            {formatDynamic(pin.amount)}
          </button>
        ))}
      </div>
    </div>
  );
}

function Launcher() {
  const { overlayOpen, mapExpanded } = useOverlayState();
  return <AgentAssistant compact hideLauncher={launcherHidden({ isDashboardRoute: true, overlayOpen, mapExpanded, assistantChatOpen: false })} />;
}

export default function FunderV3Harness() {
  const [params] = useSearchParams();
  const view = params.get('view') ?? 'houses';
  const ui = params.get('ui') ?? 'v3';
  const total = Number(params.get('total') ?? 2534);
  const state = params.get('state') ?? 'ready';
  const loc = (params.get('loc') ?? 'granted') as 'granted' | 'prompt' | 'denied';
  const tagsParam = params.get('tags');
  const boardTagsOn = tagsParam === 'on' || tagsParam === 'board';
  const boardMode = tagsParam === 'board';
  const demote = useMemo<FunderV3DemoteApi | null>(
    () =>
      params.get('demote') === '1'
        ? {
            // Fake server: the first ticked item is skipped once two or more are sent.
            submit: async (items) => ({
              demoted_count: items.length >= 2 ? items.length - 1 : items.length,
              skipped: items.length >= 2 ? [{ kind: items[0].kind, id: items[0].id, reason: 'ALREADY_FUNDED', message: 'Already funded, left on the board' }] : [],
            }),
          }
        : null,
    [params],
  );
  const [loaded, setLoaded] = useState(() => Number(params.get('count') ?? 12));
  const [open, setOpen] = useState(view === 'houses');
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const unchecked = params.get('unchecked') === '1';
  const items = useMemo(() => {
    if (state === 'empty') return [];
    const feed = makeFeed(Math.min(loaded, total));
    // The live feed reads verified houses only (p_verified_only); with unchecked=1,
    // every third empty house has not been checked by Welile (house_listings.verified = false).
    let n = 0;
    return feed.map((entry) => {
      if (entry.category !== 'empty') return entry;
      n += 1;
      return { ...entry, item: { ...entry.item, verified: !(unchecked && n % 3 === 1) } };
    });
  }, [loaded, total, state, unchecked]);
  const tagOf = (entry: FeedEntry): BoardTag | null => {
    if (!boardTagsOn) return null;
    return entry.category === 'empty' ? 'empty_house' : 'verified';
  };
  // E72b fixture board: the two fundable plans are Verified, plus one Verified held by a funder, one Verified not loaded yet,
  // Booked, Funded and Pending verification items (view only). The real grouping helper builds the list.
  const board = useMemo<{ items: BoardItem[]; counts: BoardItemsCounts } | null>(() => {
    if (!boardMode) return null;
    const make = (id: string, tag: BoardItem['tag'], i: number, extra: Partial<BoardItem> = {}): BoardItem => ({
      id, tag, selectable: tag === 'verified', held: false, tenantFirstName: ['Grace', 'Moses', 'Ruth', 'Isaac'][i % 4],
      houseCategory: ['Single Room', 'Double Room', 'Self Contained', 'Two Bedroom House'][i % 4], city: ['Kira', 'Ntinda', 'Nansana', 'Mukono'][i % 4],
      mainPhoto: null, photos: [], rentAmount: 250000 + i * 50000, durationDays: 30, dailyRepayment: null, lat: 0.33 + i * 0.012, lng: 32.55 + i * 0.015, sortAt: null, ...extra,
    });
    const items: BoardItem[] = [
      make('plan-0', 'verified', 0),
      make('plan-1', 'verified', 1),
      make('rq-held', 'verified', 2, { selectable: false, held: true }),
      // Selectable on the server but its page of fundable plans has not loaded: still a fundable card.
      make('rq-late', 'verified', 8),
      make('rq-b1', 'booked', 3), make('rq-b2', 'booked', 4),
      make('rq-f1', 'funded', 5),
      make('rq-p1', 'pending_verification', 6), make('rq-p2', 'pending_verification', 7),
    ];
    return {
      items,
      counts: { verified: 4, verified_ugx: 1550000, booked: 2, funded: 1, pending_verification: 2, pending_verification_ugx: 1050000, ready_total: 6, ready_total_ugx: 2600000 },
    };
  }, [boardMode]);
  const boardGroups = useMemo(() => {
    if (!board) return null;
    return buildBoardGroups<FeedEntry>({
      board: board.items,
      ready: items.filter((e) => e.category === 'ready'),
      empty: items.filter((e) => e.category === 'empty'),
      sort: 'recommended',
      radiusKm: null,
      kmOfEntry: () => null,
      kmOfItem: () => null,
      filters: { search: '', location: '', amount: 'all', rentMin: null, rentMax: null },
      emptyTotal: Math.max(0, total - items.filter((e) => e.category === 'ready').length),
    });
  }, [board, items, total]);
  const boardPins = useMemo(
    () =>
      (boardGroups ?? []).flatMap((g) =>
        g.tag === 'empty_house'
          ? []
          : g.rows.map((row, i) => ({
              id: row.kind === 'board' ? row.item.id : itemId('ready', row.entry.item),
              cardId: row.cardId,
              lat: row.kind === 'board' ? row.item.lat ?? 0.35 : 0.36,
              lng: row.kind === 'board' ? row.item.lng ?? 32.6 : 32.6 + i * 0.01,
              amount: row.kind === 'board' ? row.item.rentAmount : 320000,
              tag: row.tag,
            })),
      ),
    [boardGroups],
  );
  const api = fixtureApi({
    boardTagsOn,
    boardTagOf: tagOf,
    boardGroups,
    // Header totals are COO/CEO only (funders_board_can_demote), like the live section.
    boardCounts: demote ? board?.counts ?? null : null,
    boardPins,
    items,
    filteredTotal: state === 'empty' ? 0 : total,
    feedLoading: state === 'loading',
    feedError: state === 'error',
    location: fixtureLocation(loc, loc === 'granted'),
    searchInput: search,
    setSearchInput: setSearch,
    fetchNextFeed: () => setLoaded((n) => n + 12),
    isSaved: (category, id) => saved.has(`${category}:${id}`),
    isSelected: (category, id) => selected.has(`${category}:${id}`),
    toggleSave: (category, id) => setSaved((prev) => toggle(prev, `${category}:${id}`)),
    toggleSelect: (category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan) =>
      setSelected((prev) => toggle(prev, `${category}:${itemId(category, item)}`)),
    openDetail: (category, item) => setDetail(`${category}:${itemId(category, item)}`),
  });

  if (ui === 'old') {
    // The live presentation on the same fixtures: max-w-lg column, viewport breakpoints.
    const prefix = getDynamicCurrencySymbol();
    return (
      <div data-testid="fv3-harness-old" className="min-h-dvh bg-background">
        <main className="mx-auto w-full max-w-lg space-y-3 px-3 py-3">
          <section className="rounded-3xl bg-primary px-5 py-5 text-primary-foreground">
            <h1 className="text-3xl font-black">Earn monthly 15% of your money</h1>
            <p className="mt-3 text-right text-[22px] font-black text-green-300">{prefix} {formatDynamic(FIXTURE_SUMMARY.totalRentNeeded).replace(prefix, '').trim()}</p>
          </section>
          <div className="grid gap-0 sm:grid-cols-2 sm:gap-3">
            {items.map((entry) => (
              <FunderNewHouseCard
                key={`${entry.category}:${itemId(entry.category, entry.item)}`}
                category={entry.category}
                item={entry.item}
                saved={false}
                selected={false}
                distance={api.distanceFor(entry)}
                onSave={() => {}}
                onSelect={() => {}}
                onDetail={() => {}}
                boardTagsOn={boardTagsOn}
              />
            ))}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div data-testid="fv3-harness" className="min-h-dvh bg-background">
      <div className="pb-nav">
        <FunderV3Home
          avatar={<div className="h-[72px] w-[72px] rounded-full bg-primary/15" aria-hidden />}
          firstName="Mark"
          locationLabel="Kampala"
          openHouses={FIXTURE_SUMMARY.houseCount}
          avgRentLabel="UGX 487K"
          onViewPortfolio={() => {}}
          summary={FIXTURE_SUMMARY}
          summaryLoading={false}
          summaryError={false}
          emptyHousesAllowed
          onOpenHouses={() => setOpen(true)}
        />
      </div>
      {open ? (
        <FunderV3HousesScreen
          api={api}
          onClose={() => setOpen(false)}
          demote={demote}
          renderMap={(props) =>
            params.get('map') === 'real' ? (
              <FunderV3Map filters={api.filters} location={api.location} {...props} />
            ) : (
              <FakeMap api={api} {...props} />
            )
          }
        />
      ) : null}
      {detail ? (
        <div role="dialog" data-state="open" aria-label="House details" data-testid="fv3-harness-detail" className="fixed inset-x-0 bottom-0 z-[1300] rounded-t-2xl bg-card p-4 shadow-2xl">
          <p className="text-sm font-semibold">Details for {detail}</p>
          <button type="button" className="mt-2 h-11 rounded-xl bg-muted px-4 text-sm" onClick={() => setDetail(null)}>
            Close
          </button>
        </div>
      ) : null}
      <Launcher />
    </div>
  );
}

function toggle(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
