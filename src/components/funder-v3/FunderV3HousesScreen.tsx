import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Filter, ListChecks, MapPin, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { FeedEntry, FunderListingsViewApi } from '@/components/supporter/FunderHouseListingsSection';
import type { BoardKind, DemoteReason, DemoteResult } from '@/lib/fundersBoard';
import { boardItemFor } from '@/components/funder-new/FundersBoardTag';
import type { FunderNewEmptyHouse } from '@/components/funder-new/types';
import { locationNoticeState } from '@/components/funder-new/FunderNewLocationNotice';
import { FunderV3HousesList, type FunderV3HousesListHandle } from './FunderV3HousesList';
import { FunderV3MapControls } from './FunderV3MapControls';
import { FunderV3DemoteSheet } from './FunderV3DemoteSheet';
import { cardIdOf } from './FunderV3HousesList';
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
  /** false while the map is the still preview above the list (phones and tablets). */
  interactive: boolean;
  /** Tapping the still preview opens it full screen. */
  onMapTap?: () => void;
  /** px the visible part of the map sits below the canvas centre (half the shrink, once settled). */
  centreOffsetY?: number;
  /** E59: colour pins by funders board tag. */
  boardTagsOn: boolean;
}

/** E59 demote, given only to viewers for whom funders_board_can_demote() is true. */
export interface FunderV3DemoteApi {
  submit: (items: { kind: BoardKind; id: string }[], reason: DemoteReason, note: string) => Promise<DemoteResult>;
}

/** "3 demoted · 1 skipped" */
export function demoteToastTitle(result: DemoteResult): string {
  return `${result.demoted_count} demoted · ${result.skipped.length} skipped`;
}

/** "12 of 2,534" — loaded cards against the filtered total the list already has. */
export function countLabel(shown: number, filteredTotal: number): string {
  return `${shown.toLocaleString()} of ${filteredTotal.toLocaleString()}`;
}

/** Map height on phones/tablets: half the screen at the top of the list, a quarter once scrolled. */
export const MAP_OPEN_FRACTION = 0.5;
export const MAP_PINNED_FRACTION = 0.25;

/**
 * How far the map has shrunk for a list scroll position, in px (0 = half the
 * screen, `mapHeight * (1 - pinned/open)` = a quarter). The list scrolls 1:1
 * with the map's bottom edge until the map is pinned.
 */
export function mapShrinkFor(scrollTop: number, mapHeight: number): number {
  const max = mapHeight * (1 - MAP_PINNED_FRACTION / MAP_OPEN_FRACTION);
  return Math.min(Math.max(scrollTop, 0), max);
}

const HISTORY_KEY = 'fv3Houses';

/**
 * The "Houses to fund" screen.
 *
 *  • compact / medium (< 1024px): one scroll. The map fills the top half; as
 *    the list scrolls it shrinks to a quarter and stays pinned while houses
 *    scroll under it (scroll-driven, transforms only), and grows back at the
 *    top. The search bar stays over the map. Tapping the map (or its expand
 *    button) opens it full screen. Houses are 1 per row on phones, 2 on tablets.
 *  • expanded (≥ 1024px): split view — list pane on the left with its own wheel
 *    scroll, the map filling the rest.
 *
 * Tapping a pin scrolls the list to that house and highlights it (or opens the
 * house when its card is not loaded). Back (button, Escape or the browser's
 * back) always returns to the funder home.
 *
 * The root is a full page region, not role="dialog": the platform's Android
 * compositor rules (html.android-compositor-safe) strip transforms and sticky
 * positioning inside dialogs, which would freeze the map and the list.
 */
export function FunderV3HousesScreen({
  api,
  onClose,
  renderMap,
  listTop,
  listOverlay,
  listLoadingOverride = false,
  demote = null,
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
  /** E59: null (default) = no demote controls at all. */
  demote?: FunderV3DemoteApi | null;
}) {
  const mode = useLayoutMode();
  const reducedMotion = usePrefersReducedMotion();
  const expanded = mode === 'expanded';
  const viewportHeight = useViewportHeight();

  const [mapFull, setMapFull] = useState(false);
  const mapFullRef = useRef(mapFull);
  mapFullRef.current = mapFull;
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const listHandle = useRef<FunderV3HousesListHandle | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const mapWindowRef = useRef<HTMLDivElement | null>(null);
  const paneScrollRef = useRef<HTMLDivElement | null>(null);
  const searchBarRef = useRef<HTMLDivElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const [topReserve, setTopReserve] = useState(76);
  const [centreOffset, setCentreOffset] = useState(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // E59 select-to-demote.
  const [demoteMode, setDemoteMode] = useState(false);
  const [demoteChecked, setDemoteChecked] = useState<Map<string, { kind: BoardKind; id: string }>>(() => new Map());
  const [demoteSheetOpen, setDemoteSheetOpen] = useState(false);
  const [demoteBusy, setDemoteBusy] = useState(false);
  const demoteIds = useMemo(() => new Set(demoteChecked.keys()), [demoteChecked]);
  const leaveDemoteMode = useCallback(() => {
    setDemoteMode(false);
    setDemoteChecked(new Map());
    setDemoteSheetOpen(false);
  }, []);
  const toggleDemoteMode = useCallback(() => {
    if (demoteMode) leaveDemoteMode();
    else setDemoteMode(true);
  }, [demoteMode, leaveDemoteMode]);
  const toggleDemoteCard = useCallback((entry: FeedEntry) => {
    const cardId = cardIdOf(entry);
    setDemoteChecked((prev) => {
      const next = new Map(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.set(cardId, boardItemFor(entry.category, entry.item));
      return next;
    });
  }, []);
  const confirmDemote = useCallback(
    async (reason: DemoteReason, note: string) => {
      if (!demote || demoteChecked.size === 0) return;
      setDemoteBusy(true);
      try {
        const result = await demote.submit(Array.from(demoteChecked.values()), reason, note);
        const skips = result.skipped.map((skip) => skip.message).filter(Boolean);
        toast.success(
          demoteToastTitle(result),
          skips.length
            ? {
                description: (
                  <ul className="mt-1 list-disc space-y-0.5 pl-4" data-testid="fv3-demote-skips">
                    {skips.map((message, index) => (
                      <li key={index}>{message}</li>
                    ))}
                  </ul>
                ),
              }
            : undefined,
        );
        leaveDemoteMode();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Could not demote.');
      } finally {
        setDemoteBusy(false);
      }
    },
    [demote, demoteChecked, leaveDemoteMode],
  );

  // While this screen is up the app header, role nav and assistant launcher step aside.
  useEffect(() => {
    document.body.dataset.mapExpanded = 'true';
    const timer = window.setTimeout(() => backRef.current?.focus({ preventScroll: true }), 60);
    return () => {
      window.clearTimeout(timer);
      delete document.body.dataset.mapExpanded;
    };
  }, []);

  // The screen owns one history entry, so the phone's back gesture returns to
  // the funder home instead of leaving the dashboard.
  useEffect(() => {
    const state = (window.history.state ?? {}) as Record<string, unknown>;
    if (!state[HISTORY_KEY]) window.history.pushState({ ...state, [HISTORY_KEY]: true }, '');
    const onPop = () => {
      const now = (window.history.state ?? {}) as Record<string, unknown>;
      if (!now[HISTORY_KEY]) onCloseRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const demoteModeRef = useRef(demoteMode);
  demoteModeRef.current = demoteMode;
  const leaveDemoteModeRef = useRef(leaveDemoteMode);
  leaveDemoteModeRef.current = leaveDemoteMode;

  const close = useCallback(() => {
    const state = (window.history.state ?? {}) as Record<string, unknown>;
    if (state[HISTORY_KEY]) window.history.back();
    else onCloseRef.current();
  }, []);

  // Escape closes the full screen map first, then the screen — unless a dialog on top handles it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;
      if (mapFullRef.current) setMapFull(false);
      else if (demoteModeRef.current) leaveDemoteModeRef.current();
      else close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  // The full screen map only exists on phones and tablets.
  useEffect(() => {
    if (expanded) setMapFull(false);
  }, [expanded]);

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

  // Scroll-driven map: passive listener + one rAF per frame, transform only.
  // The window slides up with the list until a quarter of the screen is left,
  // then stays pinned. The canvas never changes size and keeps its bottom (and
  // Google's logo) in view; once scrolling settles, the map pans by half the
  // shrink so its centre is back in the middle of what is visible.
  useLayoutEffect(() => {
    if (expanded) return;
    const scroller = scrollerRef.current;
    const win = mapWindowRef.current;
    if (!scroller || !win) return;
    let frame = 0;
    let settle = 0;
    let shrink = 0;
    const apply = () => {
      frame = 0;
      if (mapFullRef.current) {
        win.style.transform = '';
        win.dataset.shrink = '0';
        return;
      }
      const height = win.offsetHeight;
      shrink = mapShrinkFor(scroller.scrollTop, height);
      win.style.transform = shrink ? `translate3d(0, ${-shrink}px, 0)` : '';
      win.dataset.shrink = height ? (shrink / height).toFixed(3) : '0';
    };
    const settled = () => setCentreOffset(Math.round(shrink / 2));
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(apply);
      window.clearTimeout(settle);
      settle = window.setTimeout(settled, 160);
    };
    apply();
    settled();
    scroller.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      scroller.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [expanded, mapFull]);

  const [chipDismissed, setChipDismissed] = useState(readChipDismissed);
  const chipState = locationNoticeState(api.location, chipDismissed);
  const dismissChip = useCallback(() => {
    writeChipDismissed();
    setChipDismissed(true);
  }, []);

  const onPinHouse = useCallback(
    (house: FunderNewEmptyHouse) => {
      const cardId = `empty:${house.house_id}`;
      const reveal = () => {
        if (listHandle.current?.scrollToCard(cardId)) {
          setHighlightedId(cardId);
          return;
        }
        // The pin is an area or a house whose card is not loaded: open the house, as live.
        api.openDetail('empty', house);
      };
      if (mapFullRef.current) {
        setMapFull(false);
        window.requestAnimationFrame(() => window.requestAnimationFrame(reveal));
      } else reveal();
    },
    [api],
  );

  const openMapFull = useCallback(() => setMapFull(true), []);
  const toggleMapFull = useCallback(() => setMapFull((on) => !on), []);

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
      onClick={close}
      aria-label="Back to your dashboard"
      data-testid="fv3-back"
      className="fv3-tap flex flex-none items-center justify-center rounded-full text-foreground hover:bg-muted"
    >
      <ArrowLeft className="h-5 w-5" aria-hidden />
    </button>
  );

  const demoteToggle = demote ? (
    <button
      type="button"
      onClick={toggleDemoteMode}
      aria-pressed={demoteMode}
      data-testid="fv3-demote-toggle"
      className={cn(
        'inline-flex min-h-11 w-fit items-center gap-2 rounded-full px-4 fv3-t-sm font-semibold ring-1 transition-colors',
        demoteMode ? 'bg-destructive/10 text-destructive ring-destructive/40' : 'bg-card text-foreground ring-border hover:bg-muted',
      )}
    >
      <ListChecks className="h-4 w-4" aria-hidden />
      {demoteMode ? 'Cancel selecting' : 'Select to demote'}
    </button>
  ) : null;

  // Sticky bar for the selection: inside the screen (a page region), never in a dialog.
  const demoteBar =
    demote && demoteMode ? (
      <div
        data-testid="fv3-demote-bar"
        className="pointer-events-auto flex items-center gap-3 rounded-2xl bg-card p-2 pl-4 shadow-[0_-2px_18px_hsl(var(--foreground)/0.18)] ring-1 ring-border"
      >
        <span className="min-w-0 flex-1 fv3-t-sm font-semibold text-foreground" aria-live="polite">
          {demoteChecked.size === 0 ? 'Tick the houses to demote' : `${demoteChecked.size} selected`}
        </span>
        <button
          type="button"
          disabled={demoteChecked.size === 0}
          onClick={() => setDemoteSheetOpen(true)}
          data-testid="fv3-demote-open"
          className="fv3-tap inline-flex h-11 items-center rounded-xl bg-destructive px-5 fv3-t-sm font-semibold text-destructive-foreground shadow-sm transition-opacity disabled:opacity-50"
        >
          Demote {demoteChecked.size}
        </button>
      </div>
    ) : null;

  const demoteSheet = demote ? (
    <FunderV3DemoteSheet
      open={demoteSheetOpen}
      count={demoteChecked.size}
      busy={demoteBusy}
      onOpenChange={setDemoteSheetOpen}
      onConfirm={confirmDemote}
    />
  ) : null;

  const listBody = (scrollRef: React.RefObject<HTMLElement | null>, scrollPaddingTop = 0) => (
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
          scrollPaddingTop={scrollPaddingTop}
          highlightedId={highlightedId}
          onHoverCard={expanded ? setHoveredId : undefined}
          reducedMotion={reducedMotion}
          demoteMode={demoteMode}
          demoteChecked={demoteIds}
          onDemoteToggle={demote ? toggleDemoteCard : undefined}
        />
      )}
    </div>
  );

  if (expanded) {
    return (
      <div
        className="fv3 fv3-screen fixed inset-0 z-[70] grid bg-background"
        style={{ gridTemplateColumns: 'clamp(380px, 36vw, 560px) minmax(0, 1fr)' }}
        role="region"
        aria-label="Houses to fund"
        data-testid="fv3-houses"
        data-layout="expanded"
      >
        <aside className="relative flex min-h-0 flex-col border-r border-border/60 bg-background">
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
            {demoteToggle}
          </div>
          <div
            ref={paneScrollRef}
            data-testid="fv3-pane-scroll"
            className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3 [scrollbar-gutter:stable]', demoteMode ? 'pb-28' : 'pb-8')}
          >
            {listBody(paneScrollRef)}
          </div>
          {demoteBar ? <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20">{demoteBar}</div> : null}
        </aside>
        <div className="relative min-h-0 min-w-0">
          {renderMap({ activeHouseId, onPinHouse, insets: { top: 0, right: 0, bottom: 0, left: 0 }, showLoadedNote: true, interactive: true, boardTagsOn: api.boardTagsOn })}
          <div className="absolute bottom-4 right-4 z-20">
            <FunderV3MapControls location={api.location} />
          </div>
        </div>
        {demoteSheet}
      </div>
    );
  }

  // Phones and tablets: the map window is sticky at the top of the one scroll.
  // Full screen: same map instance, the window grows to the whole screen (the
  // negative margin keeps the list where it was) and the list stops scrolling.
  const pinnedHeight = Math.round(viewportHeight * MAP_PINNED_FRACTION);

  return (
    <div
      className="fv3 fv3-screen fixed inset-0 z-[70] overflow-hidden bg-background"
      role="region"
      aria-label="Houses to fund"
      data-testid="fv3-houses"
      data-layout={mode}
      data-map-full={mapFull ? 'true' : undefined}
    >
      <div
        ref={scrollerRef}
        data-testid="fv3-scroll"
        className={cn('absolute inset-0 overscroll-contain', mapFull ? 'overflow-hidden' : 'overflow-y-auto')}
        style={{ scrollPaddingTop: pinnedHeight + 12 }}
      >
        <div
          ref={mapWindowRef}
          data-testid="fv3-map-window"
          data-full={mapFull ? 'true' : undefined}
          className="fv3-map-window sticky top-0 z-20 overflow-hidden"
        >
          <div className="absolute inset-0">
            {renderMap({
              activeHouseId,
              onPinHouse,
              insets: { top: topReserve, right: 0, bottom: 0, left: 0 },
              showLoadedNote: false,
              interactive: mapFull,
              onMapTap: openMapFull,
              centreOffsetY: mapFull ? 0 : centreOffset,
              boardTagsOn: api.boardTagsOn,
            })}
          </div>
          <div className="pointer-events-none absolute bottom-3 right-3 z-10 pb-[env(safe-area-inset-bottom,0px)]">
            <FunderV3MapControls location={api.location} fullscreen={mapFull} onToggleFullscreen={toggleMapFull} />
          </div>
        </div>

        <section
          aria-label="Houses list"
          data-testid="fv3-list-section"
          className="fv3-list-section relative z-10 bg-background pb-[calc(env(safe-area-inset-bottom,0px)+32px)]"
        >
          <div className={cn('mx-auto w-full space-y-2 px-3 pb-2 pt-4', mode === 'medium' && 'max-w-[980px] px-5')}>
            {titleRow}
            {chip}
            {demoteToggle}
          </div>
          <div className={cn('mx-auto w-full px-3', mode === 'medium' && 'max-w-[980px] px-5', demoteMode && 'pb-24')}>
            {listBody(scrollerRef, pinnedHeight + 12)}
          </div>
        </section>
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

      {demoteBar && !mapFull ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]">
          <div className={cn('mx-auto w-full', mode === 'medium' ? 'max-w-[720px]' : '')}>{demoteBar}</div>
        </div>
      ) : null}
      {demoteSheet}
    </div>
  );
}

export default FunderV3HousesScreen;
