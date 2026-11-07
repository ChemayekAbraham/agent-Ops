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
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { FunderNewCategory, FunderNewEmptyHouse, FunderNewReadyPlan } from '@/components/funder-new/types';
import { itemId } from '@/components/funder-new/utils';
import { FunderNewHouseCard } from '@/components/funder-new/FunderNewHouseCard';
import { FunderV3HousesScreen, type FunderV3MapRenderProps } from '@/components/funder-v3/FunderV3HousesScreen';
import { FunderV3Home } from '@/components/funder-v3/FunderV3Home';
import { AgentAssistant } from '@/components/agent/AgentAssistant';
import { launcherHidden, useOverlayState } from '@/components/FloatingToolbar';
import { FIXTURE_SUMMARY, fixtureApi, fixtureLocation, makeFeed } from '@/components/funder-v3/__fixtures__/funderV3Fixtures';
import { formatDynamic } from '@/lib/currencyFormat';
import { getDynamicCurrencySymbol } from '@/lib/currencyFormat';

function FakeMap({ api, activeHouseId, onPinHouse, insets }: FunderV3MapRenderProps & { api: ReturnType<typeof fixtureApi> }) {
  const pins = api.items.filter((entry) => entry.category === 'empty').slice(0, 40) as Array<{ category: 'empty'; item: FunderNewEmptyHouse }>;
  return (
    <div data-testid="fv3-fake-map" className="relative h-full w-full overflow-hidden bg-[hsl(140_20%_88%)] dark:bg-[hsl(220_15%_18%)]">
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
              onClick={() => onPinHouse(house)}
              className={`absolute -translate-x-1/2 -translate-y-full rounded-full border px-2 py-1 text-[11px] font-bold shadow ${active ? 'z-10 border-white bg-green-600 text-white' : 'border-green-300 bg-white text-green-700'}`}
              style={{ left: `${x}%`, top: `${y}%` }}
            >
              {formatDynamic(Number(house.monthly_rent) || 100000)}
            </button>
          );
        })}
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
  const [loaded, setLoaded] = useState(() => Number(params.get('count') ?? 12));
  const [open, setOpen] = useState(view === 'houses');
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const items = useMemo(() => (state === 'empty' ? [] : makeFeed(Math.min(loaded, total))), [loaded, total, state]);
  const api = fixtureApi({
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
          renderMap={(props) => <FakeMap api={api} {...props} />}
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
