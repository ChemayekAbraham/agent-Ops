import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronsUpDown, Building2, Loader2, Search, AlertTriangle, UserPlus, X, MapPin, Phone, CornerDownLeft, Sparkles, SlidersHorizontal, Ban, ShieldCheck, ShieldAlert } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';

export interface LandlordOption {
  id: string;
  name: string;
  phone: string;
  property_address: string | null;
  /** Extended saved details, used to auto-fill the rent request form. */
  district?: string | null;
  town_council?: string | null;
  county?: string | null;
  village?: string | null;
  house_category?: string | null;
  monthly_rent?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  /** Whether the landlord has been verified by Landlord Ops. */
  verified?: boolean | null;
  /** Fuzzy-search ranking metadata (present only on search results). */
  match_score?: number | null;
  match_kind?: 'all' | 'name_exact' | 'phone' | 'fuzzy' | string | null;
}

interface LandlordSearchSelectProps {
  value: LandlordOption | null;
  onChange: (landlord: LandlordOption | null) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Increment/change this to programmatically open the search popover. */
  autoOpenSignal?: number | string;
  /** Called when the agent taps "Register new landlord" from the empty-state warning. */
  onAddNew?: () => void;
  /**
   * Render the search bar + results inline (always open, no trigger button or
   * popover). Used in mobile-first wizards where a single, obvious tap-free
   * search field is friendlier than a tap-to-open combobox.
   */
  inline?: boolean;
  /**
   * Fuzzy-match similarity threshold (0.05–0.9). Lower = more typo-tolerant
   * (more results), higher = stricter. Used as the initial slider value.
   */
  similarityThreshold?: number;
  /**
   * When set, the search is scoped to landlords registered by this agent
   * (landlords_directory.registered_by). Omit for a system-wide search.
   */
  registeredBy?: string | null;
}

/** Per-character highlight style for each match flavour. */
const HL_CLASS = {
  // Google bolds the matched terms in its results.
  exact: 'bg-transparent font-bold text-foreground',
  phone: 'bg-transparent font-bold text-[#188038] dark:text-[#81c995]',
  typo: 'bg-transparent font-bold text-[#1a73e8] dark:text-[#8ab4f8] underline decoration-dotted decoration-current/60 underline-offset-2',
} as const;

type HighlightMode = keyof typeof HL_CLASS;

/** Character indices in `text` covered by any case-insensitive occurrence of a term. */
function substringMatchedIndices(text: string, terms: string[]): Set<number> {
  const lower = text.toLowerCase();
  const set = new Set<number>();
  for (const raw of terms) {
    const t = raw.toLowerCase();
    if (!t) continue;
    let from = 0;
    let pos = lower.indexOf(t, from);
    while (pos !== -1) {
      for (let k = 0; k < t.length; k++) set.add(pos + k);
      from = pos + t.length;
      pos = lower.indexOf(t, from);
    }
  }
  return set;
}

/**
 * Character indices in `text` that align to `query` via the longest common
 * subsequence — used for typo matches where there is no contiguous substring.
 */
function lcsMatchedIndices(text: string, query: string): Set<number> {
  const a = text.toLowerCase();
  const b = query.toLowerCase().replace(/\s+/g, '');
  const n = a.length;
  const m = b.length;
  const idx = new Set<number>();
  if (!n || !m) return idx;
  // DP table of LCS lengths.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Backtrack to mark which characters of `text` participate.
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      idx.add(i);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return idx;
}

/** Render `text` with the matched character indices wrapped in highlight spans. */
function renderHighlighted(text: string, matched: Set<number>, mode: HighlightMode): ReactNode {
  if (!matched.size) return text;
  const out: ReactNode[] = [];
  let buffer = '';
  let bufferOn = matched.has(0);
  const flush = (on: boolean, key: number) => {
    if (!buffer) return;
    out.push(
      on ? (
        <mark key={key} className={cn('bg-transparent', HL_CLASS[mode])}>
          {buffer}
        </mark>
      ) : (
        <span key={key}>{buffer}</span>
      )
    );
    buffer = '';
  };
  for (let i = 0; i < text.length; i++) {
    const on = matched.has(i);
    if (on !== bufferOn) {
      flush(bufferOn, i);
      bufferOn = on;
    }
    buffer += text[i];
  }
  flush(bufferOn, text.length);
  return out;
}

/** Highlight a landlord NAME according to how the row was matched. */
function highlightName(text: string | null | undefined, query: string, kind?: string | null): ReactNode {
  const value = text ?? '';
  const term = query.trim();
  if (!value || !term) return value;
  if (kind === 'fuzzy') {
    // No contiguous substring — align character-by-character.
    const sub = substringMatchedIndices(value, [term]);
    const matched = sub.size ? sub : lcsMatchedIndices(value, term);
    return renderHighlighted(value, matched, sub.size ? 'exact' : 'typo');
  }
  return renderHighlighted(value, substringMatchedIndices(value, [term]), 'exact');
}

/** Highlight a landlord PHONE (digits matched are coloured distinctly). */
function highlightPhone(text: string | null | undefined, query: string): ReactNode {
  const value = text ?? '';
  const term = query.trim();
  if (!value || !term) return value;
  const digits = term.replace(/\D/g, '');
  const terms = [term];
  if (digits.length >= 3 && digits !== term) terms.push(digits);
  return renderHighlighted(value, substringMatchedIndices(value, terms), 'phone');
}

/**
 * Google-style searchable landlord picker.
 * Debounced typeahead querying `landlords` by name OR phone (ILIKE), capped at 20 results.
 * Supports keyboard navigation, query highlighting, a live result count, and a
 * prominent fallback warning when no registered landlords are found.
 */
// Minimum keystrokes before the landlord search runs — mirrors the LC1 search.
const MIN_QUERY_CHARS = 3;
// Hard ceiling on a single search request. Without this, a stalled request on
// a slow/flaky connection never resolves and never rejects, so the UI is left
// showing "Searching…" forever with no way out (see the 2026-09-14 Shakirah
// report — the request just hung, it wasn't a "no results" case).
const SEARCH_TIMEOUT_MS = 12000;

export function LandlordSearchSelect({
  value,
  onChange,
  placeholder = 'Search landlord by name or phone…',
  disabled,
  autoOpenSignal,
  onAddNew,
  inline = false,
  similarityThreshold = 0.2,
  registeredBy = null,
}: LandlordSearchSelectProps) {
  const [open, setOpen] = useState(false);
  // In inline mode the panel is permanently open (no trigger / popover).
  const panelOpen = inline || open;
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [results, setResults] = useState<LandlordOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // Configurable fuzzy-match precision (clamped to the RPC's valid range).
  const [threshold, setThreshold] = useState(() =>
    Math.min(Math.max(similarityThreshold, 0.05), 0.9)
  );
  const [showThreshold, setShowThreshold] = useState(false);
  // Persistent note describing the most recent in-flight search that was aborted
  // because the agent kept typing (or changed precision): which query was
  // dropped and when, so the UI can show "Cancelled 'xyz' · 3s ago" until the
  // next search resolves.
  const [cancelledInfo, setCancelledInfo] = useState<{ query: string; at: number } | null>(null);
  // True when the most recent search hit SEARCH_TIMEOUT_MS without resolving —
  // distinct from "results.length === 0", which means the search actually came
  // back with nothing. Conflating the two risks an agent registering a
  // duplicate landlord after a merely-stalled search.
  const [searchFailed, setSearchFailed] = useState(false);
  // Bumped to manually re-run the search after a timeout, without requiring
  // the agent to retype the query.
  const [retryTick, setRetryTick] = useState(0);
  // Ticks once a second while a cancellation note is showing so the elapsed
  // "…s ago" counter stays live.
  const [nowTick, setNowTick] = useState(() => Date.now());
  const cancelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reqIdRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  // Tracks the landlord currently highlighted by the keyboard, so we can keep
  // the same row highlighted (and the scroll position steady) when a fresh
  // result set arrives mid-navigation rather than snapping back to the top.
  const activeIdRef = useRef<string | null>(null);
  // Snapshot of the previous result set's ordering (by id) plus the index that
  // was highlighted within it. When the highlighted landlord disappears after a
  // query change, we walk outward from that old position to land on the nearest
  // surviving neighbour instead of jumping to the top.
  const prevOrderRef = useRef<{ ids: string[]; index: number }>({ ids: [], index: 0 });

  useEffect(() => {
    if (inline || autoOpenSignal === undefined || disabled) return;
    setOpen(true);
  }, [autoOpenSignal, disabled, inline]);

  // Debounce typing — short delay so results feel instant as you type.
  useEffect(() => {
    const next = query.trim();
    // Empty query updates immediately; otherwise wait a beat for the keystroke burst.
    if (!next) {
      setDebounced('');
      return;
    }
    const t = setTimeout(() => setDebounced(next), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Remember which landlord is highlighted (by id) plus the full result order on
  // every change, so the next result set can locate the nearest surviving row.
  useEffect(() => {
    activeIdRef.current = results[activeIndex]?.id ?? null;
    prevOrderRef.current = { ids: results.map((r) => r.id), index: activeIndex };
  }, [activeIndex, results]);

  // When a fresh result set loads — whether from a precision change, a
  // late-arriving fetch, or the agent refining the query (backspace / edits
  // mid-navigation) — keep the previously highlighted landlord selected (by id)
  // and the scroll position intact instead of snapping back to row 0. We only
  // fall back to clamping the cursor when that landlord is no longer present.
  useEffect(() => {
    const prevScroll = listRef.current?.scrollTop ?? null;
    setActiveIndex((prev) => {
      if (!results.length) {
        // Clear highlight and selection history when nothing matches.
        activeIdRef.current = null;
        prevOrderRef.current = { ids: [], index: -1 };
        return -1;
      }
      const prevId = activeIdRef.current;
      if (prevId) {
        const found = results.findIndex((r) => r.id === prevId);
        if (found !== -1) return found;
      }
      // The highlighted landlord is gone — find the nearest still-present row by
      // scanning outward (closer neighbours first) from its old position.
      const newIndexById = new Map(results.map((r, i) => [r.id, i] as const));
      const { ids: prevIds, index: prevIdx } = prevOrderRef.current;
      for (let dist = 1; dist < prevIds.length; dist++) {
        const below = prevIds[prevIdx + dist];
        if (below !== undefined && newIndexById.has(below)) return newIndexById.get(below)!;
        const above = prevIds[prevIdx - dist];
        if (above !== undefined && newIndexById.has(above)) return newIndexById.get(above)!;
      }
      // No prior neighbour survived — clamp the cursor to the new bounds.
      return Math.max(0, Math.min(prev, results.length - 1));
    });
    // Restore the scroll offset the list had before this re-render.
    if (prevScroll !== null && listRef.current) {
      const container = listRef.current;
      requestAnimationFrame(() => {
        if (container.scrollTop !== prevScroll) container.scrollTop = prevScroll;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results]);

  // Fetch on debounced/threshold change (only when popover is open).
  // Each run aborts the previous in-flight request so a slow earlier
  // response can never land after a newer one (no out-of-order results).
  useEffect(() => {
    if (!panelOpen) return;
    // Search-only list: nothing is fetched until the agent has typed at least
    // MIN_QUERY_CHARS characters (same behaviour as the LC1 chairperson search).
    if (debounced.trim().length < MIN_QUERY_CHARS) {
      reqIdRef.current++;
      setResults([]);
      setLoading(false);
      return;
    }
    const myId = ++reqIdRef.current;
    const controller = new AbortController();
    const { signal } = controller;
    // Per-request state so the cleanup can tell whether this fetch had already
    // finished (no flash) or was still in flight when superseded (flash), and
    // whether it was OUR timeout (not a supersession) that ended it.
    const reqState = { settled: false, timedOut: false };
    const isAborted = () => signal.aborted || myId !== reqIdRef.current;
    setSearchFailed(false);
    const timeoutId = setTimeout(() => {
      if (reqState.settled || myId !== reqIdRef.current) return;
      reqState.timedOut = true;
      controller.abort();
      setLoading(false);
      setResults([]);
      setCancelledInfo(null);
      setSearchFailed(true);
    }, SEARCH_TIMEOUT_MS);
    const run = async () => {
      setLoading(true);
      try {
        // Typo-tolerant fuzzy search via Postgres trigram RPC.
        // Falls back to an ILIKE query if the RPC is unavailable.
        const { data, error } = await (supabase.rpc as any)('search_landlords_fuzzy', {
          p_query: debounced,
          p_limit: 20,
          p_threshold: threshold,
          p_registered_by: registeredBy,
        }).abortSignal(signal);
        if (error) throw error;
        if (!isAborted()) {
          // Returns both verified and pending-verification landlords
          // (verified ranked first) — agents may post on a pending landlord.

          setResults(((data ?? []) as unknown as LandlordOption[]));
          // This search finished — clear any lingering cancellation note.
          setCancelledInfo(null);
        }
      } catch (err) {
        if (reqState.timedOut) return; // Already surfaced by the timeout above.
        if (isAborted()) return; // Superseded by a newer query — not a failure.
        // No ILIKE fallback: the trigram RPC is the only search path.
        // A cross-table ILIKE on `landlords` (or `landlords_directory`) with
        // ORDER BY name + LIMIT bypasses the trigram index and pins the DB CPU
        // at 100% under load, so we surface a failure state instead — never
        // silently treat a request error as "no matches", which would invite
        // registering a duplicate landlord for someone who already exists.
        console.warn('[LandlordSearchSelect] search_landlords_fuzzy failed', err);
        setResults([]);
        setSearchFailed(true);
      } finally {
        clearTimeout(timeoutId);
        reqState.settled = true;
        if (!isAborted() && !reqState.timedOut) setLoading(false);
      }
    };
    run();
    return () => {
      clearTimeout(timeoutId);
      controller.abort();
      // If this request was still loading when it got superseded, record the
      // query that was dropped so a persistent note can show which search was
      // cancelled and how long ago.
      if (!reqState.settled && !reqState.timedOut && debounced) {
        setCancelledInfo({ query: debounced, at: Date.now() });
      }
    };
  }, [debounced, panelOpen, threshold, registeredBy, retryTick]);

  // Keep the elapsed "…s ago" counter live while a cancellation note is shown.
  useEffect(() => {
    if (!cancelledInfo) {
      if (cancelTimerRef.current) clearInterval(cancelTimerRef.current);
      cancelTimerRef.current = null;
      return;
    }
    setNowTick(Date.now());
    cancelTimerRef.current = setInterval(() => setNowTick(Date.now()), 1000);
    return () => {
      if (cancelTimerRef.current) clearInterval(cancelTimerRef.current);
      cancelTimerRef.current = null;
    };
  }, [cancelledInfo]);

  // Drop the cancellation/failure notes when the search box is emptied.
  useEffect(() => {
    if (!query.trim()) {
      setCancelledInfo(null);
      setSearchFailed(false);
    }
  }, [query]);

  const triggerLabel = useMemo(() => {
    if (!value) return placeholder;
    return `${value.name} • ${value.phone}`;
  }, [value, placeholder]);

  // No standalone count round-trip: the search RPC is the only query.
  const isSystemEmpty = false;
  // True while a keystroke is still waiting out the debounce window — lets us
  // show "Searching…" the instant the agent types, before the fetch even fires.
  const isTyping = panelOpen && query.trim().length > 0 && query.trim() !== debounced;
  // Unified "working" flag: either debouncing the latest keystroke or fetching.
  const busy = loading || isTyping;
  // Below MIN_QUERY_CHARS nothing has been searched yet, so neither the
  // "no landlords in the system" nor the "no match" state applies.
  const needsMoreChars = query.trim().length < MIN_QUERY_CHARS;
  // A stalled/errored request is NOT the same as "searched and found nothing" —
  // keep it out of isSearchEmpty so the UI never offers to register a
  // duplicate landlord over what was actually a connection problem.
  const isSearchEmpty =
    !busy &&
    !needsMoreChars &&
    !searchFailed &&
    results.length === 0 &&
    debounced.length >= MIN_QUERY_CHARS;
  const isSearchFailed = !busy && !needsMoreChars && searchFailed && results.length === 0;

  // Compose a location subtitle from the most specific available fields.
  const locationLine = (l: LandlordOption) =>
    [l.property_address, l.village, l.town_council, l.county, l.district]
      .filter(Boolean)
      .join(', ');

  // Human-readable ranking context for a result, based on how it was matched.
  const matchContext = (l: LandlordOption) => {
    if (!debounced) return null;
    const pct = typeof l.match_score === 'number' ? Math.round(l.match_score * 100) : null;
    switch (l.match_kind) {
      case 'name_exact':
        return { label: 'Exact name', tone: 'exact' as const, pct };
      case 'phone':
        return { label: 'Phone match', tone: 'exact' as const, pct };
      case 'fuzzy':
        return {
          label: pct !== null ? `Typo match · ${pct}%` : 'Typo match',
          tone: 'fuzzy' as const,
          pct,
        };
      default:
        return null;
    }
  };

  // Whether any result was surfaced purely through typo tolerance.
  const hasFuzzy = useMemo(
    () => !!debounced && results.some((r) => r.match_kind === 'fuzzy'),
    [results, debounced]
  );

  const commitSelection = (l: LandlordOption) => {
    onChange(l);
    setOpen(false);
    setQuery('');
  };

  // Whole-second elapsed label for the cancellation note, recomputed each tick.
  const cancelledAgo = useMemo(() => {
    if (!cancelledInfo) return null;
    const secs = Math.max(0, Math.round((nowTick - cancelledInfo.at) / 1000));
    return secs <= 0 ? 'just now' : `${secs}s ago`;
  }, [cancelledInfo, nowTick]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    // Disable arrow-key navigation and selection when there are no results.
    if (!results.length || activeIndex < 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = results[activeIndex];
      if (chosen) commitSelection(chosen);
    }
  };

  // Keep the active row scrolled into view during keyboard navigation.
  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const container = listRef.current;
    const el = container.querySelector<HTMLElement>(`[data-row="${activeIndex}"]`);
    if (!el) return;

    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const containerTop = container.scrollTop;
    const pad = 4; // small padding so it's not hugging the edge

    const elTopRelative = elRect.top - containerRect.top + containerTop;
    const elBottomRelative = elRect.bottom - containerRect.top + containerTop;

    if (elTopRelative < containerTop + pad) {
      container.scrollTo({ top: elTopRelative - pad, behavior: 'smooth' });
    } else if (elBottomRelative > containerTop + containerRect.height - pad) {
      container.scrollTo({
        top: elBottomRelative - containerRect.height + pad,
        behavior: 'smooth',
      });
    }
  }, [activeIndex]);

  const panel = (
    <>
        <div className="px-4 pt-3.5 pb-2.5">
          {/* Simple debounced search input */}
          <div className="relative flex items-center rounded-full border border-border/70 bg-background px-4 h-11 shadow-sm transition-shadow focus-within:shadow-[0_1px_6px_rgba(32,33,36,0.28)] hover:shadow-[0_1px_6px_rgba(32,33,36,0.18)]">
            <Search className="h-4 w-4 shrink-0 text-[#4285F4]" />
            <input
              autoFocus={!inline}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search a landlord by name or phone"
              className="flex-1 bg-transparent px-3 text-base outline-none placeholder:text-muted-foreground"
            />
            {busy && (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#4285F4]" aria-label="Searching" />
            )}
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery('')}
                className="ml-1 rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {/* Live request status: "Searching…" while a request runs, plus a
              persistent "Cancelled 'xyz' · 3s ago" note when an in-flight search
              is aborted because the agent kept typing. */}
          {(busy || cancelledInfo) && (
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 px-1.5 pt-2 text-[11px]" aria-live="polite">
              {busy && (
                <span className="flex items-center gap-1 font-medium text-[#1a73e8] dark:text-[#8ab4f8]">
                  <Loader2 className="h-3 w-3 animate-spin" /> Searching…
                </span>
              )}
              {cancelledInfo && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      tabIndex={0}
                      className="flex items-center gap-1 text-muted-foreground underline decoration-dotted decoration-current/50 underline-offset-2 cursor-help"
                    >
                      <Ban className="h-3 w-3 shrink-0" />
                      <span>
                        Cancelled{' '}
                        <span className="font-semibold text-foreground">“{cancelledInfo.query}”</span>
                        {cancelledAgo && <span className="opacity-70"> · {cancelledAgo}</span>}
                      </span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[240px] text-xs leading-relaxed">
                    You typed again before this search for “{cancelledInfo.query}” finished, so it was
                    stopped to avoid showing stale results. The timer counts the seconds since it was
                    cancelled and clears once your next search loads.
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
          {/* Google-style results meta line */}
          {!loading && !isSystemEmpty && results.length > 0 && (
            <div className="flex items-center justify-between gap-2 px-1 pt-2">
              <p className="text-xs text-muted-foreground truncate">
                {debounced
                  ? `About ${results.length} landlord${results.length === 1 ? '' : 's'} matching "${debounced}"`
                  : `Showing ${results.length} registered landlord${results.length === 1 ? '' : 's'}`}
              </p>
              <button
                type="button"
                onClick={() => setShowThreshold((s) => !s)}
                className={cn(
                  'flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] shrink-0 transition-colors',
                  showThreshold ? 'bg-[#4285F4]/10 text-[#1a73e8] dark:text-[#8ab4f8]' : 'text-muted-foreground hover:bg-accent'
                )}
                aria-pressed={showThreshold}
              >
                <SlidersHorizontal className="h-3 w-3" />
                Precision {Math.round(threshold * 100)}%
              </button>
            </div>
          )}

          {/* Configurable similarity threshold */}
          {!loading && !isSystemEmpty && results.length > 0 && showThreshold && (
            <div className="mt-2 rounded-lg border bg-background/60 p-2.5">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>More results</span>
                <span className="font-medium text-foreground">
                  Match precision {Math.round(threshold * 100)}%
                </span>
                <span>Stricter</span>
              </div>
              <Slider
                className="mt-2"
                value={[Math.round(threshold * 100)]}
                min={5}
                max={90}
                step={5}
                onValueChange={(v) => setThreshold((v[0] ?? 20) / 100)}
              />
              <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
                Lower precision tolerates more typos; higher precision shows only close matches.
              </p>
            </div>
          )}

          {/* Typo-tolerance hint when fuzzy matches are present */}
          {!loading && hasFuzzy && (
            <div className="mt-2 px-1.5 space-y-1">
              <p className="flex items-center gap-1 text-[11px] text-[#1a73e8] dark:text-[#8ab4f8]">
                <Sparkles className="h-3 w-3 shrink-0" />
                Some results matched despite spelling differences.
              </p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <mark className={cn('px-1 bg-transparent', HL_CLASS.exact)}>Aa</mark> exact
                </span>
                <span className="flex items-center gap-1">
                  <mark className={cn('px-1 bg-transparent', HL_CLASS.phone)}>09</mark> phone
                </span>
                <span className="flex items-center gap-1">
                  <mark className={cn('px-1 bg-transparent', HL_CLASS.typo)}>Aa</mark> typo
                </span>
              </div>
            </div>
          )}
        </div>
        <div ref={listRef} className="max-h-72 overflow-y-auto border-t border-border/50 py-1">
          {/* Instant feedback: show "Searching…" the moment the agent types,
              through the debounce window and the fetch. Keep prior results
              visible while re-searching so the list never flickers empty. */}
          {!needsMoreChars && busy && results.length === 0 && (
            <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
            </div>
          )}

          {/* Prominent fallback warning when the system has zero landlords */}
          {!loading && !needsMoreChars && isSystemEmpty && (
            <div className="px-3 py-4 space-y-3">
              <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 flex items-start gap-2.5">
                <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-warning">No landlords registered yet</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-snug">
                    You must register a landlord before you can post a rent request.
                  </p>
                </div>
              </div>
              {onAddNew && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-full gap-1.5 text-xs"
                  onClick={() => {
                    setOpen(false);
                    onAddNew();
                  }}
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  Register a new landlord
                </Button>
              )}
            </div>
          )}

          {/* Prominent fallback warning when search yields no matches */}
          {!loading && !isSystemEmpty && isSearchEmpty && (
            <div className="px-3 py-4 space-y-3">
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 flex items-start gap-2.5">
                <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-destructive">No registered landlord found</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-snug">
                    {registeredBy
                      ? 'Only landlords you registered appear here. Try a different spelling or phone number, or register this landlord first.'
                      : 'Try a different spelling or phone number. Only landlords already registered in the system can be selected.'}
                  </p>
                  <div className="mt-2 space-y-1">
                    <p className="text-[11px] text-muted-foreground">
                      <span className="font-medium">Name:</span> e.g. <span className="font-mono text-foreground">John Mukasa</span>
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      <span className="font-medium">Phone:</span> <span className="font-mono text-foreground">07xxxxxxxx</span> or <span className="font-mono text-foreground">+2567xxxxxxxx</span>
                    </p>
                  </div>
                </div>
              </div>
              {onAddNew && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-full gap-1.5 text-xs"
                  onClick={() => {
                    setOpen(false);
                    onAddNew();
                  }}
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  Register this as a new landlord
                </Button>
              )}
            </div>
          )}

          {/* Search stalled or errored — deliberately NOT the "no matches" state,
              so an agent never registers a duplicate landlord over what was
              actually a connection problem. */}
          {!loading && isSearchFailed && (
            <div className="px-3 py-4 space-y-3">
              <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 flex items-start gap-2.5">
                <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-warning">Search didn't finish</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-snug">
                    This looks like a connection problem, not a missing landlord. Check your
                    connection and try again before registering a new one.
                  </p>
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-full gap-1.5 text-xs"
                onClick={() => setRetryTick((t) => t + 1)}
              >
                <Search className="h-3.5 w-3.5" />
                Retry search
              </Button>
            </div>
          )}

          {!loading && !needsMoreChars && !isSystemEmpty && !isSearchEmpty && results.length === 0 && debounced.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              Start typing to search landlords.
            </div>
          )}

          {results.length > 0 &&
            results.map((l, idx) => {
              const selected = value?.id === l.id;
              const active = idx === activeIndex;
              const location = locationLine(l);
              const ctx = matchContext(l);
              return (
                <button
                  key={l.id}
                  type="button"
                  data-row={idx}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => commitSelection(l)}
                  className={cn(
                    'relative w-full flex items-center gap-3 px-4 pt-2.5 pb-1 text-left transition-all duration-75',
                    active
                      ? 'bg-[#f1f3f4] dark:bg-accent/80 shadow-sm translate-x-0.5'
                      : 'hover:bg-[#f1f3f4]/70 dark:hover:bg-accent/60',
                    // The chosen row stays marked even after the pointer moves
                    // away — `selected` was being computed and never used, so
                    // picking a landlord left no trace in the list.
                    selected && 'bg-primary/5 dark:bg-primary/15'
                  )}
                >
                  {/* Active row left accent bar */}
                  <div
                    className={cn(
                      'absolute left-0 top-2 bottom-2 w-1 rounded-r-full transition-opacity',
                      active ? 'bg-[#4285F4] opacity-100' : selected ? 'bg-primary opacity-100' : 'bg-[#4285F4] opacity-0'
                    )}
                  />
                  <div className="h-9 w-9 rounded-full bg-[#4285F4]/10 flex items-center justify-center shrink-0">
                    <Building2 className="h-5 w-5 text-[#4285F4]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className={cn(
                        'text-sm font-medium truncate group-hover:underline',
                        active ? 'text-foreground' : 'text-[#1a0dab] dark:text-[#8ab4f8]'
                      )}>
                        {highlightName(l.name, debounced, l.match_kind)}
                      </p>
                      {ctx && (
                        <span
                          className={cn(
                            'shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
                            ctx.tone === 'fuzzy'
                              ? 'bg-[#4285F4]/10 text-[#1a73e8] dark:text-[#8ab4f8]'
                              : 'bg-muted text-muted-foreground'
                          )}
                        >
                          {ctx.label}
                        </span>
                      )}
                      {l.verified ? (
                        <span className="inline-flex items-center gap-1 shrink-0 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-semibold text-success">
                          <ShieldCheck className="h-3 w-3" /> Verified
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 shrink-0 rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold text-warning border border-warning/30">
                          <ShieldAlert className="h-3 w-3" /> Pending verification
                        </span>
                      )}

                    </div>
                    <p className="text-xs truncate flex items-center gap-1 text-[#188038] dark:text-[#81c995]">
                      <Phone className="h-3 w-3 shrink-0" />
                      {highlightPhone(l.phone, debounced)}
                      {location && (
                        <>
                          <MapPin className="h-3 w-3 shrink-0 ml-1 text-muted-foreground" />
                          <span className="truncate text-muted-foreground">{location}</span>
                        </>
                      )}
                    </p>
                  </div>
                  {selected ? (
                    <Check className="h-4 w-4 shrink-0 text-[#34A853]" />
                  ) : active ? (
                    <CornerDownLeft className="h-4 w-4 shrink-0 text-[#4285F4] animate-pulse" />
                  ) : null}
                </button>
              );
            })}
        </div>
    </>
  );

  if (inline) {
    return (
      <div className="overflow-hidden rounded-[28px] border border-border/60 bg-background shadow-[0_1px_6px_rgba(32,33,36,0.18)]">
        {panel}
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'w-full justify-between h-11 font-normal',
            !value && 'text-muted-foreground'
          )}
        >
          <span className="flex items-center gap-2 truncate">
            <Building2 className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate">{triggerLabel}</span>
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0 overflow-hidden rounded-[28px] border border-border/60 bg-background shadow-[0_1px_6px_rgba(32,33,36,0.28)]"
        align="start"
      >
        {panel}
      </PopoverContent>
    </Popover>
  );
}
