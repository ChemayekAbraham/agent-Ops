import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Filter, List, Map as MapIcon, MapPin, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FunderListingsViewApi } from '@/components/supporter/FunderHouseListingsSection';
import type { FunderNewEmptyHouse } from '@/components/funder-new/types';
import { locationNoticeState } from '@/components/funder-new/FunderNewLocationNotice';
import { FunderV3HousesList, type FunderV3HousesListHandle } from './FunderV3HousesList';
import { FunderV3Sheet, snapHeights, type SheetSnap } from './FunderV3Sheet';
import type { FunderV3MapInsets } from './FunderV3Map';
import { useLayoutMode, usePrefersReducedMotion, useViewportHeight } from './useLayoutMode';
import './funderV3.css';

/** "Show houses near you" chip: dismissal is remembered for 7 days (a timestamp, never a position). */
const CHIP_DISMISSED_KEY = 'welile.funder-v3.location-chip-dismissed-at';
const CHIP_DISMISS_MS = 7 * 24 * 60 * 60 * 1000;

export function readChipDismissed(now = Date.now()): boolean {
  try {
    const at = Number(window.localStorage.getItem(CHIP_DISMISSED_KEY) || 0);
    return at > 0 && now - at < CHIP_DISMISS_MS;
  } catch {
    return false;
  }
}

function writeChipDismissed() {
  try {
    window.localStorage.setItem(CHIP_DISMISSED_KEY, String(Date.now()));
  } catch {
    /* private mode: the chip simply comes back */
  }
}

export interface FunderV3MapRenderProps {
  activeHouseId: string | null;
  onPinHouse: (house: FunderNewEmptyHouse) => void;
  insets: FunderV3MapInsets;
  showLoadedNote: boolean;
}

/** "12 of 2,534" — loaded cards against the filtered total the list already has. */
export function countLabel(shown: number, filteredTotal: number): string {
  return `${shown.toLocaleString()} of ${filteredTotal.toLocaleString()}`;
}

/**
 * The "Houses to fund" screen.
 *
 *  • compact / medium (< 1024px): full-bleed map, floating search under the
 *    safe area, a bottom sheet with the list (centred, max 720px, on medium) and
 *    a Map/List toggle in the thumb zone.
 *  • expanded (≥ 1024px): split view — list pane on the left with its own wheel
 *    scroll, the map filling the rest. Hovering a card lights its pin; clicking
 *    a pin scrolls to its card and highlights it.
 *
 * Re-lays out live when the window crosses a breakpoint; the list, filters and
 * selection live in the listing section above, so nothing resets.
 */
export function FunderV3HousesScreen({
  api,
  onClose,
  renderMap,
  listTop,
  listOverlay,
  listLoadingOverride = false,
}: {
  api: FunderListingsViewApi;
  onClose: () => void;
  renderMap: (props: FunderV3MapRenderProps) => ReactNode;
  /** Shown above the cards (e.g. the approval banner). */
  listTop?: ReactNode;
  /** Covers the cards (e.g. the agreement lock). */
  listOverlay?: ReactNode;
  /** The dashboard's own first-load skeleton (kept from the live screen). */
  listLoadingOverride?: boolean;
}) {
  const mode = useLayoutMode();
  const reducedMotion = usePrefersReducedMotion();
  const expanded = mode === 'expanded';

  const [snap, setSnap] = useState<SheetSnap>('half');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const listHandle = useRef<FunderV3HousesListHandle | null>(null);
  const sheetContentRef = useRef<HTMLDivElement | null>(null);
  const paneScrollRef = useRef<HTMLDivElement | null>(null);
  const searchBarRef = useRef<HTMLDivElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const [topReserve, setTopReserve] = useState(76);
  const viewportHeight = useViewportHeight();

  // While this screen is up the app header, role nav and assistant launcher step aside.
  useEffect(() => {
    document.body.dataset.mapExpanded = 'true';
    const timer = window.setTimeout(() => backRef.current?.focus({ preventScroll: true }), 60);
    return () => {
      window.clearTimeout(timer);
      delete document.body.dataset.mapExpanded;
    };
  }, []);

  // Escape closes the screen, unless a dialog on top is handling it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Room the floating search takes at the top (safe area included), measured live.
  useLayoutEffect(() => {
    if (expanded) return;
    const bar = searchBarRef.current;
    if (!bar) return;
    const measure = () => setTopReserve(Math.round(bar.getBoundingClientRect().bottom + 8));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [expanded]);

  const [chipDismissed, setChipDismissed] = useState(readChipDismissed);
  const chipState = locationNoticeState(api.location, chipDismissed);
  const dismissChip = useCallback(() => {
    writeChipDismissed();
    setChipDismissed(true);
  }, []);

  const onPinHouse = useCallback(
    (house: FunderNewEmptyHouse) => {
      const cardId = `empty:${house.house_id}`;
      if (expanded && listHandle.current?.scrollToCard(cardId)) {
        setHighlightedId(cardId);
        return;
      }
      // Phones and tablets keep the live behaviour: a pin opens the house.
      api.openDetail('empty', house);
    },
    [api, expanded],
  );

  const activeCard = hoveredId ?? highlightedId;
  const activeHouseId = activeCard?.startsWith('empty:') ? activeCard.slice('empty:'.length) : null;

  const shown = api.items.length;
  const counting = api.feedLoading || listLoadingOverride;

  const titleRow = (
    <div className="flex min-w-0 items-center gap-2">
      <h2 className="fv3-t-base font-bold text-foreground">Houses to fund</h2>
      <span data-testid="fv3-count" className="rounded-full bg-primary/10 px-2 py-0.5 fv3-t-2xs font-semibold tabular-nums text-primary">
        {counting ? '…' : countLabel(shown, api.filteredTotal)}
      </span>
    </div>
  );

  const chip = chipState ? (
    chipState === 'prompt' ? (
      <div className="flex min-w-0 items-center gap-1" data-testid="fv3-location-chip">
        <button
          type="button"
          onClick={api.location.request}
          disabled={api.location.status === 'locating'}
          className="inline-flex h-9 min-w-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-3 fv3-t-xs font-semibold text-primary hover:bg-primary/10 disabled:opacity-60"
        >
          <MapPin className="h-3.5 w-3.5 flex-none" aria-hidden />
          <span className="truncate">{api.location.status === 'locating' ? 'Finding you…' : 'Show houses near you'}</span>
        </button>
        <button type="button" onClick={dismissChip} aria-label="Not now" className="fv3-tap flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    ) : (
      <div className="flex min-w-0 items-center gap-1 rounded-full bg-muted/70 pl-3 fv3-t-2xs text-muted-foreground" role="status" data-testid="fv3-location-chip">
        <MapPin className="h-3.5 w-3.5 flex-none" aria-hidden />
        <span className="min-w-0 py-1.5 leading-snug">Location is off. Turn it on in your browser settings to see houses near you.</span>
        <button type="button" onClick={dismissChip} aria-label="Dismiss" className="fv3-tap flex flex-none items-center justify-center rounded-full hover:text-foreground">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    )
  ) : null;

  const searchField = (
    <label className="relative flex min-w-0 flex-1 items-center">
      <span className="sr-only">Search houses and rent plans by type or location</span>
      <Search className="pointer-events-none absolute left-3.5 h-[1.1em] w-[1.1em] text-muted-foreground" aria-hidden />
      <input
        value={api.searchInput}
        onChange={(event) => api.setSearchInput(event.target.value)}
        placeholder="Search house type or location…"
        aria-label="Search houses and rent plans by type or location"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
        data-testid="fv3-search"
        className="h-11 w-full min-w-0 rounded-full bg-transparent pl-10 pr-10 fv3-t-base text-foreground outline-none placeholder:text-muted-foreground"
      />
      {api.searchInput ? (
        <button type="button" aria-label="Clear search" onClick={() => api.setSearchInput('')} className="fv3-tap absolute right-0 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" aria-hidden />
        </button>
      ) : null}
    </label>
  );

  const filtersActive = api.activeFilterCount > 0;
  const filtersButton = (
    <button
      type="button"
      onClick={api.openFilters}
      aria-label={filtersActive ? `Filters, ${api.activeFilterCount} applied` : 'Filters'}
      className={cn('fv3-tap relative flex flex-none items-center justify-center rounded-full hover:bg-muted', filtersActive ? 'text-primary' : 'text-muted-foreground')}
    >
      <Filter className="h-5 w-5" aria-hidden />
      {filtersActive ? (
        <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground" aria-hidden>
          {api.activeFilterCount}
        </span>
      ) : null}
    </button>
  );

  const backButton = (
    <button
      ref={backRef}
      type="button"
      onClick={onClose}
      aria-label="Close houses to fund"
      className="fv3-tap flex flex-none items-center justify-center rounded-full text-foreground hover:bg-muted"
    >
      <ArrowLeft className="h-5 w-5" aria-hidden />
    </button>
  );

  const listBody = (scrollRef: React.RefObject<HTMLElement | null>) => (
    <div className="relative flex flex-col gap-3" id="opportunities">
      {listOverlay}
      {listTop}
      {listLoadingOverride ? (
        <div className="space-y-3" aria-busy="true">
          <div className="fv3-skeleton h-40 rounded-2xl" />
          <div className="fv3-skeleton h-40 rounded-2xl" />
        </div>
      ) : (
        <FunderV3HousesList
          ref={listHandle}
          api={api}
          scrollRef={scrollRef}
          highlightedId={highlightedId}
          onHoverCard={expanded ? setHoveredId : undefined}
          reducedMotion={reducedMotion}
        />
      )}
    </div>
  );

  if (expanded) {
    return (
      <div
        className="fv3 fv3-screen fixed inset-0 z-[70] grid bg-background"
        style={{ gridTemplateColumns: 'clamp(380px, 36vw, 560px) minmax(0, 1fr)' }}
        role="dialog"
        aria-modal="true"
        aria-label="Houses to fund"
        data-testid="fv3-houses"
        data-layout="expanded"
      >
        <aside className="flex min-h-0 flex-col border-r border-border/60 bg-background">
          <div className="flex-none space-y-3 border-b border-border/50 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <div className="flex items-center gap-2">
              {backButton}
              {titleRow}
            </div>
            <div className="flex items-center gap-1 rounded-full bg-muted/60 pr-1 ring-1 ring-border/60 focus-within:ring-2 focus-within:ring-ring">
              {searchField}
              {filtersButton}
            </div>
            {chip}
          </div>
          <div
            ref={paneScrollRef}
            data-testid="fv3-pane-scroll"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-8 pt-3 [scrollbar-gutter:stable]"
          >
            {listBody(paneScrollRef)}
          </div>
        </aside>
        <div className="relative min-h-0 min-w-0">
          {renderMap({ activeHouseId, onPinHouse, insets: { top: 0, right: 0, bottom: 0, left: 0 }, showLoadedNote: true })}
        </div>
      </div>
    );
  }

  const heights = snapHeights(viewportHeight, topReserve);
  const toggleToMap = snap === 'full';

  return (
    <div
      className="fv3 fv3-screen fixed inset-0 z-[70] overflow-hidden bg-background"
      role="dialog"
      aria-modal="true"
      aria-label="Houses to fund"
      data-testid="fv3-houses"
      data-layout={mode}
    >
      <div className="absolute inset-0">
        {renderMap({ activeHouseId, onPinHouse, insets: { top: topReserve, right: 0, bottom: heights[snap], left: 0 }, showLoadedNote: false })}
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div
          ref={searchBarRef}
          className="pointer-events-auto mx-auto flex h-12 w-full max-w-[720px] items-center gap-0.5 rounded-full bg-card pl-1 pr-1 shadow-[0_2px_12px_hsl(var(--foreground)/0.22)] ring-1 ring-border/50 focus-within:ring-2 focus-within:ring-ring"
        >
          {backButton}
          {searchField}
          {filtersButton}
        </div>
      </div>

      <FunderV3Sheet
        snap={snap}
        onSnapChange={setSnap}
        topReserve={topReserve}
        contentRef={sheetContentRef}
        centred={mode === 'medium'}
        bottomPadding={64}
        header={
          <div className="space-y-2">
            {titleRow}
            {chip}
          </div>
        }
      >
        {listBody(sheetContentRef)}
      </FunderV3Sheet>

      {/* Map/List toggle, in the thumb zone. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center pb-[calc(env(safe-area-inset-bottom,0px)+16px)]">
        <button
          type="button"
          data-testid="fv3-toggle"
          onClick={() => setSnap(toggleToMap ? 'peek' : 'full')}
          className="fv3-tap pointer-events-auto inline-flex h-11 items-center gap-2 rounded-full bg-foreground px-5 fv3-t-sm font-semibold text-background shadow-lg transition-transform active:scale-95"
        >
          {toggleToMap ? <MapIcon className="h-4 w-4" aria-hidden /> : <List className="h-4 w-4" aria-hidden />}
          {toggleToMap ? 'Map' : 'List'}
        </button>
      </div>
    </div>
  );
}

export default FunderV3HousesScreen;
